'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { APP_ROOT, CLI_ROOT } = require('./bootstrap');
const {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  platformName,
  systemdUserDir,
  launchAgentsDir,
  shellEscape,
  which,
} = require('./platform');
const daemon = require('./daemon');

const SERVICE_ID = 'omnishpilot';
const LAUNCHD_LABEL = 'tech.eligapris.omnishpilot';
const WINDOWS_TASK = 'OmnishPilot';

function cliBin() {
  const linked = which('omnishpilot');
  if (linked) return linked;
  return path.join(CLI_ROOT, 'bin', 'omnishpilot.js');
}

function nodeBin() {
  return process.execPath;
}

function startCommand() {
  // Prefer invoking node + script so Windows Task Scheduler doesn't need shell wrappers.
  return {
    exe: nodeBin(),
    args: [path.join(CLI_ROOT, 'bin', 'omnishpilot.js'), 'start', '-d'],
    cwd: APP_ROOT,
  };
}

function systemdUnitPath() {
  return path.join(systemdUserDir(), `${SERVICE_ID}.service`);
}

function launchdPlistPath() {
  return path.join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
}

function renderSystemdUnit() {
  const cfg = require(path.join(APP_ROOT, 'server', 'config')).loadConfig();
  const bin = cliBin();
  const isJs = bin.endsWith('.js');
  const execStart = isJs
    ? `${shellEscape(nodeBin())} ${shellEscape(bin)} start -d`
    : `${shellEscape(bin)} start -d`;
  let pathValue = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  try {
    const { augmentedPath } = require(path.join(APP_ROOT, 'server', 'resolve-bin'));
    pathValue = augmentedPath(process.env.PATH || '/usr/local/bin:/usr/bin:/bin');
  } catch { /* ignore */ }
  return `[Unit]
Description=OmnishPilot agent control plane
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=OMNISHPILOT_PACKAGE_ROOT=${shellEscape(APP_ROOT)}
Environment=OMNISHPILOT_HOME=${shellEscape(cfg._root)}
Environment=PATH=${shellEscape(pathValue)}
Environment=HOME=${shellEscape(require('os').homedir())}
WorkingDirectory=${shellEscape(APP_ROOT)}
ExecStart=${execStart}
ExecStop=${isJs ? `${shellEscape(nodeBin())} ${shellEscape(bin)} stop` : `${shellEscape(bin)} stop`}

[Install]
WantedBy=default.target
`;
}

