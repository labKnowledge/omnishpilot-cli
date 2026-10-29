'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishpilot-recovery-'));
process.env.OMNISHPILOT_HOME = home;
fs.writeFileSync(path.join(home, 'omnishpilot.config.json'), JSON.stringify({
  dataDir: './data',
  omnish: { enabled: false },
  workspaces: [],
}));

const recovery = require('./recovery');
const atomic = require('./atomic');
const store = require('./store');
const omnish = require('./omnish');
const worker = require('./worker');

const sent = [];
omnish.taskFailed = async (task, message) => { sent.push(message); };

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    process.exitCode = 1;
  }
}

function agentTask(spec = {}) {
  return store.createTask({
    workspaceId: 'w',
    templateId: 'agent-task',
    title: 'Nightly triage',
    connector: 'generic-agent',
    maxAttempts: 3,
    ...spec,
  });
}

function started(task, patch = {}) {
  return store.updateTask(task.id, {
    status: 'running',
    execution: { attempts: 1, resolvedAgentId: 'claude', connector: 'generic-agent', ...patch },
  });
}

const settings = { notifyOnFail: true };

(async () => {
  await test('a crash is retried', () => {
    assert.deepStrictEqual(recovery.classifyFailure({ cause: 'exit', exitCode: 1, taskId: 't' }), { kind: 'retry' });
  });

  await test('an approval prompt is the owner\'s to fix, not retried', () => {
    const v = recovery.classifyFailure({ cause: 'hang', taskId: 't' });
    assert.strictEqual(v.kind, 'owner');
    assert.strictEqual(v.noticeKey, 't:prompt');
  });

  await test('a timeout is final', () => {
    assert.strictEqual(recovery.classifyFailure({ cause: 'timeout', taskId: 't' }).kind, 'final');
  });

  await test('a signed-out agent is named, once per agent', () => {
    const v = recovery.classifyFailure({
      cause: 'exit', connector: 'generic-agent', agentId: 'claude', taskId: 't',
      logTail: 'thinking...\nError: Not logged in. Please run claude login',
    });
    assert.strictEqual(v.cause, 'signed_out');
    assert.strictEqual(v.noticeKey, 'claude:signed_out');
    assert.match(v.detail, /Agent "claude" is signed out/);
  });

  await test('sign-in words early in a long agent log are not a sign-out', () => {
    const tail = ['the route returns 401 when not logged in', ...Array(20).fill('working')].join('\n');
    assert.strictEqual(recovery.classifyFailure({ cause: 'exit', connector: 'generic-agent', logTail: tail, taskId: 't' }).kind, 'retry');
  });

  await test('shell exit 127 is a setup problem', () => {
    assert.strictEqual(recovery.classifyFailure({ cause: 'exit', connector: 'shell-command', exitCode: 127, taskId: 't' }).cause, 'setup');
  });

  await test('signatures ignore numbers', () => {
    assert.strictEqual(
      recovery.failureSignature('idle', 'No log progress for 13m'),
      recovery.failureSignature('idle', 'No log progress for 47m'),
    );
  });

  await test('notices are told once, and a success clears them', () => {
    let { first, notices } = recovery.takeNotice([], 'claude:signed_out');
    assert.ok(first);
    assert.strictEqual(recovery.takeNotice(notices, 'claude:signed_out').first, false);
    notices = recovery.clearNotices(notices, { taskId: 'x', agentId: 'claude' });
    assert.deepStrictEqual(notices, []);
  });

  await test('the retry note only appears on a retry', () => {
    assert.strictEqual(recovery.retryNote(null), '');
    assert.match(recovery.retryNote({ cause: 'exit', error: 'Process exited with code 1' }), /nothing is done twice/);
  });

  await test('a damaged JSON file is set aside and the last good copy restored', () => {
    const file = path.join(home, 'jobs.json');
    atomic.writeJsonAtomic(file, [{ id: 1 }], { backup: true });
    atomic.writeJsonAtomic(file, [{ id: 1 }, { id: 2 }], { backup: true });
    fs.writeFileSync(file, '[{"id": 1}, {"id"');
    assert.deepStrictEqual(atomic.readJsonSafe(file, []), [{ id: 1 }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 1 }]);
    assert.ok(fs.readdirSync(home).some((f) => f.startsWith('jobs.json.corrupt-')));
  });

  await test('worker: a crash is re-queued with the retry context', async () => {
    const task = started(agentTask());
    await worker.failTask(task.id, store.getTask(task.id), 'Process exited with code 1', settings, { cause: 'exit', exitCode: 1 });
    const after = store.getTask(task.id);
    assert.strictEqual(after.status, 'scheduled');
    assert.deepStrictEqual(after.execution.retryOf, { cause: 'exit', error: 'Process exited with code 1' });
  });

  await test('worker: a hang fails at once without spending retries', async () => {
    sent.length = 0;
    const task = started(agentTask());
    await worker.failTask(task.id, store.getTask(task.id), 'Agent appears blocked on approval/TTY', settings, { cause: 'hang' });
    const after = store.getTask(task.id);
    assert.strictEqual(after.status, 'failed');
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /would stop at the same prompt/);
  });

  await test('worker: a recurring job keeps its schedule after it fails, and a repeat failure stays quiet', async () => {
    sent.length = 0;
    const task = started(agentTask({ maxAttempts: 1, schedule: { type: 'daily', hour: 3, minute: 0, runAt: new Date().toISOString() } }));
    await worker.failTask(task.id, store.getTask(task.id), 'Process exited with code 2', settings, { cause: 'exit', exitCode: 2 });
    let after = store.getTask(task.id);
    assert.strictEqual(after.status, 'scheduled');
    assert.ok(new Date(after.schedule.runAt) > new Date());
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /Next run/);

    started(after);
    await worker.failTask(task.id, store.getTask(task.id), 'Process exited with code 2', settings, { cause: 'exit', exitCode: 2 });
    after = store.getTask(task.id);
    assert.strictEqual(after.status, 'scheduled');
    assert.strictEqual(sent.length, 1, 'same failure twice should notify once');
  });

  await test('supervisor: a running task with no live process is recovered', async () => {
    const supervisor = require('./supervisor');
    const task = started(agentTask(), { pid: null });
    await supervisor.checkRunningTasks();
    const after = store.getTask(task.id);
    assert.strictEqual(after.status, 'scheduled');
    assert.strictEqual(after.execution.retryOf.cause, 'restart');
  });

  console.log('recovery tests done');
  fs.rmSync(home, { recursive: true, force: true });
})();
