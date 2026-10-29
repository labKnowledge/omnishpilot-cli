#!/usr/bin/env node
'use strict';

/**
 * postinstall / CLI entry: copy OmnishPilot skill into global agent skill dirs.
 *
 * Canonical: ~/.agents/skills/omnishpilot
 * Symlinks:  ~/.cursor/skills/omnishpilot, ~/.claude/skills/omnishpilot
 *            (+ ~/.codex/skills when that dir exists or can be created)
 *
 * Env:
 *   OMNISHPILOT_SKIP_SKILL_INSTALL=1  — no-op (CI / locked-down hosts)
 *   OMNISHPILOT_INSTALL_SKILL=1       — force even when not a global npm install
 *   OMNISHPILOT_SKILL_QUIET=1         — suppress success logs (postinstall default)
 */

const path = require('path');
const { installSkill, skillStatus, uninstallSkill } = require('../lib/skill-install');

function isGlobalNpmInstall() {
  const g = process.env.npm_config_global;
  return g === 'true' || g === '1' || g === true;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'install').toLowerCase();
  const quiet =
    process.env.OMNISHPILOT_SKILL_QUIET === '1'
    || process.env.npm_lifecycle_event === 'postinstall';
  const skip = process.env.OMNISHPILOT_SKIP_SKILL_INSTALL === '1';
  const force = process.env.OMNISHPILOT_INSTALL_SKILL === '1' || cmd === 'install';

  if (cmd === 'status') {
    const st = skillStatus();
    console.log(JSON.stringify(st, null, 2));
    process.exit(st.installed ? 0 : 1);
  }

  if (cmd === 'uninstall') {
    const r = uninstallSkill({ quiet: false });
    if (r.error) {
      console.error(`[omnishpilot] skill uninstall: ${r.error}`);
      process.exit(1);
    }
    console.log(`[omnishpilot] skill removed from ${r.removed.join(', ') || '(nothing found)'}`);
    return;
  }

  // Default: install
  if (skip) {
    if (!quiet) console.log('[omnishpilot] skill install skipped (OMNISHPILOT_SKIP_SKILL_INSTALL=1)');
    return;
  }

  // On bare `node scripts/install-skill.js` from postinstall: only auto-run for
  // global installs unless forced. Explicit `install` argv always runs.
  const fromPostinstall = process.env.npm_lifecycle_event === 'postinstall' && argv.length === 0;
  if (fromPostinstall && !isGlobalNpmInstall() && process.env.OMNISHPILOT_INSTALL_SKILL !== '1') {
    return;
  }

  if (!force && fromPostinstall === false && argv.length === 0) {
    // unreachable for normal CLI; keep safe default
  }

  try {
    const r = installSkill({ quiet });
    if (r.error) {
      if (!quiet) console.error(`[omnishpilot] skill install warning: ${r.error}`);
      // Never fail npm install because of skill copy
      process.exitCode = fromPostinstall ? 0 : 1;
      return;
    }
    if (!quiet) {
      console.log(`[omnishpilot] skill installed → ${r.canonical}`);
      for (const link of r.links || []) {
        console.log(`[omnishpilot]   linked → ${link}`);
      }
    } else if (r.canonical) {
      console.log(`[omnishpilot] agent skill → ${r.canonical}`);
    }
  } catch (err) {
    if (!quiet) console.error(`[omnishpilot] skill install warning: ${err.message || err}`);
    if (!fromPostinstall) process.exitCode = 1;
  }
}

main();
