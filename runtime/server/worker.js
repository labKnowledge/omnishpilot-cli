'use strict';

const path = require('path');
const store = require('./store');
const omnish = require('./omnish');
const delivery = require('./delivery');
const registry = require('./connectors/registry');
const procUtils = require('./proc-utils');
const templates = require('./templates');
const scheduler = require('./scheduler');
const agents = require('./agents');
const acceptance = require('./acceptance');
const verifier = require('./verifier');
const worktree = require('./worktree');
const hang = require('./hang');
const ids = require('./connectors/ids');
const { loadConfig } = require('./config');

function workspaceById(id) {
  return loadConfig().workspaces?.find((w) => w.id === id) || null;
}

async function finishJob(taskId, settings, packExtra = {}) {
  const task = store.getTask(taskId);
  // Prefer the morning decision pack whenever completion notify/delivery is on.
  if (settings.deliveryOnComplete || settings.notifyOnComplete || settings.morningPack) {
    await delivery.deliverTaskResult(task, {
      ...settings,
      deliveryOnComplete: true,
      deliveryMode: settings.deliveryMode || 'pack',
      morningPack: settings.morningPack !== false,
    }, packExtra);
  }
}

function applyLimitFailover(task, updated, err, logPath) {
  const failedAgentId = updated.execution?.resolvedAgentId;
  if (!failedAgentId) return null;

  const logTail = store.tailLog(logPath, 400);
  if (!agents.isLimitHit(logTail) && !agents.isLimitHit(err)) return null;

  const parsed = agents.parseLimitReset(logTail);
  agents.markCooldown(failedAgentId, parsed.cooldownMinutes, {
    reason: 'rate_limit',
    resetAt: parsed.resetAt,
  });

  const nextAgentId = agents.pickAgent({ exclude: [failedAgentId] });
  if (nextAgentId) {
    return {
      status: 'scheduled',
      inputs: { ...(updated.inputs || task.inputs || {}), agentId: nextAgentId },
      schedule: {
        ...(updated.schedule || task.schedule),
        type: 'now',
        runAt: new Date(Date.now() + 5000).toISOString(),
      },
      execution: {
        ...updated.execution,
        pid: null,
        resolvedAgentId: null,
        limitFailover: {
          from: failedAgentId,
          to: nextAgentId,
          resetAt: parsed.resetAt,
          at: new Date().toISOString(),
        },
        error: `${err} — agent "${failedAgentId}" hit its usage limit, switching to "${nextAgentId}"`,
      },
      _notify: { type: 'switch', from: failedAgentId, to: nextAgentId },
    };
  }

  // All agents limited — resume at earliest reset instead of burning retries.
  const cfg = loadConfig();
  const order = cfg.agent?.preferredOrder || agents.DEFAULT_PREFERRED_ORDER;
  const earliest = agents.earliestCooldownEnd(order) || (Date.now() + parsed.cooldownMinutes * 60000);
  const resumeAt = new Date(Math.max(earliest, Date.now() + 60000) + 15000).toISOString();
  return {
    status: 'scheduled',
    schedule: {
      ...(updated.schedule || task.schedule),
      type: 'once',
      runAt: resumeAt,
      priority: Math.max(updated.schedule?.priority || 50, 80),
    },
    execution: {
      ...updated.execution,
      pid: null,
      resumeAtReset: {
        resumeAt,
        failedAgentId,
        resetAt: parsed.resetAt,
        at: new Date().toISOString(),
      },
      // Don't burn attempts on quota walls
      attempts: Math.max(0, (updated.execution.attempts || 1) - 1),
      error: `${err} — all agents rate-limited; resume scheduled at ${resumeAt}`,
    },
    _notify: { type: 'all_limited', order, resumeAt },
  };
}

