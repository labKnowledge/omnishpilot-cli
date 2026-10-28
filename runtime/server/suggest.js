const ledger = require('./ledger');
const store = require('./store');
const templates = require('./templates');
const skeletonMiner = require('./skeletonMiner');
const { loadConfig } = require('./config');

// Frecency-Slot Model: a recency-decayed, outcome-weighted running score per candidate value
// for a given (templateId, slot) — the same shape as Mozilla's Places "frecency" ranking
// (frequency + recency, introduced in Firefox 3) applied to job fields (agent, workspace
// folder, schedule type) instead of URLs. A value used constantly last month but not this
// week fades out on its own instead of squatting at the top forever.

const OUTCOME_WEIGHT = { completed: 1.0, pending: 0.7, stopped: 0.5, failed: 0.3 };
const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_MIN_COUNT = 2;

function suggestionConfig() {
  const cfg = loadConfig();
  const s = cfg.suggestions || {};
  return {
    halfLifeMs: (s.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * 24 * 60 * 60 * 1000,
    minCount: s.minCount ?? DEFAULT_MIN_COUNT,
  };
}

function decay(ageMs, halfLifeMs) {
  return Math.pow(0.5, Math.max(ageMs, 0) / halfLifeMs);
}

function outcomeByTaskId() {
  const map = new Map();
  for (const e of ledger.query({ type: 'job_completed' })) map.set(e.taskId, 'completed');
  for (const e of ledger.query({ type: 'job_failed' })) map.set(e.taskId, 'failed');
  for (const e of ledger.query({ type: 'job_stopped' })) if (!map.has(e.taskId)) map.set(e.taskId, 'stopped');
  return map;
}

// Returns the top-scoring value for one (templateId, slot) pair, or null below the cold-start
// floor (minCount) — callers must treat null as "say nothing, keep today's default".
function suggestSlot(templateId, slot, opts = {}) {
  const { halfLifeMs, minCount } = { ...suggestionConfig(), ...opts };
  const events = ledger.query({ type: 'job_created', templateId }).filter(e => e[slot]);
  if (!events.length) return null;

  const outcomes = outcomeByTaskId();
  const now = Date.now();
  const scores = new Map();
  const counts = new Map();
  const lastUsedAt = new Map();

  for (const e of events) {
    const value = e[slot];
    const outcome = outcomes.get(e.taskId) || 'pending';
    const weight = OUTCOME_WEIGHT[outcome] ?? OUTCOME_WEIGHT.pending;
    const score = weight * decay(now - new Date(e.ts).getTime(), halfLifeMs);
    scores.set(value, (scores.get(value) || 0) + score);
    counts.set(value, (counts.get(value) || 0) + 1);
    if (!lastUsedAt.has(value) || e.ts > lastUsedAt.get(value)) lastUsedAt.set(value, e.ts);
  }

  let best = null;
  for (const [value, score] of scores) {
    const count = counts.get(value);
    if (count < minCount) continue;
    if (!best || score > best.score) best = { value, score, count, lastUsedAt: lastUsedAt.get(value) };
  }
  return best;
}

function suggestForTemplate(templateId, opts = {}) {
  return {
    agentId: suggestSlot(templateId, 'agentId', opts),
    workspaceId: suggestSlot(templateId, 'workspaceId', opts),
    workspacePath: suggestSlot(templateId, 'workspacePath', opts),
    scheduleType: suggestSlot(templateId, 'scheduleType', opts),
  };
}

// Skeleton Miner wiring: pulls the user's own last few fill-ins per instruction section
// straight from tasks.json (the content-bearing source of truth — the ledger only tracks
// lightweight structured events, not full instruction text) and anti-unifies them.
function suggestInstructionSkeletons(templateId, opts = {}) {
  const tpl = templates.getTemplate(templateId);
  if (!tpl || !tpl.instructionSections?.length) return {};

  const tasks = store.listTasks()
    .filter(t => t.templateId === templateId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const out = {};
  for (const sec of tpl.instructionSections) {
    const samples = tasks
      .map(t => t.instructions?.[sec.key])
      .filter(text => text && text.trim() && !text.includes('{{slot_'))
      .slice(0, opts.limit || 6);
    const mined = skeletonMiner.mineSkeleton(samples);
    if (mined) out[sec.key] = mined;
  }
  return out;
}

module.exports = { suggestSlot, suggestForTemplate, suggestInstructionSkeletons, suggestionConfig };
