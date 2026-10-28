const store = require('./store');
const omnish = require('./omnish');
const delivery = require('./delivery');
const registry = require('./connectors/registry');
const procUtils = require('./proc-utils');
const templates = require('./templates');
const scheduler = require('./scheduler');
const agents = require('./agents');
const { loadConfig } = require('./config');

function workspaceById(id) {
  return loadConfig().workspaces?.find(w => w.id === id) || null;
}

async function finishJob(taskId, settings) {
  const task = store.getTask(taskId);
  if (settings.deliveryOnComplete) {
    await delivery.deliverTaskResult(task, settings);
  } else if (settings.notifyOnComplete) {
    await omnish.taskCompleted(task);
  }
}

async function executeTask(task) {
  const ws = workspaceById(task.workspaceId);
  const logPath = store.taskLogPath(task.id);
  const settings = store.getSettings();

  store.updateTask(task.id, {
    status: 'running',
    execution: {
      ...task.execution,
      attempts: task.execution.attempts + 1,
      startedAt: new Date().toISOString(),
      logPath,
      error: null,
    },
  });

  if (settings.notifyOnStart) await omnish.taskStarted(task);

  const template = templates.getTemplate(task.templateId);
  const connector = task.execution?.connector || template?.connector;
  const def = registry.get(connector);
  if (!def.run) throw new Error(`Unknown connector: ${connector}`);

  const runner = await def.run({ ws, task, logPath, agentId: ws?.meta?.agentId });
  if (runner.spawnError) {
    runner.logStream?.end?.();
    const updated = store.getTask(task.id);
    await failTask(task.id, updated, runner.spawnError, settings);
    return store.getTask(task.id);
  }

  store.updateTask(task.id, { execution: { ...store.getTask(task.id).execution, pid: runner.child?.pid || null } });

  if (!runner.child) {
    const updated = store.getTask(task.id);
    await failTask(task.id, updated, 'Failed to start agent process', settings);
    return store.getTask(task.id);
  }

  const code = await waitChild(runner.child, runner.logStream);
  const updated = store.getTask(task.id);

  if (code === 0) {
    const day = registry.resolveDay(task);
    const artifacts = def.collectResultFiles ? def.collectResultFiles({ ws, task, day, outDir: runner.outDir }) : [];
    const schedule = updated.schedule || task.schedule;
    if (scheduler.isRecurring(schedule?.type)) {
      const runCount = (updated.execution.runCount || 0) + 1;
      const nextRunAt = scheduler.computeNextRun(schedule, new Date());
      store.updateTask(task.id, {
        status: 'scheduled',
        completedAt: null,
        schedule: { ...schedule, type: scheduler.normalizeType(schedule.type), runAt: nextRunAt },
        execution: {
          ...updated.execution,
          pid: null,
          finishedAt: new Date().toISOString(),
          lastFinishedAt: new Date().toISOString(),
          runCount,
          attempts: 0,
          artifacts,
          error: null,
        },
      });
      if (settings.notifyOnComplete || settings.deliveryOnComplete) {
        await finishJob(task.id, settings);
      }
      return store.getTask(task.id);
    }
    store.updateTask(task.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      execution: { ...updated.execution, pid: null, finishedAt: new Date().toISOString(), artifacts, error: null },
    });
    if (settings.notifyOnComplete || settings.deliveryOnComplete) {
      await finishJob(task.id, settings);
    }
    return store.getTask(task.id);
  }

  const err = code === -1
    ? 'Agent process failed to start (check workspace path exists and agent-run is installed)'
    : `Process exited with code ${code}`;

  const failedAgentId = updated.execution?.resolvedAgentId;
  if (failedAgentId) {
    const logTail = store.tailLog(logPath, 200);
    if (agents.isLimitHit(logTail)) {
      agents.markCooldown(failedAgentId);
      const nextAgentId = agents.pickAgent({ exclude: [failedAgentId] });
      if (nextAgentId) {
        await omnish.agentLimitSwitch(updated, failedAgentId, nextAgentId);
        store.updateTask(task.id, {
          status: 'scheduled',
          inputs: { agentId: nextAgentId },
          schedule: { ...(updated.schedule || task.schedule), runAt: new Date(Date.now() + 5000).toISOString() },
          execution: { ...updated.execution, pid: null, resolvedAgentId: null, error: `${err} — agent "${failedAgentId}" hit its usage limit, switching to "${nextAgentId}"` },
        });
        return store.getTask(task.id);
      }
      const cfg = loadConfig();
      await omnish.agentsAllLimited(updated, cfg.agent?.preferredOrder || agents.DEFAULT_PREFERRED_ORDER);
    }
  }

  await failTask(task.id, updated, err, settings);
  return store.getTask(task.id);
}

async function failTask(taskId, updated, err, settings) {
  const cfg = loadConfig();
  const backoffSec = cfg.worker?.retryBackoffSec || 120;
  if (updated.execution.attempts < updated.execution.maxAttempts) {
    const task = store.getTask(taskId);
    store.updateTask(taskId, {
      status: 'scheduled',
      schedule: {
        ...task.schedule,
        runAt: new Date(Date.now() + backoffSec * 1000).toISOString(),
      },
      execution: { ...updated.execution, pid: null, error: err },
    });
  } else {
    store.updateTask(taskId, {
      status: 'failed',
      execution: { ...updated.execution, pid: null, finishedAt: new Date().toISOString(), error: err },
    });
    if (settings.notifyOnFail) await omnish.taskFailed(store.getTask(taskId), err);
  }
}