async function completeSuccessfully(task, updated, {
  artifacts,
  acceptanceResult,
  verifierResult,
  worktreeMeta,
  settings,
  outDir,
}) {
  const schedule = updated.schedule || task.schedule;
  const packExtra = {
    acceptanceResult,
    verifierResult,
    worktreeMeta,
    diffStat: worktree.diffStat(worktreeMeta),
    changedFiles: worktree.diffNameOnly(worktreeMeta),
  };

  const executionPatch = {
    ...updated.execution,
    pid: null,
    finishedAt: new Date().toISOString(),
    artifacts,
    error: null,
    acceptance: acceptanceResult
      ? {
          ok: acceptanceResult.ok,
          softPass: acceptanceResult.softPass || false,
          failures: acceptanceResult.failures || [],
          report: acceptance.formatAcceptanceReport(acceptanceResult),
        }
      : null,
    verifier: verifierResult && !verifierResult.skipped
      ? { ok: verifierResult.ok, verdict: verifierResult.verdict, detail: verifierResult.detail, agentId: verifierResult.agentId }
      : null,
    worktree: worktreeMeta?.worktree
      ? { path: worktreeMeta.path, branch: worktreeMeta.branch || null }
      : null,
    outDir: outDir || updated.execution?.outDir || null,
  };

  if (scheduler.isRecurring(schedule?.type)) {
    const runCount = (updated.execution.runCount || 0) + 1;
    const nextRunAt = scheduler.computeNextRun(schedule, new Date());
    store.updateTask(task.id, {
      status: 'scheduled',
      completedAt: null,
      schedule: { ...schedule, type: scheduler.normalizeType(schedule.type), runAt: nextRunAt },
      execution: { ...executionPatch, lastFinishedAt: executionPatch.finishedAt, runCount, attempts: 0 },
    });
  } else {
    store.updateTask(task.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      execution: executionPatch,
    });
  }

  worktree.cleanupWorktree(worktreeMeta, { success: true });

  if (settings.notifyOnComplete || settings.deliveryOnComplete || settings.morningPack !== false) {
    await finishJob(task.id, settings, packExtra);
  }
  return store.getTask(task.id);
}

