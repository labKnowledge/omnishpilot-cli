'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** Extra dirs where agent CLIs commonly live (especially macOS LaunchAgent / Homebrew). */
function agentBinDirs() {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  // Cursor agent versioned installs
  const cursorVersions = path.join(home, '.local', 'share', 'cursor-agent', 'versions');
  try {
    if (fs.existsSync(cursorVersions)) {
      const vers = fs.readdirSync(cursorVersions)
        .map((name) => path.join(cursorVersions, name))
        .filter((p) => fs.statSync(p).isDirectory())
        .sort()
        .reverse();
      for (const v of vers.slice(0, 3)) dirs.unshift(v);
    }
  } catch { /* ignore */ }
  return dirs.filter((d) => d && fs.existsSync(d));
}

/** PATH with user/Homebrew bins prepended — critical when daemon runs under launchd/systemd. */
function augmentedPath(base = process.env.PATH || '') {
  const parts = [];
  const seen = new Set();
  for (const d of [...agentBinDirs(), ...String(base).split(path.delimiter)]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    parts.push(d);
  }
  return parts.join(path.delimiter);
}

function which(bin, { envPath } = {}) {
  if (!bin) return null;
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return bin;

  const pathEnv = envPath || augmentedPath();
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, PATH: pathEnv },
    });
    if (r.status === 0) {
      const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line && fs.existsSync(line)) return line;
    }
  } catch { /* ignore */ }

  for (const dir of agentBinDirs()) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
    // macOS sometimes installs without execute bit visible; still try .js wrappers
    if (process.platform === 'win32') {
      for (const ext of ['.cmd', '.exe', '.bat']) {
        const w = candidate + ext;
        if (fs.existsSync(w)) return w;
      }
    }
  }
  return null;
}

function resolveAgentRunBin(cfg) {
  const configured = cfg?.agent?.agentRunBin;
  if (configured) {
    const hit = which(configured) || (path.isAbsolute(configured) && fs.existsSync(configured) ? configured : null);
    if (hit) return hit;
    return configured;
  }
  return which('agent-run') || 'agent-run';
}

module.exports = {
  which,
  resolveAgentRunBin,
  augmentedPath,
  agentBinDirs,
};