function waitChild(child, logStream) {
  return new Promise(resolve => {
    child.on('close', code => { logStream.end(); resolve(code ?? 1); });
    child.on('error', () => { logStream.end(); resolve(-1); });
  });
}

// Only checks whether THIS task's own workspace has a live external (cron-driven) run in
// progress — prevents double-triggering the same campaign day, without serializing unrelated
// workspaces. The global concurrency cap is enforced separately via settings.maxConcurrent.
async function isSystemBusy(task) {
  const settings = store.getSettings();
  if (!settings.blockedWhenBusy) return false;
  const ws = workspaceById(task.workspaceId);
  const def = registry.get(ws?.connector);
  if (!def.getLiveRun) return false;
  const live = def.getLiveRun({ ws });
  if (live?.pid) {
    try {
      process.kill(live.pid, 0);
      return true;
    } catch { /* stale */ }
  }
  return false;
}

function isTaskPaused(task) {
  const ws = workspaceById(task.workspaceId);
  const def = registry.get(ws?.connector);
  if (!def.isPaused) return false;
  // Ad-hoc jobs parked in a connector's workspace but not part of its day pipeline (no day
  // resolved) aren't subject to that pipeline's pause state — otherwise a campaign-wide pause
  // would block them forever (silently, with no status change).
  const day = registry.resolveDay(task);
  if (day == null) return false;
  return def.isPaused({ ws, day });
}

async function tick() {
  const settings = store.getSettings();
  if (store.runningTasks().length >= settings.maxConcurrent) return;

  const due = store.listTasks().filter(t => {
    if (t.status !== 'scheduled') return false;
    if (t.muted) return false;
    if (!scheduler.isDue(t.schedule)) return false;
    return !isTaskPaused(t);
  });

  if (!due.length) return;

  due.sort((a, b) => (b.schedule?.priority || 50) - (a.schedule?.priority || 50));

  let candidate = null;
  for (const t of due) {
    if (!(await isSystemBusy(t))) { candidate = t; break; }
  }
  if (!candidate) return;

  try {
    await executeTask(candidate);
  } catch (e) {
    const t = store.getTask(candidate.id);
    store.updateTask(candidate.id, {
      status: 'failed',
      execution: { ...t.execution, error: e.message, finishedAt: new Date().toISOString() },
    });
    await omnish.taskFailed(t, e.message);
  }
}

function startWorker() {
  const cfg = loadConfig();
  const ms = cfg.worker?.pollIntervalMs || 5000;
  tick().catch(console.error);
  return setInterval(() => tick().catch(console.error), ms);
}

async function stopTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const ws = workspaceById(task.workspaceId);
  const def = registry.get(ws?.connector);
  const day = registry.resolveDay(task);

  if (task.status === 'running' && task.execution?.pid) {
    procUtils.killProcessGroup(task.execution.pid);
  }
  if (def.pauseDay && day != null) {
    def.pauseDay({ ws, day });
  }
  store.updateTask(taskId, {
    status: 'paused',
    execution: { ...store.getTask(taskId).execution, pid: null, error: 'Stopped by user' },
  });
  return store.getTask(taskId);
}

async function resumeTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const ws = workspaceById(task.workspaceId);
  const def = registry.get(ws?.connector);
  const day = registry.resolveDay(task);

  if (def.resumeDay && day != null) {
    def.resumeDay({ ws, day });
  }
  store.updateTask(taskId, {
    status: 'scheduled',
    schedule: { ...task.schedule, type: 'now', priority: 95 },
    execution: { ...task.execution, attempts: 0, error: null, finishedAt: null },
  });
  return store.getTask(taskId);
}

async function pauseWorkspace(wsId) {
  const ws = loadConfig().workspaces?.find(w => w.id === wsId);
  if (!ws) return null;
  const def = registry.get(ws.connector);
  if (def.pauseAll) def.pauseAll({ ws });

  for (const t of store.listTasks({ workspaceId: wsId })) {
    if (['completed', 'draft', 'paused'].includes(t.status)) continue;
    if (t.status === 'running' && t.execution?.pid) procUtils.killProcessGroup(t.execution.pid);
    store.updateTask(t.id, {
      status: 'paused',
      execution: { ...t.execution, pid: null, error: 'Campaign paused by user' },
    });
  }
  return { workspaceId: wsId, paused: true };
}

async function resumeWorkspace(wsId) {
  const ws = loadConfig().workspaces?.find(w => w.id === wsId);
  if (!ws) return null;
  const def = registry.get(ws.connector);
  if (def.resumeAll) def.resumeAll({ ws });

  const st = def.readState ? def.readState({ ws }) : null;
  const pausedDays = new Set((st?.paused_days || []).map(String));

  for (const t of store.listTasks({ workspaceId: wsId })) {
    if (t.status !== 'paused') continue;
    const day = registry.resolveDay(t);
    if (day != null && pausedDays.has(String(day))) continue;
    store.updateTask(t.id, { status: 'scheduled', execution: { ...t.execution, error: null } });
  }
  return { workspaceId: wsId, paused: false };
}

module.exports = { executeTask, tick, startWorker, isSystemBusy, stopTask, resumeTask, pauseWorkspace, resumeWorkspace };
