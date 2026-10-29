const express = require('express');
const path = require('path');
const fs = require('fs');

const { loadConfig, ROOT } = require('./config');
const store = require('./store');
const templates = require('./templates');
const worker = require('./worker');
const supervisor = require('./supervisor');
const wake = require('./wake');
const registry = require('./connectors/registry');
const ids = require('./connectors/ids');
const leaptr = require('./connectors/leaptr');
const agent = require('./connectors/agent');
const agents = require('./agents');
const quickAdd = require('./quickAdd');
const ledger = require('./ledger');
const suggest = require('./suggest');
const macroDetector = require('./macroDetector');
const omnish = require('./omnish');
const delivery = require('./delivery');
const { buildImportTemplate, buildCampaignPlanTemplate, stripGuideForImport, stripExampleComments } = require('./import-template');
const scheduler = require('./scheduler');
const calendar = require('./calendar');
const auth = require('./auth');
const webhooks = require('./webhooks');

const app = express();
const cfg = loadConfig();
const PUBLIC = path.join(__dirname, '..', 'public');

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Webhook triggers (GitHub / Linear / generic) — token-gated, auth-middleware bypassed below.
webhooks.mountWebhooks(app);

function writeImportTemplateFile() {
  try {
    const p = path.join(PUBLIC, 'omnishpilot-import-template.json');
    fs.writeFileSync(p, JSON.stringify(buildImportTemplate(cfg), null, 2) + '\n');
  } catch (e) {
    console.warn('[omnishpilot] import template file not written:', e.message);
  }
}
writeImportTemplateFile();

function writeCampaignPlanTemplateFile() {
  try {
    const p = path.join(PUBLIC, 'omnishpilot-campaign-plan-template.json');
    fs.writeFileSync(p, JSON.stringify(buildCampaignPlanTemplate(), null, 2) + '\n');
  } catch (e) {
    console.warn('[omnishpilot] campaign plan template file not written:', e.message);
  }
}
writeCampaignPlanTemplateFile();

function syncAllWorkspaces() {
  const results = [];
  for (const ws of cfg.workspaces || []) {
    const def = registry.get(ws.connector);
    if (def.sync && ws.enabled) {
      results.push({ workspaceId: ws.id, ...def.sync({ ws, store, templates }) });
    }
  }
  return results;
}

// Boot sync
syncAllWorkspaces();

// One-time: backfill the suggestion ledger from existing task history so recommendations
// have real signal from the very first request instead of starting stone cold.
ledger.bootstrapFromTasksIfEmpty();

function packageVersion() {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(__dirname, '..', '..', 'omnishpilot-cli', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).version || '0.0.0';
    } catch { /* try next */ }
  }
  return '0.0.0';
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'omnishpilot', version: packageVersion() });
});

app.get('/api/auth/status', (req, res) => {
  const { enabled } = auth.authConfig();
  res.json({
    enabled,
    authenticated: auth.isAuthenticated(req),
  });
});

