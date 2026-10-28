'use strict';

const fs = require('fs');
const path = require('path');
const { APP_ROOT, CLI_ROOT, requireApp } = require('./bootstrap');
const { defaultHome, openUrl, platformName, which } = require('./platform');
const client = require('./client');
const daemon = require('./daemon');
const service = require('./service');
const watch = require('./watch');
const { die, ok, parseArgs, flag, shortId, printJson, table } = require('./util');

const VERSION = require('../package.json').version;
const { loadConfig, PACKAGE_ROOT, ensureHomeScaffold } = requireApp('server/config');
const store = requireApp('server/store');
const templates = requireApp('server/templates');
const registry = requireApp('server/connectors/registry');
const agents = requireApp('server/agents');
const sandbox = requireApp('server/sandbox');

const HELP = `omnishpilot v${VERSION} (${platformName()})
Free autonomy harness: queue heavy agent jobs, run them unattended in a sandbox,
failover across any local/OSS agent CLI, track runs, notify when done.

Usage:
  omnishpilot <command> [args...]

Lifecycle:
  start [-d|--daemon]          Start the control plane (foreground by default)
  stop                         Stop the background daemon
  restart                      Restart the daemon
  status [--json]              Running state, URL, pid
  doctor [--json]              Check Node, agents, sandbox, Omnish, config
  open                         Print / open the UI URL
  watch [id] [--log] [--json]  Live dashboard, task log, or daemon log
  service <install|uninstall|status|logs|help>
                               OS login service (systemd / LaunchAgent / schtasks)

Autonomy & sandbox:
  sandbox status|check|deny-test [--json]
                               Isolation backend health + write-escape probe
  capabilities [--json]        What this install can do (have / gap)

Jobs:
  tasks [status] [--json]      List jobs
  task <id> [--json]           Show one job
  add <goal...> [flags]        Queue a job (deterministic — no LLM interpret)
  run <id>                     Queue a job to run now
  start-job|stop-job|resume <id>
  mute|unmute <id>
  rm <id>                      Delete a job
  log <id> [-n lines]          Tail a job log
  duplicate <id>

Schedule & ops:
  dashboard [--json]
  calendar [--month M] [--day D] [--json]
  sync
  workspaces [--json]
  agents [--json]
  templates
  notify-test | delivery-test

Config:
  config show|path|init
  version

Global flags:
  --no-autostart               Do not auto-start daemon for API commands

Env:
  OMNISHPILOT_HOME             Runtime data/config root
  OMNISHPILOT_PACKAGE_ROOT     App package (server+public) root
  OMNISHPILOT_PORT / HOST      Override bind for CLI client
  OMNISHPILOT_NO_AUTOSTART=1   Same as --no-autostart

Install elsewhere:
  cd omnishpilot-cli && bash install.sh
  # or: npm install && npm run sync && npm link

add — agent contract (CLI does NOT interpret like the UI):
  Bare text becomes an agent-task. Default schedule is once, 5 minutes from now
  (queued — not immediate). Use --now for the front of the queue.

  Required:  <goal...>                 What the agent should do (free text)
  Optional:  --workspace|-w <path>     Codebase / working folder
             --template|-t <id>        agent-task (default) | code-task | research | …
             --title <text>            Short title (default: truncated goal)
             --agent <id>              cursor-agent | claude | agy | auto
             --acceptance <text>       Done-when criteria (enforced as gates)
             --in <minutes>            Delay before run (default: 5)
             --now                     Run ASAP (schedule type now)
             --json                    Print created task JSON

  Meaning of plain text:
    omnishpilot add "do xyz"
      → template=agent-task, goal="do xyz", status=scheduled,
        runAt=now+5m, runMode=auto

Examples:
  omnishpilot doctor
  omnishpilot sandbox deny-test
  omnishpilot service install
  omnishpilot watch
  omnishpilot add "research competitor pricing into a one-pager"
  omnishpilot add --workspace ~/proj --now "fix the auth redirect"
  omnishpilot add --in 15 --agent claude "draft release notes"
`;

function applyGlobalFlags(flags) {
  if (flag(flags, 'no-autostart')) process.env.OMNISHPILOT_NO_AUTOSTART = '1';
}

