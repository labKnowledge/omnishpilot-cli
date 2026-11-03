const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { loadConfig } = require('./config');
const ledger = require('./ledger');
const { readJsonSafe, writeJsonAtomic } = require('./atomic');

const FILES = {
  tasks: 'tasks.json',
  settings: 'settings.json',
};

/** Parallel by default. 0 = unlimited. Config worker.maxConcurrent overrides when settings omit it. */
const DEFAULT_MAX_CONCURRENT = 4;

const DEFAULT_SETTINGS = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  notifyOnStart: true,
  notifyOnComplete: true,
  notifyOnFail: true,
  supervisorEnabled: true,
  blockedWhenBusy: true,
  deliveryOnComplete: false,
  deliveryMode: 'pack',
  morningPack: true,
  deliveryPeer: '',
  publicUrl: '',
};

function maxConcurrentFromConfig() {
  try {
    const fromCfg = loadConfig().worker?.maxConcurrent;
    if (fromCfg === 0 || fromCfg === 'unlimited') return 0;
    if (Number.isFinite(Number(fromCfg)) && Number(fromCfg) > 0) return Math.floor(Number(fromCfg));
  } catch { /* ignore */ }
  return DEFAULT_MAX_CONCURRENT;
}

/**
 * Resolve concurrency cap.
 * 0 = unlimited. Prefer explicit settings value; else config.worker.maxConcurrent; else default 4.
 */
function resolveMaxConcurrent(settings) {
  const src = settings || getSettings();
  const raw = src.maxConcurrent;
  if (raw === 0 || raw === 'unlimited' || raw === 'Unlimited') return 0;
  if (Number.isFinite(Number(raw)) && Number(raw) > 0) return Math.floor(Number(raw));
  return maxConcurrentFromConfig();
}

function concurrencySlotsFree(settings) {
  const max = resolveMaxConcurrent(settings);
  if (max === 0) return Infinity;
  return Math.max(0, max - runningTasks().length);
}

function dataPath(name) {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, name);
}

function readJson(file, fallback) {
  return readJsonSafe(dataPath(file), fallback);
}

function writeJson(file, data) {
  writeJsonAtomic(dataPath(file), data, { backup: true });
}

function listTasks(filter = {}) {
  let tasks = readJson(FILES.tasks, []);
  if (filter.workspaceId) tasks = tasks.filter(t => t.workspaceId === filter.workspaceId);
  if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
  if (filter.upcoming) {
    tasks = tasks.filter(t => ['scheduled', 'draft'].includes(t.status));
  }
  return tasks.sort((a, b) => {
    const da = a.schedule?.runAt || a.schedule?.campaignDay || 999;
    const db = b.schedule?.runAt || b.schedule?.campaignDay || 999;
    return String(da).localeCompare(String(db));
  });
}

function getTask(id) {
  return readJson(FILES.tasks, []).find(t => t.id === id) || null;
}

function saveTasks(tasks) {
  writeJson(FILES.tasks, tasks);
}

function upsertTask(task) {
  const tasks = readJson(FILES.tasks, []);
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
  saveTasks(tasks);
  return task;
}

function createTask(spec) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    workspaceId: spec.workspaceId,
    templateId: spec.templateId,
    title: spec.title,
    summary: spec.summary || '',
    status: spec.status || 'scheduled',
    runMode: spec.runMode || 'auto',
    muted: spec.muted || false,
    schedule: spec.schedule || { type: 'manual' },
    instructions: spec.instructions || {},
    inputs: spec.inputs || {},
    acceptance: spec.acceptance || null,
    outputs: spec.outputs || [],
    execution: {
      attempts: 0,
      maxAttempts: spec.maxAttempts || 3,
      pid: null,
      logPath: null,
      connector: spec.connector || null,
      startedAt: null,
      finishedAt: null,
      error: null,
      artifacts: [],
    },
    source: spec.source || 'user',
    sourceRef: spec.sourceRef || null,
    deliveryId: spec.deliveryId || null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  upsertTask(task);
  ledger.record('job_created', {
    taskId: task.id,
    templateId: task.templateId,
    workspaceId: task.workspaceId,
    agentId: task.inputs?.agentId || null,
    workspacePath: task.inputs?.workspace || null,
    scheduleType: task.schedule?.type || null,
    source: task.source,
  });
  return task;
}

const OUTCOME_EVENT_BY_STATUS = { completed: 'job_completed', failed: 'job_failed', paused: 'job_stopped' };

function updateTask(id, patch) {
  const task = getTask(id);
  if (!task) return null;
  const updated = {
    ...task,
    ...patch,
    instructions: patch.instructions ? { ...task.instructions, ...patch.instructions } : task.instructions,
    inputs: patch.inputs ? { ...task.inputs, ...patch.inputs } : task.inputs,
    execution: patch.execution ? { ...task.execution, ...patch.execution } : task.execution,
    updatedAt: new Date().toISOString(),
  };
  upsertTask(updated);
  if (patch.status && patch.status !== task.status && OUTCOME_EVENT_BY_STATUS[patch.status]) {
    ledger.record(OUTCOME_EVENT_BY_STATUS[patch.status], {
      taskId: updated.id,
      templateId: updated.templateId,
      workspaceId: updated.workspaceId,
      agentId: updated.inputs?.agentId || null,
    });
  }
  return updated;
}

function deleteTask(id) {
  const tasks = readJson(FILES.tasks, []).filter(t => t.id !== id);
  saveTasks(tasks);
}

function runningTasks() {
  return readJson(FILES.tasks, []).filter(t => t.status === 'running');
}

function getSettings() {
  const stored = readJson(FILES.settings, {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // If the file never set maxConcurrent, prefer config.worker.maxConcurrent over the code default.
  if (!Object.prototype.hasOwnProperty.call(stored, 'maxConcurrent')) {
    merged.maxConcurrent = maxConcurrentFromConfig();
  }
  return merged;
}

function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'maxConcurrent')) {
    const n = patch.maxConcurrent;
    if (n === 'unlimited' || n === 'Unlimited') s.maxConcurrent = 0;
    else if (n === 'serial' || n === 'queue') s.maxConcurrent = 1;
    else {
      const num = Number(n);
      if (!Number.isFinite(num) || num < 0) throw new Error('maxConcurrent must be >= 0 (0 = unlimited)');
      s.maxConcurrent = Math.floor(num);
    }
  }
  writeJson(FILES.settings, s);
  return s;
}

function taskLogPath(taskId) {
  const logDir = path.join(loadConfig().dataDir, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `${taskId}.log`);
}

function tailLog(filePath, lines = 300) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').split('\n').slice(-lines).join('\n');
}

module.exports = {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  upsertTask,
  runningTasks,
  getSettings,
  saveSettings,
  resolveMaxConcurrent,
  concurrencySlotsFree,
  DEFAULT_MAX_CONCURRENT,
  taskLogPath,
  tailLog,
  readJson,
  writeJson,
  FILES,
};
