'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { APP_ROOT } = require('./bootstrap');
const { isAlive, killProcess, IS_WIN } = require('./platform');
const client = require('./client');

function loadConfig() {
  return require(path.join(APP_ROOT, 'server', 'config')).loadConfig();
}

function pidPath(cfg = loadConfig()) {
  if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, 'omnishpilot.pid');
}

function logPath(cfg = loadConfig()) {
  if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, 'omnishpilot.log');
}

function readPid(cfg = loadConfig()) {
  const p = pidPath(cfg);
  if (!fs.existsSync(p)) return null;
  const n = Number(String(fs.readFileSync(p, 'utf8')).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function writePid(pid, cfg = loadConfig()) {
  fs.writeFileSync(pidPath(cfg), String(pid) + '\n');
}

function clearPid(cfg = loadConfig()) {
  const p = pidPath(cfg);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function serverEntry() {
  return path.join(APP_ROOT, 'server', 'index.js');
}

function resolveBind(cfg = loadConfig()) {
  const port = Number(
    process.env.OMNISHPILOT_PORT
      || process.env.AGENTBOARD_PORT
      || cfg.port
      || 4580
  );
  const host = process.env.OMNISHPILOT_HOST
    || process.env.AGENTBOARD_HOST
    || cfg.host
    || '127.0.0.1';
  return { host, port };
}

function envForServer(cfg = loadConfig()) {
  const { host, port } = resolveBind(cfg);
  const env = {
    ...process.env,
    AGENTBOARD_PORT: String(port),
    AGENTBOARD_HOST: host,
    OMNISHPILOT_PORT: String(port),
    OMNISHPILOT_HOST: host,
    OMNISHPILOT_PACKAGE_ROOT: APP_ROOT,
  };
  if (cfg._root) env.OMNISHPILOT_HOME = cfg._root;
  return env;
}

async function status() {
  const cfg = loadConfig();
  const pid = readPid(cfg);
  const alive = isAlive(pid);
  const health = await client.health();
  return {
    pid: alive ? pid : null,
    running: Boolean(alive || health),
    health,
    url: client.baseUrl(cfg),
    dataDir: cfg.dataDir,
    root: cfg._root,
    packageRoot: APP_ROOT,
    logFile: logPath(cfg),
    pidFile: pidPath(cfg),
    platform: process.platform,
  };
}

function startForeground() {
  const cfg = loadConfig();
  const child = spawn(process.execPath, [serverEntry()], {
    stdio: 'inherit',
    env: envForServer(cfg),
    cwd: APP_ROOT,
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
  return child;
}

async function startDaemon({ waitMs = 10000 } = {}) {
  const cfg = loadConfig();
  const existing = await status();
  if (existing.health) {
    return { already: true, ...existing };
  }
  if (existing.pid) clearPid(cfg);

  if (!fs.existsSync(serverEntry())) {
    return {
      already: false,
      running: false,
      error: `Server entry missing: ${serverEntry()}. Run: npm run sync (from omnishpilot-cli)`,
    };
  }

  const out = fs.openSync(logPath(cfg), 'a');
  const child = spawn(process.execPath, [serverEntry()], {
    detached: true,
    stdio: ['ignore', out, out],
    env: envForServer(cfg),
    cwd: APP_ROOT,
    windowsHide: true,
  });
  writePid(child.pid, cfg);
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const h = await client.health();
    if (h) {
      return {
        already: false,
        pid: child.pid,
        running: true,
        health: h,
        url: client.baseUrl(cfg),
        logFile: logPath(cfg),
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    already: false,
    pid: child.pid,
    running: isAlive(child.pid),
    health: null,
    url: client.baseUrl(cfg),
    logFile: logPath(cfg),
    warning: 'Started process but health check did not pass yet — check the log',
  };
}

async function stop({ timeoutMs = 5000 } = {}) {
  const cfg = loadConfig();
  const pid = readPid(cfg);
  if (!pid || !isAlive(pid)) {
    clearPid(cfg);
    const health = await client.health();
    if (health) {
      // Best-effort: ask OS service to stop when we did not own the pidfile.
      try {
        const svc = require('./service');
        const st = svc.serviceStatus();
        if (st.installed) {
          if (require('./platform').IS_LINUX) {
            require('child_process').spawnSync('systemctl', ['--user', 'stop', 'omnishpilot.service'], {
              encoding: 'utf8',
            });
          } else if (require('./platform').IS_MAC) {
            const plist = require('path').join(
              require('./platform').launchAgentsDir(),
              'tech.eligapris.omnishpilot.plist'
            );
            require('child_process').spawnSync('launchctl', ['unload', plist], { encoding: 'utf8' });
          }
          await new Promise((r) => setTimeout(r, 400));
          if (!(await client.health())) return { stopped: true, via: 'service' };
        }
      } catch {
        /* fall through */
      }
      return {
        stopped: false,
        error: 'Server responds but no pidfile — stop that process manually, or: omnishpilot service uninstall && kill the node process',
      };
    }
    return { stopped: false, already: true };
  }

  const soft = killProcess(pid, { force: false });
  if (!soft.ok) {
    clearPid(cfg);
    return { stopped: false, error: soft.error };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      clearPid(cfg);
      return { stopped: true, pid };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  killProcess(pid, { force: true });
  clearPid(cfg);
  return { stopped: true, pid, forced: true, windows: IS_WIN };
}

/**
 * Ensure the API is reachable; start a daemon if needed.
 * Set OMNISHPILOT_NO_AUTOSTART=1 or pass autoStart:false to disable.
 */
async function ensureRunning({ autoStart = true, quiet = false } = {}) {
  const h = await client.health();
  if (h) return { health: h, started: false };

  if (!autoStart || process.env.OMNISHPILOT_NO_AUTOSTART === '1') {
    const err = new Error('OmnishPilot is not running. Start it with: omnishpilot start -d');
    err.code = 'NOT_RUNNING';
    throw err;
  }

  if (!quiet) process.stderr.write('[omnishpilot] not running — starting daemon…\n');
  const r = await startDaemon();
  if (r.error) {
    const err = new Error(r.error);
    err.code = 'START_FAILED';
    throw err;
  }
  if (!r.health) {
    const err = new Error(
      `Daemon started but not healthy yet. Check: ${r.logFile || 'omnishpilot status'}`
    );
    err.code = 'NOT_HEALTHY';
    throw err;
  }
  if (!quiet) process.stderr.write(`[omnishpilot] ready → ${r.url}\n`);
  return { health: r.health, started: !r.already, ...r };
}

module.exports = {
  pidPath,
  logPath,
  status,
  startForeground,
  startDaemon,
  stop,
  ensureRunning,
  serverEntry,
  envForServer,
};