function resolveTaskId(partial) {
  const tasks = store.listTasks();
  const exact = tasks.find((t) => t.id === partial);
  if (exact) return exact.id;
  const matches = tasks.filter((t) => t.id.startsWith(partial));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) die(`Ambiguous id "${partial}" — matches ${matches.length} jobs`);
  die(`No job matching "${partial}"`);
}

function redactConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  if (copy.auth?.password) copy.auth.password = '***';
  if (copy.auth?.sessionSecret) copy.auth.sessionSecret = '***';
  delete copy._root;
  delete copy._packageRoot;
  return copy;
}

async function cmdDoctor(flags) {
  const cfg = loadConfig();
  const checks = [];
  const push = (id, okFlag, detail) => checks.push({ id, ok: okFlag, detail });

  push('node', true, `${process.version} (need >=18)`);
  push('platform', true, platformName());
  push('cli', true, CLI_ROOT);
  push('package', fs.existsSync(path.join(APP_ROOT, 'server', 'index.js')), APP_ROOT);
  push('runtime_root', true, cfg._root);
  push('data_dir', fs.existsSync(cfg.dataDir), cfg.dataDir);
  push(
    'config',
    fs.existsSync(path.join(cfg._root, 'omnishpilot.config.json'))
      || fs.existsSync(path.join(cfg._root, 'omnishpilot.config.local.json')),
    path.join(cfg._root, 'omnishpilot.config.json')
  );

  const omnishBin = cfg.omnish?.bin || 'omnish';
  const omnishPath = which(omnishBin);
  push('omnish', Boolean(omnishPath), omnishPath || `not found (${omnishBin})`);

  const agentRunCandidates = [
    cfg.agent?.agentRunBin,
    'agent-run',
    path.join(require('os').homedir(), '.local', 'bin', 'agent-run'),
  ].filter(Boolean);
  let agentRunPath = null;
  for (const c of agentRunCandidates) {
    agentRunPath = which(c) || (path.isAbsolute(c) && fs.existsSync(c) ? c : null);
    if (agentRunPath) break;
  }
  push('agent-run', Boolean(agentRunPath), agentRunPath || 'not found (agent-run)');

  let agentList = [];
  try {
    agentList = agents.getAgentsWithHealth();
  } catch {
    agentList = [];
  }
  const availableAgents = agentList.filter((a) => a.available);
  push(
    'agents',
    availableAgents.length > 0,
    availableAgents.length ? availableAgents.map((a) => a.id).join(', ') : 'no available agent CLIs'
  );

  const workspaces = cfg.workspaces || [];
  const enabled = workspaces.filter((w) => w.enabled);
  const withPath = enabled.filter((w) => w.rootPath && fs.existsSync(w.rootPath));
  push(
    'workspaces',
    enabled.length === 0 || withPath.length > 0,
    `${withPath.length}/${enabled.length} enabled workspaces have a valid rootPath`
  );

  const st = await daemon.status();
  push(
    'daemon',
    true,
    st.running ? `running at ${st.url}${st.pid ? ` (pid ${st.pid})` : ''}` : 'not running — omnishpilot start -d'
  );

  const svc = service.serviceStatus();
  push('service', true, svc.installed
    ? `installed (${svc.platform}${svc.active ? ', active' : ''})`
    : `not installed — omnishpilot service install`);

  const sb = sandbox.status(cfg);
  const gate = sandbox.canRunAutonomous(cfg);
  push(
    'sandbox',
    gate.ok,
    gate.ok
      ? `${sb.backend} — ${sb.note}`
      : `${sb.backend}: ${gate.reason}`
  );
  push('sandbox_root', !sb.runningAsRoot, sb.runningAsRoot ? 'running as root — autonomous refused' : 'non-root ok');

  if (flag(flags, 'json')) {
    printJson({
      version: VERSION,
      platform: platformName(),
      checks,
      status: st,
      service: svc,
      sandbox: sb,
      autonomous: gate,
    });
    return;
  }

  console.log(`OmnishPilot doctor v${VERSION} (${platformName()})\n`);
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? 'ok' : '!!';
    if (!c.ok) failed++;
    console.log(`  [${mark}] ${c.id.padEnd(14)} ${c.detail}`);
  }
  console.log(failed ? `\n${failed} issue(s) — fix paths/sandbox, then retry.` : '\nReady for unattended jobs.');
  if (failed) process.exitCode = 1;
}

