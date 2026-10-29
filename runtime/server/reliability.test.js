'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishpilot-reliability-'));
process.env.OMNISHPILOT_HOME = home;
const cfgPath = path.join(home, 'omnishpilot.config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ dataDir: './data', omnish: { enabled: false }, workspaces: [] }));

const recovery = require('./recovery');
const budget = require('./budget');
const wake = require('./wake');
const store = require('./store');
const ledger = require('./ledger');
const omnish = require('./omnish');
const webhooks = require('./webhooks');
const worker = require('./worker');

const alerts = [];
omnish.notify = async (title, body) => { alerts.push({ title, body }); };
omnish.taskFailed = async () => {};

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    process.exitCode = 1;
  }
}

const MIN = 60_000;

(async () => {
  await test('backoff doubles from 15 minutes and stops at 4 hours', () => {
    const now = 0;
    const first = recovery.backoffUntil(1, 'job', now);
    assert.ok(first >= 12 * MIN && first <= 18 * MIN, String(first / MIN));
    assert.ok(Math.abs(recovery.backoffUntil(2, 'job', now) - 2 * first) < 1);
    assert.ok(recovery.backoffUntil(20, 'job', now) <= 4 * 60 * MIN * 1.2);
    assert.strictEqual(recovery.backoffUntil(0, 'job', now), now);
  });

  await test('an interval job that keeps failing backs off past its next interval', async () => {
    const task = store.createTask({
      workspaceId: 'w', templateId: 'agent-task', title: 'Every 5', connector: 'generic-agent', maxAttempts: 1,
      schedule: { type: 'interval', intervalMinutes: 5, runAt: new Date().toISOString() },
    });
    for (let i = 0; i < 3; i += 1) {
      store.updateTask(task.id, { status: 'running', execution: { attempts: 1 } });
      await worker.failTask(task.id, store.getTask(task.id), 'Process exited with code 1', { notifyOnFail: false }, { cause: 'exit', exitCode: 1 });
    }
    const after = store.getTask(task.id);
    assert.strictEqual(after.execution.failuresInRow, 3);
    assert.ok(new Date(after.schedule.runAt) - Date.now() > 45 * MIN, 'third failure waits about an hour');
  });

  await test('usage is read from Claude JSON and Codex totals', () => {
    assert.deepStrictEqual(
      budget.usageFromLog('{"type":"result","total_cost_usd":0.42}\ntokens used\n12,345\n'),
      { costUsd: 0.42, tokens: 12345 },
    );
    assert.deepStrictEqual(budget.usageFromLog('plain text output'), { costUsd: null, tokens: null });
  });

  await test('no budget configured means no caps', () => {
    assert.strictEqual(budget.budgetState({}, []), null);
  });

  await test('minutes count today, dollars count this month, running jobs count too', () => {
    const now = new Date(2026, 9, 29, 15, 0);
    const events = [
      { type: 'agent_usage', ts: new Date(2026, 9, 29, 9, 0).toISOString(), minutes: 50, costUsd: 1 },
      { type: 'agent_usage', ts: new Date(2026, 9, 28, 9, 0).toISOString(), minutes: 500, costUsd: 2 },
      { type: 'agent_usage', ts: new Date(2026, 8, 30, 9, 0).toISOString(), minutes: 5, costUsd: 99 },
    ];
    const running = [{ execution: { startedAt: new Date(2026, 9, 29, 14, 30).toISOString() } }];
    const state = budget.budgetState({ budget: { dailyAgentMinutes: 100, monthlyUsd: 10 } }, events, running, now);
    assert.strictEqual(state.minutes.used, 80);
    assert.strictEqual(state.minutes.warn, true);
    assert.strictEqual(state.minutes.exceeded, false);
    assert.strictEqual(state.usd.used, 3);
    assert.strictEqual(state.exceeded, false);
  });

  await test('budget alerts: one warning and one cap notice per day', () => {
    const at = (used) => ({ day: '2026-10-29', month: '2026-10', minutes: { used, limit: 100, percent: used, warn: used >= 80, exceeded: used >= 100 } });
    let r = budget.takeBudgetAlert({}, at(85));
    assert.match(r.alert.title, /85%/);
    r = budget.takeBudgetAlert(r.marks, at(90));
    assert.strictEqual(r.alert, null);
    r = budget.takeBudgetAlert(r.marks, at(100));
    assert.strictEqual(r.alert.title, 'Agent budget reached');
    assert.strictEqual(budget.takeBudgetAlert(r.marks, at(120)).alert, null);
    assert.ok(budget.takeBudgetAlert(r.marks, { ...at(85), day: '2026-10-30' }).alert, 'a new day warns again');
  });

  await test('worker: agent jobs wait at the cap, terminal jobs still run', async () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      dataDir: './data', omnish: { enabled: false }, workspaces: [], budget: { dailyAgentMinutes: 30 },
    }));
    ledger.record('agent_usage', { taskId: 'x', minutes: 45 });
    for (const t of store.listTasks()) store.deleteTask(t.id);
    const agentJob = store.createTask({
      workspaceId: 'w', templateId: 'agent-task', title: 'Agent', connector: 'generic-agent',
      schedule: { type: 'now', runAt: new Date(Date.now() - 1000).toISOString() },
    });
    const shellJob = store.createTask({
      workspaceId: 'w', templateId: 'shell-command', title: 'Backup', connector: 'shell-command', maxAttempts: 1,
      inputs: { command: 'echo backed-up', cwd: home },
      schedule: { type: 'now', runAt: new Date(Date.now() - 1000).toISOString() },
    });
    alerts.length = 0;
    await worker.tick();
    assert.strictEqual(store.getTask(shellJob.id).status, 'completed', JSON.stringify(store.getTask(shellJob.id).execution.error));
    const after = store.getTask(agentJob.id);
    assert.strictEqual(after.status, 'scheduled');
    assert.match(after.execution.held, /agent budget of 30 minutes/);
    assert.deepStrictEqual(alerts.filter((a) => /budget/i.test(a.title)).map((a) => a.title), ['Agent budget reached']);
    store.deleteTask(agentJob.id);
    store.deleteTask(shellJob.id);
  });

  await test('weekly outcomes count successes and failures of the last 7 days', () => {
    ledger.record('job_completed', { taskId: 'weekly' });
    ledger.record('job_completed', { taskId: 'weekly' });
    ledger.record('job_failed', { taskId: 'weekly' });
    assert.deepStrictEqual(ledger.weekOutcomes().get('weekly'), { ok: 2, total: 3 });
  });

  await test('webhooks: a redelivered event returns the job it already started', () => {
    const cfg = { webhooks: {}, workspaces: [] };
    const summary = { title: 'Issue opened', goal: 'Triage', ref: 'github:issue:a/b:1:opened' };
    const first = webhooks.createWebhookJob({ source: 'webhook:github', summary, body: {}, cfg, deliveryId: 'd-1' });
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    store.updateTask(first.task.id, {});
    const tasks = store.listTasks().map((t) => (t.id === first.task.id ? { ...t, createdAt: old } : t));
    store.writeJson(store.FILES.tasks, tasks);
    const again = webhooks.createWebhookJob({ source: 'webhook:github', summary, body: {}, cfg, deliveryId: 'd-1' });
    assert.strictEqual(again.deduped, true);
    assert.strictEqual(again.task.id, first.task.id);
    const other = webhooks.createWebhookJob({ source: 'webhook:github', summary, body: {}, cfg, deliveryId: 'd-2' });
    assert.strictEqual(other.deduped, false);
  });

  await test('webhooks read the senders\' delivery headers', () => {
    const req = (headers) => ({ get: (h) => headers[h.toLowerCase()] });
    assert.strictEqual(webhooks.deliveryIdOf(req({ 'x-github-delivery': 'abc' })), 'abc');
    assert.strictEqual(webhooks.deliveryIdOf(req({ 'linear-delivery': 'lin' })), 'lin');
    assert.strictEqual(webhooks.deliveryIdOf(req({})), null);
  });

  await test('wake: hold while running or due soon, not for later or muted jobs', () => {
    const now = Date.now();
    const at = (ms) => new Date(now + ms).toISOString();
    assert.deepStrictEqual(wake.wakeHoldOf([{ status: 'running' }], now), { hold: true, reason: 'running' });
    assert.strictEqual(wake.wakeHoldOf([{ status: 'scheduled', schedule: { runAt: at(10 * MIN) } }], now).hold, true);
    assert.strictEqual(wake.wakeHoldOf([{ status: 'scheduled', schedule: { runAt: at(60 * MIN) } }], now).hold, false);
    assert.strictEqual(wake.wakeHoldOf([{ status: 'scheduled', muted: true, schedule: { runAt: at(MIN) } }], now).hold, false);
  });

  await test('wake: every inhibitor exits with the daemon', () => {
    assert.ok(wake.inhibitorCommand('linux', 42).args.includes('--pid=42'));
    assert.deepStrictEqual(wake.inhibitorCommand('darwin', 42).args, ['-i', '-w', '42']);
    assert.match(wake.inhibitorCommand('win32', 42).args.join(' '), /Get-Process -Id 42/);
    assert.strictEqual(wake.inhibitorCommand('aix', 42), null);
  });

  await test('wake: holds once, releases, and gives up on a refused lock', () => {
    const spawned = [];
    const fake = () => {
      const p = new EventEmitter();
      p.kill = () => p.emit('exit', null);
      spawned.push(p);
      return p;
    };
    const logs = [];
    const lock = wake.createWakeLock({ platform: 'linux', run: fake, log: (m) => logs.push(m) });
    lock.hold();
    lock.hold();
    assert.strictEqual(spawned.length, 1);
    lock.release();
    assert.strictEqual(lock.isHeld(), false);
    lock.hold();
    spawned[1].emit('exit', 1);
    lock.hold();
    assert.strictEqual(spawned.length, 2, 'a lock the OS refused is not asked for again');
    assert.match(logs[0], /can't keep this computer awake/);
  });

  await test('a failure quotes the last line the job wrote, and the next run in words', async () => {
    const task = store.createTask({
      workspaceId: 'w', templateId: 'agent-task', title: 'Nightly', connector: 'generic-agent', maxAttempts: 1,
      schedule: { type: 'daily', hour: 3, minute: 0, runAt: new Date().toISOString() },
    });
    fs.writeFileSync(store.taskLogPath(task.id), '=== start ===\ncwd: /x\nnpm ERR! missing script: build\n\n');
    store.updateTask(task.id, { status: 'running', execution: { attempts: 1 } });
    const sent = [];
    omnish.taskFailed = async (_t, message) => { sent.push(message); };
    await worker.failTask(task.id, store.getTask(task.id), 'Process exited with code 1', { notifyOnFail: true }, { cause: 'exit', exitCode: 1 });
    omnish.taskFailed = async () => {};
    assert.match(store.getTask(task.id).execution.error, /Last output: "npm ERR! missing script: build"/);
    assert.match(sent[0], /Next run (today|tomorrow) 03:00$/);
    store.deleteTask(task.id);
  });

  await test('last words skip our own header lines and cut long ones', () => {
    assert.strictEqual(recovery.lastWords('=== x ===\nworkspace: /a\nsandbox: none (host command)\n'), '');
    assert.strictEqual(recovery.lastWords('boom\ncommand: x\n'), 'boom');
    assert.strictEqual(recovery.lastWords('y'.repeat(300)).length, 160);
  });

  await test('next run reads as today, tomorrow or a date', () => {
    const now = new Date(2026, 9, 29, 10, 0);
    assert.strictEqual(recovery.whenText(new Date(2026, 9, 29, 14, 30).toISOString(), now), 'today 14:30');
    assert.strictEqual(recovery.whenText(new Date(2026, 9, 30, 9, 0).toISOString(), now), 'tomorrow 09:00');
    assert.strictEqual(recovery.whenText(new Date(2026, 9, 31, 9, 0).toISOString(), now), 'Sat 31 Oct 09:00');
  });

  await test('resuming a failed daily job runs it now and keeps it daily', async () => {
    const task = store.createTask({
      workspaceId: 'w', templateId: 'agent-task', title: 'Daily', connector: 'generic-agent',
      schedule: { type: 'daily', hour: 16, minute: 30, runAt: new Date(Date.now() - 90 * 86_400_000).toISOString() },
    });
    store.updateTask(task.id, { status: 'failed', execution: { error: 'Process exited with code 1' } });
    const after = await worker.resumeTask(task.id);
    assert.strictEqual(after.status, 'scheduled');
    assert.strictEqual(after.schedule.type, 'daily');
    assert.ok(Date.now() - new Date(after.schedule.runAt) < 5000);
    store.deleteTask(task.id);
  });

  console.log('reliability tests done');
  fs.rmSync(home, { recursive: true, force: true });
})();
