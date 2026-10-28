'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acceptance = require('./acceptance');
const hang = require('./hang');
const agents = require('./agents');

function testInfer() {
  assert.strictEqual(acceptance.inferTestCommand('Done when npm test passes'), 'npm test');
  assert.ok(acceptance.inferArtifacts('write result.md and notes.txt').includes('result.md'));
}

function testCheckAcceptance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-acc-'));
  fs.writeFileSync(path.join(dir, 'result.md'), 'ok');
  const task = {
    templateId: 'agent-task',
    acceptance: { requiredArtifacts: ['result.md'] },
    instructions: {},
  };
  const ok = acceptance.checkAcceptance({
    task,
    outDir: dir,
    workspacePath: dir,
    cfg: { acceptance: { enabled: true } },
  });
  assert.strictEqual(ok.ok, true, acceptance.formatAcceptanceReport(ok));

  const bad = acceptance.checkAcceptance({
    task: { ...task, acceptance: { requiredArtifacts: ['missing.bin'] } },
    outDir: dir,
    workspacePath: dir,
    cfg: { acceptance: { enabled: true } },
  });
  assert.strictEqual(bad.ok, false);
}

function testHang() {
  const sig = hang.detectHangSignals('Waiting for your approval to run bash');
  assert.strictEqual(sig.hung, true);
  const health = hang.evaluateRunHealth(
    {
      execution: {
        startedAt: new Date(Date.now() - 20 * 60000).toISOString(),
        lastLogAt: new Date(Date.now() - 15 * 60000).toISOString(),
      },
    },
    {
      cfg: { worker: { hangIdleMinutes: 12, hangHardMinutes: 45, jobTimeoutMinutes: 240 } },
      logTail: 'Waiting for your approval',
    },
  );
  assert.strictEqual(health.action, 'hang');
}

function testLimitParse() {
  const a = agents.parseLimitReset('Rate limit hit. Try again in 2 hours.', { agent: { cooldownMinutes: 60 } });
  assert.ok(a.cooldownMinutes >= 120 && a.cooldownMinutes <= 130);
  assert.ok(a.resetAt);
  assert.strictEqual(agents.isLimitHit('Error 429 Too Many Requests'), true);
}

testInfer();
testCheckAcceptance();
testHang();
testLimitParse();
console.log('acceptance/hang/agents tests ok');
