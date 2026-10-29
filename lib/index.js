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
const { loadConfig, updateConfig, configFilePath, PACKAGE_ROOT, ensureHomeScaffold, ROOT } = requireApp('server/config');
const auth = requireApp('server/auth');
const store = requireApp('server/store');
const templates = requireApp('server/templates');
const registry = requireApp('server/connectors/registry');
const agents = requireApp('server/agents');
const sandbox = requireApp('server/sandbox');
const ledger = requireApp('server/ledger');
const scheduler = requireApp('server/scheduler');
const budget = requireApp('server/budget');

const HELP = `omnishpilot v${VERSION} (${platformName()})
Autonomy harness for agents and humans: queue jobs, run unattended in a sandbox,
track progress, get notified when done. CLI is deterministic (no LLM interpret).

Usage:
  omnishpilot <command> [args...]

Lifecycle:
  start [-d|--daemon]          Start control plane (foreground by default)
  stop | restart | status [--json]
  doctor [--json]              Node, agents, sandbox, Omnish, config
  open                         Print / open the UI URL
  service <install|uninstall|status|logs|help>

Jobs — create:
  add <goal...> [schedule] [flags]
                               Create a scheduled job (see ADD CONTRACT below)

Jobs — inspect / track (for agents that scheduled work):
  tasks [status] [--json]      List jobs (status: scheduled|running|completed|failed)
  task <id> [--json]           Full job record
  progress <id> [--json]       One-shot status + last log lines + gates
  follow|wait <id> [--timeout SEC] [--poll MS] [--json]
                               Stream progress until completed/failed (exit 0/1)
  watch [id] [--log] [--json]  Live dashboard, or follow one job log
  log <id> [-n lines]          Tail job log once

Jobs — control:
  run <id>                     Run this job now
  start-job|stop-job|resume <id>
  mute|unmute <id> | rm <id> | duplicate <id>

Schedule & ops:
  dashboard [--json] | calendar [--month M] [--day D] [--json]
  sync | workspaces [--json] | agents [--json] | templates
  sandbox status|check|deny-test [--json]
  capabilities [--json]
  budget [--minutes N] [--usd N] [--off] [--json]
                               Cap agent time per day / reported spend per month
  notify-test | delivery-test

Auth (local config — you do not need the old UI password to set a new one):
  password status [--json]     Is auth on? Still using the built-in default?
  password set <new>           Set / replace UI password in config
  password change --from <old> --to <new>
                               Change password (verifies old first)

Config:
  config show|path|init
  version

──────────────────────── ADD CONTRACT (for agents) ────────────────────────
CLI does NOT call the UI interpreter. Flags map 1:1 to the job record.

Default (bare text):
  omnishpilot add "do xyz"
    → template=agent-task, goal="do xyz", status=scheduled,
      schedule=once at now+5 minutes, runMode=auto

One-shot:
  --now                        Run immediately after create (not +5m)
  --in <minutes>               One-shot delay (default 5 if no other schedule)
  --at <ISO|YYYY-MM-DDTHH:MM>  One-shot at absolute time

Repeatable:
  --interval <minutes>         Every N minutes (min 5)
  --hourly [:<MM>|MM]          Every hour at minute MM (default :00)
  --daily <HH:MM>              Every day at HH:MM (24h)
  --weekly <DAY> <HH:MM>       Every week (DAY=mon..sun or 0..6)

Common flags:
  --workspace|-w <path>        Working folder / repo (or cwd for --command)
  --template|-t <id>           agent-task (default) | shell-command | code-task | …
  --command|--cmd|-c           Pure terminal job — no agent (template=shell-command)
  --title <text>               Short title (default: truncated goal)
  --agent <id>                 cursor-agent | claude | agy | auto (agent jobs only)
  --acceptance <text>          Done-when (enforced as gates; agent jobs)
  --follow|-f                  After create, follow until done (exit 0/1)
  --json                       Machine-readable output
  --dry-run|-n                 Print spec only; do not create

Examples:
  omnishpilot add --now --follow "fix login redirect"
  omnishpilot add --workspace ~/app --daily 09:00 "triage overnight CI failures"
  omnishpilot add --weekly mon 09:30 --agent claude "weekly competitor brief"
  omnishpilot add --interval 60 "poll status page and write result.md"
  omnishpilot add --command --daily 02:00 --workspace ~/data "./backup.sh"
  omnishpilot add -c --hourly "curl -fsS https://example.com/health >/dev/null"
  omnishpilot progress <id> --json
  omnishpilot follow <id> --timeout 3600
  omnishpilot password set 'your-secret'
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

  let agentRunPath = null;
  let agentRunNote = '';
  try {
    const resolveBin = requireApp('server/resolve-bin');
    agentRunPath = resolveBin.resolveAgentRunBin(cfg);
    const bundled = resolveBin.bundledAgentRunPath?.();
    if (bundled && agentRunPath === bundled) {
      agentRunNote = 'bundled';
    } else if (agentRunPath && fs.existsSync(agentRunPath)) {
      agentRunNote = 'ok';
    }
  } catch {
    agentRunPath = which('agent-run')
      || path.join(__dirname, '..', 'bin', 'agent-run.js');
  }
  const agentRunOk = Boolean(agentRunPath && (fs.existsSync(agentRunPath) || which(agentRunPath)));
  push(
    'agent-run',
    agentRunOk,
    agentRunOk
      ? `${agentRunPath}${agentRunNote ? ` (${agentRunNote})` : ''}`
      : 'not found — reinstall omnishpilot (bundled agent-run missing)'
  );

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
    const byTask = ledger.weekOutcomes();
    tasks = store.listTasks({
      status: statusFilter || undefined,
      workspaceId: flag(flags, 'workspace', 'w') || undefined,
    }).map((t) => ({ ...t, week: scheduler.isRecurring(t.schedule?.type) ? byTask.get(t.id) || null : null }));
  }
  if (asJson) return printJson(tasks);
  table(tasks.map((t) => ({
    id: shortId(t.id),
    status: t.status,
    title: (t.title || '').slice(0, 48),
    when: t.schedule?.type || '—',
    week: t.week ? `${t.week.ok}/${t.week.total} ok` : '—',
    workspace: (t.workspaceName || t.workspaceId || '').slice(0, 20),
  })), ['id', 'status', 'title', 'when', 'week', 'workspace']);
}

function weekSentence({ ok, total }) {
  return `${ok} of ${total} run${total === 1 ? '' : 's'} succeeded in the last 7 days`;
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
    const offline = store.getTask(id);
    payload = { task: offline && { ...offline, week: scheduler.isRecurring(offline.schedule?.type) ? ledger.weekOutcomes().get(offline.id) || null : null } };
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
  if (task.week) console.log(`week:     ${weekSentence(task.week)}`);
  if (task.execution?.held && task.status === 'scheduled') console.log(`waiting:  ${task.execution.held}`);
  if (task.execution?.error) console.log(`error:    ${task.execution.error}`);
  if (task.summary) console.log(`summary:  ${task.summary}`);
}

const DEFAULT_ADD_DELAY_MIN = 5;
const DAY_NAMES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2, tues: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4, thur: 4, thurs: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseHHMM(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseAbsoluteRunAt(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Accept ISO or local-ish YYYY-MM-DDTHH:MM / YYYY-MM-DD HH:MM
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Build schedule from CLI flags. Priority: recurring > --at > --now > --in/default+5m */
function buildCliSchedule(flags) {
  const interval = flag(flags, 'interval', 'every');
  if (interval != null && interval !== true) {
    const n = Number(interval);
    if (!Number.isFinite(n) || n < 5) die('--interval must be minutes >= 5');
    return { type: 'interval', intervalMinutes: n, priority: 50 };
  }

  const daily = flag(flags, 'daily');
  if (daily != null && daily !== true) {
    const t = parseHHMM(daily);
    if (!t) die('--daily expects HH:MM (24h), e.g. --daily 09:30');
    return { type: 'daily', hour: t.hour, minute: t.minute, priority: 50 };
  }

  const hourly = flag(flags, 'hourly');
  if (hourly != null) {
    let minute = 0;
    if (hourly !== true) {
      const raw = String(hourly).replace(/^:/, '');
      minute = Number(raw);
      if (!Number.isFinite(minute) || minute < 0 || minute > 59) die('--hourly expects minute 0-59, e.g. --hourly 15 or --hourly :15');
    }
    return { type: 'hourly', minute, priority: 50 };
  }

  const weeklyDay = flag(flags, 'weekly');
  if (weeklyDay != null && weeklyDay !== true) {
    // --weekly mon 09:30  → parseArgs may only give "mon"; time can be --at or second flag value
    // Support --weekly=mon --at not; prefer --weekly "mon 09:30" via equals, or day + --time
    let dayRaw = String(weeklyDay).trim();
    let timeRaw = flag(flags, 'time') || null;
    const parts = dayRaw.split(/\s+/);
    if (parts.length >= 2) {
      dayRaw = parts[0];
      timeRaw = parts.slice(1).join(' ');
    }
    const dayKey = dayRaw.toLowerCase();
    const dayOfWeek = DAY_NAMES[dayKey] != null ? DAY_NAMES[dayKey] : Number(dayRaw);
    if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      die('--weekly expects DAY HH:MM (DAY=mon..sun or 0..6), e.g. --weekly "mon 09:30"');
    }
    const t = parseHHMM(timeRaw || '09:00');
    if (!t) die('--weekly time must be HH:MM');
    return { type: 'weekly', dayOfWeek, hour: t.hour, minute: t.minute, priority: 50 };
  }

  const at = flag(flags, 'at');
  if (at != null && at !== true) {
    const runAt = parseAbsoluteRunAt(at);
    if (!runAt) die('--at expects ISO datetime, e.g. --at 2026-10-29T14:00');
    return { type: 'once', runAt, priority: 50 };
  }

  if (flag(flags, 'now')) {
    return { type: 'now', runAt: new Date().toISOString(), priority: 95 };
  }

  const delayRaw = flag(flags, 'in', 'delay');
  let delayMin = DEFAULT_ADD_DELAY_MIN;
  if (delayRaw != null && delayRaw !== true) {
    const n = Number(delayRaw);
    if (!Number.isFinite(n) || n < 0) die(`--in must be minutes >= 0 (got ${delayRaw})`);
    delayMin = n;
  }
  return {
    type: 'once',
    runAt: new Date(Date.now() + delayMin * 60 * 1000).toISOString(),
    priority: 50,
  };
}

function buildCliAddSpec(flags, positionals) {
  const goal = positionals.join(' ').trim();
  if (!goal) {
    die(`Usage: omnishpilot add <goal...> [schedule flags]

