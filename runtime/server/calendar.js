const scheduler = require('./scheduler');
const { loadConfig } = require('./config');

const MAX_OCCURRENCES_PER_TASK = 120;
const MAX_DAY_EVENTS = 400;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function localDateKey(iso, tz) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function localTimeParts(iso, tz) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = Number(parts.hour === '24' ? 0 : parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second || 0);
  const secondsOfDay = hour * 3600 + minute * 60 + second;
  return {
    hour,
    minute,
    second,
    secondsOfDay,
    label: formatClock(hour, minute, second),
    minutesOfDay: hour * 60 + minute,
  };
}

function formatClock(hour, minute, second = 0) {
  const h = Number(hour);
  const m = Number(minute) || 0;
  const s = Number(second) || 0;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  if (s > 0) return `${h12}:${pad(m)}:${pad(s)} ${ampm}`;
  return `${h12}:${pad(m)} ${ampm}`;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function firstWeekday(year, month) {
  return new Date(year, month - 1, 1).getDay();
}

function campaignDayDate(ws, campaignDay, hour = 7, minute = 0) {
  const start = ws?.meta?.campaignStart;
  if (!start || !campaignDay) return null;
  const tz = ws.meta?.timezone || scheduler.defaultTimezone();
  const base = new Date(`${start}T12:00:00`);
  base.setDate(base.getDate() + Number(campaignDay) - 1);
  const y = base.getFullYear();
  const m = base.getMonth() + 1;
  const d = base.getDate();
  return scheduler.zonedTimeToUtc(y, m, d, hour, minute, tz).toISOString();
}

function expandScheduledOccurrences(task, rangeStart, rangeEnd, tz, workspaces) {
  const schedule = task.schedule || {};
  const type = scheduler.normalizeType(schedule.type);
  const out = [];

  if (type === 'manual') return out;

  if (type === 'campaign_day') {
    const ws = workspaces.find(w => w.id === task.workspaceId);
    const at = campaignDayDate(ws, schedule.campaignDay, schedule.hour ?? 7, schedule.minute ?? 0);
    if (at) {
      const t = new Date(at);
      if (t >= rangeStart && t <= rangeEnd) out.push(at);
    }
    return out;
  }

  if (type === 'once' || type === 'now') {
    if (schedule.runAt) {
      const t = new Date(schedule.runAt);
      if (t >= rangeStart && t <= rangeEnd) out.push(schedule.runAt);
    }
    return out;
  }

  if (!scheduler.isRecurring(type)) return out;

  let cursor = new Date(rangeStart.getTime() - 1000);
  const anchor = schedule.runAt ? new Date(schedule.runAt) : rangeStart;
  if (anchor > cursor) cursor = new Date(anchor.getTime() - 1000);

  for (let i = 0; i < MAX_OCCURRENCES_PER_TASK; i++) {
    const nextIso = scheduler.computeNextRun(schedule, cursor);
    if (!nextIso) break;
    const next = new Date(nextIso);
    if (next > rangeEnd) break;
    if (next >= rangeStart) out.push(nextIso);
    cursor = new Date(next.getTime() + 1000);
  }
  return out;
}

function eventFromTask(task, at, kind, extra = {}) {
  const tz = task.schedule?.timezone || scheduler.defaultTimezone();
  const time = localTimeParts(at, tz);
  const type = scheduler.normalizeType(task.schedule?.type);
  const draggable = kind === 'scheduled'
    && ['scheduled', 'draft'].includes(task.status)
    && type !== 'now'
    && task.status !== 'running';
  return {
    id: `${task.id}:${kind}:${at}`,
    taskId: task.id,
    title: task.title,
    summary: task.summary || '',
    status: task.status,
    templateId: task.templateId,
    runMode: task.runMode,
    muted: task.muted === true,
    kind,
    at,
    date: localDateKey(at, tz),
    draggable,
    ...time,
    scheduleType: type,
    scheduleLabel: scheduler.formatScheduleLabel(task.schedule),
    recurring: scheduler.isRecurring(type),
    workspaceId: task.workspaceId,
    ...extra,
  };
}

function actualRunEvents(task, rangeStart, rangeEnd) {
  const out = [];
  const ex = task.execution || {};
  const tz = task.schedule?.timezone || scheduler.defaultTimezone();

  const pushIfInRange = (iso, kind, status, extra) => {
    if (!iso) return;
    const t = new Date(iso);
    if (t < rangeStart || t > rangeEnd) return;
    out.push(eventFromTask(
      { ...task, status },
      iso,
      kind,
      extra,
    ));
  };

  pushIfInRange(ex.startedAt, 'run-start', 'running', { endsAt: ex.finishedAt || null });
  pushIfInRange(task.completedAt || ex.finishedAt, 'run-end', task.status, { startedAt: ex.startedAt || null });
  if (task.status === 'running' && ex.startedAt) {
    const start = new Date(ex.startedAt);
    if (start >= rangeStart && start <= rangeEnd) {
      out.push(eventFromTask(task, ex.startedAt, 'running', {
        endsAt: null,
        live: true,
      }));
    }
  }
  return out;
}

function collectEventsForRange(tasks, rangeStart, rangeEnd, workspaces) {
  const events = [];
  const tz = scheduler.defaultTimezone();

  for (const task of tasks) {
    if (task.status === 'draft' && scheduler.normalizeType(task.schedule?.type) === 'manual') {
      continue;
    }

    if (['scheduled', 'draft'].includes(task.status)) {
      for (const at of expandScheduledOccurrences(task, rangeStart, rangeEnd, tz, workspaces)) {
        events.push(eventFromTask(task, at, 'scheduled', { projected: true }));
      }
    }

    if (task.status === 'scheduled' && task.schedule?.runAt) {
      const type = scheduler.normalizeType(task.schedule.type);
      if (!scheduler.isRecurring(type) && type !== 'campaign_day') {
        const t = new Date(task.schedule.runAt);
        if (t >= rangeStart && t <= rangeEnd) {
          const exists = events.some(e => e.taskId === task.id && e.at === task.schedule.runAt);
          if (!exists) {
            events.push(eventFromTask(task, task.schedule.runAt, 'scheduled', { projected: false }));
          }
        }
      }
    }

    events.push(...actualRunEvents(task, rangeStart, rangeEnd));
  }

  events.sort((a, b) => {
    const d = a.minutesOfDay - b.minutesOfDay;
    if (d !== 0) return d;
    return a.title.localeCompare(b.title);
  });

  return events.slice(0, MAX_DAY_EVENTS);
}

function summarizeMonth(events, year, month, tz) {
  const dim = daysInMonth(year, month);
  const todayKey = localDateKey(new Date().toISOString(), tz);

  function countsForDate(key) {
    const dayEvents = events.filter(e => e.date === key);
    const counts = { scheduled: 0, running: 0, completed: 0, failed: 0, other: 0 };
    for (const e of dayEvents) {
      if (e.kind === 'scheduled') counts.scheduled += 1;
      else if (e.status === 'running' || e.kind === 'running') counts.running += 1;
      else if (e.status === 'completed') counts.completed += 1;
      else if (e.status === 'failed') counts.failed += 1;
      else counts.other += 1;
    }
    return { counts, total: dayEvents.length, hasEvents: dayEvents.length > 0 };
  }

  const days = [];
  for (let day = 1; day <= dim; day++) {
    const key = dateKey(year, month, day);
    const summary = countsForDate(key);
    days.push({
      date: key,
      day,
      inMonth: true,
      isToday: key === todayKey,
      ...summary,
    });
  }

  const leading = firstWeekday(year, month);
  const cells = [];
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevDim = daysInMonth(prevYear, prevMonth);
  for (let i = leading - 1; i >= 0; i--) {
    const d = prevDim - i;
    const key = dateKey(prevYear, prevMonth, d);
    cells.push({ date: key, day: d, inMonth: false, isToday: key === todayKey, ...countsForDate(key) });
  }
  cells.push(...days);
  const trailing = (7 - (cells.length % 7)) % 7;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let d = 1; d <= trailing; d++) {
    const key = dateKey(nextYear, nextMonth, d);
    cells.push({ date: key, day: d, inMonth: false, isToday: key === todayKey, ...countsForDate(key) });
  }

  return { days, cells, today: todayKey };
}