async function cmdStart(flags) {
  const daemonize = Boolean(flag(flags, 'd', 'daemon'));
  if (daemonize) {
    const r = await daemon.startDaemon();
    if (r.error) die(r.error);
    if (r.already) ok(`Already running at ${r.url}`);
    else ok(`Started${r.pid ? ` (pid ${r.pid})` : ''} → ${r.url}`);
    if (r.warning) console.error(r.warning);
    if (r.logFile) ok(`Log: ${r.logFile}`);
    return;
  }
  ok(`Starting OmnishPilot at ${client.baseUrl()} …`);
  daemon.startForeground();
}

async function cmdStop() {
  const r = await daemon.stop();
  if (r.already) ok('Not running.');
  else if (r.error) die(r.error);
  else ok(`Stopped${r.forced ? ' (forced)' : ''}${r.pid ? ` pid ${r.pid}` : ''}.`);
}

async function cmdRestart() {
  await daemon.stop();
  await cmdStart({ d: true, daemon: true });
}

async function cmdStatus(flags) {
  const st = await daemon.status();
  if (flag(flags, 'json')) return printJson(st);
  console.log(`running:  ${st.running ? 'yes' : 'no'}`);
  console.log(`url:      ${st.url}`);
  console.log(`pid:      ${st.pid || '—'}`);
  console.log(`platform: ${st.platform}`);
  console.log(`package:  ${st.packageRoot}`);
  console.log(`root:     ${st.root}`);
  console.log(`data:     ${st.dataDir}`);
  if (st.health) console.log(`health:   ${JSON.stringify(st.health)}`);
}

async function cmdService(flags, positionals) {
  const sub = (positionals[0] || 'help').toLowerCase();
  if (sub === 'help' || sub === '-h') {
    console.log(`omnishpilot service — ${platformName()} login service

Commands:
  install      Install + enable (systemd user / LaunchAgent / schtasks)
  uninstall    Remove service unit/task
  status       Show install state
  logs         Show daemon log path / hints
  help

Hints:`);
    for (const h of service.hints()) console.log(`  ${h}`);
    return;
  }
  if (sub === 'install') {
    const r = service.install();
    if (r.error) die(r.error);
    printJson(r);
    ok('Service installed. Daemon should start on login.');
    return;
  }
  if (sub === 'uninstall') {
    printJson(service.uninstall());
    return;
  }
  if (sub === 'status') {
    const r = { ...service.serviceStatus(), daemon: await daemon.status() };
    if (flag(flags, 'json')) return printJson(r);
    console.log(`platform:  ${r.platform}`);
    console.log(`installed: ${r.installed ? 'yes' : 'no'}`);
    if (r.active != null) console.log(`active:    ${r.active ? 'yes' : 'no'}`);
    if (r.unit) console.log(`unit:      ${r.unit}`);
    if (r.plist) console.log(`plist:     ${r.plist}`);
    if (r.task) console.log(`task:      ${r.task}`);
    console.log(`daemon:    ${r.daemon.running ? r.daemon.url : 'not running'}`);
    return;
  }
  if (sub === 'logs') {
    const cfg = loadConfig();
    const logFile = daemon.logPath(cfg);
    ok(logFile);
    for (const h of service.hints()) console.log(h);
    return;
  }
  die(`Unknown service subcommand: ${sub}`);
}

