'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const agentRun = require('./agent-run');
const resolveBin = require('../runtime/server/resolve-bin');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    process.exitCode = 1;
  }
}

test('shlexSplit respects quotes', () => {
  assert.deepStrictEqual(
    agentRun.shlexSplit('{BIN} -p "{PROMPT}"'),
    ['{BIN}', '-p', '{PROMPT}']
  );
});

test('buildArgv substitutes without re-splitting prompt', () => {
  const argv = agentRun.buildArgv('{BIN} -p "{PROMPT}"', {
    BIN: '/usr/bin/claude',
    PROMPT: 'hello "world" and $HOME',
  });
  assert.deepStrictEqual(argv, ['/usr/bin/claude', '-p', 'hello "world" and $HOME']);
});

test('bundledAgentRunPath finds package bin', () => {
  process.env.OMNISHPILOT_CLI_ROOT = path.join(__dirname, '..');
  const p = resolveBin.bundledAgentRunPath();
  assert.ok(p);
  assert.ok(fs.existsSync(p));
  assert.ok(p.endsWith(path.join('bin', 'agent-run.js')));
});

test('resolveAgentRunBin prefers bundled', () => {
  process.env.OMNISHPILOT_CLI_ROOT = path.join(__dirname, '..');
  const bin = resolveBin.resolveAgentRunBin({});
  assert.strictEqual(bin, resolveBin.bundledAgentRunPath());
});

test('resolveAgentRunSpawn uses node for .js', () => {
  process.env.OMNISHPILOT_CLI_ROOT = path.join(__dirname, '..');
  const inv = resolveBin.resolveAgentRunSpawn({}, ['list', '--json']);
  assert.strictEqual(inv.bin, process.execPath);
  assert.strictEqual(inv.args[0], resolveBin.bundledAgentRunPath());
  assert.deepStrictEqual(inv.args.slice(1), ['list', '--json']);
});

test('CLI list --json exits 0', () => {
  const script = path.join(__dirname, '..', 'bin', 'agent-run.js');
  const r = spawnSync(process.execPath, [script, 'list', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some((a) => a.id === 'claude'));
  assert.ok(parsed.some((a) => a.id === 'cursor-agent'));
});