function buildCalendar({ year, month, day }, tasks, cfg = loadConfig()) {
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || new Date().getMonth() + 1;
  const tz = scheduler.defaultTimezone();
  const workspaces = cfg.workspaces || [];

  const monthStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  const monthEvents = collectEventsForRange(tasks, monthStart, monthEnd, workspaces);
  const monthSummary = summarizeMonth(monthEvents, y, m, tz);

  const selectedDay = day != null ? Number(day) : null;
  let dayDetail = null;
  if (selectedDay >= 1 && selectedDay <= daysInMonth(y, m)) {
    const key = dateKey(y, m, selectedDay);
    const dayEvents = monthEvents.filter(e => e.date === key);

    for (const task of tasks) {
      if (task.status !== 'draft') continue;
      if (scheduler.normalizeType(task.schedule?.type) !== 'manual') continue;
      const at = scheduler.zonedTimeToUtc(y, m, selectedDay, 9, 0, tz).toISOString();
      dayEvents.push(eventFromTask(task, at, 'scheduled', {
        projected: true,
        unqueued: true,
        draggable: true,
      }));
    }

    dayEvents.sort((a, b) => {
      const d = (a.secondsOfDay ?? 0) - (b.secondsOfDay ?? 0);
      if (d !== 0) return d;
      return a.title.localeCompare(b.title);
    });
    const slots = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: formatClock(hour, 0).replace(':00', ''),
      events: dayEvents.filter(e => e.hour === hour),
    }));
    const unslotted = dayEvents.filter(e => !Number.isFinite(e.hour));
    dayDetail = {
      date: key,
      day: selectedDay,
      isToday: key === monthSummary.today,
      events: dayEvents,
      slots,
      unslotted,
      total: dayEvents.length,
    };
  }

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  return {
    year: y,
    month: m,
    monthName: monthNames[m - 1],
    timezone: tz,
    weekdayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    today: monthSummary.today,
    grid: monthSummary.cells,
    days: monthSummary.days,
    selectedDay: dayDetail,
    stats: {
      tasks: tasks.length,
      monthEvents: monthEvents.length,
      scheduled: monthEvents.filter(e => e.kind === 'scheduled').length,
      runs: monthEvents.filter(e => e.kind !== 'scheduled').length,
    },
  };
}

