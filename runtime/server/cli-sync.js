#!/usr/bin/env node
const { loadConfig } = require('./config');
const store = require('./store');
const templates = require('./templates');
const registry = require('./connectors/registry');

const cfg = loadConfig();
console.log('[sync] OmnishPilot workspace sync');
for (const ws of cfg.workspaces || []) {
  const def = registry.get(ws.connector);
  if (def.sync) {
    const r = def.sync({ ws, store, templates });
    console.log(`  ${ws.name}: ${r.synced} tasks`);
  }
}
console.log('[sync] done');
