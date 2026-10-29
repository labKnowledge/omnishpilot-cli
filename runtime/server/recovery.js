'use strict';

// What a failed run turns into. A crash, a flaky network or an acceptance gate the agent can still meet is worth
// another start. A signed-out agent CLI, a command that doesn't exist, a prompt nobody will answer or a hard timeout
// would only fail the same way again, so those fail at once with the one thing the owner has to fix, told once.

const SHELL_COMMAND = 'shell-command';

/** Agent CLIs' own sign-in failures. Read only from the last lines of the log, where the CLI's exit message is. */
const SIGNED_OUT = /\b(not logged in|you are logged out|please (log|sign) ?in|authentication required|invalid (x-)?api[ -]key|oauth token (has )?expired|run [`'"]?[\w-]+ (auth )?login)\b/i;
const SIGNED_OUT_TAIL_LINES = 15;

const COMMAND_NOT_FOUND = 127;

/**
 * @param {object} f
 * @param {'spawn'|'hang'|'idle'|'timeout'|'acceptance'|'verifier'|'restart'|'exit'} f.cause
 * @param {string} [f.connector]
 * @param {number} [f.exitCode]
 * @param {string} [f.logTail]
 * @param {string} [f.agentId]
 * @returns {{ kind: 'retry' } | { kind: 'final', detail: string } | { kind: 'owner', cause: string, detail: string, noticeKey: string }}
 */
function classifyFailure({ cause, connector, exitCode, logTail = '', agentId, taskId }) {
  const isShell = connector === SHELL_COMMAND;
  const forTask = (c) => `${taskId}:${c}`;

  if (cause === 'spawn') {
    return {
      kind: 'owner',
      cause: 'setup',
      noticeKey: forTask('setup'),
      detail: isShell
        ? 'Check the command, its working directory and PATH, then retry.'
        : 'Run `omnishpilot doctor` to check the agent CLI, workspace path and sandbox, then retry.',
    };
  }
  if (cause === 'hang') {
    return {
      kind: 'owner',
      cause: 'prompt',
      noticeKey: forTask('prompt'),
      detail: 'Not retried: it would stop at the same prompt again. Run `omnishpilot doctor` to check the agent runs unattended, then retry.',
    };
  }
  if (cause === 'timeout') {
    return {
      kind: 'final',
      detail: 'Not retried: a second run would most likely hit the same limit. Raise worker.jobTimeoutMinutes if this job needs longer.',
    };
  }
  if (isShell && exitCode === COMMAND_NOT_FOUND) {
    return {
      kind: 'owner',
      cause: 'setup',
      noticeKey: forTask('setup'),
      detail: 'The command was not found. Check its spelling and PATH, then retry.',
    };
  }
  if (!isShell && cause === 'exit') {
    const lastLines = logTail.split('\n').slice(-SIGNED_OUT_TAIL_LINES).join('\n');
    if (SIGNED_OUT.test(lastLines)) {
      const who = agentId ? `Agent "${agentId}"` : 'The agent CLI';
      return {
        kind: 'owner',
        cause: 'signed_out',
        noticeKey: `${agentId || 'agent'}:signed_out`,
        detail: `${who} is signed out. Run it once by hand on this machine to sign in, then retry the job.`,
      };
    }
  }
  return { kind: 'retry' };
}

/** Two failures with the same signature failed the same way: numbers (durations, line counts) don't count. */
function failureSignature(cause, error) {
  return `${cause}:${String(error || '').replace(/\d+/g, '#').slice(0, 200)}`;
}

/** The lines a retried agent reads first, so a run that already did part of the work doesn't do it twice. */
function retryNote(retryOf) {
  if (!retryOf) return '';
  const why = retryOf.cause === 'resume'
    ? 'was stopped before it finished'
    : retryOf.cause === 'restart'
      ? 'was cut off when OmnishPilot restarted'
      : `did not finish (${String(retryOf.error || 'unknown error').slice(0, 300)})`;
  return `
## This is a retry
An earlier run of this job ${why}. It may have done part of the work already. Before you start, check what it left behind (files in the output directory and workspace, commits, messages sent, anything it started) so nothing is done twice. Then finish the job.
`;
}

/**
 * Owner notices are told once per key until a run clears them. Returns whether this one is new, and the list to save.
 * @param {{ key: string, at: string }[]} notices
 */
function takeNotice(notices, key, now = new Date()) {
  const list = Array.isArray(notices) ? notices : [];
  if (list.some((n) => n.key === key)) return { first: false, notices: list };
  return { first: true, notices: [...list, { key, at: now.toISOString() }].slice(-500) };
}

/** A successful run clears its own notices and its agent's. */
function clearNotices(notices, { taskId, agentId }) {
  const list = Array.isArray(notices) ? notices : [];
  return list.filter((n) => !n.key.startsWith(`${taskId}:`) && !(agentId && n.key.startsWith(`${agentId}:`)));
}

const BACKOFF_FIRST_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 4 * 60 * 60_000;

/** The same fraction for every failure of one job, so jobs that fail together don't all come back together. */
function jitter(seed) {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return 0.8 + (hash % 1000) / 2500;
}

/**
 * The earliest a recurring job may run again after `failures` failed runs in a row: 15 minutes doubled for each
 * further failure, at most 4 hours, give or take a fifth. A daily job's own next run is later than this anyway.
 */
function backoffUntil(failures, seed, now = Date.now()) {
  if (!failures) return now;
  return now + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1)) * jitter(seed);
}

// Lines OmnishPilot writes into a log itself, before the job's own output starts.
const LOG_NOISE = /^(===|workspace:|output:|prompt:|NOTE:|WARN:|sandbox|cwd:|shell:|command:|agent-run:|\(no agent)/;

/** The last line the job itself wrote, which is usually the error. Empty when it wrote nothing. */
function lastWords(logTail = '', max = 160) {
  const lines = logTail.split('\n').map((l) => l.trim()).filter((l) => l && !LOG_NOISE.test(l));
  const line = lines.pop() || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "today 14:30", "tomorrow 09:00", or "Fri 31 Oct 09:00", in local time. */
function whenText(iso, now = new Date()) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

module.exports = {
  classifyFailure, failureSignature, retryNote, takeNotice, clearNotices, backoffUntil, lastWords, whenText, LOG_NOISE,
};