function buildReschedulePatch(task, dateStr, hour, minute, second = 0) {
  const tz = task.schedule?.timezone || scheduler.defaultTimezone();
  const [y, m, d] = dateStr.split('-').map(Number);
  const sec = Number(second) || 0;
  const base = scheduler.zonedTimeToUtc(y, m, d, hour, minute, tz);
  const runAt = new Date(base.getTime() + sec * 1000).toISOString();
  const type = scheduler.normalizeType(task.schedule?.type);
  const timeFields = { hour, minute, timezone: tz };

  if (type === 'manual' || type === 'now' || type === 'once') {
    return {
      schedule: { type: 'once', runAt, timezone: tz, recurring: false },
      status: 'scheduled',
    };
  }
  if (type === 'daily') {
    const schedule = { ...task.schedule, ...timeFields, type: 'daily', recurring: true };
    schedule.runAt = scheduler.computeNextRun(schedule, new Date());
    return { schedule, status: 'scheduled' };
  }
  if (type === 'hourly') {
    const schedule = { ...task.schedule, type: 'hourly', minute, timezone: tz, recurring: true };
    schedule.runAt = scheduler.computeNextRun(schedule, new Date());
    return { schedule, status: 'scheduled' };
  }
  if (type === 'weekly') {
    const dayOfWeek = new Date(`${dateStr}T12:00:00`).getDay();
    const schedule = {
      ...task.schedule,
      ...timeFields,
      type: 'weekly',
      dayOfWeek,
      recurring: true,
    };
    schedule.runAt = scheduler.computeNextRun(schedule, new Date());
    return { schedule, status: 'scheduled' };
  }
  if (type === 'monthly') {
    const schedule = {
      ...task.schedule,
      ...timeFields,
      type: 'monthly',
      dayOfMonth: d,
      recurring: true,
    };
    schedule.runAt = scheduler.computeNextRun(schedule, new Date());
    return { schedule, status: 'scheduled' };
  }
  if (type === 'interval') {
    return {
      schedule: { ...task.schedule, type: 'interval', runAt, timezone: tz },
      status: 'scheduled',
    };
  }
  if (type === 'campaign_day') {
    return {
      schedule: { ...task.schedule, type: 'campaign_day', ...timeFields },
      status: task.status === 'draft' ? 'scheduled' : task.status,
    };
  }
  return {
    schedule: { type: 'once', runAt, timezone: tz, recurring: false },
    status: 'scheduled',
  };
}

module.exports = {
  buildCalendar,
  buildReschedulePatch,
  collectEventsForRange,
  localDateKey,
  localTimeParts,
  formatClock,
};