function renderLaunchdPlist() {
  const cfg = require(path.join(APP_ROOT, 'server', 'config')).loadConfig();
  const cmd = startCommand();
  const log = daemon.logPath(cfg);
  const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const argsXml = [cmd.exe, ...cmd.args].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  let pathValue = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    const { augmentedPath } = require(path.join(APP_ROOT, 'server', 'resolve-bin'));
    pathValue = augmentedPath(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin');
  } catch { /* ignore */ }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(APP_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OMNISHPILOT_PACKAGE_ROOT</key>
    <string>${escapeXml(APP_ROOT)}</string>
    <key>OMNISHPILOT_HOME</key>
    <string>${escapeXml(cfg._root)}</string>
    <key>PATH</key>
    <string>${escapeXml(pathValue)}</string>
    <key>HOME</key>
    <string>${escapeXml(require('os').homedir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}

function installLinux() {
  const dir = systemdUserDir();
  fs.mkdirSync(dir, { recursive: true });
  const unit = systemdUnitPath();
  fs.writeFileSync(unit, renderSystemdUnit());
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', `${SERVICE_ID}.service`], {
    encoding: 'utf8',
  });
  return {
    platform: 'linux',
    unit,
    enabled: enable.status === 0,
    detail: (enable.stderr || enable.stdout || '').trim() || 'systemd user unit installed',
  };
}

function uninstallLinux() {
  spawnSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_ID}.service`], { encoding: 'utf8' });
  const unit = systemdUnitPath();
  if (fs.existsSync(unit)) fs.unlinkSync(unit);
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  return { platform: 'linux', removed: true, unit };
}

function statusLinux() {
  const unit = systemdUnitPath();
  const r = spawnSync('systemctl', ['--user', 'is-active', `${SERVICE_ID}.service`], { encoding: 'utf8' });
  return {
    platform: 'linux',
    installed: fs.existsSync(unit),
    active: (r.stdout || '').trim() === 'active',
    unit,
    raw: (r.stdout || '').trim(),
  };
}

function installMac() {
  const dir = launchAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const plist = launchdPlistPath();
  fs.writeFileSync(plist, renderLaunchdPlist());
  spawnSync('launchctl', ['unload', plist], { encoding: 'utf8' });
  const load = spawnSync('launchctl', ['load', plist], { encoding: 'utf8' });
  return {
    platform: 'macos',
    plist,
    loaded: load.status === 0,
    detail: (load.stderr || load.stdout || '').trim() || 'LaunchAgent installed',
  };
}

function uninstallMac() {
  const plist = launchdPlistPath();
  if (fs.existsSync(plist)) {
    spawnSync('launchctl', ['unload', plist], { encoding: 'utf8' });
    fs.unlinkSync(plist);
  }
  return { platform: 'macos', removed: true, plist };
}

function statusMac() {
  const plist = launchdPlistPath();
  const r = spawnSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' });
  return {
    platform: 'macos',
    installed: fs.existsSync(plist),
    active: r.status === 0,
    plist,
  };
}

function installWindows() {
  const cmd = startCommand();
  const tr = `${shellEscape(cmd.exe)} ${cmd.args.map(shellEscape).join(' ')}`;
  // Remove existing task if present, then create on logon.
  spawnSync('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const create = spawnSync(
    'schtasks',
    ['/Create', '/TN', WINDOWS_TASK, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'],
    { encoding: 'utf8', windowsHide: true }
  );
  // Also start once now.
  spawnSync('schtasks', ['/Run', '/TN', WINDOWS_TASK], { encoding: 'utf8', windowsHide: true });
  return {
    platform: 'windows',
    task: WINDOWS_TASK,
    created: create.status === 0,
    detail: (create.stderr || create.stdout || '').trim() || 'Scheduled task created (ONLOGON)',
    command: tr,
  };
}

function uninstallWindows() {
  const r = spawnSync('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    platform: 'windows',
    removed: r.status === 0,
    task: WINDOWS_TASK,
  };
}

function statusWindows() {
  const r = spawnSync('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    platform: 'windows',
    installed: r.status === 0,
    task: WINDOWS_TASK,
    raw: (r.stdout || '').trim().slice(0, 500),
  };
}

function install() {
  if (IS_LINUX) return installLinux();
  if (IS_MAC) return installMac();
  if (IS_WIN) return installWindows();
  return { platform: platformName(), error: `service install not supported on ${process.platform}` };
}

function uninstall() {
  if (IS_LINUX) return uninstallLinux();
  if (IS_MAC) return uninstallMac();
  if (IS_WIN) return uninstallWindows();
  return { platform: platformName(), error: `service uninstall not supported on ${process.platform}` };
}

function serviceStatus() {
  if (IS_LINUX) return statusLinux();
  if (IS_MAC) return statusMac();
  if (IS_WIN) return statusWindows();
  return { platform: platformName(), installed: false };
}

function hints() {
  if (IS_LINUX) {
    return [
      'systemctl --user status omnishpilot',
      'journalctl --user -u omnishpilot -f',
      'loginctl enable-linger $USER   # keep user services after logout (optional)',
    ];
  }
  if (IS_MAC) {
    return [
      `launchctl list ${LAUNCHD_LABEL}`,
      `launchctl unload ${launchdPlistPath()}`,
    ];
  }
  if (IS_WIN) {
    return [
      `schtasks /Query /TN ${WINDOWS_TASK}`,
      `schtasks /Run /TN ${WINDOWS_TASK}`,
    ];
  }
  return [];
}

module.exports = {
  SERVICE_ID,
  LAUNCHD_LABEL,
  WINDOWS_TASK,
  install,
  uninstall,
  serviceStatus,
  hints,
  renderSystemdUnit,
  renderLaunchdPlist,
};
