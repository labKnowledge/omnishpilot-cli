'use strict';

const store = require('./store');
const omnish = require('./omnish');
const registry = require('./connectors/registry');
const procUtils = require('./proc-utils');
const hang = require('./hang');
const recovery = require('./recovery');
const worker = require('./worker');
const { loadConfig } = require('./config');

async function checkRunningTasks() {
  for (const task of store.runningTasks()) {
    if (worker.isInFlight(task.id)) continue;
    const pid = task.execution?.pid;
    let alive = false;
    if (pid) try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
    if (!alive) {
      await worker.failTask(task.id, task, 'Process stopped while OmnishPilot was not watching it', store.getSettings(), { cause: 'restart' });
    }
  }
}

function lastMeaningfulLogLine(logPath) {
  return recovery.lastWords(store.tailLog(logPath, 40));
}

function refreshLogActivity(task) {
  const logPath = store.taskLogPath(task.id);
  const act = hang.logActivity(logPath);
  const ex = task.execution || {};
  const prevBytes = ex.lastLogBytes || 0;
  if (act.size !== prevBytes) {
    store.updateTask(task.id, {
      execution: {
        ...ex,
        lastLogBytes: act.size,
        lastLogAt: new Date().toISOString(),
      },
    });
    return store.getTask(task.id);
  }
  return task;
}

/**
 * Kill jobs that are hung on approval/TTY or past hard timeout.
 * Marks execution so worker.waitChild resolves with code -2.
 */
async function checkHangsAndTimeouts() {
  const cfg = loadConfig();
  for (let task of store.runningTasks()) {
    if (!task.execution?.pid) continue;
    task = refreshLogActivity(task);
    const logTail = store.tailLog(store.taskLogPath(task.id), 80);
    const health = hang.evaluateRunHealth(task, { cfg, logTail });
    if (health.action === 'ok') continue;

    const flag = health.action === 'timeout' ? 'killedForTimeout' : 'killedForHang';
    const reason = health.matched
      ? `${health.reason} (saw: "${health.matched}")`
      : health.reason;

    // Kill only — worker.waitChild / executeTask owns requeue + attempt accounting.
    store.updateTask(task.id, {
      execution: {
        ...store.getTask(task.id).execution,
        [flag]: true,
        killCause: health.action,
        error: reason,
      },
    });
    procUtils.killProcessGroup(task.execution.pid);
    await omnish.supervisorAlert(task, reason);
  }
}

async function checkProgressHeartbeats() {
  const cfg = loadConfig();
  if (!cfg.omnish?.enabled) return;
  const intervalMin = cfg.worker?.heartbeatIntervalMinutes ?? 10;
  if (!intervalMin) return;

  const now = Date.now();
  for (const task of store.runningTasks()) {
    const ex = task.execution;
    if (!ex?.pid || !ex?.startedAt) continue;
    const startedAt = new Date(ex.startedAt).getTime();
    const lastBeat = ex.lastHeartbeatAt ? new Date(ex.lastHeartbeatAt).getTime() : startedAt;
    if (now - lastBeat < intervalMin * 60000) continue;

    const elapsedMin = Math.round((now - startedAt) / 60000);
    const lastLine = lastMeaningfulLogLine(store.taskLogPath(task.id));
    await omnish.progressHeartbeat(task, elapsedMin, lastLine);
    store.updateTask(task.id, { execution: { ...ex, lastHeartbeatAt: new Date().toISOString() } });
  }
}

async function checkFailedCampaignDays() {
  const cfg = loadConfig();
  for (const ws of cfg.workspaces || []) {
    if (!ws.enabled) continue;
    const def = registry.get(ws.connector);
    if (!def.getFailedDays) continue;
    for (const { day, reason } of def.getFailedDays({ ws })) {
      const tasks = store.listTasks({ workspaceId: ws.id });
      const task = tasks.find((t) => String(registry.resolveDay(t)) === String(day));
      if (task && task.status === 'scheduled') {
        await omnish.supervisorAlert(task, `Campaign day ${day} failed earlier: ${reason || 'unknown'}. Ready to retry from board.`);
      }
    }
  }
}

function startSupervisor() {
  const cfg = loadConfig();
  const settings = store.getSettings();
  if (!settings.supervisorEnabled) return null;

  const ms = cfg.worker?.supervisorIntervalMs || 300000;
  const hangMs = cfg.worker?.hangCheckIntervalMs || 30000;

  const run = async () => {
    try {
      await checkRunningTasks();
      await checkProgressHeartbeats();
      await checkFailedCampaignDays();
    } catch (e) {
      console.error('[supervisor]', e.message);
    }
  };
  const runHang = async () => {
    try {
      await checkHangsAndTimeouts();
    } catch (e) {
      console.error('[supervisor:hang]', e.message);
    }
  };

  run();
  runHang();
  const a = setInterval(run, ms);
  const b = setInterval(runHang, hangMs);
  return { close() { clearInterval(a); clearInterval(b); } };
}

module.exports = {
  startSupervisor,
  checkRunningTasks,
  checkHangsAndTimeouts,
};
