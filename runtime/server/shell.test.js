'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const shell = require('./connectors/shell');
const templates = require('./templates');
const ids = require('./connectors/ids');
const acceptance = require('./acceptance');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    process.exitCode = 1;
  }
}

test('shell-command template exists and uses SHELL_COMMAND connector', () => {
  const tpl = templates.getTemplate('shell-command');
  assert.ok(tpl);
  assert.strictEqual(tpl.connector, ids.SHELL_COMMAND);
  assert.strictEqual(tpl.defaultRunMode, 'manual');
  assert.strictEqual(tpl.defaultMaxAttempts, 1);
  assert.deepStrictEqual(tpl.instructionSections, []);
});

test('resolveCommand reads inputs.command', () => {
  assert.strictEqual(shell.resolveCommand({ inputs: { command: ' echo hi ' } }), 'echo hi');
});

test('resolveCommand rejects empty', () => {
  assert.throws(() => shell.resolveCommand({ inputs: {} }), /required/i);
});

test('resolveCwd requires existing directory when set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishpilot-shell-'));
  assert.strictEqual(shell.resolveCwd({ inputs: { cwd: dir } }), path.resolve(dir));
  assert.throws(() => shell.resolveCwd({ inputs: { cwd: path.join(dir, 'missing') } }), /not found/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseEnvBlock parses KEY=value lines', () => {
  const env = shell.parseEnvBlock('# comment\nFOO=bar\nBAZ=1\n');
  assert.strictEqual(env.FOO, 'bar');
  assert.strictEqual(env.BAZ, '1');
});

test('shellInvoker returns a shell binary', () => {
  const inv = shell.shellInvoker();
  assert.ok(inv.bin);
  assert.ok(Array.isArray(inv.prefix));
  assert.ok(inv.prefix.length >= 1);
});

test('acceptance disabled by default for shell-command', () => {
  const profile = acceptance.resolveAcceptance({ templateId: 'shell-command', inputs: {} });
  assert.strictEqual(profile.enabled, false);
  assert.strictEqual(profile.verifier, false);
});

test('acceptance can be enabled explicitly for shell-command', () => {
  const profile = acceptance.resolveAcceptance({
    templateId: 'shell-command',
    acceptance: { enabled: true, requiredArtifacts: ['out.txt'] },
  });
  assert.strictEqual(profile.enabled, true);
  assert.deepStrictEqual(profile.requiredArtifacts, ['out.txt']);
  assert.strictEqual(profile.verifier, false);
});
