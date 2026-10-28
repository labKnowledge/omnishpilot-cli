'use strict';

const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('./bootstrap');
const client = require('./client');
const daemon = require('./daemon');
const { shortId } = require('./util');

function loadStore() {
  return require(path.join(APP_ROOT, 'server', 'store'));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fingerprintDashboard(data) {
  const s = data?.stats || {};
  const running = (data?.running || []).map((t) => t.id).sort().join(',');
  const failed = (data?.failed || []).map((t) => t.id).sort().join(',');
  return [
    s.total, s.running, s.scheduled, s.failed, s.drafts,
    running, failed,
  ].join('|');
}

async function watchDashboard({ intervalMs = 2000, json = false, signal } = {}) {
  await client.ensureApi();
  let last = '';
  process.stderr.write(`[watch] dashboard every ${intervalMs}ms — Ctrl+C to stop\n`);

  while (!signal?.aborted) {
    try {
      const r = await client.get('/api/dashboard');
      if (!r.ok) {
        process.stderr.write(`[watch] api ${r.status}\n`);
      } else {
        const fp = fingerprintDashboard(r.data);
        if (fp !== last) {
          last = fp;
          if (json) {
            console.log(JSON.stringify({ ts: new Date().toISOString(), ...r.data.stats, running: r.data.running }));
          } else {
            const s = r.data.stats || {};
            const ts = new Date().toISOString().slice(11, 19);
            console.log(
              `${ts}  total ${s.total || 0}  running ${s.running || 0}  scheduled ${s.scheduled || 0}  failed ${s.failed || 0}`
            );
            for (const t of r.data.running || []) {
              console.log(`         ▶ ${shortId(t.id)}  ${t.title}`);
            }
          }
        }
      }
    } catch (e) {
      process.stderr.write(`[watch] ${e.message}\n`);
    }
    await sleep(intervalMs);
  }
}

async function watchTaskLog(taskId, { intervalMs = 1000, lines = 40, signal } = {}) {
  await client.ensureApi();
  let seen = '';
  process.stderr.write(`[watch] task ${shortId(taskId)} log — Ctrl+C to stop\n`);

  while (!signal?.aborted) {
    try {
      const r = await client.get(`/api/tasks/${taskId}/log`, { query: { lines: 500 } });
      const text = typeof r.data === 'string' ? r.data : (r.data?.log || '');
      if (text && text !== seen) {
        const next = text.startsWith(seen) ? text.slice(seen.length) : text;
        if (next.trim()) process.stdout.write(next.endsWith('\n') ? next : `${next}\n`);
        seen = text;
      }
    } catch (e) {
      process.stderr.write(`[watch] ${e.message}\n`);
    }
    await sleep(intervalMs);
  }
}

async function watchDaemonLog({ signal } = {}) {
  const cfg = require(path.join(APP_ROOT, 'server', 'config')).loadConfig();
  const file = daemon.logPath(cfg);
  process.stderr.write(`[watch] daemon log ${file} — Ctrl+C to stop\n`);

  let pos = 0;
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    pos = Math.max(0, st.size - 4096);
  }

  const dump = () => {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size < pos) pos = 0;
    if (st.size === pos) return;
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - pos;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos = st.size;
      process.stdout.write(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  };

  dump();

  if (typeof fs.watch === 'function') {
    try {
      const watcher = fs.watch(file, () => dump());
      signal?.addEventListener?.('abort', () => watcher.close());
    } catch {
      /* fall through to poll */
    }
  }

  while (!signal?.aborted) {
    dump();
    await sleep(500);
  }
}

async function watchMain({ taskId, daemonLog, intervalMs, json, signal }) {
  if (daemonLog) return watchDaemonLog({ signal });
  if (taskId) return watchTaskLog(taskId, { intervalMs, signal });
  return watchDashboard({ intervalMs, json, signal });
}

/**
 * Follow one job until it reaches a terminal status (or timeout).
 * Streams new log lines; exits process with 0 on completed, 1 on failed/timeout.
 */
async function followTask(taskId, {
  intervalMs = 2000,
  timeoutSec = 0,
  json = false,
  streamLog = true,
  signal,
} = {}) {
  await client.ensureApi();
  const store = loadStore();
  const started = Date.now();
  let seenLog = '';
  let lastStatus = '';

  const terminal = new Set(['completed', 'failed', 'paused']);

  while (!signal?.aborted) {
    if (timeoutSec > 0 && (Date.now() - started) / 1000 > timeoutSec) {
      if (json) console.log(JSON.stringify({ ok: false, error: 'timeout', taskId, status: lastStatus }));
      else process.stderr.write(`[follow] timeout after ${timeoutSec}s (status=${lastStatus || '?'})\n`);
      process.exitCode = 1;
      return { ok: false, reason: 'timeout', status: lastStatus };
    }

    let task = null;
    try {
      const r = await client.get(`/api/tasks/${taskId}`);
      task = r.ok ? (r.data.task || r.data) : null;
    } catch {
      task = store.getTask(taskId);
    }
    if (!task) {
      process.stderr.write(`[follow] task not found: ${taskId}\n`);
      process.exitCode = 1;
      return { ok: false, reason: 'not_found' };
    }

    if (task.status !== lastStatus) {
      lastStatus = task.status;
      const line = {
        ts: new Date().toISOString(),
        id: task.id,
        status: task.status,
        title: task.title,
        error: task.execution?.error || null,
        acceptance: task.execution?.acceptance?.report || null,
      };
      if (json) console.log(JSON.stringify(line));
      else {
        const err = task.execution?.error ? ` — ${task.execution.error}` : '';
        console.log(`[follow] ${shortId(task.id)}  ${task.status}${err}`);
      }
    }

    if (streamLog && !json) {
      try {
        const r = await client.get(`/api/tasks/${taskId}/log`, { query: { lines: 200 } });
        const text = typeof r.data === 'string' ? r.data : (r.data?.log || '');
        if (text && text !== seenLog) {
          const next = text.startsWith(seenLog) ? text.slice(seenLog.length) : text;
          if (next.trim()) process.stdout.write(next.endsWith('\n') ? next : `${next}\n`);
          seenLog = text;
        }
      } catch { /* ignore */ }
    }

    if (terminal.has(task.status)) {
      const okDone = task.status === 'completed';
      process.exitCode = okDone ? 0 : 1;
      if (json) {
        console.log(JSON.stringify({
          ok: okDone,
          done: true,
          status: task.status,
          taskId: task.id,
          acceptance: task.execution?.acceptance || null,
          error: task.execution?.error || null,
        }));
      } else {
        console.log(`[follow] done — ${task.status}`);
      }
      return { ok: okDone, status: task.status, task };
    }

    await sleep(intervalMs);
  }
  return { ok: false, reason: 'aborted' };
}

module.exports = {
  watchMain,
  watchDashboard,
  watchTaskLog,
  watchDaemonLog,
  followTask,
  loadStore,
};
