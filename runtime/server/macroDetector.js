const ledger = require('./ledger');
const templates = require('./templates');
const suggest = require('./suggest');
const { loadConfig } = require('./config');

// Macro-operator learning (in the spirit of Macro-FF's automatically learned planning
// macro-operators, and HTN methods that reduce a compound task to a fixed sequence of
// primitives): scan the ledger for "job A finishes, job B starts soon after, in the same
// workspace" adjacencies that recur across multiple distinct days, and promote the recurring
// pair into a named one-click compound action. A macro is pure sugar over the existing
// POST /api/tasks primitive — it never introduces a new execution path.

function macroConfig() {
  const cfg = loadConfig();
  const s = cfg.suggestions || {};
  return {
    windowMs: (s.macroWindowMinutes ?? 120) * 60 * 1000,
    minCount: s.macroMinCount ?? 3,
    minDays: s.macroMinDays ?? 2,
  };
}

function dateKey(ts) {
  return String(ts).slice(0, 10);
}

// Anti-overfit guard: a burst of 3 manual clicks in one afternoon must NOT look like a habit —
// occurrences have to spread across at least minDays distinct calendar days too.
function detectMacros(opts = {}) {
  const { windowMs, minCount, minDays } = { ...macroConfig(), ...opts };

  const completions = ledger.query({ type: 'job_completed' })
    .filter(e => e.workspaceId && e.templateId)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const creations = ledger.query({ type: 'job_created' })
    .filter(e => e.workspaceId && e.templateId)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const pairs = new Map();
  for (const done of completions) {
    const doneTime = new Date(done.ts).getTime();
    const next = creations.find(c => {
      if (c.workspaceId !== done.workspaceId || c.taskId === done.taskId) return false;
      const dt = new Date(c.ts).getTime() - doneTime;
      return dt > 0 && dt <= windowMs;
    });
    if (!next || next.templateId === done.templateId) continue;

    const key = `${done.workspaceId}|${done.templateId}|${next.templateId}`;
    if (!pairs.has(key)) {
      pairs.set(key, { workspaceId: done.workspaceId, templateId: done.templateId, toTemplateId: next.templateId, count: 0, days: new Set() });
    }
    const p = pairs.get(key);
    p.count++;
    p.days.add(dateKey(done.ts));
  }

  return [...pairs.values()]
    .filter(p => p.count >= minCount && p.days.size >= minDays)
    .map(p => ({ ...p, days: p.days.size }))
    .sort((a, b) => b.count - a.count);
}

// Builds a ready-to-POST /api/tasks spec for the macro's target template, populated the same
// way quick-add's interpreter would: Frecency-Slot Model for agent/workspace/schedule,
// Skeleton Miner for instruction sections. Never executed automatically — the caller always
// hands this to the wizard or a confirm step for the user's explicit click.
function buildMacroSpec(toTemplateId, workspaceId, fromTask) {
  const tpl = templates.getTemplate(toTemplateId);
  if (!tpl) return null;

  const agent = suggest.suggestSlot(toTemplateId, 'agentId');
  const workspacePath = suggest.suggestSlot(toTemplateId, 'workspacePath');
  const schedule = suggest.suggestSlot(toTemplateId, 'scheduleType');
  const skeletons = suggest.suggestInstructionSkeletons(toTemplateId);

  const inputs = {};
  for (const f of tpl.fields) {
    if (f.key === 'agentId' && agent) inputs.agentId = agent.value;
    else if (f.key === 'workspace' && workspacePath) inputs.workspace = workspacePath.value;
    else if (f.key === 'title') inputs.title = `${tpl.name} — from "${fromTask.title}"`;
    else if (f.key === 'sourceDay' && fromTask.inputs?.dayNumber) inputs.sourceDay = fromTask.inputs.dayNumber;
    else if (f.key === 'dayNumber' && fromTask.inputs?.dayNumber) inputs.dayNumber = fromTask.inputs.dayNumber;
    else inputs[f.key] = '';
  }

  const instructions = {};
  for (const sec of tpl.instructionSections) {
    instructions[sec.key] = skeletons[sec.key]?.text || '';
  }

  return {
    templateId: tpl.id,
    workspaceId: workspaceId || fromTask.workspaceId,
    title: inputs.title || tpl.name,
    inputs,
    instructions,
    schedule: { type: schedule?.value || 'manual' },
    runMode: tpl.defaultRunMode,
  };
}

function macroForTask(task) {
  if (!task?.workspaceId || !task?.templateId) return null;
  const macros = detectMacros().filter(m => m.workspaceId === task.workspaceId && m.templateId === task.templateId);
  if (!macros.length) return null;
  const best = macros[0];
  const toTpl = templates.getTemplate(best.toTemplateId);
  if (!toTpl) return null;
  return {
    id: `${best.workspaceId}:${best.templateId}:${best.toTemplateId}`,
    label: toTpl.name,
    icon: toTpl.icon || '➡️',
    count: best.count,
    spec: buildMacroSpec(best.toTemplateId, best.workspaceId, task),
  };
}

module.exports = { detectMacros, buildMacroSpec, macroForTask };
