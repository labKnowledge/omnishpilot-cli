const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = process.env.OMNISHPILOT_PACKAGE_ROOT
  ? path.resolve(process.env.OMNISHPILOT_PACKAGE_ROOT)
  : path.join(__dirname, '..');

function defaultHome() {
  return path.join(os.homedir(), '.omnishpilot');
}

/**
 * Resolve the runtime root (config + data).
 * Priority:
 *   1. OMNISHPILOT_HOME
 *   2. Package checkout when it has a local config (dev)
 *   3. ~/.omnishpilot (global install / packaged use)
 */
function resolveRoot() {
  if (process.env.OMNISHPILOT_HOME) {
    return path.resolve(process.env.OMNISHPILOT_HOME);
  }
  const localMarkers = [
    'omnishpilot.config.local.json',
    'omnishpilot.config.json',
    'agentboard.config.local.json',
    'agentboard.config.json',
  ];
  // Prefer config next to the live app package, then classic AgentBoard root.
  const searchRoots = [PACKAGE_ROOT];
  const classic = path.join(__dirname, '..');
  if (path.resolve(classic) !== path.resolve(PACKAGE_ROOT)) searchRoots.push(classic);
  for (const root of searchRoots) {
    const hasLocal = localMarkers.some((name) => fs.existsSync(path.join(root, name)));
    if (hasLocal) return root;
  }
  return defaultHome();
}

const ROOT = resolveRoot();

function ensureHomeScaffold(root) {
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const cfgPath = path.join(root, 'omnishpilot.config.json');
  if (!fs.existsSync(cfgPath)) {
    const example = path.join(PACKAGE_ROOT, 'omnishpilot.config.example.json');
    const bundled = path.join(PACKAGE_ROOT, 'omnishpilot.config.json');
    const source = fs.existsSync(example) ? example : (fs.existsSync(bundled) ? bundled : null);
    if (source) {
      const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
      // Strip machine-specific absolute paths from a seeded home config.
      if (raw.omnish?.bin && path.isAbsolute(raw.omnish.bin)) raw.omnish.bin = 'omnish';
      if (raw.agent?.cursorAgent && path.isAbsolute(raw.agent.cursorAgent)) {
        raw.agent.cursorAgent = 'cursor-agent';
      }
      if (raw.agent?.defaultWorkspace) raw.agent.defaultWorkspace = '';
      if (raw.agent?.envFile) raw.agent.envFile = '';
      if (Array.isArray(raw.workspaces)) {
        raw.workspaces = raw.workspaces.map((ws) => ({
          ...ws,
          rootPath: ws.rootPath && !String(ws.rootPath).startsWith('/media/') ? ws.rootPath : '',
          enabled: Boolean(ws.rootPath) && !String(ws.rootPath).startsWith('/media/'),
        }));
      }
      raw.dataDir = './data';
      fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    } else {
      fs.writeFileSync(cfgPath, JSON.stringify({
        port: 4580,
        host: '127.0.0.1',
        dataDir: './data',
        omnish: { enabled: true, peer: '*', bin: 'omnish' },
        workspaces: [],
      }, null, 2) + '\n');
    }
  }
}

function loadConfig() {
  if (ROOT !== PACKAGE_ROOT) ensureHomeScaffold(ROOT);

  const paths = [
    path.join(ROOT, 'omnishpilot.config.local.json'),
    path.join(ROOT, 'omnishpilot.config.json'),
    path.join(ROOT, 'agentboard.config.local.json'),
    path.join(ROOT, 'agentboard.config.json'),
  ];
  let cfg = {};
  for (const p of paths) {
    if (fs.existsSync(p)) cfg = { ...cfg, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir || './data');
  cfg._root = ROOT;
  cfg._packageRoot = PACKAGE_ROOT;
  return cfg;
}

module.exports = {
  loadConfig,
  ROOT,
  PACKAGE_ROOT,
  defaultHome,
  resolveRoot,
  ensureHomeScaffold,
};