app.post('/api/auth/login', (req, res) => {
  const { enabled, secret, sessionMs } = auth.authConfig();
  if (!enabled) {
    return res.json({ ok: true, authenticated: true, disabled: true });
  }
  const password = req.body?.password;
  if (!auth.verifyPassword(password)) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  const token = auth.createSessionToken(secret, sessionMs);
  auth.setSessionCookie(res, token, req);
  res.json({ ok: true, authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.get('/login.html', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

const PUBLIC_ASSET_PATHS = new Set([
  '/favicon.svg', '/favicon.ico', '/favicon-16x16.png', '/favicon-32x32.png',
  '/apple-touch-icon.png', '/android-chrome-192x192.png', '/android-chrome-512x512.png',
  '/maskable-icon-512x512.png', '/site.webmanifest', '/logo.svg', '/logo-256.png', '/logo-512.png',
]);

app.use((req, res, next) => {
  if (req.path === '/login.html') {
    return res.sendFile(path.join(PUBLIC, 'login.html'));
  }
  if (PUBLIC_ASSET_PATHS.has(req.path)) {
    return next();
  }
  // Token-gated webhooks are mounted above; keep them outside session auth.
  if (req.path.startsWith('/hooks/') || req.path.startsWith('/api/hooks/')) {
    return next();
  }
  return auth.requireAuth(req, res, next);
});

app.use(express.static(PUBLIC));

const DELIVERY_MODES = [
  { id: 'pack', label: 'Morning pack', description: 'Gate + artifacts + diff — wake to a verdict' },
  { id: 'message', label: 'Short message', description: 'Brief finish notice only' },
  { id: 'summary', label: 'Message + summary', description: 'Includes social copy or result text' },
  { id: 'files', label: 'Send files', description: 'Ship output files through Omnish' },
  { id: 'link', label: 'Message + link', description: 'Summary plus a link to outputs' },
];

app.get('/api/meta', (_req, res) => {
  res.json({
    templates: templates.TEMPLATES,
    runModes: templates.RUN_MODES,
    scheduleTypes: templates.SCHEDULE_TYPES,
    deliveryModes: DELIVERY_MODES,
    importTemplateUrl: '/omnishpilot-import-template.json',
    campaignPlanTemplateUrl: '/omnishpilot-campaign-plan-template.json',
    scheduler: {
      defaultTimezone: scheduler.defaultTimezone(),
      minIntervalMinutes: cfg.scheduler?.minIntervalMinutes || 5,
    },
    workspaces: cfg.workspaces,
    settings: store.getSettings(),
  });
});

app.get('/api/import-template', (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="omnishpilot-import-template.json"');
  res.send(JSON.stringify(buildImportTemplate(cfg), null, 2) + '\n');
});

app.get('/api/campaign-plan-template', (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="omnishpilot-campaign-plan-template.json"');
  res.send(JSON.stringify(buildCampaignPlanTemplate(), null, 2) + '\n');
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: agents.getAgentsWithHealth() });
});

app.post('/api/agents/preview', (req, res) => {
  const { inputs = {}, instructions = {}, title, summary, agentId, commandTemplate, flattenPrompt, model } = req.body || {};
  const taskLike = { inputs, instructions, title, summary };
  const noopLog = { write: () => {} };
  const { path: workspacePath } = agent.resolveWorkspace(taskLike, cfg, noopLog);
  const fullPrompt = `${agent.agentPromptPath(taskLike)}

## Output directory
Save all deliverables here: <output directory for this run>

## Agent tools
Use available tools (GenerateImage, file write, shell) as needed to complete the goal.
For images: save PNG files into the output directory and write a brief result.md summary.
`;

  const tmpFile = path.join(require('os').tmpdir(), `agentboard-preview-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, fullPrompt);
  try {
    const args = ['run', '--agent', agentId || 'auto', '--workspace', workspacePath, '--prompt-file', tmpFile, '--dry-run'];
    if (model) args.push('--model', model);
    if (commandTemplate) args.push('--command-template', commandTemplate);
    if (flattenPrompt === true) args.push('--flatten');
    else if (flattenPrompt === false) args.push('--no-flatten');

    const { spawnSync } = require('child_process');
    const inv = agents.resolveAgentRunSpawn(cfg, args);
    const r = spawnSync(inv.bin, inv.args, { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) {
      return res.status(400).json({ error: (r.stderr || r.stdout || 'preview failed').trim() });
    }
    res.json({ command: r.stdout.trim(), workspace: workspacePath });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Action Abstraction Layer — see ACTION-ABSTRACTION.md. Read-only: these only ever return
// pre-fill hints for the wizard/quick-add to show, never mutate anything on their own.
app.get('/api/suggestions', (req, res) => {
  const templateId = req.query.templateId;
  if (!templateId || !templates.getTemplate(templateId)) return res.status(400).json({ error: 'invalid_template' });
  res.json({
    ...suggest.suggestForTemplate(templateId),
    instructions: suggest.suggestInstructionSkeletons(templateId),
  });
});

app.get('/api/suggestions/macro/:taskId', (req, res) => {
  const task = store.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const macro = macroDetector.macroForTask(task);
  if (!macro) return res.status(404).json({ error: 'no_macro' });
  res.json({ macro });
});

app.get('/api/fs/browse', (req, res) => {
  const os = require('os');
  const requested = typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path.trim() : os.homedir();
  const dir = path.resolve(requested);

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return res.status(404).json({ error: 'not_found', path: dir });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'not_a_directory', path: dir });
  }

  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return res.status(403).json({ error: 'permission_denied', path: dir });
  }

  const showHidden = req.query.hidden === '1';
  const entries = names
    .filter(d => d.isDirectory())
    .filter(d => showHidden || !d.name.startsWith('.'))
    .map(d => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
  res.json({ path: dir, parent, home: os.homedir(), entries });
});

app.post('/api/fs/mkdir', (req, res) => {
  const { path: dirPath } = req.body || {};
  if (!dirPath) return res.status(400).json({ error: 'path_required' });
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    ledger.record('folder_created', { path: dirPath });
    res.json({ success: true, path: dirPath });
  } catch (e) {
    res.status(500).json({ error: e.message || 'could_not_create_directory' });
  }
});

app.get('/api/calendar', (req, res) => {
  const tasks = store.listTasks().map(enrichTask);
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const day = req.query.day != null ? Number(req.query.day) : null;
  res.json(calendar.buildCalendar({ year, month, day }, tasks, cfg));
});

app.patch('/api/calendar/reschedule', (req, res) => {
  const { taskId, date, hour, minute, second } = req.body || {};
  if (!taskId || !date) {
    return res.status(400).json({ error: 'taskId_and_date_required' });
  }
  const task = store.getTask(taskId);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (task.status === 'running') {
    return res.status(400).json({ error: 'cannot_reschedule_running' });
  }
  if (task.status === 'completed') {
    return res.status(400).json({ error: 'cannot_reschedule_completed' });
  }
  const h = Number(hour);
  const min = Number(minute);
  const sec = Number(second) || 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) {
    return res.status(400).json({ error: 'invalid_time' });
  }
  try {
    const patch = calendar.buildReschedulePatch(task, date, h, min, sec);
    const prepared = patch.schedule
      ? { ...patch, schedule: scheduler.prepareSchedule(patch.schedule) }
      : patch;
    const updated = store.updateTask(taskId, prepared);
    const ws = cfg.workspaces?.find(w => w.id === updated.workspaceId);
    registry.get(ws?.connector).onReschedule?.({ ws, task: updated });
    res.json({ ok: true, task: enrichTask(updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function resolveStatusFromSchedule(schedule, explicitStatus) {
  const type = scheduler.normalizeType(schedule?.type);
  if (explicitStatus && explicitStatus !== 'draft') return explicitStatus;
  if (type === 'manual') return 'draft';
  if (type === 'now' || type === 'once' || scheduler.isRecurring(type) || type === 'campaign_day') {
    return 'scheduled';
  }
  return explicitStatus || 'draft';
}

function applySchedule(body) {
  if (!body.schedule) return body;
  const prepared = scheduler.prepareSchedule(body.schedule);
  return {
    ...body,
    schedule: prepared,
    status: resolveStatusFromSchedule(prepared, body.status),
  };
}

let weekCache = { at: 0, byTask: new Map() };
function weekOf(task) {
  if (!scheduler.isRecurring(task.schedule?.type)) return null;
  if (Date.now() - weekCache.at > 5000) weekCache = { at: Date.now(), byTask: ledger.weekOutcomes() };
  return weekCache.byTask.get(task.id) || null;
}

function enrichTask(task) {
  const ws = cfg.workspaces?.find(w => w.id === task.workspaceId);
  const def = registry.get(ws?.connector);
  const day = registry.resolveDay(task);
  const paused = def.isPaused && day != null
    ? def.isPaused({ ws, day })
    : task.status === 'paused';
  return {
    ...task,
    scheduleLabel: scheduler.formatScheduleLabel(task.schedule),
    paused,
    muted: task.muted === true,
    week: weekOf(task),
  };
}

function todayInTimezone(tz = 'America/Denver') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function campaignDayToday(startDate, totalDays = 30, tz = 'America/Denver') {
  if (!startDate) return null;
  const todayStr = todayInTimezone(tz);
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${todayStr}T12:00:00`);
  const diff = Math.floor((end - start) / 86400000) + 1;
  if (diff < 1) return 0;
  return Math.min(totalDays, diff);
}

function buildCampaignSummaries(tasks) {
  return (cfg.workspaces || []).filter(w => w.enabled).map(ws => {
    const wsTasks = tasks.filter(t => t.workspaceId === ws.id);
    const total = ws.meta?.totalDays || 30;
    const completed = wsTasks.filter(t => t.status === 'completed').length;
    const todayDay = campaignDayToday(ws.meta?.campaignStart, total, ws.meta?.timezone);
    const todayTask = wsTasks.find(t =>
      t.schedule?.campaignDay === todayDay || t.inputs?.dayNumber === todayDay
    );
    const nextTask = wsTasks
      .filter(t => t.status === 'scheduled')
      .sort((a, b) => (a.schedule?.campaignDay || 99) - (b.schedule?.campaignDay || 99))[0];
    const def = registry.get(ws.connector);
    const st = def.readState ? def.readState({ ws }) : null;
    const dailyRun = (def.dailyRunLabel && def.dailyRunLabel({ ws })) || '7:00';
    return {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      connector: ws.connector,
      startDate: ws.meta?.campaignStart,
      timezone: ws.meta?.timezone || 'America/Denver',
      totalDays: total,
      completed,
      todayDay,
      todayTask: todayTask ? { id: todayTask.id, title: todayTask.title, status: todayTask.status } : null,
      nextTask: nextTask ? { id: nextTask.id, title: nextTask.title, day: nextTask.schedule?.campaignDay } : null,
      dailyRun,
      autopilot: st ? {
        lastRunDay: st.last_run_day,
        lastRunAt: st.last_run_at,
        inProgress: st.in_progress,
      } : null,
      campaignPaused: st?.paused === true,
    };
  });
}

function withWorkspaceName(t) {
  return { ...t, workspaceName: cfg.workspaces?.find(w => w.id === t.workspaceId)?.name || null };
}

// Interleave round-robin across workspaces (capped per workspace) so one high-volume or
// low-day-number campaign can't crowd another out of a shared, UI-truncated list.
function fairPerWorkspace(sortedTasks, perWorkspace) {
  const byWs = new Map();
  for (const t of sortedTasks) {
    if (!byWs.has(t.workspaceId)) byWs.set(t.workspaceId, []);
    if (byWs.get(t.workspaceId).length < perWorkspace) byWs.get(t.workspaceId).push(t);
  }
  const lists = [...byWs.values()];
  const merged = [];
  for (let i = 0; i < perWorkspace; i++) {
    for (const list of lists) if (list[i]) merged.push(list[i]);
  }
  return merged;
}

app.get('/api/dashboard', async (_req, res) => {
  const tasks = store.listTasks();
  let running = tasks.filter(t => t.status === 'running');
  const drafts = tasks.filter(t => t.status === 'draft');
  const upcomingAll = tasks.filter(t => t.status === 'scheduled')
    .sort((a, b) => (a.schedule?.campaignDay || 99) - (b.schedule?.campaignDay || 99));
  const upcoming = fairPerWorkspace(upcomingAll, 10).map(withWorkspaceName);
  const completedAll = tasks.filter(t => t.status === 'completed')
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  const completed = fairPerWorkspace(completedAll, 6)
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  const failed = tasks.filter(t => t.status === 'failed').map(withWorkspaceName);
  const paused = tasks.filter(t => t.status === 'paused').map(withWorkspaceName);

  const liveRuns = [];
  for (const ws of cfg.workspaces || []) {
    if (!ws.enabled) continue;
    const def = registry.get(ws.connector);
    const live = def.getLiveRun ? def.getLiveRun({ ws }) : null;
    if (!live) continue;
    const dayTask = tasks.find(t => t.workspaceId === ws.id && registry.resolveDay(t) === live.day);
    liveRuns.push({
      source: 'autopilot',
      workspaceId: ws.id,
      day: live.day,
      pid: live.pid,
      role: live.role,
      startedAt: live.startedAt,
      taskId: dayTask?.id || null,
      title: dayTask?.title || `Day ${live.day}`,
    });
    if (dayTask && !running.find(r => r.id === dayTask.id)) {
      running = [...running, { ...dayTask, status: 'running', _live: true }];
    }
  }

  // Computed once per request (not per card) — detectMacros() scans the whole ledger, so
  // reuse the same pass across every completed task instead of rescanning per card.
  const macros = macroDetector.detectMacros();
  const enrichCompleted = completed.map(t => {
    const ws = cfg.workspaces?.find(w => w.id === t.workspaceId);
    const def = registry.get(ws?.connector);
    const day = registry.resolveDay(t);
    const thumbUrl = def.thumbnailUrl && day != null
      ? def.thumbnailUrl({ ws, day, workspaceId: t.workspaceId })
      : null;
    const match = macros.find(m => m.workspaceId === t.workspaceId && m.templateId === t.templateId);
    const toTpl = match ? templates.getTemplate(match.toTemplateId) : null;
    const suggestedMacro = toTpl ? { label: toTpl.name, icon: toTpl.icon || '➡️', count: match.count } : null;
    return { ...withWorkspaceName(t), thumbUrl, suggestedMacro };
  });

  res.json({
    campaigns: buildCampaignSummaries(tasks),
    running,
    liveRuns,
    drafts,
    upcoming,
    completed: enrichCompleted,
    failed,
    paused,
    stats: {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'completed').length,
      scheduled: upcomingAll.length,
      drafts: drafts.length,
      running: running.length + (liveRuns.length && !running.length ? liveRuns.length : 0),
      failed: failed.length,
      paused: paused.length,
    },
  });
});

app.get('/api/timeline', (req, res) => {
  const wsId = req.query.workspaceId || cfg.workspaces?.[0]?.id;
  const ws = cfg.workspaces?.find(w => w.id === wsId);
  if (!ws) return res.status(404).json({ error: 'workspace_not_found' });

  const totalDays = ws.meta?.totalDays || 30;
  const tasks = store.listTasks({ workspaceId: wsId });
  const byDay = {};
  for (const t of tasks) {
    const day = t.schedule?.campaignDay || t.inputs?.dayNumber;
    if (day) byDay[day] = enrichTask(t);
  }

  const planByDay = {};
  const timelineDef = registry.get(ws.connector);
  if (timelineDef.getCampaignPlan) {
    for (const d of timelineDef.getCampaignPlan({ ws })) {
      planByDay[d.day] = { title: d.title, pillar: d.pillar, cta: d.cta };
    }
  }

  const days = [];
  for (let day = 1; day <= totalDays; day++) {
    const task = byDay[day] || null;
    const planned = planByDay[day] || null;
    days.push({
      day,
      task,
      planned,
      hasJob: Boolean(task),
      hasPlan: Boolean(planned),
    });
  }

  const missingJobs = days.filter(d => d.hasPlan && !d.hasJob).length;

  res.json({
    workspaceId: ws.id,
    workspaceName: ws.name,
    totalDays,
    days,
    stats: {
      withJobs: days.filter(d => d.hasJob).length,
      withPlan: days.filter(d => d.hasPlan).length,
      missingJobs,
    },
  });
});

app.get('/api/tasks', (req, res) => {
  const filter = {};
  if (req.query.workspaceId) filter.workspaceId = req.query.workspaceId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.upcoming === '1') filter.upcoming = true;
  res.json(store.listTasks(filter).map(enrichTask));
});

app.get('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const template = templates.getTemplate(task.templateId);
  const ws = cfg.workspaces?.find(w => w.id === task.workspaceId);
  const day = registry.resolveDay(task);
  const connector = task.execution?.connector || template?.connector;
  const artifactDef = registry.get(connector);
  const artifacts = artifactDef.listArtifacts ? artifactDef.listArtifacts({ ws, task, day, cfg }) : [];
  res.json({
    task: enrichTask(task),
    template,
    artifacts,
    editable: ['scheduled', 'draft', 'failed'].includes(task.status),
  });
});

function createTaskFromBody(rawBody) {
  const body = { ...(rawBody || {}) };
  const quickAddOrigin = body.quickAddOrigin;
  delete body.quickAddOrigin;
  const prepared = applySchedule(body);
  const template = templates.getTemplate(prepared.templateId);
  if (!template) throw new Error('invalid_template');

  const instructions = prepared.instructions
    || templates.buildDefaultInstructions(template, prepared.inputs || {});

  const inputs = { ...(prepared.inputs || {}) };
  if (prepared.skills?.length && !inputs.skills) {
    inputs.skills = prepared.skills;
  }

  const task = store.createTask({
    workspaceId: prepared.workspaceId || cfg.workspaces?.[0]?.id,
    templateId: prepared.templateId,
    title: prepared.title || prepared.inputs?.title || template.name,
    summary: prepared.summary || '',
    status: prepared.status || 'draft',
    runMode: prepared.runMode || template.defaultRunMode,
    schedule: prepared.schedule || { type: 'manual' },
    instructions,
    inputs,
    acceptance: prepared.acceptance || null,
    outputs: template.outputs,
    connector: template.connector,
    source: prepared.source || 'user',
    maxAttempts: prepared.maxAttempts || template.defaultMaxAttempts,
  });

  if (scheduler.normalizeType(prepared.schedule?.type) === 'now') {
    store.updateTask(task.id, {
      schedule: { ...task.schedule, type: 'now', priority: 90, runAt: new Date().toISOString() },
      status: 'scheduled',
    });
  }

  const finalTask = store.getTask(task.id);
  if (quickAddOrigin?.text) {
    const finalSpec = {
      templateId: finalTask.templateId,
      title: finalTask.title,
      inputs: finalTask.inputs,
      instructions: finalTask.instructions,
      schedule: finalTask.schedule,
      runMode: finalTask.runMode,
    };
    const proposed = quickAddOrigin.proposedSpec || {};
    const corrected = finalSpec.templateId !== proposed.templateId
      || finalSpec.runMode !== proposed.runMode
      || JSON.stringify(finalSpec.inputs) !== JSON.stringify(proposed.inputs)
      || JSON.stringify(finalSpec.schedule) !== JSON.stringify(proposed.schedule);
    // PbD-style demonstration+correction capture (CoScripter/SUGILITE): whatever the user
    // changed between the interpreter's first guess and what they actually created becomes
    // the labeled example a near-duplicate future request reuses — see quickAdd.findReusableSpec.
    ledger.record('quick_add_resolved', {
      taskId: finalTask.id,
      requestText: quickAddOrigin.text,
      workspace: quickAddOrigin.workspace || '',
      proposedSpec: proposed,
      finalSpec,
      corrected,
    });
  }

  return enrichTask(finalTask);
}

app.post('/api/tasks', (req, res) => {
  try {
    res.status(201).json(createTaskFromBody(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/quick-add/interpret', (req, res) => {
  try {
    res.json({ spec: quickAdd.interpretQuickAdd(req.body || {}) });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

app.post('/api/tasks/bulk', (req, res) => {
  const body = req.body || {};

  if (body.mode === 'campaign' || body.mode === 'campaign-range') {
    const ws = cfg.workspaces?.find(w => w.id === body.workspaceId) || cfg.workspaces?.[0];
    if (!ws) return res.status(400).json({ error: 'no_workspace' });
    const opts = {};
    if (body.fromDay != null) opts.fromDay = Number(body.fromDay);
    if (body.toDay != null) opts.toDay = Number(body.toDay);
    const def = registry.get(ws.connector);
    const result = def.sync ? def.sync({ ws, store, templates, opts }) : { synced: 0 };
    return res.status(201).json({
      mode: 'campaign',
      workspaceId: ws.id,
      fromDay: opts.fromDay || null,
      toDay: opts.toDay || null,
      ...result,
    });
  }

  const jobs = stripGuideForImport(body) || body.jobs;
  if (!Array.isArray(jobs) || !jobs.length) {
    return res.status(400).json({ error: 'jobs_required', hint: 'Send jobs array, or a file with _guide + jobs' });
  }

  const created = [];
  const errors = [];
  for (let i = 0; i < jobs.length; i++) {
    try {
      created.push(createTaskFromBody(stripExampleComments(jobs[i])));
    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }

  if (!created.length) return res.status(400).json({ error: 'bulk_failed', errors });
  res.status(201).json({ created: created.length, tasks: created, errors });
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (task.status === 'completed' && !req.body.force) {
    return res.status(400).json({ error: 'completed_tasks_readonly', hint: 'Duplicate to edit' });
  }
  let patch = { ...req.body };
  if (patch.schedule) {
    try {
      const merged = scheduler.prepareSchedule({ ...task.schedule, ...patch.schedule });
      patch = {
        ...patch,
        schedule: merged,
        status: resolveStatusFromSchedule(merged, patch.status || task.status),
      };
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  const updated = store.updateTask(req.params.id, patch);
  const ws = cfg.workspaces?.find(w => w.id === updated.workspaceId);
  registry.get(ws?.connector).onReschedule?.({ ws, task: updated });
  res.json(enrichTask(updated));
});

app.post('/api/tasks/:id/start', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (task.status === 'running') return res.status(400).json({ error: 'already_running' });
  if (enrichTask(task).paused) return res.status(409).json({ error: 'paused', hint: 'Resume the day or campaign first' });
  if (task.muted) return res.status(409).json({ error: 'muted', hint: 'Unmute this job first' });
  const patch = {
    status: 'scheduled',
    schedule: { ...task.schedule, type: 'now', priority: 95 },
  };
  if (task.status === 'failed') {
    patch.execution = { ...task.execution, attempts: 0, error: null, finishedAt: null };
  }
  store.updateTask(task.id, patch);
  res.json({ queued: true, task: store.getTask(task.id) });
});

app.post('/api/tasks/:id/run-now', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (enrichTask(task).paused) return res.status(409).json({ error: 'paused', hint: 'Resume the day or campaign first' });
  if (task.muted) return res.status(409).json({ error: 'muted', hint: 'Unmute this job first' });
  if (store.runningTasks().length >= store.getSettings().maxConcurrent) {
    return res.status(409).json({ error: 'system_busy', hint: 'Another task is running' });
  }
  try {
    const result = await worker.executeTask({ ...task, status: 'scheduled' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks/:id/duplicate', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const copy = store.createTask({
    workspaceId: task.workspaceId,
    templateId: task.templateId,
    title: `${task.title} (copy)`,
    summary: task.summary,
    status: 'draft',
    runMode: task.runMode,
    schedule: { type: 'manual' },
    instructions: { ...task.instructions },
    inputs: { ...task.inputs },
    outputs: task.outputs,
    connector: task.execution?.connector || templates.getTemplate(task.templateId)?.connector,
    source: 'duplicate',
    sourceRef: task.id,
  });
  res.status(201).json(copy);
});

app.post('/api/tasks/:id/mute', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  res.json(enrichTask(store.updateTask(req.params.id, { muted: true })));
});

app.post('/api/tasks/:id/unmute', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  res.json(enrichTask(store.updateTask(req.params.id, { muted: false })));
});

app.delete('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (task.status === 'running') return res.status(400).json({ error: 'cannot_delete_running' });
  store.deleteTask(req.params.id);
  res.json({ deleted: true });
});

app.post('/api/tasks/:id/stop', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const updated = await worker.stopTask(req.params.id);
  res.json(enrichTask(updated));
});

app.post('/api/tasks/:id/resume', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const updated = await worker.resumeTask(req.params.id);
  res.json(enrichTask(updated));
});

app.post('/api/workspaces/:id/pause', async (req, res) => {
  const ws = cfg.workspaces?.find(w => w.id === req.params.id);
  if (!ws) return res.status(404).json({ error: 'not_found' });
  const result = await worker.pauseWorkspace(req.params.id);
  res.json(result);
});

app.post('/api/workspaces/:id/resume', async (req, res) => {
  const ws = cfg.workspaces?.find(w => w.id === req.params.id);
  if (!ws) return res.status(404).json({ error: 'not_found' });
  const result = await worker.resumeWorkspace(req.params.id);
  res.json(result);
});

app.get('/api/workspaces/:id/campaign-plan', (req, res) => {
  const ws = cfg.workspaces?.find(w => w.id === req.params.id);
  const def = registry.get(ws?.connector);
  if (!ws || !def.getCampaignPlan) return res.status(404).json({ error: 'not_found' });
  res.json({ days: def.getCampaignPlan({ ws }) });
});

app.put('/api/workspaces/:id/campaign-plan', (req, res) => {
  const ws = cfg.workspaces?.find(w => w.id === req.params.id);
  const def = registry.get(ws?.connector);
  if (!ws || !def.setCampaignPlan) return res.status(404).json({ error: 'not_found' });
  const days = req.body?.days;
  const { ok, errors } = def.validateCampaignPlan({ days });
  if (!ok) return res.status(400).json({ error: 'invalid_plan', errors });
  const saved = def.setCampaignPlan({ ws, days });
  res.json({ saved: true, count: saved.length });
});

app.post('/api/campaigns', (req, res) => {
  const { name, targetPath, totalDays, startDate, timezone, dailyRunHour, dailyRunMinute, brandName, brandDomain } = req.body || {};
  if (!name || !targetPath || !startDate) {
    return res.status(400).json({ error: 'name, targetPath, and startDate are required' });
  }
  const id = leaptr.slugify(name);
  if (cfg.workspaces?.some(w => w.id === id)) {
    return res.status(400).json({ error: `A workspace called "${id}" already exists` });
  }

  const meta = {
    campaignStart: startDate,
    totalDays: Number(totalDays) || 30,
    timezone: timezone || cfg.scheduler?.defaultTimezone || 'America/Denver',
    dailyRunHour: Number.isFinite(Number(dailyRunHour)) ? Number(dailyRunHour) : 7,
    dailyRunMinute: Number(dailyRunMinute) || 0,
  };

  let scaffold;
  try {
    scaffold = leaptr.scaffoldCampaign({ name, targetPath, ...meta, startDate, brandName, brandDomain });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const workspace = {
    id,
    name,
    description: `Autopilot campaign — ${name}`,
    connector: ids.LEAPTR_CAMPAIGN,
    rootPath: scaffold.autopilotDir,
    enabled: true,
    meta,
  };

  const configPath = path.join(ROOT, 'agentboard.config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(configPath, path.join(ROOT, `agentboard.config.json.bak-${stamp}`));
  raw.workspaces = [...(raw.workspaces || []), workspace];
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');

  // Reflect immediately in this running process — cfg was loaded once at boot.
  cfg.workspaces = [...(cfg.workspaces || []), workspace];

  res.status(201).json({ workspace });
});

app.post('/api/workspaces/:id/install-cron', (req, res) => {
  const ws = cfg.workspaces?.find(w => w.id === req.params.id);
  const def = registry.get(ws?.connector);
  if (!ws || !def.installCron) return res.status(404).json({ error: 'not_found' });
  try {
    const output = def.installCron({ ws });
    res.json({ installed: true, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tasks/:id/log', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task?.execution?.logPath) return res.json({ log: store.tailLog(store.taskLogPath(req.params.id)) });
  res.json({ log: store.tailLog(task.execution.logPath, Number(req.query.lines) || 300) });
});

app.post('/api/sync', (_req, res) => {
  res.json({ results: syncAllWorkspaces() });
});

app.patch('/api/settings', (req, res) => {
  res.json(store.saveSettings(req.body || {}));
});

app.get('/api/tasks/:id/outputs/:file', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const outDir = path.join(cfg.dataDir, 'outputs', task.id);
  const file = path.basename(req.params.file);
  const filePath = path.join(outDir, file);
  if (!filePath.startsWith(outDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.sendFile(filePath);
});

app.get('/api/assets/:workspaceId/:day/:file', (req, res) => {
  const ws = cfg.workspaces?.find(w => w.id === req.params.workspaceId);
  const def = registry.get(ws?.connector);
  const dayDir = def.dayOutputPath ? def.dayOutputPath({ ws, day: Number(req.params.day) }) : null;
  if (!ws || !dayDir) return res.status(404).end();
  const filePath = path.join(dayDir, path.basename(req.params.file));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.sendFile(filePath);
});

app.post('/api/notify/test', async (_req, res) => {
  const r = await omnish.notify('OmnishPilot test', 'Notifications are working.');
  res.json(r);
});

app.post('/api/delivery/test', async (_req, res) => {
  const r = await delivery.sendTestDelivery(store.getSettings());
  res.json(r);
});

app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

worker.startWorker();
supervisor.startSupervisor();
wake.startKeepAwake({ cfg, listTasks: () => store.listTasks() });

const PORT = Number(process.env.AGENTBOARD_PORT || cfg.port || 4580);
const HOST = process.env.AGENTBOARD_HOST || cfg.host || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[omnishpilot] http://${HOST}:${PORT}`);
});
