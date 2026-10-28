const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LEAPTR_CAMPAIGN } = require('./ids');

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function dayOut(root, day) {
  return path.join(root, 'output', `day-${String(day).padStart(2, '0')}`);
}

function readDailyRunTime(root, workspace = null) {
  const env = parseEnv(path.join(root, 'config.env'));
  const hour = Number(env.DAILY_RUN_HOUR ?? workspace?.meta?.dailyRunHour ?? 7);
  const minute = Number(env.DAILY_RUN_MINUTE ?? workspace?.meta?.dailyRunMinute ?? 0);
  const timezone = env.CAMPAIGN_TIMEZONE || workspace?.meta?.timezone || 'America/Denver';
  return { hour, minute, timezone };
}

function campaignSchedule(root, workspace, campaignDay) {
  const { hour, minute, timezone } = readDailyRunTime(root, workspace);
  return { type: 'campaign_day', campaignDay, hour, minute, timezone };
}

function writeTaskInstructions(root, task) {
  const day = task.inputs?.dayNumber || task.schedule?.campaignDay;
  if (!day) return;
  const out = dayOut(root, day);
  if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
  const ins = task.instructions || {};
  if (ins.voScript) fs.writeFileSync(path.join(out, 'vo.txt'), ins.voScript);
  if (ins.socialPost) fs.writeFileSync(path.join(out, 'post-draft.txt'), ins.socialPost);
  if (ins.imagePrompt) fs.writeFileSync(path.join(out, 'image-prompt.txt'), ins.imagePrompt);
  if (ins.creativeBrief) fs.writeFileSync(path.join(out, 'creative-brief.md'), ins.creativeBrief);
  if (ins.agentPrompt) fs.writeFileSync(path.join(out, 'agent-instructions.md'), ins.agentPrompt);
}

function getDayStatus(root, day) {
  const out = dayOut(root, day);
  const mark = readJson(path.join(out, '.complete.json'));
  const st = readJson(path.join(root, 'state.json')) || {};
  const inProg = st.in_progress;
  const running = inProg && Number(inProg.day) === Number(day);
  let complete = false;
  if (mark?.verify === 'pass') complete = true;
  if (st.completed?.[String(day)]) complete = true;
  return { complete, running, mark, out };
}

async function runLeaptrPipeline(root, task, logPath, agentId) {
  const day = task.inputs?.dayNumber || task.schedule?.campaignDay;
  if (!day) throw new Error('Campaign day number required');
  writeTaskInstructions(root, task);
  const env = { ...process.env, ...parseEnv(path.join(root, 'config.env')) };
  if (task.runMode === 'manual') env.SKIP_CURSOR_AGENT = '1';
  if (agentId) env.AGENT_ID = agentId;
  const scriptName = task.runMode === 'supervised' || task.runMode === 'auto'
    ? 'run-day-retry.sh'
    : 'run-day-retry.sh';
  return spawnShell(root, scriptName, [String(day)], logPath, env);
}

async function runLeaptrDeliver(root, task, logPath) {
  const day = task.inputs?.sourceDay || task.inputs?.dayNumber || task.schedule?.campaignDay;
  if (!day) throw new Error('Source day required');
  const env = { ...process.env, ...parseEnv(path.join(root, 'config.env')) };
  return spawnShell(root, 'deliver-day.sh', [String(day)], logPath, env);
}

async function runLeaptrHeal(root, _task, logPath) {
  return spawnShell(root, 'heal-state.sh', [], logPath, parseEnv(path.join(root, 'config.env')));
}

