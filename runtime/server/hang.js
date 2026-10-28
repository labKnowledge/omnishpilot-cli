'use strict';

const fs = require('fs');

/** Log patterns that usually mean the agent is blocked on a human / TTY. */
const HANG_PATTERNS = [
  /waiting for (your )?(approval|permission|confirmation)/i,
  /awaiting (human|user|your) (input|approval|permission)/i,
  /press (enter|any key|return) to continue/i,
  /\b\(y\/n\)\b/i,
  /\b\[y\/n\]\b/i,
  /do you want to (continue|proceed|allow|run)/i,
  /permission required/i,
  /approve (this|the) (command|action|tool)/i,
  /run everything\??/i,
  /allowlist|auto-?review/i,
  /dangerously-skip-permissions.*denied/i,
  /needs? (your )?confirmation/i,
  /human[- ]in[- ]the[- ]loop/i,
  /type ['"]?(yes|y|continue)['"]? to/i,
];

function detectHangSignals(text) {
  if (!text) return { hung: false, matched: null };
  for (const re of HANG_PATTERNS) {
    const m = text.match(re);
    if (m) return { hung: true, matched: m[0] };
  }
  return { hung: false, matched: null };
}

function logActivity(logPath) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return { size: 0, mtimeMs: 0 };
    const st = fs.statSync(logPath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

/**
 * Decide whether a running job is hung or past hard timeout.
 * @returns {{ action: 'ok'|'hang'|'timeout'|'idle', reason: string, matched?: string }}
 */
function evaluateRunHealth(task, { now = Date.now(), cfg = {}, logTail = '' } = {}) {
  const ex = task.execution || {};
  const hangIdleMin = cfg.worker?.hangIdleMinutes ?? 12;
  const hangHardMin = cfg.worker?.hangHardMinutes ?? 45;
  const jobTimeoutMin = cfg.worker?.jobTimeoutMinutes ?? 240;

  if (!ex.startedAt) return { action: 'ok', reason: 'not_started' };

  const startedAt = new Date(ex.startedAt).getTime();
  const elapsedMin = (now - startedAt) / 60000;
  if (jobTimeoutMin > 0 && elapsedMin >= jobTimeoutMin) {
    return {
      action: 'timeout',
      reason: `Job exceeded ${jobTimeoutMin}m timeout (${Math.round(elapsedMin)}m elapsed)`,
    };
  }

  const lastActivityAt = ex.lastLogAt
    ? new Date(ex.lastLogAt).getTime()
    : startedAt;
  const idleMin = (now - lastActivityAt) / 60000;

  const signals = detectHangSignals(logTail);
  if (signals.hung && idleMin >= Math.min(3, hangIdleMin)) {
    return {
      action: 'hang',
      reason: `Agent appears blocked on approval/TTY (idle ${Math.round(idleMin)}m)`,
      matched: signals.matched,
    };
  }

  if (hangIdleMin > 0 && idleMin >= hangIdleMin && signals.hung) {
    return {
      action: 'hang',
      reason: `No log progress for ${Math.round(idleMin)}m and hang signals present`,
      matched: signals.matched,
    };
  }

  if (hangHardMin > 0 && idleMin >= hangHardMin) {
    return {
      action: 'idle',
      reason: `No log progress for ${Math.round(idleMin)}m (hard idle ${hangHardMin}m)`,
    };
  }

  return { action: 'ok', reason: 'healthy' };
}

module.exports = {
  HANG_PATTERNS,
  detectHangSignals,
  logActivity,
  evaluateRunHealth,
};
