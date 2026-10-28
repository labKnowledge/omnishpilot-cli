const assert = require('assert');
const scheduler = require('./scheduler');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    process.exitCode = 1;
  }
}

test('normalizeType maps datetime to once', () => {
  assert.strictEqual(scheduler.normalizeType('datetime'), 'once');
});

test('isRecurring for interval', () => {
  assert.strictEqual(scheduler.isRecurring('interval'), true);
  assert.strictEqual(scheduler.isRecurring('once'), false);
});

test('validateSchedule rejects short interval', () => {
  const r = scheduler.validateSchedule({ type: 'interval', intervalMinutes: 2 });
  assert.strictEqual(r.ok, false);
});

test('prepareSchedule interval sets runAt ahead', () => {
  const before = Date.now();
  const s = scheduler.prepareSchedule({ type: 'interval', intervalMinutes: 15 });
  const runAt = new Date(s.runAt).getTime();
  assert.ok(runAt >= before + 14 * 60 * 1000);
  assert.strictEqual(s.recurring, true);
});

test('prepareSchedule daily computes future runAt', () => {
  const s = scheduler.prepareSchedule({ type: 'daily', hour: 9, minute: 10, timezone: 'America/Denver' });
  assert.ok(s.runAt);
  assert.strictEqual(s.recurring, true);
  assert.match(scheduler.formatScheduleLabel(s), /Daily at 9:10 AM/);
});

test('prepareSchedule weekly Monday', () => {
  const s = scheduler.prepareSchedule({
    type: 'weekly',
    dayOfWeek: 1,
    hour: 8,
    minute: 0,
    timezone: 'America/Denver',
  });
  assert.ok(new Date(s.runAt) > new Date());
  assert.match(scheduler.formatScheduleLabel(s), /Every Monday/);
});

test('computeNextRun interval from after', () => {
  const after = new Date('2026-07-10T12:00:00Z');
  const next = scheduler.computeNextRun({ type: 'interval', intervalMinutes: 15 }, after);
  assert.strictEqual(next, '2026-07-10T12:15:00.000Z');
});

test('isDue respects runAt', () => {
  assert.strictEqual(scheduler.isDue({ type: 'once', runAt: '2020-01-01T00:00:00Z' }), true);
  assert.strictEqual(scheduler.isDue({ type: 'manual' }), false);
});

test('legacy datetime alias in isDue', () => {
  assert.strictEqual(scheduler.isDue({ type: 'datetime', runAt: '2020-01-01T00:00:00Z' }), true);
});

if (process.exitCode) process.exit(process.exitCode);
console.log('scheduler tests done');
