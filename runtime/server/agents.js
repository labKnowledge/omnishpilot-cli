'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const store = require('./store');
const { resolveAgentRunBin, resolveAgentRunSpawn, which, augmentedPath } = require('./resolve-bin');

/** Known coding-agent CLIs when agent-run is missing or returns empty (common on macOS launchd). */
const FALLBACK_ADAPTERS = [
  { id: 'cursor-agent', label: 'Cursor Agent', binNames: ['cursor-agent'] },
  { id: 'claude', label: 'Claude Code', binNames: ['claude'] },
  { id: 'agy', label: 'Agy', binNames: ['agy'] },
  { id: 'codex', label: 'Codex', binNames: ['codex'] },
  { id: 'gemini', label: 'Gemini CLI', binNames: ['gemini'] },
];

function spawnEnv() {
  return { ...process.env, PATH: augmentedPath() };
}

function fallbackAgentList() {
  return FALLBACK_ADAPTERS.map((a) => {
    let bin = null;
    for (const name of a.binNames) {
      bin = which(name);
      if (bin) break;
    }
    return {
      id: a.id,
      label: a.label,
      bin,
      version: null,
      available: Boolean(bin),
      source: 'fallback',
    };
  });
}

const DEFAULT_PREFERRED_ORDER = ['cursor-agent', 'claude', 'agy'];
const DEFAULT_COOLDOWN_MINUTES = 60;
const COOLDOWN_FILE = 'agent-cooldowns.json';

// Text signatures for "this agent CLI hit its usage/rate limit" rather than a real crash.
// Expanded from common quota phrasing across Cursor / Claude Code / Codex / Gemini CLIs.
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /quota (exceeded|reached|reset)/i,
  /too many requests/i,
  /\b429\b/,
  /please try again (later|in)\b/i,
  /overloaded/i,
  /capacity exceeded/i,
  /you've hit (your |the )?(usage|rate|spending) limit/i,
  /hit (your |the )?(max|usage|rate) limit/i,
  /out of (usage|quota|credits)/i,
  /spending limit/i,
  /limit reached/i,
  /resets? (at|in|on)\b/i,
  /try again (at|after|in)\b/i,
  /resource.?exhausted/i,
  /throttl(ed|ing)/i,
];

let agentsCache = { at: 0, list: [] };

function agentRunBin(cfg) {
  return resolveAgentRunBin(cfg || loadConfig());
}

