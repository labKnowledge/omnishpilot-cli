'use strict';

/**
 * Bundled agent-run — detect installed AI coding-agent CLIs and invoke one
 * non-interactively. Same CLI surface as the former standalone Python tool so
 * OmnishPilot does not need an external agent-run install.
 *
 * Usage:
 *   agent-run list [--json]
 *   agent-run run --agent <id|auto> --workspace <path> --prompt-file <file>
 *                  [--model <model>] [--out <dir>] [--command-template <tpl>]
 *                  [--flatten | --no-flatten] [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ADAPTERS = [
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    binNames: ['cursor-agent'],
    versionArgs: ['--version'],
    commandTemplate: '{BIN} --yolo -p --workspace "{WORKSPACE}" "{PROMPT}"',
    flattenPrompt: false,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    binNames: ['claude'],
    versionArgs: ['--version'],
    // -p/--print required for non-interactive exit; flatten helps Claude's prompt handling.
    commandTemplate: '{BIN} -p --dangerously-skip-permissions "{PROMPT}"',
    flattenPrompt: true,
  },
  {
    id: 'agy',
    label: 'Agy',
    binNames: ['agy'],
    versionArgs: ['--version'],
    commandTemplate: '{BIN} -p --dangerously-skip-permissions "{PROMPT}"',
    flattenPrompt: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    binNames: ['codex'],
    versionArgs: ['--version'],
    commandTemplate: '{BIN} exec --full-auto "{PROMPT}"',
    flattenPrompt: true,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    binNames: ['gemini'],
    versionArgs: ['--version'],
    commandTemplate: '{BIN} -p "{PROMPT}"',
    flattenPrompt: true,
  },
  {
    id: 'openagents',
    label: 'OpenAgents',
    binNames: ['openagents', 'open-agents'],
    versionArgs: ['--version'],
    commandTemplate: '{BIN} -p "{PROMPT}"',
    flattenPrompt: true,
  },
];

function extraBinDirs() {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const cursorVersions = path.join(home, '.local', 'share', 'cursor-agent', 'versions');
  try {
    if (fs.existsSync(cursorVersions)) {
      const vers = fs.readdirSync(cursorVersions)
        .map((name) => path.join(cursorVersions, name))
        .filter((p) => {
          try { return fs.statSync(p).isDirectory(); } catch { return false; }
        })
        .sort()
        .reverse();
      for (const v of vers.slice(0, 3)) dirs.unshift(v);
    }
  } catch { /* ignore */ }
  return dirs;
}

function whichBin(name) {
  const pathEnv = [extraBinDirs().join(path.delimiter), process.env.PATH || ''].filter(Boolean).join(path.delimiter);
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, PATH: pathEnv },
    });
    if (r.status === 0) {
      const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line && fs.existsSync(line)) return line;
    }
  } catch { /* ignore */ }
  for (const dir of extraBinDirs()) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    if (process.platform === 'win32') {
      for (const ext of ['.cmd', '.exe', '.bat']) {
        const w = candidate + ext;
        if (fs.existsSync(w)) return w;
      }
    }
  }
  return null;
}

function findBin(names) {
  for (const name of names) {
    const found = whichBin(name);
    if (found) return found;
  }
  return null;
}

function probeVersion(binPath, versionArgs) {
  try {
    const r = spawnSync(binPath, versionArgs, {
      encoding: 'utf8',
      timeout: 10000,
      env: process.env,
    });
    const out = String(r.stdout || r.stderr || '').trim().split(/\r?\n/);
    return out[0] || null;
  } catch {
    return null;
  }
}

function detectAgents() {
  return ADAPTERS.map((adapter) => {
    const binPath = findBin(adapter.binNames);
    const version = binPath ? probeVersion(binPath, adapter.versionArgs) : null;
    return {
      id: adapter.id,
      label: adapter.label,
      bin: binPath,
      version,
      available: Boolean(binPath && version != null),
      commandTemplate: adapter.commandTemplate,
      flattenPrompt: adapter.flattenPrompt,
    };
  });
}

/** Minimal POSIX-ish splitter for trusted templates (never re-parses substituted values). */
function shlexSplit(input) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur.length) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function shellQuote(arg) {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_\/:.,=@%+-]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildArgv(commandTemplate, values) {
  const tokens = shlexSplit(commandTemplate);
  return tokens.map((tok) => {
    let out = tok;
    for (const [key, val] of Object.entries(values)) {
      out = out.split(`{${key}}`).join(val == null ? '' : String(val));
    }
    return out;
  });
}

