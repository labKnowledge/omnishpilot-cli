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
const ledger = require('./ledger');
const recovery = require('./recovery');
const budget = require('./budget');
const { loadConfig } = require('./config');

const NOTICES_FILE = 'notices.json';
const BUDGET_ALERTS_FILE = 'budget-alerts.json';
/** Tasks this process is executing right now; the supervisor leaves them to their own waitChild. */
const inFlight = new Set();

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
        retryOf: { cause: 'exit', error: `agent "${failedAgentId}" hit its usage limit` },
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
      retryOf: { cause: 'exit', error: `agent "${failedAgentId}" hit its usage limit` },
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
    retryOf: null,
    lastFailure: null,
    failuresInRow: 0,
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
    ledger.record('job_completed', {
      taskId: task.id,
      templateId: task.templateId,
      workspaceId: task.workspaceId,
      agentId: task.inputs?.agentId || null,
    });
  } else {
    store.updateTask(task.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      execution: executionPatch,
    });
  }

  worktree.cleanupWorktree(worktreeMeta, { success: true });
  store.writeJson(NOTICES_FILE, recovery.clearNotices(store.readJson(NOTICES_FILE, []), {
    taskId: task.id,
    agentId: updated.execution?.resolvedAgentId,
  }));

  if (settings.notifyOnComplete || settings.deliveryOnComplete || settings.morningPack !== false) {
    await finishJob(task.id, settings, packExtra);
  }
  return store.getTask(task.id);
}

async function executeTask(task) {
  inFlight.add(task.id);
  try {
    return await runOnce(task);
  } finally {
    inFlight.delete(task.id);
  }
}

async function runOnce(task) {
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
      retryOf: null,
      held: null,
      killedForHang: false,
      killedForTimeout: false,
      killCause: null,
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
    await failTask(task.id, updated, runner.spawnError, settings, { cause: 'spawn' });
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
    const startErr = connector === ids.SHELL_COMMAND
      ? 'Failed to start command process'
      : 'Failed to start agent process';
    await failTask(task.id, updated, startErr, settings, { cause: 'spawn' });
    worktree.cleanupWorktree(worktreeMeta, { success: false });
    return store.getTask(task.id);
  }

  const code = await waitChild(runner.child, runner.logStream, task.id);
  if (connector !== ids.SHELL_COMMAND) recordAgentUsage(task.id, logPath);
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
      await failTask(task.id, store.getTask(task.id), `Acceptance gate failed: ${report}`, settings, { cause: 'acceptance' });
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
          { cause: 'verifier' },
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
    const cause = updated.execution.killedForTimeout ? 'timeout' : (updated.execution.killCause || 'hang');
    await failTask(task.id, updated, hangErr, settings, { cause });
    worktree.cleanupWorktree(worktreeMeta, { success: false });
    return store.getTask(task.id);
  }

  const err = code === -1
    ? (connector === ids.SHELL_COMMAND
      ? 'Command process failed to start (check the shell, PATH, and working directory)'
      : 'Agent process failed to start (check workspace path exists and that an agent CLI is installed)')
    : `Process exited with code ${code}`;

  // Agent rate-limit failover does not apply to pure shell jobs.
  if (connector !== ids.SHELL_COMMAND) {
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
  }

  await failTask(task.id, updated, err, settings, { cause: code === -1 ? 'spawn' : 'exit', exitCode: code });
  worktree.cleanupWorktree(worktreeMeta, { success: false });
  return store.getTask(task.id);
}

function recordAgentUsage(taskId, logPath) {
  const ex = store.getTask(taskId).execution;
  const minutes = Math.max(0, (Date.now() - new Date(ex.startedAt).getTime()) / 60000);
  const usage = { minutes: Math.round(minutes * 10) / 10, ...budget.usageFromLog(store.tailLog(logPath, 200)) };
  store.updateTask(taskId, { execution: { usage } });
  ledger.record('agent_usage', { taskId, agentId: ex.resolvedAgentId || null, ...usage });
}

function isShellJob(task) {
  return (task.execution?.connector || templates.getTemplate(task.templateId)?.connector) === ids.SHELL_COMMAND;
}

/** Agent jobs wait while a budget cap is reached; terminal jobs never do. Returns the due jobs that may start. */
async function applyBudget(due) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const state = budget.budgetState(loadConfig(), ledger.query({ type: 'agent_usage', since: monthStart }), store.runningTasks(), now);
  const { alert, marks } = budget.takeBudgetAlert(store.readJson(BUDGET_ALERTS_FILE, {}), state);
  if (alert) {
    store.writeJson(BUDGET_ALERTS_FILE, marks);
    await omnish.notify(alert.title, alert.body);
  }
  const held = budget.heldReason(state);
  if (!held) return due;
  for (const t of due) {
    if (!isShellJob(t) && t.execution?.held !== held) store.updateTask(t.id, { execution: { held } });
  }
  return due.filter(isShellJob);
}

