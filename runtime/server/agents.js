const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const store = require('./store');

const DEFAULT_PREFERRED_ORDER = ['cursor-agent', 'claude', 'agy'];
const DEFAULT_COOLDOWN_MINUTES = 60;
const COOLDOWN_FILE = 'agent-cooldowns.json';

// Best-effort text signatures for "this agent CLI hit its usage/rate limit" rather than a real
// crash. Drawn from common quota-error phrasing across coding-agent CLIs — untested against a
// live limit hit from cursor-agent/claude/agy, since none has been observed yet. Tighten this
// list the first time a real limit message shows up in a job log.
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /quota exceeded/i,
  /too many requests/i,
  /\b429\b/,
  /please try again later/i,
  /overloaded/i,
  /capacity exceeded/i,
  /resets? (at|in|on)\b.*\b(limit|quota|usage)\b/i,
];

let agentsCache = { at: 0, list: [] };

function agentRunBin(cfg) {
  return (cfg || loadConfig()).agent?.agentRunBin || '/home/eligapris/.local/bin/agent-run';
}

function getAgents() {
  const now = Date.now();
  if (now - agentsCache.at > 60000) {
    const cfg = loadConfig();
    try {
      const r = spawnSync(agentRunBin(cfg), ['list', '--json'], { encoding: 'utf8', timeout: 15000 });
      agentsCache = { at: now, list: r.status === 0 ? JSON.parse(r.stdout) : [] };
    } catch {
      agentsCache = { at: now, list: [] };
    }
  }
  return agentsCache.list;
}

function getCooldowns() {
  const cooldowns = store.readJson(COOLDOWN_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(cooldowns)) {
    if (cooldowns[id] <= now) { delete cooldowns[id]; changed = true; }
  }
  if (changed) store.writeJson(COOLDOWN_FILE, cooldowns);
  return cooldowns;
}

function isInCooldown(agentId, cooldowns = getCooldowns()) {
  return !!cooldowns[agentId] && cooldowns[agentId] > Date.now();
}

function markCooldown(agentId, minutes) {
  const cfg = loadConfig();
  const mins = minutes || cfg.agent?.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES;
  const cooldowns = getCooldowns();
  cooldowns[agentId] = Date.now() + mins * 60000;
  store.writeJson(COOLDOWN_FILE, cooldowns);
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
  return getAgents().map(a => ({
    ...a,
    inCooldown: isInCooldown(a.id, cooldowns),
    cooldownUntil: cooldowns[a.id] || null,
  }));
}

// Pick a concrete agent id: prefer the explicitly requested one unless it's excluded or
// cooling down, otherwise walk the configured preferred order (default: cursor-agent, claude,
// agy), skipping unavailable/cooled-down/excluded agents. Returns null if nothing usable is
// found — caller should fall back to agent-run's own 'auto' resolution in that case.
function pickAgent({ requestedId, exclude = [] } = {}) {
  const cfg = loadConfig();
  const agents = getAgents();
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  const cooldowns = getCooldowns();
  const excluded = new Set(exclude.filter(Boolean));

  const usable = (id) => byId[id]?.available && !excluded.has(id) && !isInCooldown(id, cooldowns);

  if (requestedId && requestedId !== 'auto' && usable(requestedId)) return requestedId;

  const order = cfg.agent?.preferredOrder || DEFAULT_PREFERRED_ORDER;
  for (const id of order) {
    if (usable(id)) return id;
  }
  for (const a of agents) {
    if (usable(a.id)) return a.id;
  }
  return null;
}

function isLimitHit(text) {
  if (!text) return false;
  return LIMIT_PATTERNS.some(re => re.test(text));
}

module.exports = {
  getAgents,
  getAgentsWithHealth,
  pickAgent,
  isLimitHit,
  markCooldown,
  clearCooldown,
  isInCooldown,
  getCooldowns,
  DEFAULT_PREFERRED_ORDER,
};
