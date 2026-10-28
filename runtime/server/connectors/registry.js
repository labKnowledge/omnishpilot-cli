// Connector capability registry.
//
// worker/index/supervisor/cli-sync used to branch on the literal string 'leaptr-campaign'
// (or 'generic-agent', 'leaptr-deliver') to decide whether a workspace supports pausing,
// day-pipeline addressing, campaign plans, live-run tracking, artifact listing, etc. That
// meant every new capability check had to be re-taught to every consumer file, and adding a
// new connector meant hunting down every one of those checks.
//
// Instead, each connector below declares only the hooks it actually implements. Consumers
// never compare against a connector id — they just ask "does this connector have an
// `isPaused` hook" (etc.) and call it if so. Adding a connector is a new entry here; no
// changes needed anywhere else.
const fs = require('fs');
const path = require('path');
const ids = require('./ids');
const leaptr = require('./leaptr');
const agent = require('./agent');
const shell = require('./shell');

// The one addressing scheme every day-pipeline connector shares: a task belongs to a
// numbered day, whether that's stored as inputs.dayNumber (ad-hoc/manual entry) or
// schedule.campaignDay (recurring campaign-day schedule).
function resolveDay(task) {
  const day = task?.inputs?.dayNumber ?? task?.schedule?.campaignDay;
  return day == null ? null : day;
}

const CONNECTORS = {
  [ids.LEAPTR_CAMPAIGN]: {
    run: ({ ws, task, logPath, agentId }) => leaptr.runLeaptrPipeline(ws.rootPath, task, logPath, agentId),

    isPaused: ({ ws, day }) => leaptr.isPaused(ws.rootPath, day),
    pauseDay: ({ ws, day }) => leaptr.pauseDay(ws.rootPath, day),
    resumeDay: ({ ws, day }) => leaptr.resumeDay(ws.rootPath, day),
    pauseAll: ({ ws }) => leaptr.pauseCampaign(ws.rootPath),
    resumeAll: ({ ws }) => leaptr.resumeCampaign(ws.rootPath),
    readState: ({ ws }) => leaptr.readJson(path.join(ws.rootPath, 'state.json')),

    getFailedDays: ({ ws }) => {
      const st = leaptr.readJson(path.join(ws.rootPath, 'state.json'));
      if (!st?.failed || st.paused) return [];
      const pausedDays = new Set(st.paused_days || []);
      return Object.entries(st.failed)
        .filter(([day]) => !pausedDays.has(day))
        .map(([day, fail]) => ({ day, reason: fail.reason }));
    },

    getLiveRun: ({ ws }) => {
      const st = leaptr.readJson(path.join(ws.rootPath, 'state.json'));
      const ip = st?.in_progress;
      return ip?.day ? { day: ip.day, pid: ip.pid, role: ip.role, startedAt: ip.started_at } : null;
    },

    onReschedule: ({ ws, task }) => leaptr.writeTaskInstructions(ws.rootPath, task),

    listArtifacts: ({ ws, task, day }) => (day == null ? [] : leaptr.listArtifacts(ws.rootPath, day).map(a => ({
      name: a.name,
      url: `/api/assets/${task.workspaceId}/${day}/${a.name}`,
    }))),

    // Distinct from listArtifacts above: this is what gets persisted onto the task's
    // execution history when a run finishes (raw file paths, not HTTP-ready URLs).
    collectResultFiles: ({ ws, day }) => (day == null ? [] : leaptr.listArtifacts(ws.rootPath, day).map(a => ({
      name: a.name,
      path: a.path,
    }))),

    dayOutputPath: ({ ws, day }) => (day == null ? null : leaptr.dayOut(ws.rootPath, day)),

    thumbnailUrl: ({ ws, day, workspaceId }) => {
      if (day == null) return null;
      const thumbPath = path.join(leaptr.dayOut(ws.rootPath, day), 'thumbnail.png');
      return fs.existsSync(thumbPath) ? `/api/assets/${workspaceId}/${day}/thumbnail.png` : null;
    },

    sync: ({ ws, store, templates, opts }) => leaptr.syncCampaignTasks(ws, store, templates, opts),
    getCampaignPlan: ({ ws }) => leaptr.getCampaignPlan(ws),
    validateCampaignPlan: ({ days }) => leaptr.validateCampaignPlan(days),
    setCampaignPlan: ({ ws, days }) => leaptr.writeCampaignPlan(ws.rootPath, days),
    installCron: ({ ws }) => leaptr.installCron(ws.rootPath),

    dailyRunLabel: ({ ws }) => {
      const configPath = path.join(ws.rootPath, 'config.env');
      if (!fs.existsSync(configPath)) return null;
      const m = fs.readFileSync(configPath, 'utf8').match(/DAILY_RUN_HOUR=(\d+)[\s\S]*?DAILY_RUN_MINUTE=(\d+)/);
      return m ? `${m[1]}:${m[2].padStart(2, '0')}` : null;
    },
  },

  [ids.LEAPTR_DELIVER]: {
    run: ({ ws, task, logPath }) => leaptr.runLeaptrDeliver(ws.rootPath, task, logPath),
  },

  [ids.GENERIC_AGENT]: {
    run: ({ task, logPath }) => agent.runGenericAgent(task, logPath),
    listArtifacts: ({ task, cfg }) => {
      const outDir = path.join(cfg.dataDir, 'outputs', task.id);
      return agent.listOutputArtifacts(outDir).map(a => ({
        name: a.name,
        url: `/api/tasks/${task.id}/outputs/${encodeURIComponent(a.name)}`,
      }));
    },
    collectResultFiles: ({ outDir }) => {
      if (!outDir) return [];
      const files = agent.listOutputArtifacts(outDir).map(a => ({ name: a.name, path: a.path }));
      files.push({ name: 'output-dir', path: outDir });
      return files;
    },
  },

  [ids.SHELL_COMMAND]: {
    run: ({ task, logPath }) => shell.runShellCommand(task, logPath),
    listArtifacts: ({ task, cfg }) => {
      const outDir = path.join(cfg.dataDir, 'outputs', task.id);
      return shell.listOutputArtifacts(outDir).map(a => ({
        name: a.name,
        url: `/api/tasks/${task.id}/outputs/${encodeURIComponent(a.name)}`,
      }));
    },
    collectResultFiles: ({ outDir }) => {
      if (!outDir) return [];
      const files = shell.listOutputArtifacts(outDir).map(a => ({ name: a.name, path: a.path }));
      files.push({ name: 'output-dir', path: outDir });
      return files;
    },
  },
};

function get(connectorId) {
  return CONNECTORS[connectorId] || {};
}

module.exports = { get, resolveDay };
