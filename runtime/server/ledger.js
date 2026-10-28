const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

// Derived, append-only projection of job lifecycle events, used only to power suggestions —
// never a source of truth. tasks.json (store.js) remains authoritative; deleting this file
// resets every suggestion with zero data loss, and bootstrapFromTasksIfEmpty() can regenerate
// it from tasks.json at any time.
const LOG_FILE = 'action-log.json';
const MAX_EVENTS = 5000; // backstop so a long-lived install can't grow this file unbounded

function filePath() {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, LOG_FILE);
}

function readEvents() {
  const p = filePath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function writeEvents(events) {
  const p = filePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function record(type, fields = {}) {
  const events = readEvents();
  const event = { ts: new Date().toISOString(), type, ...fields };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  writeEvents(events);
  return event;
}

function query({ type, templateId, workspaceId, taskId, since } = {}) {
  let events = readEvents();
  if (type) events = events.filter(e => e.type === type);
  if (templateId) events = events.filter(e => e.templateId === templateId);
  if (workspaceId) events = events.filter(e => e.workspaceId === workspaceId);
  if (taskId) events = events.filter(e => e.taskId === taskId);
  if (since) events = events.filter(e => e.ts >= since);
  return events;
}

// One-time bootstrap: if the ledger is empty but tasks.json already has real history (this
// user's existing campaigns), synthesize job_created/job_completed/job_failed events from it
// so suggestions have signal from day one instead of starting stone cold.
function bootstrapFromTasksIfEmpty() {
  if (readEvents().length) return;
  const store = require('./store'); // lazy: store.js requires this module, so avoid a load-order cycle
  const tasks = store.listTasks();
  if (!tasks.length) return;

  const events = [];
  for (const t of tasks) {
    events.push({
      ts: t.createdAt || new Date().toISOString(),
      type: 'job_created',
      taskId: t.id,
      templateId: t.templateId,
      workspaceId: t.workspaceId,
      agentId: t.inputs?.agentId || null,
      workspacePath: t.inputs?.workspace || null,
      scheduleType: t.schedule?.type || null,
      source: t.source || 'user',
    });
    if (t.status === 'completed' || t.status === 'failed') {
      events.push({
        ts: t.completedAt || t.updatedAt || t.createdAt,
        type: t.status === 'completed' ? 'job_completed' : 'job_failed',
        taskId: t.id,
        templateId: t.templateId,
        workspaceId: t.workspaceId,
        agentId: t.inputs?.agentId || null,
      });
    }
  }
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  writeEvents(events);
}

module.exports = { record, query, readEvents, bootstrapFromTasksIfEmpty };