function spawnShell(cwd, scriptFile, args, logPath, env = process.env) {
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} ${scriptFile} ${args.join(' ')} ===\n`);
  const child = spawn('bash', [script(cwd, scriptFile), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  return { child, logStream };
}

function runStateTool(root, args) {
  const r = spawnSync('python3', [path.join(root, 'scripts', 'state-tool.py'), ...args], { cwd: root, encoding: 'utf8' });
  return r.status === 0;
}

function isPaused(root, day) {
  const st = readJson(path.join(root, 'state.json')) || {};
  if (st.paused === true) return true;
  const day_ = day != null ? String(day) : null;
  return !!(day_ && (st.paused_days || []).includes(day_));
}

const CAMPAIGN_TEMPLATE_ROOT = path.join(__dirname, '..', '..', 'campaign-template');

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'campaign';
}

// Leaves unrecognized {{TOKEN}} patterns untouched — prompts/*.md already use {{DAY}}/{{TITLE}}/
// {{OUT_DIR}} etc. as their OWN runtime placeholders (substituted later by render-prompt.py),
// so this must only fill in tokens it actually knows, not blank out everything else.
function renderTemplateString(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (match, key) => (vars[key] != null ? String(vars[key]) : match));
}

const TEMPLATE_TEXT_EXTENSIONS = new Set(['.md', '.sh', '.py', '.json', '.env']);

function walkAndRenderTemplate(dir, vars) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      walkAndRenderTemplate(full, vars);
    } else if (TEMPLATE_TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      const text = fs.readFileSync(full, 'utf8');
      const rendered = renderTemplateString(text, vars);
      if (rendered !== text) fs.writeFileSync(full, rendered);
    }
  }
}

function scaffoldCampaign({ name, targetPath, totalDays, startDate, timezone, dailyRunHour, dailyRunMinute, brandName, brandDomain }) {
  if (!fs.existsSync(targetPath)) throw new Error(`targetPath does not exist: ${targetPath}`);
  const autopilotDir = path.join(targetPath, 'marketing', 'autopilot');
  if (fs.existsSync(autopilotDir)) throw new Error(`${autopilotDir} already exists`);

  fs.cpSync(CAMPAIGN_TEMPLATE_ROOT, autopilotDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'config.env.template',
  });

  const slug = slugify(name);
  const supervisorRunHour = (Number(dailyRunHour) + 6) % 24;
  const vars = {
    CAMPAIGN_NAME: name,
    CAMPAIGN_START_DATE: startDate,
    CAMPAIGN_TIMEZONE: timezone,
    DAILY_RUN_HOUR: dailyRunHour,
    DAILY_RUN_MINUTE: dailyRunMinute,
    PROJECT_ROOT: targetPath,
    CAMPAIGN_SLUG: slug,
    SUPERVISOR_RUN_HOUR: supervisorRunHour,
    SUPERVISOR_RUN_MINUTE: dailyRunMinute,
    BRAND_NAME: brandName || name,
    BRAND_DOMAIN: brandDomain || `${slug}.com`,
  };

  const tplEnv = fs.readFileSync(path.join(CAMPAIGN_TEMPLATE_ROOT, 'config.env.template'), 'utf8');
  fs.writeFileSync(path.join(autopilotDir, 'config.env'), renderTemplateString(tplEnv, vars));

  // Fills {{BRAND_NAME}}/{{BRAND_DOMAIN}}/{{CAMPAIGN_SLUG}} etc. across the cloned scripts/docs/
  // prompts — leaves prompts' own {{DAY}}/{{TITLE}}/{{OUT_DIR}} runtime placeholders untouched.
  walkAndRenderTemplate(autopilotDir, vars);

  const days = Array.from({ length: totalDays }, (_, i) => ({ day: i + 1, title: '' }));
  fs.writeFileSync(path.join(autopilotDir, 'days.json'), JSON.stringify({ days }, null, 2) + '\n');

  fs.mkdirSync(path.join(autopilotDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(autopilotDir, 'output'), { recursive: true });
  for (const f of fs.readdirSync(path.join(autopilotDir, 'scripts'))) {
    if (f.endsWith('.sh') || f.endsWith('.py')) {
      fs.chmodSync(path.join(autopilotDir, 'scripts', f), 0o755);
    }
  }

  return { autopilotDir, slug };
}

function installCron(root) {
  const scriptPath = path.join(root, 'scripts', 'install-schedule.sh');
  if (!fs.existsSync(scriptPath)) throw new Error('install-schedule.sh not found');
  const r = spawnSync('bash', [scriptPath], {
    cwd: root,
    env: { ...process.env, AUTO_INSTALL_CRON: '1' },
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.status !== 0) throw new Error(`install-schedule.sh failed: ${(r.stdout || '') + (r.stderr || '')}`.slice(0, 2000));
  return r.stdout;
}

function pauseDay(root, day) {
  return runStateTool(root, ['pause-day', String(day)]);
}

function resumeDay(root, day) {
  return runStateTool(root, ['resume-day', String(day)]);
}

function pauseCampaign(root) {
  return runStateTool(root, ['pause']);
}

function resumeCampaign(root) {
  return runStateTool(root, ['resume']);
}

function listArtifacts(root, day) {
  const out = dayOut(root, day);
  if (!fs.existsSync(out)) return [];
  return fs.readdirSync(out)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const p = path.join(out, f);
      const st = fs.statSync(p);
      if (!st.isFile()) return null;
      return { name: f, path: p, size: st.size };
    })
    .filter(Boolean);
}

function syncCampaignTasks(workspace, store, templates, opts = {}) {
  const root = workspace.rootPath;
  const daysData = readJson(path.join(root, 'days.json'));
  if (!daysData?.days) return { synced: 0 };
  const template = templates.getTemplate('social-video');
  let synced = 0;
  const existing = store.listTasks({ workspaceId: workspace.id });

  for (const d of daysData.days) {
    if (opts.fromDay != null && d.day < opts.fromDay) continue;
    if (opts.toDay != null && d.day > opts.toDay) continue;
    const ref = `day-${d.day}`;
    let task = existing.find(t => t.sourceRef === ref);
    const status = getDayStatus(root, d.day);
    const instructions = {
      voScript: d.vo_script || '',
      socialPost: d.social_post || '',
      imagePrompt: d.image_prompt || '',
      creativeBrief: d.creative ? JSON.stringify(d.creative, null, 2) : '',
      beats: (d.beats || []).map(b => `${b.caption} | ${b.icon} | ${b.animation}`).join('\n'),
      verifyNotes: 'Video 9:16, post has CTA, no observability-platform positioning',
    };
    const taskStatus = status.complete ? 'completed' : status.running ? 'running' : 'scheduled';

    if (task) {
      const schedulePatch = campaignSchedule(root, workspace, d.day);
      if (task.status === 'scheduled' || task.status === 'draft' || task.status === 'failed') {
        store.updateTask(task.id, {
          title: `Day ${d.day} — ${d.title}`,
          summary: d.pillar,
          inputs: { dayNumber: d.day, title: d.title, cta: d.cta },
          schedule: { ...task.schedule, ...schedulePatch },
          status: task.status === 'draft' ? 'draft' : taskStatus === 'completed' ? 'completed' : task.status,
          completedAt: status.complete ? (status.mark?.completed_at || new Date().toISOString()) : null,
        });
      } else if (status.complete && task.status !== 'completed') {
        store.updateTask(task.id, { status: 'completed', completedAt: status.mark?.completed_at });
      }
      synced++;
      continue;
    }

    store.createTask({
      workspaceId: workspace.id,
      templateId: 'social-video',
      title: `Day ${d.day} — ${d.title}`,
      summary: d.pillar,
      status: taskStatus,
      runMode: template.defaultRunMode,
      schedule: campaignSchedule(root, workspace, d.day),
      instructions,
      inputs: { dayNumber: d.day, title: d.title, cta: d.cta, hook: d.vo_script?.split('\n')[0] },
      outputs: template.outputs,
      connector: LEAPTR_CAMPAIGN,
      source: 'sync',
      sourceRef: ref,
      completedAt: status.complete ? status.mark?.completed_at : null,
    });
    synced++;
  }
  return { synced };
}

function getCampaignPlan(workspace) {
  const daysData = readJson(path.join(workspace.rootPath, 'days.json'));
  return daysData?.days || [];
}

function validateCampaignPlan(days) {
  const errors = [];
  if (!Array.isArray(days) || !days.length) {
    return { ok: false, errors: ['days must be a non-empty array'] };
  }
  const seen = new Set();
  days.forEach((d, i) => {
    if (!Number.isInteger(d?.day) || d.day < 1) {
      errors.push(`days[${i}]: "day" must be a positive integer`);
    } else if (seen.has(d.day)) {
      errors.push(`days[${i}]: duplicate day number ${d.day}`);
    } else {
      seen.add(d.day);
    }
    if (typeof d?.title !== 'string' || !d.title.trim()) {
      errors.push(`days[${i}]: "title" is required`);
    }
  });
  return { ok: errors.length === 0, errors };
}

function writeCampaignPlan(root, days) {
  const file = path.join(root, 'days.json');
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(root, `days.json.bak-${stamp}`));
  }
  const sorted = [...days].sort((a, b) => a.day - b.day);
  fs.writeFileSync(file, JSON.stringify({ days: sorted }, null, 2) + '\n');
  return sorted;
}

module.exports = {
  runLeaptrPipeline,
  runLeaptrDeliver,
  runLeaptrHeal,
  writeTaskInstructions,
  getDayStatus,
  listArtifacts,
  syncCampaignTasks,
  getCampaignPlan,
  validateCampaignPlan,
  writeCampaignPlan,
  dayOut,
  readJson,
  isPaused,
  pauseDay,
  resumeDay,
  pauseCampaign,
  resumeCampaign,
  slugify,
  scaffoldCampaign,
  installCron,
};