function resolveAdapter(agentId, detected) {
  const byId = Object.fromEntries(detected.map((r) => [r.id, r]));
  if (agentId === 'auto') {
    const first = detected.find((r) => r.available);
    if (!first) return { adapter: null, resolved: null };
    return {
      adapter: ADAPTERS.find((a) => a.id === first.id),
      resolved: first,
    };
  }
  const adapter = ADAPTERS.find((a) => a.id === agentId) || null;
  if (!adapter) return { adapter: null, resolved: null };
  const resolved = byId[agentId];
  return {
    adapter,
    resolved: resolved && resolved.available ? resolved : null,
  };
}

function cmdList(args) {
  const results = detectAgents();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  for (const r of results) {
    const status = r.available ? `available (${r.version})` : 'not found';
    process.stdout.write(`${r.id.padEnd(14)} ${status}\n`);
  }
  return 0;
}

function cmdRun(args) {
  const detected = detectAgents();
  const { adapter, resolved } = resolveAdapter(args.agent, detected);
  if (!adapter) {
    process.stderr.write(`Unknown agent: ${args.agent}\n`);
    return 2;
  }
  if (!resolved) {
    process.stderr.write(`Agent '${args.agent}' is not available on this system\n`);
    return 3;
  }

  let prompt = fs.readFileSync(args.promptFile, 'utf8').replace(/\n$/, '');
  const flatten = args.flatten == null ? adapter.flattenPrompt : args.flatten;
  if (flatten) prompt = prompt.split(/\s+/).filter(Boolean).join(' ');

  const workspace = path.resolve(args.workspace);
  const template = args.commandTemplate || adapter.commandTemplate;
  const values = {
    BIN: resolved.bin,
    WORKSPACE: workspace,
    MODEL: args.model || '',
    PROMPT: prompt,
  };
  const argv = buildArgv(template, values);

  if (args.dryRun) {
    process.stdout.write(`${argv.map(shellQuote).join(' ')}\n`);
    return 0;
  }

  const cwd = args.out || workspace;
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (r.error) {
    process.stderr.write(`SPAWN ERROR: ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status;
}

function parseArgs(argv) {
  const args = argv.slice();
  const cmd = args.shift();
  if (!cmd || cmd === '-h' || cmd === '--help') {
    return { cmd: 'help' };
  }
  if (cmd === 'list') {
    return { cmd: 'list', json: args.includes('--json') };
  }
  if (cmd === 'run') {
    const out = {
      cmd: 'run',
      agent: 'auto',
      workspace: null,
      promptFile: null,
      model: null,
      out: null,
      commandTemplate: null,
      flatten: null,
      dryRun: false,
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const next = () => args[++i];
      if (a === '--agent') out.agent = next();
      else if (a === '--workspace') out.workspace = next();
      else if (a === '--prompt-file') out.promptFile = next();
      else if (a === '--model') out.model = next();
      else if (a === '--out') out.out = next();
      else if (a === '--command-template') out.commandTemplate = next();
      else if (a === '--flatten') out.flatten = true;
      else if (a === '--no-flatten') out.flatten = false;
      else if (a === '--dry-run') out.dryRun = true;
      else if (a === '-h' || a === '--help') return { cmd: 'help' };
      else throw new Error(`Unknown argument: ${a}`);
    }
    if (!out.workspace) throw new Error('--workspace is required');
    if (!out.promptFile) throw new Error('--prompt-file is required');
    return out;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

function printHelp() {
  process.stdout.write(`agent-run — invoke a local coding-agent CLI non-interactively

Usage:
  agent-run list [--json]
  agent-run run --agent <id|auto> --workspace <path> --prompt-file <file>
                [--model <model>] [--out <dir>] [--command-template <tpl>]
                [--flatten | --no-flatten] [--dry-run]

Bundled with omnishpilot; agents (cursor-agent, claude, …) remain separate installs.
`);
}

function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    printHelp();
    return 2;
  }
  if (parsed.cmd === 'help') {
    printHelp();
    return 0;
  }
  if (parsed.cmd === 'list') return cmdList(parsed);
  if (parsed.cmd === 'run') return cmdRun(parsed);
  return 2;
}

module.exports = {
  ADAPTERS,
  detectAgents,
  buildArgv,
  shlexSplit,
  resolveAdapter,
  main,
};

if (require.main === module) {
  process.exitCode = main();
}