function getAgents() {
  const now = Date.now();
  if (now - agentsCache.at > 60000) {
    const cfg = loadConfig();
    let list = [];
    try {
      const inv = resolveAgentRunSpawn(cfg, ['list', '--json']);
      const r = spawnSync(inv.bin, inv.args, {
        encoding: 'utf8',
        timeout: 15000,
        env: spawnEnv(),
      });
      if (r.status === 0 && r.stdout) {
        const parsed = JSON.parse(r.stdout);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch { /* fall through */ }

    const available = list.filter((a) => a.available);
    if (!available.length) {
      // agent-run missing, wrong PATH (macOS LaunchAgent), or all unavailable — probe bins directly.
      const fb = fallbackAgentList();
      if (fb.some((a) => a.available)) list = fb;
    }
    agentsCache = { at: now, list };
  }
  return agentsCache.list;
}

function getCooldowns() {
  const cooldowns = store.readJson(COOLDOWN_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(cooldowns)) {
    const until = typeof cooldowns[id] === 'object' ? cooldowns[id].until : cooldowns[id];
    if (!until || until <= now) {
      delete cooldowns[id];
      changed = true;
    }
  }
  if (changed) store.writeJson(COOLDOWN_FILE, cooldowns);
  return cooldowns;
}

function cooldownUntilMs(entry) {
  if (!entry) return 0;
  return typeof entry === 'object' ? (entry.until || 0) : entry;
}

function isInCooldown(agentId, cooldowns = getCooldowns()) {
  return cooldownUntilMs(cooldowns[agentId]) > Date.now();
}

function markCooldown(agentId, minutes, meta = {}) {
  const cfg = loadConfig();
  const mins = minutes != null ? minutes : (cfg.agent?.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES);
  const cooldowns = getCooldowns();
  cooldowns[agentId] = {
    until: Date.now() + mins * 60000,
    reason: meta.reason || 'rate_limit',
    resetAt: meta.resetAt || null,
    markedAt: new Date().toISOString(),
  };
  store.writeJson(COOLDOWN_FILE, cooldowns);
  return cooldowns[agentId];
}

function clearCooldown(agentId) {
  const cooldowns = getCooldowns();
  if (cooldowns[agentId]) {
    delete cooldowns[agentId];
    store.writeJson(COOLDOWN_FILE, cooldowns);
  }
}

function getAgentsWithHealth() {
  const cooldowns = getCooldowns();
  return getAgents().map((a) => ({
    ...a,
    inCooldown: isInCooldown(a.id, cooldowns),
    cooldownUntil: cooldownUntilMs(cooldowns[a.id]) || null,
    cooldownMeta: typeof cooldowns[a.id] === 'object' ? cooldowns[a.id] : null,
  }));
}

function pickAgent({ requestedId, exclude = [] } = {}) {
  const cfg = loadConfig();
  const list = getAgents();
  const byId = Object.fromEntries(list.map((a) => [a.id, a]));
  const cooldowns = getCooldowns();
  const excluded = new Set(exclude.filter(Boolean));

  const usable = (id) => byId[id]?.available && !excluded.has(id) && !isInCooldown(id, cooldowns);

  if (requestedId && requestedId !== 'auto' && usable(requestedId)) return requestedId;

  const order = cfg.agent?.preferredOrder || DEFAULT_PREFERRED_ORDER;
  for (const id of order) {
    if (usable(id)) return id;
  }
  for (const a of list) {
    if (usable(a.id)) return a.id;
  }
  return null;
}

function isLimitHit(text) {
  if (!text) return false;
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Best-effort parse of provider reset / retry-after hints from log text.
 * @returns {{ resetAt: string|null, cooldownMinutes: number }}
 */
function parseLimitReset(text, cfg = loadConfig()) {
  const fallback = cfg.agent?.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES;
  if (!text) return { resetAt: null, cooldownMinutes: fallback };

  // "try again in 4h" / "resets in 35 minutes"
  const inMatch = text.match(/(?:try again|reset(?:s)?|retry|available)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    let minutes = n;
    if (unit.startsWith('hour') || unit.startsWith('hr')) minutes = n * 60;
    else if (unit.startsWith('sec')) minutes = Math.max(1, Math.ceil(n / 60));
    const resetAt = new Date(Date.now() + minutes * 60000).toISOString();
    return { resetAt, cooldownMinutes: Math.min(Math.max(minutes + 1, 1), 24 * 60) };
  }

  // "resets at 4:00 AM" / "try again at 16:30"
  const atMatch = text.match(/(?:resets?|try again|retry|available)\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (atMatch) {
    let hour = Number(atMatch[1]);
    const minute = Number(atMatch[2]);
    const ampm = (atMatch[3] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const when = new Date();
    when.setSeconds(0, 0);
    when.setHours(hour, minute, 0, 0);
    if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    const minutes = Math.max(1, Math.ceil((when.getTime() - Date.now()) / 60000));
    return { resetAt: when.toISOString(), cooldownMinutes: Math.min(minutes + 1, 24 * 60) };
  }

  // ISO-ish timestamp
  const iso = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (iso) {
    const when = new Date(iso[1]);
    if (!Number.isNaN(when.getTime()) && when.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((when.getTime() - Date.now()) / 60000));
      return { resetAt: when.toISOString(), cooldownMinutes: Math.min(minutes + 1, 24 * 60) };
    }
  }

  // Retry-After: 120
  const retryAfter = text.match(/retry-?after[:\s]+(\d+)/i);
  if (retryAfter) {
    const seconds = Number(retryAfter[1]);
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return {
      resetAt: new Date(Date.now() + seconds * 1000).toISOString(),
      cooldownMinutes: Math.min(minutes + 1, 24 * 60),
    };
  }

  return { resetAt: null, cooldownMinutes: fallback };
}

/** Earliest cooldown end among preferred agents (for resume-at-reset). */
function earliestCooldownEnd(order) {
  const cfg = loadConfig();
  const preferred = order || cfg.agent?.preferredOrder || DEFAULT_PREFERRED_ORDER;
  const cooldowns = getCooldowns();
  let min = null;
  for (const id of preferred) {
    const until = cooldownUntilMs(cooldowns[id]);
    if (until && (!min || until < min)) min = until;
  }
  // Also consider any cooled-down available agent
  for (const id of Object.keys(cooldowns)) {
    const until = cooldownUntilMs(cooldowns[id]);
    if (until && (!min || until < min)) min = until;
  }
  return min;
}

function allPreferredLimited(order) {
  const cfg = loadConfig();
  const preferred = order || cfg.agent?.preferredOrder || DEFAULT_PREFERRED_ORDER;
  const list = getAgents();
  const byId = Object.fromEntries(list.map((a) => [a.id, a]));
  const cooldowns = getCooldowns();
  const considered = preferred.filter((id) => byId[id]);
  if (!considered.length) return !pickAgent({});
  return considered.every((id) => !byId[id]?.available || isInCooldown(id, cooldowns));
}

module.exports = {
  getAgents,
  getAgentsWithHealth,
  pickAgent,
  isLimitHit,
  parseLimitReset,
  markCooldown,
  clearCooldown,
  isInCooldown,
  getCooldowns,
  earliestCooldownEnd,
  allPreferredLimited,
  agentRunBin,
  resolveAgentRunBin,
  resolveAgentRunSpawn,
  DEFAULT_PREFERRED_ORDER,
  LIMIT_PATTERNS,
};