async function cmdWatch(flags, positionals) {
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    await watch.watchMain({
      taskId: positionals[0] ? resolveTaskId(positionals[0]) : null,
      daemonLog: Boolean(flag(flags, 'log', 'daemon-log')),
      intervalMs: Number(flag(flags, 'interval', 'i') || 2000),
      json: Boolean(flag(flags, 'json')),
      signal: ac.signal,
    });
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

async function cmdTasks(flags, positionals) {
  const statusFilter = positionals[0] || flag(flags, 'status') || '';
  const asJson = Boolean(flag(flags, 'json'));
  let tasks;
  const live = await client.health();
  if (live) {
    const r = await client.get('/api/tasks', {
      query: {
        status: statusFilter || undefined,
        workspaceId: flag(flags, 'workspace', 'w') || undefined,
      },
    });
    if (!r.ok) die(`API error ${r.status}: ${JSON.stringify(r.data)}`);
    tasks = r.data;
  } else {
    tasks = store.listTasks({
      status: statusFilter || undefined,
      workspaceId: flag(flags, 'workspace', 'w') || undefined,
    });
  }
  if (asJson) return printJson(tasks);
  table(tasks.map((t) => ({
    id: shortId(t.id),
    status: t.status,
    title: (t.title || '').slice(0, 48),
    when: t.schedule?.type || '—',
    workspace: (t.workspaceName || t.workspaceId || '').slice(0, 20),
  })), ['id', 'status', 'title', 'when', 'workspace']);
}

async function cmdTask(flags, positionals) {
  const id = resolveTaskId(positionals[0] || die('Usage: omnishpilot task <id>'));
  const live = await client.health();
  let payload;
  if (live) {
    const r = await client.get(`/api/tasks/${id}`);
    if (!r.ok) die(JSON.stringify(r.data));
    payload = r.data;
  } else {
    payload = { task: store.getTask(id) };
  }
  const task = payload.task || payload;
  if (!task) die('not found');
  if (flag(flags, 'json')) return printJson(payload);
  console.log(`${task.title}`);
  console.log(`id:       ${task.id}`);
  console.log(`status:   ${task.status}${task.muted ? ' (muted)' : ''}`);
  console.log(`template: ${task.templateId}`);
  console.log(`runMode:  ${task.runMode}`);
  console.log(`schedule: ${JSON.stringify(task.schedule)}`);
  if (task.execution?.error) console.log(`error:    ${task.execution.error}`);
  if (task.summary) console.log(`summary:  ${task.summary}`);
}

const DEFAULT_ADD_DELAY_MIN = 5;

function buildCliAddSpec(flags, positionals) {
  const goal = positionals.join(' ').trim();
  if (!goal) {
    die(`Usage: omnishpilot add <goal...>

CLI add is deterministic (no UI-style LLM interpret).
  Plain text → agent-task, scheduled once at now+${DEFAULT_ADD_DELAY_MIN}m.

  omnishpilot add "do xyz"
  omnishpilot add --workspace ~/repo --now "fix login redirect"
  omnishpilot add --in 15 --agent claude --acceptance "result.md exists" "draft notes"

See: omnishpilot --help  (section: add — agent contract)`);
  }

  const templateId = String(flag(flags, 'template', 't') || 'agent-task');
  const workspace = String(flag(flags, 'workspace', 'w') || '').trim();
  const titleFlag = flag(flags, 'title');
  const title = String(titleFlag || goal).replace(/\s+/g, ' ').trim().slice(0, 80);
  const agentId = flag(flags, 'agent') || 'auto';
  const acceptance = flag(flags, 'acceptance') || '';
  const wantNow = Boolean(flag(flags, 'now'));
  const delayRaw = flag(flags, 'in', 'delay');
  let delayMin = DEFAULT_ADD_DELAY_MIN;
  if (delayRaw != null && delayRaw !== true) {
    const n = Number(delayRaw);
    if (!Number.isFinite(n) || n < 0) die(`--in must be minutes >= 0 (got ${delayRaw})`);
    delayMin = n;
  }

  const runAt = wantNow
    ? new Date().toISOString()
    : new Date(Date.now() + delayMin * 60 * 1000).toISOString();

  const schedule = wantNow
    ? { type: 'now', runAt, priority: 90 }
    : { type: 'once', runAt, priority: 50 };

  return {
    templateId,
    title,
    summary: goal.slice(0, 240),
    status: 'scheduled',
    runMode: flag(flags, 'run-mode') || 'auto',
    schedule,
    instructions: {
      agentPrompt: '',
      acceptance: acceptance || 'Write result.md summarizing what you did and how you verified it.',
      deliverables: 'Save outputs under the job output directory and write result.md.',
      constraints: acceptance || '',
    },
    inputs: {
      title,
      goal,
      workspace,
      agentId,
    },
    acceptance: acceptance
      ? { requiredArtifacts: ['result.md'], soft: false }
      : { requiredArtifacts: ['result.md'] },
    source: 'cli',
    maxAttempts: Number(flag(flags, 'max-attempts')) || 3,
  };
}

async function cmdAdd(flags, positionals) {
  const spec = buildCliAddSpec(flags, positionals);
  const dry = Boolean(flag(flags, 'dry-run', 'n'));
  if (dry) {
    printJson(spec);
    return;
  }

  await client.ensureApi();
  const created = await client.post('/api/tasks', {
    ...spec,
    workspaceId: flag(flags, 'workspace-id') || undefined,
  });
  if (!created.ok) die(created.data?.error || JSON.stringify(created.data));
  const task = created.data;

  if (flag(flags, 'json')) {
    printJson(task);
    return;
  }

  const when = task.schedule?.type === 'now'
    ? 'queued now'
    : `queued for ${task.schedule?.runAt || 'later'}`;
  ok(`Created ${shortId(task.id)} — ${task.title}`);
  ok(`  template=${task.templateId}  status=${task.status}  ${when}`);
  if (task.inputs?.workspace) ok(`  workspace=${task.inputs.workspace}`);
  if (task.inputs?.agentId && task.inputs.agentId !== 'auto') ok(`  agent=${task.inputs.agentId}`);
}

async function cmdMutate(action, positionals) {
  const id = resolveTaskId(positionals[0] || die(`Usage: omnishpilot ${action} <id>`));
  await client.ensureApi();
  const map = {
    run: `/api/tasks/${id}/run-now`,
    'start-job': `/api/tasks/${id}/start`,
    'stop-job': `/api/tasks/${id}/stop`,
    resume: `/api/tasks/${id}/resume`,
    mute: `/api/tasks/${id}/mute`,
    unmute: `/api/tasks/${id}/unmute`,
    duplicate: `/api/tasks/${id}/duplicate`,
  };
  const r = await client.post(map[action]);
  if (!r.ok) die(r.data?.error || JSON.stringify(r.data));
  if (action === 'duplicate') ok(`Duplicated → ${shortId(r.data.id)} — ${r.data.title}`);
  else ok(`${action}: ${shortId(id)} → ${r.data.status || 'ok'}`);
}

async function cmdRm(positionals) {
  const id = resolveTaskId(positionals[0] || die('Usage: omnishpilot rm <id>'));
  await client.ensureApi();
  const r = await client.del(`/api/tasks/${id}`);
  if (!r.ok) die(r.data?.error || JSON.stringify(r.data));
  ok(`Deleted ${shortId(id)}`);
}

async function cmdLog(flags, positionals) {
  const id = resolveTaskId(positionals[0] || die('Usage: omnishpilot log <id>'));
  const lines = Number(flag(flags, 'n', 'lines') || 80);
  await client.ensureApi({ autoStart: false }).catch(() => null);
  const live = await client.health();
  if (live) {
    const r = await client.get(`/api/tasks/${id}/log`, { query: { lines } });
    if (!r.ok) die(JSON.stringify(r.data));
    const text = typeof r.data === 'string' ? r.data : (r.data?.log || '');
    console.log(text.split('\n').slice(-lines).join('\n') || '(empty)');
    return;
  }
  const task = store.getTask(id);
  if (!task) die('not found');
  const logFile = task.execution?.logPath || store.taskLogPath(id);
  console.log(store.tailLog(logFile, lines) || '(empty)');
}

async function cmdDashboard(flags) {
  await client.ensureApi();
  const r = await client.get('/api/dashboard');
  if (!r.ok) die(JSON.stringify(r.data));
  if (flag(flags, 'json')) return printJson(r.data);
  const s = r.data.stats || {};
  console.log(`total ${s.total || 0}  running ${s.running || 0}  scheduled ${s.scheduled || 0}  failed ${s.failed || 0}  drafts ${s.drafts || 0}`);
  if (r.data.running?.length) {
    console.log('\nRunning:');
    for (const t of r.data.running) console.log(`  ${shortId(t.id)}  ${t.title}`);
  }
  if (r.data.upcoming?.length) {
    console.log('\nUpcoming:');
    for (const t of r.data.upcoming.slice(0, 10)) console.log(`  ${shortId(t.id)}  ${t.title}`);
  }
  if (r.data.failed?.length) {
    console.log('\nFailed:');
    for (const t of r.data.failed.slice(0, 10)) console.log(`  ${shortId(t.id)}  ${t.title}`);
  }
}

async function cmdCalendar(flags) {
  await client.ensureApi();
  const now = new Date();
  const year = Number(flag(flags, 'year') || now.getFullYear());
  const month = Number(flag(flags, 'month') || now.getMonth() + 1);
  const day = flag(flags, 'day');
  const r = await client.get('/api/calendar', {
    query: { year, month, day: day != null ? day : undefined },
  });
  if (!r.ok) die(JSON.stringify(r.data));
  if (flag(flags, 'json')) return printJson(r.data);
  console.log(`${r.data.monthName} ${r.data.year} (${r.data.timezone}) — ${r.data.stats?.monthEvents || 0} events`);
  for (const d of r.data.days || []) {
    if (!d.count && !d.events?.length) continue;
    const count = d.count ?? d.events?.length ?? 0;
    console.log(`  ${d.date || d.key || d.day}: ${count} event(s)`);
  }
  if (r.data.selectedDay?.events?.length) {
    console.log(`\nDay ${r.data.selectedDay.date}:`);
    for (const e of r.data.selectedDay.events) {
      console.log(`  ${(e.label || e.time || '').padEnd(10)} ${e.title}`);
    }
  }
}

async function cmdSync() {
  const live = await client.health();
  if (live) {
    const r = await client.post('/api/sync');
    if (!r.ok) die(JSON.stringify(r.data));
    printJson(r.data);
    return;
  }
  const cfg = loadConfig();
  ok('[sync] OmnishPilot workspace sync (offline)');
  for (const ws of cfg.workspaces || []) {
    const def = registry.get(ws.connector);
    if (def.sync && ws.enabled) {
      const result = def.sync({ ws, store, templates });
      ok(`  ${ws.name}: ${result.synced} tasks`);
    }
  }
  ok('[sync] done');
}

function cmdWorkspaces(flags) {
  const cfg = loadConfig();
  const rows = (cfg.workspaces || []).map((w) => ({
    id: w.id,
    enabled: w.enabled ? 'yes' : 'no',
    connector: w.connector,
    path: w.rootPath && fs.existsSync(w.rootPath) ? w.rootPath : `${w.rootPath || '—'} (missing)`,
    name: w.name,
  }));
  if (flag(flags, 'json')) return printJson(cfg.workspaces || []);
  table(rows, ['id', 'enabled', 'connector', 'name', 'path']);
}

function cmdAgents(flags) {
  const list = agents.getAgentsWithHealth();
  if (flag(flags, 'json')) return printJson(list);
  table(list.map((a) => ({
    id: a.id,
    available: a.available ? 'yes' : 'no',
    cooldown: a.inCooldown ? 'yes' : 'no',
    bin: a.bin || a.path || '',
  })), ['id', 'available', 'cooldown', 'bin']);
}

function cmdTemplates() {
  for (const t of templates.TEMPLATES) {
    console.log(`${t.id.padEnd(16)} ${t.name} — ${t.description}`);
  }
}

function cmdSandbox(flags, positionals) {
  const cfg = loadConfig();
  const sub = (positionals[0] || 'status').toLowerCase();
  if (sub === 'help' || sub === '-h') {
    console.log(`omnishpilot sandbox — isolate unattended agent runs

Commands:
  status       Backend detection + policy (default)
  check        Same as status; exit 1 if autonomous gate fails
  deny-test    Prove outside writes fail inside the sandbox
  help

Config (omnishpilot.config.json → sandbox):
  enabled                default true
  backend                auto | bwrap | docker | firejail | none
  network                default true (agents need model APIs)
  requireForAutonomous   default true — refuse bare YOLO if sandbox unhealthy
  hidePaths              mask ~/.ssh ~/.aws ~/.gnupg ~/.kube …
  extraBindRw            extra RW mounts
`);
    return;
  }
  if (sub === 'status' || sub === 'check') {
    const st = sandbox.status(cfg);
    const gate = sandbox.canRunAutonomous(cfg);
    if (flag(flags, 'json')) {
      printJson({ ...st, autonomous: gate });
    } else {
      console.log(`enabled:     ${st.enabled ? 'yes' : 'no'}`);
      console.log(`backend:     ${st.backend}${st.backendBin ? ` (${st.backendBin})` : ''}`);
      console.log(`network:     ${st.network ? 'on' : 'off'}`);
      console.log(`require:     ${st.requireForAutonomous ? 'yes' : 'no'}`);
      console.log(`healthy:     ${st.healthy ? 'yes' : 'no'}`);
      console.log(`autonomous:  ${gate.ok ? 'ok' : 'blocked'} — ${gate.reason}`);
      console.log(`note:        ${st.note}`);
      if (st.available) {
        console.log(`available:   bwrap=${st.available.bwrap || '—'} docker=${st.available.docker || '—'} firejail=${st.available.firejail || '—'}`);
      }
    }
    if (sub === 'check' && !gate.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'deny-test') {
    ok('Running sandbox deny-test…');
    const r = sandbox.denyTest(cfg);
    if (flag(flags, 'json')) {
      printJson(r);
    } else {
      for (const row of r.results || []) {
        console.log(`  [${row.ok ? 'ok' : '!!'}] ${row.id.padEnd(14)} ${row.detail}`);
      }
      console.log(r.ok ? '\nDeny-test passed — outside writes blocked.' : `\nDeny-test FAILED${r.error ? `: ${r.error}` : ''}`);
    }
    if (!r.ok) process.exitCode = 1;
    return;
  }
  die(`Unknown sandbox subcommand: ${sub}`);
}

function cmdCapabilities(flags) {
  const cfg = loadConfig();
  const sb = sandbox.status(cfg);
  const gate = sandbox.canRunAutonomous(cfg);
  let agentList = [];
  try {
    agentList = agents.getAgentsWithHealth().filter((a) => a.available);
  } catch {
    agentList = [];
  }
  const caps = [
    { id: 'multi_agent', have: agentList.length > 0, detail: agentList.length ? agentList.map((a) => a.id).join(', ') : 'no agent CLIs detected' },
    { id: 'unattended_flags', have: true, detail: 'agent-run adapters use --yolo / --dangerously-skip-permissions' },
    { id: 'sandbox', have: sb.healthy, detail: sb.note },
    { id: 'autonomous_gate', have: gate.ok, detail: gate.reason },
    { id: 'schedule', have: true, detail: 'cron-like schedules + campaign days' },
    { id: 'supervisor', have: true, detail: 'dead-PID requeue + Omnish heartbeats' },
    { id: 'notify', have: Boolean(which(cfg.omnish?.bin || 'omnish')), detail: 'Omnish delivery on complete' },
    { id: 'failover', have: true, detail: 'preferredOrder + rate-limit cooldown + resume-at-reset' },
    { id: 'acceptance_gates', have: true, detail: 'required artifacts + test command; retry until green' },
    { id: 'git_worktree', have: true, detail: 'isolated git worktree per generic-agent run' },
    { id: 'verifier_agent', have: true, detail: 'optional second agent VERDICT: PASS|FAIL before ship' },
    { id: 'webhook_triggers', have: true, detail: 'POST /hooks/{github,linear,generic}?token=…' },
    { id: 'hang_detector', have: true, detail: 'approval/TTY idle + job timeout kill' },
    { id: 'morning_pack', have: true, detail: 'Omnish pack: gate + artifacts + diff on complete' },
  ];
  if (flag(flags, 'json')) return printJson({ sandbox: sb, agents: agentList.map((a) => a.id), capabilities: caps });
  console.log(`OmnishPilot capabilities v${VERSION}\n`);
  for (const c of caps) {
    console.log(`  [${c.have ? 'have' : 'gap '}] ${c.id.padEnd(18)} ${c.detail}`);
  }
}

async function cmdNotifyTest() {
  await client.ensureApi();
  const r = await client.post('/api/notify/test');
  printJson(r.data);
  if (!r.ok) process.exitCode = 1;
}

async function cmdDeliveryTest() {
  await client.ensureApi();
  const r = await client.post('/api/delivery/test');
  printJson(r.data);
  if (!r.ok) process.exitCode = 1;
}

function cmdConfig(flags, positionals) {
  const sub = positionals[0] || 'show';
  const cfg = loadConfig();
  if (sub === 'path') {
    console.log(`cli:     ${CLI_ROOT}`);
    console.log(`package: ${PACKAGE_ROOT}`);
    console.log(`app:     ${APP_ROOT}`);
    console.log(`root:    ${cfg._root}`);
    console.log(`home:    ${defaultHome()}`);
    console.log(`data:    ${cfg.dataDir}`);
    console.log(`config:  ${path.join(cfg._root, 'omnishpilot.config.json')}`);
    return;
  }
  if (sub === 'init') {
    const home = process.env.OMNISHPILOT_HOME
      ? path.resolve(process.env.OMNISHPILOT_HOME)
      : defaultHome();
    ensureHomeScaffold(home);
    ok(`Initialized ${home}`);
    ok(`Edit ${path.join(home, 'omnishpilot.config.json')}`);
    ok(`Then: OMNISHPILOT_HOME=${home} omnishpilot doctor`);
    return;
  }
  if (sub === 'show') {
    printJson(redactConfig(cfg));
    return;
  }
  die(`Unknown config subcommand: ${sub}`);
}

function cmdOpen() {
  const url = client.baseUrl();
  ok(url);
  openUrl(url);
}

async function main(argv) {
  const { flags, positionals } = parseArgs(argv);
  applyGlobalFlags(flags);

  if (flag(flags, 'h', 'help') && !positionals.length) {
    process.stdout.write(HELP);
    return;
  }
  if (flag(flags, 'v', 'version') && !positionals.length) {
    console.log(VERSION);
    return;
  }

  const cmd = (positionals[0] || 'help').toLowerCase();
  const rest = positionals.slice(1);

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        break;
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        break;
      case 'doctor':
        await cmdDoctor(flags);
        break;
      case 'start':
      case 'ui':
        await cmdStart(flags);
        break;
      case 'run':
        if (rest[0]) await cmdMutate('run', rest);
        else await cmdStart(flags);
        break;
      case 'stop':
        await cmdStop();
        break;
      case 'restart':
        await cmdRestart();
        break;
      case 'status':
        await cmdStatus(flags);
        break;
      case 'service':
        await cmdService(flags, rest);
        break;
      case 'watch':
        await cmdWatch(flags, rest);
        break;
      case 'open':
        cmdOpen();
        break;
      case 'tasks':
      case 'ls':
        await cmdTasks(flags, rest);
        break;
      case 'task':
      case 'show':
        await cmdTask(flags, rest);
        break;
      case 'add':
      case 'quick-add':
        await cmdAdd(flags, rest);
        break;
      case 'run-job':
        await cmdMutate('run', rest);
        break;
      case 'start-job':
        await cmdMutate('start-job', rest);
        break;
      case 'stop-job':
        await cmdMutate('stop-job', rest);
        break;
      case 'resume':
        await cmdMutate('resume', rest);
        break;
      case 'mute':
        await cmdMutate('mute', rest);
        break;
      case 'unmute':
        await cmdMutate('unmute', rest);
        break;
      case 'duplicate':
        await cmdMutate('duplicate', rest);
        break;
      case 'rm':
      case 'delete':
        await cmdRm(rest);
        break;
      case 'log':
      case 'logs':
        await cmdLog(flags, rest);
        break;
      case 'dashboard':
      case 'dash':
        await cmdDashboard(flags);
        break;
      case 'calendar':
      case 'cal':
        await cmdCalendar(flags);
        break;
      case 'sync':
        await cmdSync();
        break;
      case 'workspaces':
      case 'ws':
        cmdWorkspaces(flags);
        break;
      case 'agents':
        cmdAgents(flags);
        break;
      case 'templates':
        cmdTemplates();
        break;
      case 'sandbox':
      case 'sbx':
        cmdSandbox(flags, rest);
        break;
      case 'capabilities':
      case 'caps':
        cmdCapabilities(flags);
        break;
      case 'notify-test':
        await cmdNotifyTest();
        break;
      case 'delivery-test':
        await cmdDeliveryTest();
        break;
      case 'config':
        cmdConfig(flags, rest);
        break;
      default:
        die(`Unknown command: ${cmd}\n\nRun: omnishpilot help`);
    }
  } catch (e) {
    if (e.code === 'NOT_RUNNING' || e.code === 'START_FAILED' || e.code === 'NOT_HEALTHY') die(e.message);
    die(e.message || String(e));
  }
}

module.exports = { main, HELP, VERSION };
