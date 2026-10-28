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

/**
 * Locate the omnishpilot package root that ships bin/agent-run.js.
 * Works for: npm install (runtime/server → ../../bin), monorepo (AgentBoard/server → omnishpilot-cli/bin).
 */
function packageRoots() {
  const roots = [];
  if (process.env.OMNISHPILOT_CLI_ROOT) roots.push(process.env.OMNISHPILOT_CLI_ROOT);
  // Packaged layout: <pkg>/runtime/server/resolve-bin.js → <pkg>
  roots.push(path.resolve(__dirname, '..', '..'));
  // Monorepo: AgentBoard/server → AgentBoard/omnishpilot-cli
  roots.push(path.resolve(__dirname, '..', 'omnishpilot-cli'));
  // When APP_ROOT is the live AgentBoard tree but CLI lives beside it
  if (process.env.OMNISHPILOT_PACKAGE_ROOT) {
    roots.push(path.resolve(process.env.OMNISHPILOT_PACKAGE_ROOT, 'omnishpilot-cli'));
    roots.push(path.resolve(process.env.OMNISHPILOT_PACKAGE_ROOT, '..'));
  }
  return roots;
}

function bundledAgentRunPath() {
  for (const root of packageRoots()) {
    const candidate = path.join(root, 'bin', 'agent-run.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** PATH with user/Homebrew bins + bundled package bin prepended. */
function augmentedPath(base = process.env.PATH || '') {
  const parts = [];
  const seen = new Set();
  const bundled = bundledAgentRunPath();
  const packageBin = bundled ? path.dirname(bundled) : null;
  for (const d of [packageBin, ...agentBinDirs(), ...String(base).split(path.delimiter)]) {
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
    if (process.platform === 'win32') {
      for (const ext of ['.cmd', '.exe', '.bat']) {
        const w = candidate + ext;
        if (fs.existsSync(w)) return w;
      }
    }
  }
  return null;
}

/**
 * Resolve agent-run:
 * 1. Explicit config path
 * 2. Bundled omnishpilot bin/agent-run.js (preferred — no external install)
 * 3. PATH / common locations
 * 4. Fall back to invoking node on the bundled script, or the string "agent-run"
 */
function resolveAgentRunBin(cfg) {
  const configured = cfg?.agent?.agentRunBin;
  if (configured && configured !== 'agent-run' && configured !== 'bundled') {
    const hit = which(configured) || (path.isAbsolute(configured) && fs.existsSync(configured) ? configured : null);
    if (hit) return hit;
    return configured;
  }

  const bundled = bundledAgentRunPath();
  if (bundled) return bundled;

  const onPath = which('agent-run');
  if (onPath) return onPath;

  return 'agent-run';
}

function isNodeScript(binPath) {
  return typeof binPath === 'string' && /\.(c|m)?js$/i.test(binPath);
}

/**
 * Spawn-ready { bin, args } for agent-run. Node scripts always run via process.execPath
 * so Windows / non-executable installs work without a PATH shim.
 */
function resolveAgentRunSpawn(cfg, argv = []) {
  const resolved = resolveAgentRunBin(cfg);
  if (isNodeScript(resolved)) {
    return { bin: process.execPath, args: [resolved, ...argv], script: resolved };
  }
  return { bin: resolved, args: [...argv], script: resolved };
}

module.exports = {
  which,
  resolveAgentRunBin,
  resolveAgentRunSpawn,
  augmentedPath,
  agentBinDirs,
  bundledAgentRunPath,
};
