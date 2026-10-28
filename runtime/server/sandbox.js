'use strict';

/**
 * OmnishPilot sandbox — isolate unattended agent runs.
 *
 * Default backend on Linux: bubblewrap (bwrap).
 * Policy:
 *   - host FS read-only except explicit RW binds (workspace, outDir, dataDir, extras)
 *   - sensitive paths hidden via tmpfs (ssh/aws/gnupg/kube)
 *   - network ON by default (agents need model APIs); set sandbox.network=false to cut egress
 *   - die-with-parent + unshare-pid
 *
 * Autonomy without isolation is unsafe YOLO. doctor + requireForAutonomous enforce that.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function whichLocal(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return bin;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const candidate = path.join(d, bin);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* skip */
    }
  }
  return null;
}

const DEFAULT_HIDE = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.kube', '~/.docker'];

function expandUser(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function sandboxConfig(cfg = {}) {
  const s = cfg.sandbox || {};
  return {
    enabled: s.enabled !== false,
    backend: s.backend || 'auto',
    network: s.network !== false,
    requireForAutonomous: s.requireForAutonomous !== false,
    hidePaths: Array.isArray(s.hidePaths) ? s.hidePaths : DEFAULT_HIDE,
    extraBindRw: Array.isArray(s.extraBindRw) ? s.extraBindRw : [],
  };
}

function detectBackends() {
  return {
    bwrap: whichLocal('bwrap'),
    docker: whichLocal('docker'),
    firejail: whichLocal('firejail'),
  };
}

function resolveBackend(cfg) {
  const sc = sandboxConfig(cfg);
  const found = detectBackends();
  if (sc.backend === 'none') return { id: 'none', bin: null, found };
  if (sc.backend === 'bwrap') return { id: found.bwrap ? 'bwrap' : 'unavailable', bin: found.bwrap, found };
  if (sc.backend === 'docker') return { id: found.docker ? 'docker' : 'unavailable', bin: found.docker, found };
  if (sc.backend === 'firejail') return { id: found.firejail ? 'firejail' : 'unavailable', bin: found.firejail, found };
  // auto
  if (found.bwrap) return { id: 'bwrap', bin: found.bwrap, found };
  if (found.docker) return { id: 'docker', bin: found.docker, found };
  return { id: 'none', bin: null, found };
}

function status(cfg) {
  const sc = sandboxConfig(cfg);
  const backend = resolveBackend(cfg);
  const healthy = sc.enabled && (backend.id === 'bwrap' || backend.id === 'docker' || backend.id === 'firejail');
  const root = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  return {
    enabled: sc.enabled,
    requireForAutonomous: sc.requireForAutonomous,
    network: sc.network,
    backend: backend.id,
    backendBin: backend.bin,
    available: backend.found,
    healthy,
    runningAsRoot: root,
    platform: process.platform,
    hidePaths: sc.hidePaths.map(expandUser),
    note: healthy
      ? 'Sandbox ready for autonomous agent runs'
      : sc.enabled
        ? 'No sandbox backend found (install bubblewrap: apt install bubblewrap)'
        : 'Sandbox disabled in config (sandbox.enabled=false)',
  };
}

function canRunAutonomous(cfg) {
  const sc = sandboxConfig(cfg);
  const st = status(cfg);
  if (!sc.requireForAutonomous) return { ok: true, reason: 'requireForAutonomous=false' };
  if (!sc.enabled) return { ok: false, reason: 'sandbox.enabled=false but requireForAutonomous=true' };
  if (st.runningAsRoot) return { ok: false, reason: 'refusing autonomous run as root' };
  if (!st.healthy) return { ok: false, reason: st.note };
  return { ok: true, reason: `backend=${st.backend}` };
}

function uniqueExisting(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    const p = expandUser(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (fs.existsSync(p)) out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Build argv to run `command + args` inside the sandbox.
 * mode:
 *   - 'agent' (default): HOME RW for CLI login state; hidePaths masked
 *   - 'strict': only rwPaths/cwd writable (deny-tests / untrusted probes)
 * Returns { bin, args, backend, skipped? } — if skipped, caller runs command bare.
 */
function wrapCommand(cfg, { command, args = [], cwd, rwPaths = [], env = process.env, mode = 'agent' } = {}) {
  const sc = sandboxConfig(cfg);
  if (!sc.enabled) {
    return { bin: command, args, backend: 'none', skipped: true, reason: 'disabled' };
  }
  const gate = canRunAutonomous(cfg);
  if (!gate.ok) {
    const err = new Error(`Sandbox required for autonomous run: ${gate.reason}`);
    err.code = 'SANDBOX_REQUIRED';
    throw err;
  }
  const backend = resolveBackend(cfg);
  if (backend.id === 'bwrap') {
    return wrapBwrap(sc, backend.bin, { command, args, cwd, rwPaths, env, mode });
  }
  if (backend.id === 'docker') {
    return wrapDocker(sc, backend.bin, { command, args, cwd, rwPaths, env, mode });
  }
  if (backend.id === 'firejail') {
    return wrapFirejail(sc, backend.bin, { command, args, cwd, rwPaths });
  }
  if (!sc.requireForAutonomous) {
    return {
      bin: command,
      args,
      backend: 'none',
      skipped: true,
      reason: 'no backend; requireForAutonomous=false',
      warning: 'Running WITHOUT sandbox — install bubblewrap for isolation',
    };
  }
  const err = new Error(`No sandbox backend available`);
  err.code = 'SANDBOX_UNAVAILABLE';
  throw err;
}

function wrapBwrap(sc, bwrapBin, { command, args, cwd, rwPaths, mode }) {
  // Agent mode: HOME is RW so CLIs can use login state (~/.claude, ~/.cursor).
  // Sensitive subtrees are masked with tmpfs (hidePaths). Strict mode: only explicit RW.
  const homeBind = mode === 'strict' ? [] : [os.homedir()];
  const binds = uniqueExisting([
    ...homeBind,
    ...(rwPaths || []),
    cwd,
    ...(sc.extraBindRw || []),
  ].filter(Boolean));
  const hide = mode === 'strict' ? [] : uniqueExisting(sc.hidePaths);
  const bargs = [
    '--die-with-parent',
    '--unshare-pid',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];
  if (!sc.network) bargs.push('--unshare-net');
  for (const p of binds) {
    bargs.push('--bind', p, p);
  }
  for (const p of hide) {
    bargs.push('--tmpfs', p);
  }
  if (cwd) bargs.push('--chdir', cwd);
  bargs.push('--', command, ...args);
  return { bin: bwrapBin, args: bargs, backend: 'bwrap', skipped: false, mode };
}

function wrapDocker(sc, dockerBin, { command, args, cwd, rwPaths, env }) {
  // Lightweight host-network container with RW binds — weaker than bwrap namespaces
  // but better than bare metal when bwrap is missing.
  const binds = uniqueExisting([...(rwPaths || []), cwd].filter(Boolean));
  const dargs = ['run', '--rm', '-i', '--network', sc.network ? 'host' : 'none'];
  if (cwd) dargs.push('-w', cwd);
  for (const p of binds) dargs.push('-v', `${p}:${p}`);
  // Pass PATH and HOME so host-installed agent CLIs resolve when using a node image… 
  // Host binary invoke needs --pid=host + mount; use alpine + host paths is brittle.
  // Prefer invoking via host namespace share:
  dargs.push('--pid=host', '--ipc=host');
  dargs.push('-v', '/usr:/usr:ro', '-v', '/bin:/bin:ro', '-v', '/lib:/lib:ro');
  if (fs.existsSync('/lib64')) dargs.push('-v', '/lib64:/lib64:ro');
  if (env.HOME) dargs.push('-v', `${env.HOME}:${env.HOME}`, '-e', `HOME=${env.HOME}`);
  dargs.push('-e', `PATH=${env.PATH || '/usr/bin:/bin'}`);
  dargs.push('--entrypoint', command);
  dargs.push('alpine:3.20', ...args);
  return { bin: dockerBin, args: dargs, backend: 'docker', skipped: false, warning: 'docker backend is best-effort; prefer bubblewrap' };
}

function wrapFirejail(sc, firejailBin, { command, args, cwd, rwPaths }) {
  const binds = uniqueExisting([...(rwPaths || []), cwd].filter(Boolean));
  const fargs = ['--quiet', '--private-tmp', '--noroot'];
  if (!sc.network) fargs.push('--net=none');
  for (const p of binds) fargs.push(`--whitelist=${p}`);
  if (cwd) fargs.push(`--chdir=${cwd}`);
  fargs.push('--', command, ...args);
  return { bin: firejailBin, args: fargs, backend: 'firejail', skipped: false };
}

/**
 * Prove writes outside RW binds fail and (optionally) network is cut.
 */
function denyTest(cfg) {
  const sc = sandboxConfig(cfg);
  const results = [];
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishpilot-sbx-'));
  // Target a path on the read-only root bind (not under /tmp tmpfs or HOME).
  const outside = `/etc/omnishpilot-sbx-should-fail-${process.pid}`;

  const script = `#!/bin/sh
set -e
echo ok > "${probeDir}/inside.txt"
if echo bad > "${outside}" 2>/dev/null; then
  echo WRITE_ESCAPE
  exit 2
fi
echo DENIED_OK
`;
  const scriptPath = path.join(probeDir, 'probe.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  let wrapped;
  try {
    const testCfg = {
      ...cfg,
      sandbox: { ...sc, enabled: true, requireForAutonomous: true },
    };
    wrapped = wrapCommand(testCfg, {
      command: '/bin/sh',
      args: [scriptPath],
      cwd: probeDir,
      rwPaths: [probeDir],
      mode: 'strict',
    });
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      results: [{ id: 'wrap', ok: false, detail: e.message }],
    };
  }

  const r = spawnSync(wrapped.bin, wrapped.args, { encoding: 'utf8', timeout: 15000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const insideOk = fs.existsSync(path.join(probeDir, 'inside.txt'));
  const escaped = fs.existsSync(outside);
  results.push({ id: 'backend', ok: true, detail: wrapped.backend });
  results.push({ id: 'write_inside', ok: insideOk, detail: insideOk ? 'wrote inside RW bind' : 'failed to write inside sandbox' });
  results.push({
    id: 'write_outside',
    ok: !escaped && /DENIED_OK/.test(out),
    detail: escaped ? `ESCAPE: wrote ${outside}` : 'outside write denied (good)',
  });
  if (!sc.network) {
    try {
      const netWrap = wrapCommand(
        { ...cfg, sandbox: { ...sc, enabled: true, requireForAutonomous: true, network: false } },
        {
          command: '/bin/sh',
          args: ['-c', 'curl -s --max-time 3 https://example.com >/dev/null && echo NET_OK || echo NET_BLOCKED'],
          cwd: probeDir,
          rwPaths: [probeDir],
        }
      );
      const nr = spawnSync(netWrap.bin, netWrap.args, { encoding: 'utf8', timeout: 10000 });
      const nout = `${nr.stdout || ''}${nr.stderr || ''}`;
      results.push({
        id: 'network',
        ok: /NET_BLOCKED/.test(nout) || !/NET_OK/.test(nout),
        detail: /NET_OK/.test(nout) ? 'network still reachable (unexpected)' : 'network blocked or curl missing (ok)',
      });
    } catch (e) {
      results.push({ id: 'network', ok: false, detail: e.message });
    }
  } else {
    results.push({ id: 'network', ok: true, detail: 'network left enabled (agents need model APIs)' });
  }

  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const ok = results.every((x) => x.ok);
  return { ok, backend: wrapped.backend, results, output: out.slice(0, 500) };
}

module.exports = {
  sandboxConfig,
  detectBackends,
  resolveBackend,
  status,
  canRunAutonomous,
  wrapCommand,
  denyTest,
  DEFAULT_HIDE,
};
