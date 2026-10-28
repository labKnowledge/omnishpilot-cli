'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

function platformName() {
  if (IS_WIN) return 'windows';
  if (IS_MAC) return 'macos';
  if (IS_LINUX) return 'linux';
  return process.platform;
}

function which(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;

  // Prefer shared resolver (Homebrew + ~/.local/bin) when server package is available.
  try {
    const { APP_ROOT } = require('./bootstrap');
    const { which: resolveWhich } = require(path.join(APP_ROOT, 'server', 'resolve-bin'));
    const hit = resolveWhich(cmd);
    if (hit) return hit;
  } catch { /* fall through */ }

  const finder = IS_WIN ? 'where' : 'which';
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(path.delimiter);
  const r = spawnSync(finder, [cmd], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PATH: `${extra}${path.delimiter}${process.env.PATH || ''}` },
  });
  if (r.status !== 0) return null;
  const line = (r.stdout || '').trim().split(/\r?\n/).find(Boolean);
  return line || null;
}

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid, { force = false } = {}) {
  if (!pid) return { ok: false, error: 'no_pid' };
  if (IS_WIN) {
    const args = force
      ? ['/PID', String(pid), '/T', '/F']
      : ['/PID', String(pid), '/T'];
    const r = spawnSync('taskkill', args, { encoding: 'utf8', windowsHide: true });
    // 128 = process not found — treat as already dead
    if (r.status === 0 || r.status === 128) return { ok: true };
    return { ok: false, error: (r.stderr || r.stdout || `taskkill ${r.status}`).trim() };
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (e) {
    if (e.code === 'ESRCH') return { ok: true };
    return { ok: false, error: e.message };
  }
}

function openUrl(url) {
  try {
    if (IS_MAC) {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (IS_WIN) {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function userConfigDir(...parts) {
  if (IS_WIN) {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'omnishpilot', ...parts);
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'omnishpilot', ...parts);
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'omnishpilot', ...parts);
}

function userDataDir(...parts) {
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'omnishpilot', ...parts);
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'omnishpilot', ...parts);
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'omnishpilot', ...parts);
}

function defaultHome() {
  // Keep a single portable home across platforms for OMNISHPILOT_HOME default.
  return path.join(os.homedir(), '.omnishpilot');
}

function systemdUserDir() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'systemd', 'user');
}

function launchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function quoteCmdArg(arg) {
  const s = String(arg);
  if (!/[\s"]/u.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function shellEscape(arg) {
  if (IS_WIN) return quoteCmdArg(arg);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  platformName,
  which,
  isAlive,
  killProcess,
  openUrl,
  userConfigDir,
  userDataDir,
  defaultHome,
  systemdUserDir,
  launchAgentsDir,
  quoteCmdArg,
  shellEscape,
};
