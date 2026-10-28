#!/usr/bin/env node
'use strict';

/**
 * Copy the AgentBoard server + public UI into omnishpilot-cli/runtime/
 * so this folder can be installed/pulled elsewhere as a self-contained package.
 *
 * Source of truth remains the parent AgentBoard checkout when present.
 */

const fs = require('fs');
const path = require('path');

const CLI_ROOT = path.join(__dirname, '..');
const PARENT = path.join(CLI_ROOT, '..');
const DEST = path.join(CLI_ROOT, 'runtime');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest, { ignore = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignore.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, { ignore });
    else fs.copyFileSync(from, to);
  }
}

function main() {
  const serverSrc = path.join(PARENT, 'server');
  const publicSrc = path.join(PARENT, 'public');
  const exampleSrc = path.join(PARENT, 'omnishpilot.config.example.json');

  if (!exists(path.join(serverSrc, 'index.js'))) {
    if (exists(path.join(DEST, 'server', 'index.js'))) {
      console.log(`[sync-runtime] parent server missing — keeping existing ${DEST}`);
      return;
    }
    console.error('[sync-runtime] cannot find parent AgentBoard/server');
    process.exit(1);
  }

  console.log(`[sync-runtime] ${PARENT} → ${DEST}`);
  fs.mkdirSync(DEST, { recursive: true });

  rmrf(path.join(DEST, 'server'));
  copyDir(serverSrc, path.join(DEST, 'server'), {
    ignore: ['node_modules'],
  });

  if (exists(publicSrc)) {
    rmrf(path.join(DEST, 'public'));
    copyDir(publicSrc, path.join(DEST, 'public'));
  }

  if (exists(exampleSrc)) {
    fs.copyFileSync(exampleSrc, path.join(DEST, 'omnishpilot.config.example.json'));
    fs.copyFileSync(exampleSrc, path.join(CLI_ROOT, 'omnishpilot.config.example.json'));
  }

  // Marker so bootstrap prefers bundled runtime when desired
  fs.writeFileSync(
    path.join(DEST, '.runtime-synced.json'),
    JSON.stringify({
      syncedAt: new Date().toISOString(),
      source: PARENT,
      platform: process.platform,
    }, null, 2) + '\n'
  );

  console.log('[sync-runtime] done');
}

main();