Default: agent-task, once at now+${DEFAULT_ADD_DELAY_MIN}m.
Pure terminal (no agent): --command <cmd...>
Immediate: --now    Recurring: --daily|--hourly|--weekly|--interval
Track: --follow     Spec only: --dry-run

See: omnishpilot help`);
  }

  const wantShell = Boolean(flag(flags, 'command', 'cmd', 'c'))
    || String(flag(flags, 'template', 't') || '') === 'shell-command';
  const templateId = wantShell
    ? 'shell-command'
    : String(flag(flags, 'template', 't') || 'agent-task');
  const workspace = String(flag(flags, 'workspace', 'w') || '').trim();
  const title = String(flag(flags, 'title') || goal).replace(/\s+/g, ' ').trim().slice(0, 80);
  const schedule = buildCliSchedule(flags);

  if (wantShell || templateId === 'shell-command') {
    return {
      templateId: 'shell-command',
      title,
      summary: goal.slice(0, 240),
      status: 'scheduled',
      runMode: 'manual',
      schedule,
      instructions: {},
      inputs: {
        title,
        command: goal,
        cwd: workspace,
      },
      acceptance: null,
      source: 'cli',
      maxAttempts: Number(flag(flags, 'max-attempts')) || 1,
    };
  }

  const agentId = flag(flags, 'agent') || 'auto';
  const acceptance = flag(flags, 'acceptance') || '';

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
    acceptance: { requiredArtifacts: ['result.md'], soft: false },
    source: 'cli',
    maxAttempts: Number(flag(flags, 'max-attempts')) || 3,
  };
}

function formatScheduleBrief(schedule) {
  if (!schedule) return 'manual';
  if (schedule.type === 'now') return 'now (immediate)';
  if (schedule.type === 'once') return `once @ ${schedule.runAt}`;
  if (schedule.type === 'interval') return `every ${schedule.intervalMinutes}m`;
  if (schedule.type === 'hourly') return `hourly :${String(schedule.minute || 0).padStart(2, '0')}`;
  if (schedule.type === 'daily') {
    return `daily ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute || 0).padStart(2, '0')}`;
  }
  if (schedule.type === 'weekly') {
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return `weekly ${names[schedule.dayOfWeek] || schedule.dayOfWeek} ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute || 0).padStart(2, '0')}`;
  }
  return JSON.stringify(schedule);
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
  let task = created.data;

  // --now must start immediately after submission (not wait for the next poll alone).
  if (spec.schedule?.type === 'now') {
    const run = await client.post(`/api/tasks/${task.id}/run-now`);
    if (run.ok) task = run.data?.task || run.data || task;
    else process.stderr.write(`[add] created, but run-now failed: ${JSON.stringify(run.data)}\n`);
  }

  const wantFollow = Boolean(flag(flags, 'follow', 'f'));

  if (flag(flags, 'json') && !wantFollow) {
    printJson(task);
    return;
  }

  if (!flag(flags, 'json')) {
    ok(`Created ${task.id}`);
    ok(`  title=${task.title}`);
    ok(`  template=${task.templateId}  status=${task.status}`);
    ok(`  schedule=${formatScheduleBrief(task.schedule)}`);
    if (task.inputs?.command) ok(`  command=${task.inputs.command}`);
    if (task.inputs?.cwd) ok(`  cwd=${task.inputs.cwd}`);
    if (task.inputs?.workspace) ok(`  workspace=${task.inputs.workspace}`);
    if (task.inputs?.agentId && task.inputs.agentId !== 'auto') ok(`  agent=${task.inputs.agentId}`);
    ok(`  track: omnishpilot progress ${shortId(task.id)}  |  omnishpilot follow ${shortId(task.id)}`);
  } else {
    printJson(task);
  }

  if (wantFollow) {
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    try {
      await watch.followTask(task.id, {
        intervalMs: Number(flag(flags, 'interval-ms') || 2000),
        timeoutSec: Number(flag(flags, 'timeout') || 0),
        json: Boolean(flag(flags, 'json')),
        signal: ac.signal,
      });
    } finally {
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
    }
  }
}

async function cmdProgress(flags, positionals) {
  const id = resolveTaskId(positionals[0] || die('Usage: omnishpilot progress <id>'));
  await client.ensureApi();
  const r = await client.get(`/api/tasks/${id}`);
  if (!r.ok) die(r.data?.error || JSON.stringify(r.data));
  const task = r.data.task || r.data;
  const logR = await client.get(`/api/tasks/${id}/log`, { query: { lines: Number(flag(flags, 'n', 'lines') || 30) } });
  const logText = typeof logR.data === 'string' ? logR.data : (logR.data?.log || '');
  const lastLines = logText.trim().split('\n').slice(-Number(flag(flags, 'n', 'lines') || 30));

  const startedAt = task.execution?.startedAt ? new Date(task.execution.startedAt).getTime() : null;
  const elapsedSec = startedAt && task.status === 'running'
    ? Math.round((Date.now() - startedAt) / 1000)
    : null;

  const snapshot = {
    id: task.id,
    title: task.title,
    status: task.status,
    schedule: task.schedule,
    scheduleLabel: formatScheduleBrief(task.schedule),
    agent: task.execution?.resolvedAgentId || task.inputs?.agentId || null,
    attempts: task.execution?.attempts ?? null,
    maxAttempts: task.execution?.maxAttempts ?? null,
    elapsedSec,
    error: task.execution?.error || null,
    acceptance: task.execution?.acceptance || null,
    verifier: task.execution?.verifier || null,
    artifacts: (task.execution?.artifacts || []).map((a) => a.name).filter(Boolean),
    lastLog: lastLines,
  };

  if (flag(flags, 'json')) return printJson(snapshot);

  console.log(`${task.title}`);
  console.log(`id:         ${task.id}`);
  console.log(`status:     ${task.status}`);
  console.log(`schedule:   ${snapshot.scheduleLabel}`);
  if (snapshot.agent) console.log(`agent:      ${snapshot.agent}`);
  if (elapsedSec != null) console.log(`elapsed:    ${elapsedSec}s`);
  if (snapshot.acceptance?.report) console.log(`acceptance: ${snapshot.acceptance.report}`);
  if (snapshot.error) console.log(`error:      ${snapshot.error}`);
  if (snapshot.artifacts.length) console.log(`artifacts:  ${snapshot.artifacts.join(', ')}`);
  if (lastLines.length) {
    console.log('\n--- last log ---');
    console.log(lastLines.join('\n'));
  }
}

async function cmdFollow(flags, positionals) {
  const id = resolveTaskId(positionals[0] || die('Usage: omnishpilot follow <id> [--timeout SEC]'));
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    await watch.followTask(id, {
      intervalMs: Number(flag(flags, 'poll') || flag(flags, 'interval-ms') || 2000),
      timeoutSec: Number(flag(flags, 'timeout') || 0),
      json: Boolean(flag(flags, 'json')),
      signal: ac.signal,
    });
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

function cmdPassword(flags, positionals) {
  const sub = (positionals[0] || 'status').toLowerCase();
  const cfg = loadConfig();
  const { enabled, password } = auth.authConfig();
  const isDefault = password === auth.DEFAULT_PASSWORD
    || password === 'change-me'
    || password === '0mnis891lo7';

  if (sub === 'status') {
    const info = {
      enabled,
      usingDefaultPassword: isDefault,
      configFile: configFilePath(cfg._root || ROOT),
      hint: isDefault
        ? 'UI still uses the built-in default. Set one: omnishpilot password set <new>'
        : 'Custom password is set in config (value not shown).',
    };
    if (flag(flags, 'json')) return printJson(info);
    console.log(`auth enabled:     ${enabled ? 'yes' : 'no'}`);
    console.log(`default password: ${isDefault ? 'YES — change it' : 'no (custom set)'}`);
    console.log(`config:           ${info.configFile}`);
    console.log(info.hint);
    return;
  }

  if (sub === 'set') {
    const next = positionals[1] || flag(flags, 'to', 'password');
    if (!next || next === true) die('Usage: omnishpilot password set <new-password>');
    if (String(next).length < 4) die('Password must be at least 4 characters');
    updateConfig({ auth: { enabled: true, password: String(next) } });
    ok('Password saved to omnishpilot.config.json');
    ok('Restart the daemon if it is already running: omnishpilot restart');
    return;
  }

  if (sub === 'change') {
    const from = flag(flags, 'from', 'old') || positionals[1];
    const to = flag(flags, 'to', 'new') || positionals[2];
    if (!from || !to || from === true || to === true) {
      die('Usage: omnishpilot password change --from <old> --to <new>');
    }
    if (!auth.verifyPassword(String(from)) && !flag(flags, 'force')) {
      die('Current password does not match. Use --force to overwrite anyway, or: omnishpilot password set <new>');
    }
    if (String(to).length < 4) die('New password must be at least 4 characters');
    updateConfig({ auth: { enabled: true, password: String(to) } });
    ok('Password updated');
    ok('Restart the daemon if it is already running: omnishpilot restart');
    return;
  }

  die(`Unknown password subcommand: ${sub}\nUse: status | set | change`);
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
    { id: 'bundled_agent_run', have: true, detail: 'agent-run ships inside omnishpilot (no separate install)' },
    { id: 'unattended_flags', have: true, detail: 'bundled agent-run adapters use --yolo / --dangerously-skip-permissions' },
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
    { id: 'shell_command', have: true, detail: 'schedule pure terminal/script/app jobs with no agent' },
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

function capFlag(flags, name) {
  const raw = flag(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === true || !Number.isFinite(n) || n < 0) die(`--${name} needs a number, e.g. --${name} ${name === 'usd' ? 20 : 180}`);
  return n;
}

function cmdBudget(flags) {
  const minutes = capFlag(flags, 'minutes');
  const usd = capFlag(flags, 'usd');
  if (flag(flags, 'off')) {
    updateConfig({ budget: { dailyAgentMinutes: 0, monthlyUsd: 0 } });
    ok('Budget caps are off');
  } else if (minutes !== undefined || usd !== undefined) {
    updateConfig({ budget: {
      ...(minutes !== undefined ? { dailyAgentMinutes: minutes } : {}),
      ...(usd !== undefined ? { monthlyUsd: usd } : {}),
    } });
    ok('Budget saved; the daemon picks it up on its next check');
  }
  const state = budget.budgetState(loadConfig(), ledger.query({ type: 'agent_usage' }), store.runningTasks());
  if (flag(flags, 'json')) return printJson(state);
  if (!state) {
    console.log('No budget set. Cap agent time per day with: omnishpilot budget --minutes 180');
    console.log('Add a monthly cap on reported spend with:   omnishpilot budget --usd 20');
    return;
  }
  if (state.minutes) console.log(`today:  ${state.minutes.used} of ${state.minutes.limit} agent minutes (${state.minutes.percent}%)`);
  if (state.usd) console.log(`month:  $${state.usd.used.toFixed(2)} of $${state.usd.limit} reported spend (${state.usd.percent}%)`);
  if (state.usd) console.log('        counts only runs whose agent CLI prints its cost');
  const held = budget.heldReason(state);
  if (held) console.log(held);
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
      case 'progress':
      case 'ps':
        await cmdProgress(flags, rest);
        break;
      case 'follow':
      case 'wait':
        await cmdFollow(flags, rest);
        break;
      case 'password':
      case 'passwd':
        cmdPassword(flags, rest);
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
      case 'budget':
        cmdBudget(flags);
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
