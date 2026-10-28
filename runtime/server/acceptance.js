'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');

function inferTestCommand(text) {
  if (!text) return null;
  const npm = text.match(/\b(npm (?:test|run [\w:-]+)|pnpm (?:test|run [\w:-]+)|yarn (?:test|[\w:-]+)|pytest(?: [^\n]+)?|go test(?: [^\n]+)?|cargo test(?: [^\n]+)?|make test)\b/i);
  return npm ? npm[1].trim() : null;
}

function inferArtifacts(text) {
  if (!text) return [];
  const found = [];
  const re = /\b([\w.-]+\.(?:md|txt|json|png|jpg|webp|mp4|html|diff|patch))\b/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found.slice(0, 8);
}

/**
 * Resolve structured acceptance for a task.
 * Sources (highest first): task.acceptance, inputs.acceptance (object), instructions text inference, config defaults.
 */
function resolveAcceptance(task, cfg = loadConfig()) {
  const enabled = cfg.acceptance?.enabled !== false;
  const raw = task.acceptance
    || (task.inputs?.acceptance && typeof task.inputs.acceptance === 'object' ? task.inputs.acceptance : null)
    || {};
  const text = [
    typeof task.inputs?.acceptance === 'string' ? task.inputs.acceptance : '',
    task.instructions?.acceptance || '',
    task.instructions?.constraints || '',
    task.instructions?.verifyNotes || '',
  ].filter(Boolean).join('\n');

  const requiredArtifacts = Array.isArray(raw.requiredArtifacts) && raw.requiredArtifacts.length
    ? raw.requiredArtifacts
    : (inferArtifacts(text).length
      ? inferArtifacts(text)
      : (cfg.acceptance?.defaultArtifacts || ['result.md']));

  const testCommand = raw.testCommand
    || inferTestCommand(text)
    || cfg.acceptance?.defaultTestCommand
    || null;

  const verifier = raw.verifier != null
    ? Boolean(raw.verifier)
    : (task.runMode === 'supervised' || Boolean(cfg.acceptance?.verifier));

  const soft = raw.soft != null ? Boolean(raw.soft) : Boolean(cfg.acceptance?.soft);

  return {
    enabled: enabled && (raw.enabled !== false) && (
      Boolean(text.trim())
      || Boolean(raw.requiredArtifacts?.length)
      || Boolean(raw.testCommand)
      || Boolean(cfg.acceptance?.always)
      || ['code-task', 'agent-task', 'research'].includes(task.templateId)
    ),
    requiredArtifacts,
    testCommand,
    verifier,
    soft,
    text: text.trim(),
  };
}

function fileExistsUnder(root, name) {
  if (!root || !name) return false;
  const target = path.isAbsolute(name) ? name : path.join(root, name);
  try {
    return fs.existsSync(target) && fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function findArtifact(outDir, workspacePath, name) {
  if (fileExistsUnder(outDir, name)) return path.join(outDir, name);
  if (fileExistsUnder(workspacePath, name)) return path.join(workspacePath, name);
  // Allow nested search one level in outDir
  if (outDir && fs.existsSync(outDir)) {
    try {
      for (const ent of fs.readdirSync(outDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const nested = path.join(outDir, ent.name, name);
        if (fs.existsSync(nested) && fs.statSync(nested).isFile()) return nested;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Run mechanical acceptance gates. Does not trust agent claims.
 */
function checkAcceptance({ task, outDir, workspacePath, cfg = loadConfig() }) {
  const profile = resolveAcceptance(task, cfg);
  if (!profile.enabled) {
    return { ok: true, skipped: true, profile, failures: [], evidence: [] };
  }

  const failures = [];
  const evidence = [];

  for (const name of profile.requiredArtifacts) {
    const hit = findArtifact(outDir, workspacePath, name);
    if (hit) {
      evidence.push({ type: 'artifact', name, path: hit, ok: true });
    } else {
      failures.push(`Missing required artifact: ${name}`);
      evidence.push({ type: 'artifact', name, path: null, ok: false });
    }
  }

  if (profile.testCommand) {
    const cwd = workspacePath && fs.existsSync(workspacePath) ? workspacePath : outDir;
    const timeoutMs = (cfg.acceptance?.testTimeoutSec || 300) * 1000;
    const r = spawnSync(profile.testCommand, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
    });
    const ok = r.status === 0;
    evidence.push({
      type: 'test',
      command: profile.testCommand,
      ok,
      status: r.status,
      stdout: String(r.stdout || '').slice(-2000),
      stderr: String(r.stderr || '').slice(-2000),
    });
    if (!ok) {
      failures.push(`Test command failed (${profile.testCommand}): exit ${r.status}`);
    }
  }

  const ok = failures.length === 0;
  return {
    ok: ok || profile.soft,
    softPass: !ok && profile.soft,
    profile,
    failures,
    evidence,
  };
}

function formatAcceptanceReport(result) {
  if (result.skipped) return 'Acceptance gates skipped.';
  if (result.ok && !result.softPass) {
    const bits = result.evidence.filter((e) => e.ok).map((e) => e.type === 'test' ? `test:${e.command}` : e.name);
    return `PASS — ${bits.join(', ') || 'gates clear'}`;
  }
  if (result.softPass) {
    return `SOFT PASS (failures ignored): ${result.failures.join('; ')}`;
  }
  return `FAIL — ${result.failures.join('; ')}`;
}

module.exports = {
  resolveAcceptance,
  checkAcceptance,
  formatAcceptanceReport,
  inferTestCommand,
  inferArtifacts,
};
