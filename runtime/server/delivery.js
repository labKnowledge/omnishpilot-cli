const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const omnish = require('./omnish');

const PREFERRED_FILES = ['video.mp4', 'thumbnail.png', 'post-draft.txt', 'result.md', 'socialPost'];

function existingFiles(artifacts = []) {
  return artifacts.filter(a => {
    if (!a.path || a.name === 'output-dir') return false;
    try {
      return fs.existsSync(a.path) && fs.statSync(a.path).isFile();
    } catch {
      return false;
    }
  });
}

function sortArtifacts(artifacts) {
  return [...artifacts].sort((a, b) => {
    const ai = PREFERRED_FILES.indexOf(a.name);
    const bi = PREFERRED_FILES.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function buildSummary(task) {
  const parts = [`${task.title} is ready.`];
  if (task.instructions?.socialPost?.trim()) {
    parts.push(task.instructions.socialPost.trim());
  } else {
    const result = task.execution?.artifacts?.find(a => a.name === 'result.md');
    if (result?.path && fs.existsSync(result.path)) {
      parts.push(fs.readFileSync(result.path, 'utf8').trim().slice(0, 800));
    }
  }
  return parts.join('\n\n').slice(0, 900);
}

function publicTaskUrl(task, settings) {
  const base = settings.publicUrl || loadConfig().publicUrl || 'https://omnishpilot.eligapris.tech';
  return `${base.replace(/\/$/, '')}/?task=${task.id}`;
}

async function deliverTaskResult(task, settings) {
  if (!settings?.deliveryOnComplete) return { skipped: true };

  const mode = settings.deliveryMode || 'message';
  const peer = settings.deliveryPeer || loadConfig().omnish?.peer || '*';
  const title = `Delivered: ${task.title}`;

  if (mode === 'files') {
    const files = sortArtifacts(existingFiles(task.execution?.artifacts)).slice(0, 5);
    if (!files.length) {
      return omnish.notify(title, buildSummary(task) || 'Job finished. No files to send.', peer);
    }
    return omnish.sendFiles(
      peer,
      files.map(f => f.path),
      buildSummary(task).slice(0, 200),
    );
  }

  if (mode === 'link') {
    const url = publicTaskUrl(task, settings);
    return omnish.notify(title, `${buildSummary(task)}\n\nOpen outputs: ${url}`, peer);
  }

  if (mode === 'summary') {
    return omnish.notify(title, buildSummary(task), peer);
  }

  // message
  const count = existingFiles(task.execution?.artifacts).length;
  const body = count
    ? `Finished with ${count} file(s). Open OmnishPilot to review outputs.`
    : 'Finished. Open OmnishPilot to review outputs.';
  return omnish.notify(title, body, peer);
}

async function sendTestDelivery(settings) {
  const mode = settings?.deliveryMode || 'message';
  const peer = settings?.deliveryPeer || loadConfig().omnish?.peer || '*';
  if (mode === 'files') {
    return omnish.notify(
      'OmnishPilot delivery test',
      'File delivery is enabled. Finished jobs will send output files via Omnish.',
      peer,
    );
  }
  if (mode === 'link') {
    const base = settings?.publicUrl || loadConfig().publicUrl || 'https://omnishpilot.eligapris.tech';
    return omnish.notify(
      'OmnishPilot delivery test',
      `Link delivery is enabled.\n\nExample: ${base}`,
      peer,
    );
  }
  return omnish.notify(
    'OmnishPilot delivery test',
    mode === 'summary'
      ? 'Summary delivery is enabled.\n\nExample: Your job finished.\n\nSocial copy or result text appears here.'
      : 'Message delivery is enabled. You will get a short notice when jobs finish.',
    peer,
  );
}

module.exports = {
  deliverTaskResult,
  sendTestDelivery,
  buildSummary,
  existingFiles,
};
