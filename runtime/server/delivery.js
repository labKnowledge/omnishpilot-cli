'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const omnish = require('./omnish');
const acceptance = require('./acceptance');

const PREFERRED_FILES = ['video.mp4', 'thumbnail.png', 'post-draft.txt', 'result.md', 'socialPost', 'verifier-result.md'];

function existingFiles(artifacts = []) {
  return artifacts.filter((a) => {
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
    const result = task.execution?.artifacts?.find((a) => a.name === 'result.md');
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

/** Morning / decision pack: gate + artifacts + optional diff — wake to a verdict, not a log wall. */
function buildMorningPack(task, settings, extra = {}) {
  const lines = [];
  lines.push(`${task.title} — ready to review`);

  const acc = extra.acceptanceResult || (task.execution?.acceptance
    ? { ok: task.execution.acceptance.ok, softPass: task.execution.acceptance.softPass, failures: task.execution.acceptance.failures || [], skipped: false, profile: null }
    : null);
  if (acc && !acc.skipped) {
    lines.push(`Gate: ${acceptance.formatAcceptanceReport(acc)}`);
  } else if (task.execution?.acceptance?.report) {
    lines.push(`Gate: ${task.execution.acceptance.report}`);
  }

  const ver = extra.verifierResult || task.execution?.verifier;
  if (ver && !ver.skipped) {
    lines.push(`Verifier: ${ver.verdict || (ver.ok ? 'PASS' : 'FAIL')}${ver.detail && !ver.ok ? ` — ${ver.detail}` : ''}`);
  }

  const files = sortArtifacts(existingFiles(task.execution?.artifacts || [])).slice(0, 8);
  if (files.length) {
    lines.push(`Artifacts (${files.length}): ${files.map((f) => f.name).join(', ')}`);
  }

  const changed = extra.changedFiles || [];
  if (changed.length) {
    lines.push(`Changed (${changed.length}): ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? '…' : ''}`);
  } else if (extra.diffStat) {
    lines.push(`Diff: ${String(extra.diffStat).split('\n').slice(-3).join(' | ').slice(0, 200)}`);
  }

  if (task.execution?.worktree?.path) {
    lines.push(`Worktree: ${task.execution.worktree.path}`);
  }

  const url = publicTaskUrl(task, settings || {});
  lines.push(`Open: ${url}`);

  // Prefer a short result.md excerpt when present
  const result = files.find((f) => f.name === 'result.md');
  if (result?.path && fs.existsSync(result.path)) {
    const excerpt = fs.readFileSync(result.path, 'utf8').trim().replace(/\s+/g, ' ').slice(0, 280);
    if (excerpt) lines.push(`Summary: ${excerpt}`);
  }

  return lines.join('\n').slice(0, 900);
}

async function deliverTaskResult(task, settings, packExtra = {}) {
  const cfg = loadConfig();
  const usePack = settings?.morningPack !== false && cfg.delivery?.morningPack !== false;
  const mode = settings.deliveryMode || (usePack ? 'pack' : 'message');
  const peer = settings.deliveryPeer || cfg.omnish?.peer || '*';
  const title = usePack ? `Pack: ${task.title}` : `Delivered: ${task.title}`;

  // Pack is the default high-signal delivery for autonomy jobs.
  if (mode === 'pack' || (usePack && settings?.deliveryOnComplete !== false && mode === 'summary')) {
    const body = buildMorningPack(task, settings, packExtra);
    // Also attach top files when deliveryOnComplete + files preferred
    if (settings.deliveryMode === 'files') {
      const files = sortArtifacts(existingFiles(task.execution?.artifacts)).slice(0, 5);
      if (files.length) {
        await omnish.notify(title, body, peer);
        return omnish.sendFiles(peer, files.map((f) => f.path), body.slice(0, 160));
      }
    }
    return omnish.notify(title, body, peer);
  }

  if (!settings?.deliveryOnComplete && !usePack) return { skipped: true };

  if (mode === 'files') {
    const files = sortArtifacts(existingFiles(task.execution?.artifacts)).slice(0, 5);
    if (!files.length) {
      return omnish.notify(title, buildSummary(task) || 'Job finished. No files to send.', peer);
    }
    return omnish.sendFiles(
      peer,
      files.map((f) => f.path),
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

  const count = existingFiles(task.execution?.artifacts).length;
  const body = count
    ? `Finished with ${count} file(s). Open OmnishPilot to review outputs.`
    : 'Finished. Open OmnishPilot to review outputs.';
  return omnish.notify(title, body, peer);
}

async function sendTestDelivery(settings) {
  const mode = settings?.deliveryMode || 'pack';
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
  if (mode === 'pack' || mode === 'summary') {
    return omnish.notify(
      'OmnishPilot pack test',
      'Morning pack delivery is enabled.\nGate: PASS — result.md\nArtifacts (1): result.md\nOpen: dashboard/?task=example',
      peer,
    );
  }
  return omnish.notify(
    'OmnishPilot delivery test',
    'Message delivery is enabled. You will get a short notice when jobs finish.',
    peer,
  );
}

module.exports = {
  deliverTaskResult,
  sendTestDelivery,
  buildSummary,
  buildMorningPack,
  existingFiles,
};
