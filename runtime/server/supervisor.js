const store = require('./store');
const worker = require('./worker');
const omnish = require('./omnish');
const registry = require('./connectors/registry');
const { loadConfig } = require('./config');

async function checkRunningTasks() {
  const running = store.runningTasks();
  for (const task of running) {
    const ex = task.execution;
    if (!ex?.pid) continue;
    try {
      process.kill(ex.pid, 0);
    } catch {
      store.updateTask(task.id, {
        status: 'scheduled',
        execution: { ...ex, pid: null, error: 'Process died unexpectedly — supervisor will retry' },
      });
      await omnish.supervisorAlert(task, 'Task process stopped. Re-queued for retry.');
    }
  }
}

const LOG_NOISE = /^(===|workspace:|output:|prompt:|NOTE:|WARN:)/;

function lastMeaningfulLogLine(logPath) {
  const tail = store.tailLog(logPath, 40);
  const lines = tail.split('\n').map(l => l.trim()).filter(l => l && !LOG_NOISE.test(l));
  return lines.pop() || '';
}

// Guaranteed heartbeat for long-running jobs, independent of whether the agent itself sends
// progress updates (see progressUpdatesBlock in connectors/agent.js) — the user should never
// be left wondering if a job is still alive just because the agent didn't self-report.
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
      const task = tasks.find(t => String(registry.resolveDay(t)) === String(day));
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
  const run = async () => {
    try {
      await checkRunningTasks();
      await checkProgressHeartbeats();
      await checkFailedCampaignDays();
    } catch (e) {
      console.error('[supervisor]', e.message);
    }
  };
  run();
  return setInterval(run, ms);
}

module.exports = { startSupervisor, checkRunningTasks };