async function failTask(taskId, updated, err, settings, facts = {}) {
  const cfg = loadConfig();
  const task = store.getTask(taskId);
  const ex = { ...updated.execution, pid: null };
  const cause = facts.cause || 'exit';
  const logTail = store.tailLog(store.taskLogPath(taskId), 40);
  const verdict = recovery.classifyFailure({
    cause,
    connector: ex.connector || templates.getTemplate(task.templateId)?.connector,
    exitCode: facts.exitCode,
    logTail,
    agentId: ex.resolvedAgentId || task.inputs?.agentId,
    taskId,
  });

  if (verdict.kind === 'retry' && ex.attempts < ex.maxAttempts) {
    const backoffSec = cfg.worker?.retryBackoffSec || 120;
    store.updateTask(taskId, {
      status: 'scheduled',
      schedule: { ...task.schedule, runAt: new Date(Date.now() + backoffSec * 1000).toISOString() },
      execution: { ...ex, error: err, retryOf: { cause, error: err } },
    });
    return;
  }

  const words = recovery.lastWords(logTail);
  const said = words && !String(err).includes(words) ? `. Last output: "${words}"` : '';
  const error = verdict.detail ? `${err}${said}. ${verdict.detail}` : `${err}${said}`;
  const signature = recovery.failureSignature(cause, err);
  const sameAsLast = ex.lastFailure === signature;
  const finishedAt = new Date().toISOString();
  const schedule = task.schedule;
  const failuresInRow = (ex.failuresInRow || 0) + 1;
  const scheduledNext = scheduler.isRecurring(schedule?.type) ? scheduler.computeNextRun(schedule, new Date()) : null;
  const nextRunAt = scheduledNext && new Date(Math.max(
    new Date(scheduledNext).getTime(),
    recovery.backoffUntil(failuresInRow, taskId),
  )).toISOString();

  if (nextRunAt) {
    // One bad night must not end a nightly job: record the failure and keep the schedule.
    store.updateTask(taskId, {
      status: 'scheduled',
      schedule: { ...schedule, type: scheduler.normalizeType(schedule.type), runAt: nextRunAt },
      execution: {
        ...ex,
        attempts: 0,
        error,
        retryOf: null,
        finishedAt,
        lastFinishedAt: finishedAt,
        lastFailure: signature,
        failuresInRow,
      },
    });
    ledger.record('job_failed', {
      taskId,
      templateId: task.templateId,
      workspaceId: task.workspaceId,
      agentId: task.inputs?.agentId || null,
    });
  } else {
    store.updateTask(taskId, {
      status: 'failed',
      execution: { ...ex, error, retryOf: null, finishedAt, lastFailure: signature, failuresInRow },
    });
  }

  if (!settings.notifyOnFail) return;
  if (verdict.kind === 'owner') {
    const { first, notices } = recovery.takeNotice(store.readJson(NOTICES_FILE, []), verdict.noticeKey);
    if (!first) return;
    store.writeJson(NOTICES_FILE, notices);
  } else if (nextRunAt && sameAsLast) {
    return;
  }
  const message = [error.replace(/[.\s]+$/, ''), nextRunAt && `Next run ${recovery.whenText(nextRunAt)}`].filter(Boolean).join('. ');
  await omnish.taskFailed(store.getTask(taskId), message);
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
  const startable = await applyBudget(due);
  if (!startable.length) return;

  startable.sort((a, b) => (b.schedule?.priority || 50) - (a.schedule?.priority || 50));

  let candidate = null;
  for (const t of startable) {
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
  const interrupted = ['paused', 'failed'].includes(task.status) && task.execution?.error;
  store.updateTask(taskId, {
    status: 'scheduled',
    // A recurring job runs now and then keeps its schedule; turning it into a one-off would end it after this run.
    schedule: scheduler.isRecurring(task.schedule?.type)
      ? { ...task.schedule, runAt: new Date().toISOString(), priority: 95 }
      : { ...task.schedule, type: 'now', priority: 95 },
    execution: {
      ...task.execution,
      attempts: 0,
      error: null,
      finishedAt: null,
      retryOf: interrupted
        ? { cause: task.status === 'paused' ? 'resume' : 'exit', error: task.execution.error }
        : null,
    },
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
  failTask,
  isInFlight: (taskId) => inFlight.has(taskId),
  tick,
  startWorker,
  isSystemBusy,
  stopTask,
  resumeTask,
  pauseWorkspace,
  resumeWorkspace,
};
