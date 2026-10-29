'use strict';

// Keeps the computer from sleeping while a job runs or is about to. A run that's missed during sleep still fires on
// wake, but late; an agent cut off by sleep mid-run starts over.

const { spawn } = require('child_process');

/**
 * Whether to hold the machine awake: a job is running, or one is due within the horizon.
 * @returns {{ hold: boolean, reason?: 'running'|'due', at?: string }}
 */
function wakeHoldOf(tasks, now = Date.now(), horizonMs = 15 * 60_000) {
  if (tasks.some((t) => t.status === 'running')) return { hold: true, reason: 'running' };
  const due = tasks
    .filter((t) => t.status === 'scheduled' && !t.muted && t.schedule?.runAt)
    .map((t) => new Date(t.schedule.runAt).getTime())
    .filter((at) => Number.isFinite(at) && at <= now + horizonMs)
    .sort((a, b) => a - b)[0];
  return due === undefined ? { hold: false } : { hold: true, reason: 'due', at: new Date(due).toISOString() };
}

/**
 * The OS command that holds a wake lock until it exits. Each one also watches `pid` and exits with it, so a daemon
 * that dies without cleaning up can't leave the machine awake for good.
 */
function inhibitorCommand(platform, pid) {
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=OmnishPilot', '--why=A scheduled job is running or due', '--mode=block',
        'tail', `--pid=${pid}`, '-f', '/dev/null'],
    };
  }
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') {
    // SetThreadExecutionState holds only while the calling thread lives: ES_CONTINUOUS | ES_SYSTEM_REQUIRED.
    const script = [
      "$t = Add-Type -Name W -Namespace K -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      '$null = $t::SetThreadExecutionState(0x80000001)',
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return null;
}

function createWakeLock({ platform = process.platform, pid = process.pid, run = spawn, log = console.error } = {}) {
  let child = null;
  let unavailable = false;

  function hold() {
    if (child || unavailable) return;
    const command = inhibitorCommand(platform, pid);
    if (!command) {
      unavailable = true;
      return;
    }
    const proc = run(command.cmd, command.args, { stdio: 'ignore', windowsHide: true });
    child = proc;
    proc.on('error', (e) => {
      unavailable = true;
      log(`[wake] can't keep this computer awake for jobs (${command.cmd}: ${e.message})`);
    });
    const startedAt = Date.now();
    proc.on('exit', (code) => {
      if (child !== proc) return;
      child = null;
      // Exiting by itself this soon means the OS refused the lock (a polkit denial, say); asking again won't help.
      if (Date.now() - startedAt < 5000 && !unavailable) {
        unavailable = true;
        log(`[wake] can't keep this computer awake for jobs (${command.cmd} exited with ${code})`);
      }
    });
  }

  function release() {
    if (!child) return;
    const proc = child;
    child = null;
    try { proc.kill(); } catch { /* already gone */ }
  }

  return { hold, release, isHeld: () => child !== null };
}

/** `worker.keepAwake: false` turns it off; `worker.keepAwakeMinutes` is how far ahead a due job counts (default 15). */
function startKeepAwake({ cfg, listTasks, lock = createWakeLock(), everyMs = 60_000 }) {
  if (cfg.worker?.keepAwake === false) return null;
  const horizonMs = (cfg.worker?.keepAwakeMinutes ?? 15) * 60_000;
  const check = () => {
    try {
      if (wakeHoldOf(listTasks(), Date.now(), horizonMs).hold) lock.hold();
      else lock.release();
    } catch (e) {
      console.error('[wake]', e.message);
    }
  };
  check();
  const timer = setInterval(check, everyMs);
  return { close() { clearInterval(timer); lock.release(); } };
}

module.exports = { wakeHoldOf, inhibitorCommand, createWakeLock, startKeepAwake };
