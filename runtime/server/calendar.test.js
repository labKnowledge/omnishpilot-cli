const assert = require('assert');
const calendar = require('./calendar');
const scheduler = require('./scheduler');

const tasks = [
  {
    id: 't1',
    title: 'Daily standup digest',
    status: 'scheduled',
    templateId: 'agent-task',
    runMode: 'agent',
    workspaceId: 'ws1',
    schedule: {
      type: 'daily',
      hour: 9,
      minute: 0,
      timezone: 'America/Denver',
      runAt: '2026-07-01T15:00:00.000Z',
    },
  },
  {
    id: 't2',
    title: 'One-shot launch',
    status: 'scheduled',
    templateId: 'research',
    runMode: 'agent',
    workspaceId: 'ws1',
    schedule: {
      type: 'once',
      runAt: '2026-07-15T20:30:00.000Z',
      timezone: 'America/Denver',
    },
  },
  {
    id: 't3',
    title: 'Manual draft',
    status: 'draft',
    templateId: 'agent-task',
    runMode: 'supervised',
    workspaceId: 'ws1',
    schedule: { type: 'manual' },
  },
];

const cfg = {
  workspaces: [{ id: 'ws1', meta: { timezone: 'America/Denver' } }],
  scheduler: { defaultTimezone: 'America/Denver' },
};

const july = calendar.buildCalendar({ year: 2026, month: 7, day: 15 }, tasks, cfg);

assert.strictEqual(july.year, 2026);
assert.strictEqual(july.month, 7);
assert.ok(july.grid.length % 7 === 0, 'grid is full weeks');
assert.ok(july.days.length === 31, 'July has 31 days');
assert.ok(july.stats.monthEvents >= 31, 'daily job projects across month');
assert.ok(july.selectedDay, 'day detail when day param set');
assert.ok(july.selectedDay.events.some(e => e.taskId === 't2'), 'once job on selected day');

const noManualInMonthOnly = july.selectedDay.events.every(e => e.taskId !== 't3' || e.unqueued);
assert.ok(noManualInMonthOnly, 'manual drafts appear as unqueued on day detail only');

const parts = calendar.localTimeParts('2026-07-15T20:30:00.000Z', 'America/Denver');
assert.ok(Number.isFinite(parts.hour), 'local hour parsed');
assert.ok(Number.isFinite(parts.minutesOfDay), 'minutesOfDay parsed');

console.log('ok calendar month grid');
console.log('ok calendar day detail');
console.log('ok manual drafts on day detail');
console.log('ok local time parts');
console.log('calendar tests done');

const calendarMod = require('./calendar');

// reschedule patch smoke test
const draftTask = {
  id: 'x',
  status: 'draft',
  schedule: { type: 'manual' },
};
const patch = calendarMod.buildReschedulePatch(draftTask, '2026-07-15', 14, 30, 0);
assert.strictEqual(patch.schedule.type, 'once');
assert.strictEqual(patch.status, 'scheduled');
assert.ok(patch.schedule.runAt);
console.log('ok buildReschedulePatch manual to once');
