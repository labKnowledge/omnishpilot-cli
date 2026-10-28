'use strict';

const { which: platformWhich } = require('./platform');

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function ok(msg) {
  console.log(msg);
}

/** Flags that never take a value (so `add --now "goal"` keeps the goal positional). */
const BOOLEAN_FLAGS = new Set([
  'json', 'now', 'dry-run', 'no-autostart', 'daemon', 'log', 'help',
  'follow', 'force', 'quiet',
  'command', 'cmd', // pure terminal job (no agent)
  'd', 'n', 'f', 'c', // short forms used as booleans in places
]);

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith('-')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function flag(flags, ...names) {
  for (const n of names) {
    if (flags[n] !== undefined) return flags[n];
  }
  return undefined;
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function which(cmd) {
  return platformWhich(cmd);
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function table(rows, headers) {
  if (!rows.length) {
    console.log('(none)');
    return;
  }
  const cols = headers || Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(cols.map((c) => row[c])));
}

module.exports = {
  die,
  ok,
  parseArgs,
  flag,
  shortId,
  which,
  printJson,
  table,
};
