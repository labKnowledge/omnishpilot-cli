'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');

function quotePath(p) {
  return p.includes(' ') ? `"${p}"` : p;
}

function quoteArg(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

function omnishBin() {
  const cfg = loadConfig();
  return cfg.omnish?.bin || process.env.OMNISH_BIN || 'omnish';
}

function runOmnish(args) {
  const cfg = loadConfig();
  if (!cfg.omnish?.enabled) return Promise.resolve({ skipped: true });
  const bin = omnishBin();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      const detail = (stderr || '').trim().slice(0, 400);
      console.error('[omnish]', `exit ${code}`, args.join(' ').slice(0, 200), detail || '(no stderr)');
      resolve({ ok: false, error: detail || `omnish exited ${code}` });
    });
    child.on('error', (err) => {
      console.error('[omnish]', 'spawn failed', bin, err.message);
      resolve({ ok: false, error: 'omnish not available' });
    });
  });
}

function notify(title, body, peer) {
  const cfg = loadConfig();
  if (!cfg.omnish?.enabled) return Promise.resolve({ skipped: true });
  const target = peer || cfg.omnish.peer || '*';
  const safe = String(body).replace(/\n/g, ' · ').slice(0, 900);
  return runOmnish(['i', '-c', `/sendto ${target} -t ${quoteArg(title)} -- ${safe}`]);
}

function sendFiles(peer, filePaths, caption = '') {
  const cfg = loadConfig();
  if (!cfg.omnish?.enabled) return Promise.resolve({ skipped: true });
  const target = peer || cfg.omnish.peer || '*';
  const files = (filePaths || []).filter((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!files.length) return Promise.resolve({ ok: false, error: 'no_files' });
  const safeCaption = String(caption).replace(/\n/g, ' ').slice(0, 200);
  const fileArg = files.map(quotePath).join(',');
  const cmd = safeCaption
    ? `/sendto ${target} ${fileArg} -- ${safeCaption}`
    : `/sendto ${target} ${fileArg}`;
  return runOmnish(['i', '-c', cmd]);
}

async function taskStarted(task) {
  return notify(`▶ ${task.title}`, `Started (${task.runMode}). Task ${task.id.slice(0, 8)}`);
}

async function taskCompleted(task) {
  return notify(`✓ ${task.title}`, `Finished. Open OmnishPilot to see outputs.`);
}

async function taskFailed(task, error) {
  const reason = String(error).replace(/[.\s]+$/, '');
  return notify(`✗ ${task.title}`, `Failed: ${reason}. Open OmnishPilot to retry or edit instructions.`);
}

async function supervisorAlert(task, message) {
  return notify(`👁 Supervisor — ${task.title}`, message);
}

async function agentLimitSwitch(task, fromAgentId, toAgentId) {
  return notify(`⇄ ${task.title}`, `Agent "${fromAgentId}" reached its usage limit — switching to "${toAgentId}" and retrying.`);
}

async function agentsAllLimited(task, order, resumeAt) {
  const when = resumeAt ? ` Auto-resume at ${resumeAt}.` : '';
  return notify(
    `⚠ ${task.title}`,
    `All agents (${(order || []).join(', ')}) are rate-limited or unavailable.${when}`,
  );
}

async function progressHeartbeat(task, elapsedMin, lastLine) {
  const activity = lastLine ? ` Latest: ${lastLine.slice(0, 160)}` : '';
  return notify(`⏳ ${task.title}`, `Still working — ${elapsedMin}m in.${activity}`);
}

module.exports = {
  notify,
  sendFiles,
  taskStarted,
  taskCompleted,
  taskFailed,
  supervisorAlert,
  agentLimitSwitch,
  agentsAllLimited,
  progressHeartbeat,
};