async function executeTask(task) {
  const ws = workspaceById(task.workspaceId);
  const logPath = store.taskLogPath(task.id);
  const settings = store.getSettings();
  const cfg = loadConfig();

  const act = hang.logActivity(logPath);
  store.updateTask(task.id, {
    status: 'running',
    execution: {
      ...task.execution,
      attempts: (task.execution.attempts || 0) + 1,
      startedAt: new Date().toISOString(),
      logPath,
      error: null,
      lastLogAt: new Date().toISOString(),
      lastLogBytes: act.size,
    },
  });

  if (settings.notifyOnStart) await omnish.taskStarted(task);

  const template = templates.getTemplate(task.templateId);
  const connector = task.execution?.connector || template?.connector;
  const def = registry.get(connector);
  if (!def.run) throw new Error(`Unknown connector: ${connector}`);

  // Worktree isolation for generic-agent jobs with a git workspace
  let worktreeMeta = { path: null, worktree: false };
  let runTask = task;
  if (connector === ids.GENERIC_AGENT) {
    const workspacePath = (task.inputs?.workspace || '').trim()
      || cfg.agent?.defaultWorkspace
      || '';
    if (workspacePath) {
      worktreeMeta = worktree.prepareWorktree({ workspacePath, taskId: task.id, cfg });
      if (worktreeMeta.worktree) {
        runTask = {
          ...task,
          inputs: { ...task.inputs, workspace: worktreeMeta.path, _hostWorkspace: workspacePath },
        };
        store.updateTask(task.id, {
          execution: {
            ...store.getTask(task.id).execution,
            worktree: { path: worktreeMeta.path, branch: worktreeMeta.branch, basePath: worktreeMeta.basePath },
          },
        });
      } else if (worktreeMeta.error) {
        store.updateTask(task.id, {
          execution: {
            ...store.getTask(task.id).execution,
            worktree: { skipped: true, reason: worktreeMeta.reason, error: worktreeMeta.error },
          },
        });
      }
    }
  }

  const runner = await def.run({ ws, task: runTask, logPath, agentId: ws?.meta?.agentId });
  if (runner.spawnError) {
    runner.logStream?.end?.();
    const updated = store.getTask(task.id);
    await failTask(task.id, updated, runner.spawnError, settings);
    worktree.cleanupWorktree(worktreeMeta, { success: false });
    return store.getTask(task.id);
  }

  store.updateTask(task.id, {
    execution: {
      ...store.getTask(task.id).execution,
      pid: runner.child?.pid || null,
      outDir: runner.outDir || null,
    },
  });

  if (!runner.child) {
    const updated = store.getTask(task.id);
    await failTask(task.id, updated, 'Failed to start agent process', settings);
    worktree.cleanupWorktree(worktreeMeta, { success: false });
    return store.getTask(task.id);
  }

  const code = await waitChild(runner.child, runner.logStream, task.id);
  const updated = store.getTask(task.id);
  const outDir = runner.outDir || path.join(cfg.dataDir, 'outputs', task.id);
  const workspacePath = runTask.inputs?.workspace || worktreeMeta.path || '';

  if (code === 0) {
    // Acceptance gates — done ≠ model stopped talking
    const acceptanceResult = acceptance.checkAcceptance({
      task: runTask,
      outDir,
      workspacePath,
      cfg,
    });

    if (!acceptanceResult.ok && !acceptanceResult.skipped) {
      const report = acceptance.formatAcceptanceReport(acceptanceResult);
      store.updateTask(task.id, {
        execution: {
          ...updated.execution,
          pid: null,
          acceptance: { ok: false, failures: acceptanceResult.failures, report },
        },
      });
      // Retry until green (uses attempts / maxAttempts)
      await failTask(task.id, store.getTask(task.id), `Acceptance gate failed: ${report}`, settings);
      worktree.cleanupWorktree(worktreeMeta, { success: false });
      return store.getTask(task.id);
    }

    let verifierResult = { skipped: true, ok: true };
    const profile = acceptanceResult.profile || acceptance.resolveAcceptance(runTask, cfg);
    if (profile.verifier) {
      verifierResult = verifier.runVerifier({
        task: runTask,
        outDir,
        workspacePath,
        logPath,
        cfg,
      });
      if (!verifierResult.ok && !verifierResult.skipped) {
        await failTask(
          task.id,
          store.getTask(task.id),
          `Verifier ${verifierResult.verdict}: ${verifierResult.detail}`,
          settings,
        );
        worktree.cleanupWorktree(worktreeMeta, { success: false });
        return store.getTask(task.id);
      }
    }

    const day = registry.resolveDay(task);
    const artifacts = def.collectResultFiles
      ? def.collectResultFiles({ ws, task, day, outDir: runner.outDir })
      : [];

    return completeSuccessfully(task, store.getTask(task.id), {
      artifacts,
      acceptanceResult,
      verifierResult,
      worktreeMeta,
      settings,
      outDir,
    });
  }

  // Hang/timeout kill: prefer the supervisor's reason over a raw exit code.
  if (updated.execution?.killedForHang || updated.execution?.killedForTimeout) {
    const hangErr = updated.execution.error || 'Job stopped by hang/timeout supervisor';
    await failTask(task.id, updated, hangErr, settings);
    worktree.cleanupWorktree(worktreeMeta, { success: false });
    return store.getTask(task.id);
  }

  const err = code === -1
    ? 'Agent process failed to start (check workspace path exists and agent-run is installed)'
    : `Process exited with code ${code}`;

  const failover = applyLimitFailover(task, updated, err, logPath);
  if (failover) {
    const notify = failover._notify;
    delete failover._notify;
    store.updateTask(task.id, failover);
    if (notify?.type === 'switch') {
      await omnish.agentLimitSwitch(updated, notify.from, notify.to);
    } else if (notify?.type === 'all_limited') {
      await omnish.agentsAllLimited(updated, notify.order, notify.resumeAt);
    }
    worktree.cleanupWorktree(worktreeMeta, { success: false });
    return store.getTask(task.id);
  }

  await failTask(task.id, updated, err, settings);
  worktree.cleanupWorktree(worktreeMeta, { success: false });
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

function waitChild(child, logStream, taskId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      try { logStream?.end?.(); } catch { /* ignore */ }
      resolve(code ?? 1);
    };
    child.on('close', (code) => done(code ?? 1));
    child.on('error', () => done(-1));

    // If supervisor marks the task failed/killed for hang, surface a distinct code.
    const poll = setInterval(() => {
      const t = store.getTask(taskId);
      if (!t || t.status !== 'running') {
        clearInterval(poll);
        if (t?.execution?.killedForHang || t?.execution?.killedForTimeout) {
          try { child.kill?.('SIGTERM'); } catch { /* ignore */ }
          done(-2);
        }
      }
    }, 2000);
    child.on('close', () => clearInterval(poll));
  });
}

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
  const day = registry.resolveDay(task);
  if (day == null) return false;
  return def.isPaused({ ws, day });
}

async function tick() {
  const settings = store.getSettings();
  if (store.runningTasks().length >= settings.maxConcurrent) return;

  const due = store.listTasks().filter((t) => {
    if (t.status !== 'scheduled') return false;
    if (t.muted) return false;
    if (!scheduler.isDue(t.schedule)) return false;
    return !isTaskPaused(t);
  });

  if (!due.length) return;

  due.sort((a, b) => (b.schedule?.priority || 50) - (a.schedule?.priority || 50));

  let candidate = null;
  for (const t of due) {
    if (!(await isSystemBusy(t))) {
      candidate = t;
      break;
    }
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
  const ws = loadConfig().workspaces?.find((w) => w.id === wsId);
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
  const ws = loadConfig().workspaces?.find((w) => w.id === wsId);
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

module.exports = {
  executeTask,
  tick,
  startWorker,
  isSystemBusy,
  stopTask,
  resumeTask,
  pauseWorkspace,
  resumeWorkspace,
};
