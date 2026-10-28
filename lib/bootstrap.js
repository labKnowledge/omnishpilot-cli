'use strict';

const fs = require('fs');
const path = require('path');

const CLI_ROOT = path.join(__dirname, '..');

function resolveAppRoot() {
  if (process.env.OMNISHPILOT_PACKAGE_ROOT) {
    return path.resolve(process.env.OMNISHPILOT_PACKAGE_ROOT);
  }
  // Monorepo checkout: live AgentBoard/server next to omnishpilot-cli/
  const parent = path.join(CLI_ROOT, '..');
  if (fs.existsSync(path.join(parent, 'server', 'index.js'))) {
    return parent;
  }
  // Portable install: bundled runtime/ shipped inside this package
  const bundled = path.join(CLI_ROOT, 'runtime');
  if (fs.existsSync(path.join(bundled, 'server', 'index.js'))) {
    return bundled;
  }
  return bundled;
}

const APP_ROOT = resolveAppRoot();
process.env.OMNISHPILOT_PACKAGE_ROOT = APP_ROOT;

function requireApp(rel) {
  return require(path.join(APP_ROOT, rel));
}

module.exports = {
  CLI_ROOT,
  APP_ROOT,
  resolveAppRoot,
  requireApp,
};
