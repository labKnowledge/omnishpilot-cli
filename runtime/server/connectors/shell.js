'use strict';

/**
 * Pure terminal / script / app runner — no agent.
 * Schedules like cron: exit 0 = success. Logs stdout/stderr to the job log.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../config');
const { SHELL_COMMAND } = require('./ids');

function resolveCommand(task) {
  const cmd = String(task.inputs?.command || task.inputs?.goal || '').trim();
  if (!cmd) {
    const err = new Error('Command is required — what should the terminal run?');
    err.code = 'SHELL_NO_COMMAND';
    throw err;
  }
  return cmd;
}

function resolveCwd(task) {
  const raw = String(task.inputs?.cwd || task.inputs?.workspace || '').trim();
  if (!raw) return process.cwd();
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`Working directory not found: ${raw}`);
    err.code = 'SHELL_BAD_CWD';
    throw err;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    const err = new Error(`Working directory is not a folder: ${raw}`);
    err.code = 'SHELL_BAD_CWD';
    throw err;
  }
  return resolved;
}

function parseEnvBlock(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Prefer a real login-ish shell so PATH / aliases behave like a user terminal. */
function shellInvoker() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { bin: comspec, prefix: ['/d', '/s', '/c'], label: comspec };
  }
  if (fs.existsSync('/bin/bash')) {
    return { bin: '/bin/bash', prefix: ['-lc'], label: 'bash -lc' };
  }
  return { bin: '/bin/sh', prefix: ['-c'], label: 'sh -c' };
}

function fakeFailChild(code = 1) {
  return {
    pid: null,
    stdout: { on() {} },
    stderr: { on() {} },
    on(ev, cb) {
      if (ev === 'close') setImmediate(() => cb(code));
    },
    kill() {},
  };
}

function listOutputArtifacts(outDir) {
  if (!outDir || !fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir)
    .map((name) => {
      const p = path.join(outDir, name);
      try {
        if (!fs.statSync(p).isFile()) return null;
      } catch {
        return null;
      }
      return { name, path: p };
    })
    .filter(Boolean);
}

function runShellCommand(task, logPath) {
  const cfg = loadConfig();
  const outDir = path.join(cfg.dataDir, 'outputs', task.id);
  fs.mkdirSync(outDir, { recursive: true });

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} ${SHELL_COMMAND} ===\n`);

  let command;
  let cwd;
  try {
    command = resolveCommand(task);
    cwd = resolveCwd(task);
  } catch (err) {
    logStream.write(`ERROR: ${err.message}\n`);
    logStream.end();
    return { child: fakeFailChild(1), logStream, outDir, spawnError: err.message };
  }

  const inv = shellInvoker();
  const env = {
    ...process.env,
    ...parseEnvBlock(task.inputs?.env),
    OMNISHPILOT_OUT: outDir,
    OMNISHPILOT_TASK_ID: task.id,
  };

  logStream.write(`cwd: ${cwd}\n`);
  logStream.write(`shell: ${inv.label}\n`);
  logStream.write(`command: ${command}\n`);
  logStream.write(`(no agent — pure process)\n`);

  // Host automation by default (cron-like). Optional sandbox wrap when requested.
  let spawnBin = inv.bin;
  let spawnArgs = [...inv.prefix, command];
  let sandboxMeta = { backend: 'none', skipped: true, reason: 'shell jobs run on host by default' };

  const wantSandbox = task.inputs?.sandbox === true
    || task.inputs?.sandbox === 'true'
    || task.inputs?.sandbox === '1';

  if (wantSandbox) {
    try {
      const sandbox = require('../sandbox');
      const wrapped = sandbox.wrapCommand(cfg, {
        command: inv.bin,
        args: [...inv.prefix, command],
        cwd,
        rwPaths: [cwd, outDir, cfg.dataDir],
        env,
        mode: 'strict',
      });
      spawnBin = wrapped.bin;
      spawnArgs = wrapped.args;
      sandboxMeta = {
        backend: wrapped.backend,
        skipped: Boolean(wrapped.skipped),
        warning: wrapped.warning || null,
      };
      logStream.write(`sandbox: ${sandboxMeta.backend}${sandboxMeta.skipped ? ' (skipped)' : ''}\n`);
    } catch (err) {
      logStream.write(`SANDBOX ERROR: ${err.message}\n`);
      logStream.end();
      return {
        child: fakeFailChild(1),
        logStream,
        outDir,
        spawnError: err.message,
        sandbox: { error: err.message },
      };
    }
  } else {
    logStream.write('sandbox: none (host command)\n');
  }

  const child = spawn(spawnBin, spawnArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsVerbatimArguments: process.platform === 'win32',
  });

  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));
  child.on('error', (err) => {
    logStream.write(`\nSPAWN ERROR: ${err.message}\n`);
    if (err.code === 'ENOENT') {
      logStream.write('Hint: shell binary not found. Check PATH / ComSpec.\n');
    }
  });

  return { child, logStream, outDir, sandbox: sandboxMeta };
}

module.exports = {
  runShellCommand,
  resolveCommand,
  resolveCwd,
  parseEnvBlock,
  shellInvoker,
  listOutputArtifacts,
};
