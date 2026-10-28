const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const templates = require('./templates');
const agents = require('./agents');
const ledger = require('./ledger');
const suggest = require('./suggest');
const { resolveAgentRunBin } = require('./resolve-bin');

const NEAR_DUPLICATE_THRESHOLD = 0.6;

function wordSet(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// PbD-style correction capture (CoScripter/SUGILITE): every quick-add job we ever finalized —
// whether the user accepted the interpreter's guess as-is or edited it first — is logged with
// its request text and final spec. A near-duplicate future request (same workspace, high word
// overlap) reuses that final spec directly instead of paying for another agent-run round trip.
function findReusableSpec(text, workspace) {
  const tokens = wordSet(text);
  if (!tokens.size) return null;
  const recent = ledger.query({ type: 'quick_add_resolved' }).slice(-200);
  let best = null;
  for (const e of recent) {
    if (!e.finalSpec || (e.workspace || '') !== (workspace || '')) continue;
    const sim = jaccard(tokens, wordSet(e.requestText));
    if (sim >= NEAR_DUPLICATE_THRESHOLD && (!best || sim > best.sim)) best = { sim, spec: e.finalSpec };
  }
  return best ? best.spec : null;
}

function agentRunBin(cfg) {
  return resolveAgentRunBin(cfg);
}

function buildInterpreterPrompt(text, workspaceHint) {
  const cfg = loadConfig();
  const tz = cfg.scheduler?.defaultTimezone || 'America/Denver';
  const now = new Date().toISOString();

  const templateList = templates.TEMPLATES.map(t => {
    const fields = t.fields.map(f => `${f.key} (${f.type}${f.required ? ', required' : ''})`).join(', ');
    return `- "${t.id}": ${t.name} — ${t.description}\n  fields: ${fields}`;
  }).join('\n');

  const scheduleList = templates.SCHEDULE_TYPES.map(s =>
    `- "${s.id}": ${s.label} — ${s.description}${s.fields.length ? ` (needs: ${s.fields.join(', ')})` : ''}`
  ).join('\n');

  const runModeList = templates.RUN_MODES.map(m => `- "${m.id}": ${m.description}`).join('\n');

  return `You are turning a plain-language request into a structured job spec for an automation dashboard. Do not perform the task itself, do not write or edit any files, do not run any other shell commands — only read this request and respond with the JSON described below, then stop.

## Request
"${text.replace(/"/g, '\\"')}"
${workspaceHint ? `The user attached this folder for context: ${workspaceHint}` : 'No folder was attached.'}

## Current date/time
${now} (timezone: ${tz})

## Choose exactly one job type (templateId)
${templateList}

## Choose exactly one schedule type
${scheduleList}
Time fields: hour is 24-hour (0-23), minute is 0-59, dayOfWeek is 0=Sunday..6=Saturday, dayOfMonth is 1-31. For "once", compute an absolute ISO 8601 runAt from the current date/time above.

## Choose exactly one run mode
${runModeList}

## Output — respond with ONLY this, nothing else
\`\`\`json
{
  "templateId": "...",
  "title": "short human title, under 60 chars",
  "inputs": { "...template field key...": "..." },
  "schedule": { "type": "...", "...extra field the schedule type needs...": ... },
  "runMode": "..."
}
\`\`\`
Only include input keys that belong to the chosen template's field list. Leave "workspace" empty if none was given. If the request doesn't clearly state a schedule, use "manual". If it doesn't clearly match any job type, use "agent-task".

Special case — pure terminal work (no AI): if the user is clearly scheduling a shell command, script path, cron-like job, or app launch (e.g. "every night run ./backup.sh", "hourly: curl https://…", "daily at 2am rsync …") with no research/writing/coding for an agent, use templateId "shell-command", put the exact command in inputs.command, optional folder in inputs.cwd, and set runMode to "manual".`;
}

function extractJson(stdout) {
  const fenced = stdout.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (stdout.match(/\{[\s\S]*\}/) || [])[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function normalizeSpec(raw, fallbackText) {
  const tpl = templates.getTemplate(raw?.templateId) || templates.getTemplate('agent-task');

  const inputs = {};
  for (const f of tpl.fields) {
    inputs[f.key] = (raw?.inputs?.[f.key] ?? '').toString();
  }
  if (!inputs.goal && tpl.fields.some(f => f.key === 'goal')) inputs.goal = fallbackText;
  if (!inputs.title && tpl.fields.some(f => f.key === 'title')) inputs.title = raw?.title || fallbackText.slice(0, 60);

  // Backfill incidental technical fields (which CLI, which folder) from this user's own
  // history via the Frecency-Slot Model — these are rarely stated in a plain-language
  // request, unlike schedule, which the interpreter already parses deliberately from intent
  // and we never want to silently override.
  const suggestions = suggest.suggestForTemplate(tpl.id);
  if (!inputs.agentId && tpl.fields.some(f => f.key === 'agentId') && suggestions.agentId) {
    inputs.agentId = suggestions.agentId.value;
  }
  if (!inputs.workspace && tpl.fields.some(f => f.key === 'workspace') && suggestions.workspacePath) {
    inputs.workspace = suggestions.workspacePath.value;
  }

  const scheduleType = templates.SCHEDULE_TYPES.find(s => s.id === raw?.schedule?.type) ? raw.schedule.type : 'manual';
  const scheduleDef = templates.SCHEDULE_TYPES.find(s => s.id === scheduleType);
  const schedule = { type: scheduleType };
  for (const key of (scheduleDef?.fields || [])) {
    if (raw?.schedule?.[key] !== undefined) schedule[key] = raw.schedule[key];
  }

  const runMode = templates.RUN_MODES.find(m => m.id === raw?.runMode) ? raw.runMode : tpl.defaultRunMode;
  const title = (raw?.title || inputs.title || fallbackText.slice(0, 60)).toString();

  return {
    templateId: tpl.id,
    title,
    inputs,
    instructions: templates.buildDefaultInstructions(tpl, inputs, suggest.suggestInstructionSkeletons(tpl.id)),
    schedule,
    runMode,
  };
}

// Runs the interpreter against a single concrete agent. Returns { spec } on success, or
// { limitHit, error } on failure so the caller can decide whether to fail fast or try the
// next agent in the pool.
function tryInterpretWith(agentId, clean, cleanWorkspace) {
  const cfg = loadConfig();
  const bin = agentRunBin(cfg);

  const scratchDir = path.join(os.tmpdir(), `omnishpilot-quickadd-${randomUUID()}`);
  fs.mkdirSync(scratchDir, { recursive: true });
  const promptFile = path.join(scratchDir, 'prompt.md');
  fs.writeFileSync(promptFile, buildInterpreterPrompt(clean, cleanWorkspace));

  // Interpretation shouldn't need real project access — default to an isolated scratch
  // folder so a misbehaving agent can't touch real files. Only use the user's real folder
  // when they deliberately attached one (same trust boundary as the full wizard's path field).
  const useWorkspace = (cleanWorkspace && fs.existsSync(cleanWorkspace)) ? cleanWorkspace : scratchDir;

  try {
    const r = spawnSync(bin, ['run', '--agent', agentId, '--workspace', useWorkspace, '--prompt-file', promptFile, '--out', scratchDir], {
      encoding: 'utf8',
      timeout: 45000,
    });
    if (r.error) {
      const timedOut = r.error.code === 'ETIMEDOUT';
      return { error: new Error(timedOut ? 'Interpreting that took too long — try a shorter description, or use New Job.' : r.error.message) };
    }
    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    if (r.signal) {
      return { error: new Error('Interpreting that took too long — try a shorter description, or use New Job.') };
    }
    if (r.status !== 0 && !stdout.trim()) {
      const combined = `${stdout}\n${stderr}`;
      return {
        limitHit: agents.isLimitHit(combined),
        error: new Error(stderr.trim().slice(0, 300) || `Interpreter exited with code ${r.status}`),
      };
    }
    const raw = extractJson(stdout);
    if (!raw) return { error: new Error("Couldn't understand that — try rephrasing, or use New Job.") };
    return { spec: normalizeSpec(raw, clean) };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

// Reuses the same pool + cooldown intelligence as job execution failover: if the agent
// picked to interpret the request is itself out of quota, mark it cooling down and try the
// next one, instead of surfacing a raw CLI error for something the user never even saw.
function interpretQuickAdd({ text, workspace }) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Type what you want done first.');
  const cleanWorkspace = (workspace || '').trim();

  const reused = findReusableSpec(clean, cleanWorkspace);
  if (reused) return { ...reused, _reused: true };

  const tried = [];
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const agentId = agents.pickAgent({ exclude: tried });
    if (!agentId) break;
    tried.push(agentId);

    const result = tryInterpretWith(agentId, clean, cleanWorkspace);
    if (result.spec) return result.spec;

    lastError = result.error;
    if (result.limitHit) {
      agents.markCooldown(agentId);
      continue;
    }
    break; // non-limit failure — don't keep burning other agents on the same bad input
  }

  throw lastError || new Error("Couldn't understand that — try rephrasing, or use New Job.");
}

module.exports = { interpretQuickAdd, buildInterpreterPrompt, normalizeSpec };
