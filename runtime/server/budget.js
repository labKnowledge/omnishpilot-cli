'use strict';

// Opt-in caps on agent work: minutes of agent time per day, and dollars per month. Minutes work for every agent CLI.
// Dollars count only what a CLI reports itself (Claude Code's `total_cost_usd` in JSON output); a run that reports
// nothing costs $0 here, so the dollar cap is a floor on spend, never an estimate. Jobs over a cap wait, they don't fail.

const DEFAULT_WARN_AT_PERCENT = 80;

/** What a finished run's log says it used. Read from the end, where the CLIs print their totals. */
function usageFromLog(logTail = '') {
  const costs = [...logTail.matchAll(/"total_cost_usd"\s*:\s*([0-9]+(?:\.[0-9]+)?)/g)];
  // Codex prints "tokens used" and the count, on the same line or the next one.
  const tokens = [...logTail.matchAll(/tokens used:?\s*\n?\s*([0-9][0-9,]*)/gi)];
  const last = (matches) => (matches.length ? Number(matches[matches.length - 1][1].replace(/,/g, '')) : null);
  return { costUsd: last(costs), tokens: last(tokens) };
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function meter(used, limit, warnAt) {
  if (!(Number(limit) > 0)) return null;
  const percent = Math.round((used / limit) * 100);
  return { used, limit: Number(limit), percent, warn: percent >= warnAt, exceeded: used >= limit };
}

/**
 * Where agent work stands against the configured caps. `events` are the ledger's `agent_usage` rows; `running` are
 * tasks still running, whose minutes so far count toward today.
 */
function budgetState(cfg, events, running = [], now = new Date()) {
  const b = cfg.budget || {};
  if (!(Number(b.dailyAgentMinutes) > 0) && !(Number(b.monthlyUsd) > 0)) return null;
  const day = localDay(now);
  const month = day.slice(0, 7);
  let minutes = 0;
  let usd = 0;
  for (const e of events) {
    if (e.type !== 'agent_usage') continue;
    const at = localDay(new Date(e.ts));
    if (at === day) minutes += Number(e.minutes) || 0;
    if (at.slice(0, 7) === month) usd += Number(e.costUsd) || 0;
  }
  for (const t of running) {
    const started = new Date(t.execution?.startedAt || now).getTime();
    minutes += Math.max(0, (now.getTime() - started) / 60000);
  }
  const warnAt = Number(b.warnAtPercent) || DEFAULT_WARN_AT_PERCENT;
  const state = {
    day,
    month,
    minutes: meter(Math.round(minutes), b.dailyAgentMinutes, warnAt),
    usd: meter(Math.round(usd * 100) / 100, b.monthlyUsd, warnAt),
  };
  state.exceeded = Boolean(state.minutes?.exceeded || state.usd?.exceeded);
  return state;
}

/** Why agent jobs are waiting, in words; null when nothing is over its cap. */
function heldReason(state) {
  if (!state?.exceeded) return null;
  if (state.minutes?.exceeded) {
    return `Waiting: today's agent budget of ${state.minutes.limit} minutes is used up. Runs resume tomorrow, or raise it with \`omnishpilot budget --minutes <n>\`.`;
  }
  return `Waiting: this month's agent budget of $${state.usd.limit} is used up. Runs resume next month, or raise it with \`omnishpilot budget --usd <n>\`.`;
}

/**
 * The alert to send now, at most one warning and one cap notice per cap and period.
 * @returns {{ alert: { title: string, body: string } | null, marks: object }}
 */
function takeBudgetAlert(marks, state) {
  if (!state) return { alert: null, marks };
  const next = { ...(marks || {}) };
  const checks = [
    ['minutes', state.day, (m) => `${m.used} of ${m.limit} agent minutes used today`],
    ['usd', state.month, (m) => `$${m.used.toFixed(2)} of $${m.limit} reported spend this month`],
  ];
  for (const [key, period, words] of checks) {
    const m = state[key];
    if (!m) continue;
    const seen = next[key]?.period === period ? next[key] : { period };
    const level = m.exceeded ? 'cap' : m.warn ? 'warn' : null;
    if (!level || seen[level] || (level === 'warn' && seen.cap)) continue;
    next[key] = { ...seen, [level]: true, warn: true };
    const alert = level === 'cap'
      ? { title: 'Agent budget reached', body: `${words(m)}. Agent jobs wait until it resets. Terminal jobs still run.` }
      : { title: `Agent budget at ${m.percent}%`, body: `${words(m)}. Agent jobs will wait once it's reached.` };
    return { alert, marks: next };
  }
  return { alert: null, marks: next };
}

module.exports = { usageFromLog, budgetState, heldReason, takeBudgetAlert };
