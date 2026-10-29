const { loadConfig } = require('./config');

const RECURRING_TYPES = new Set(['interval', 'hourly', 'daily', 'weekly', 'monthly']);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalizeType(type) {
  if (type === 'datetime') return 'once';
  return type || 'manual';
}

function isRecurring(type) {
  return RECURRING_TYPES.has(normalizeType(type));
}

function defaultTimezone() {
  const cfg = loadConfig();
  return cfg.scheduler?.defaultTimezone
    || cfg.workspaces?.[0]?.meta?.timezone
    || 'America/Denver';
}

function getZonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dayOfWeek: wd[parts.weekday] ?? 0,
  };
}

function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  let t = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const p = getZonedParts(new Date(t), tz);
    const diffMin = (day - p.day) * 1440 + (hour - p.hour) * 60 + (minute - p.minute);
    if (diffMin === 0 && p.year === year && p.month === month) break;
    t += diffMin * 60 * 1000;
    if (p.year !== year || p.month !== month) {
      t = Date.UTC(year, month - 1, day, hour, minute, 0);
      const p2 = getZonedParts(new Date(t), tz);
      const d2 = (day - p2.day) * 1440 + (hour - p2.hour) * 60 + (minute - p2.minute);
      t += d2 * 60 * 1000;
    }
  }
  return new Date(t);
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function clampDayOfMonth(year, month, dayOfMonth) {
  return Math.min(dayOfMonth, daysInMonth(year, month));
}

function validateSchedule(schedule, cfg = loadConfig()) {
  const s = { ...schedule };
  const type = normalizeType(s.type);
  const minInterval = cfg.scheduler?.minIntervalMinutes || 5;

  if (!type || type === 'manual') return { ok: true, schedule: { ...s, type: 'manual' } };
  if (type === 'now') return { ok: true, schedule: { ...s, type: 'now', runAt: new Date().toISOString() } };

  s.timezone = s.timezone || defaultTimezone();

  if (type === 'once') {
    if (!s.runAt) return { ok: false, error: 'runAt required for once schedule' };
    return { ok: true, schedule: { ...s, type: 'once', recurring: false } };
  }

  if (type === 'campaign_day') {
    if (!s.campaignDay) return { ok: false, error: 'campaignDay required' };
    return { ok: true, schedule: { ...s, type: 'campaign_day', recurring: false } };
  }

  if (type === 'interval') {
    const n = Number(s.intervalMinutes ?? 30);
    if (!Number.isFinite(n) || n < minInterval) {
      return { ok: false, error: `intervalMinutes must be >= ${minInterval}` };
    }
    return { ok: true, schedule: { ...s, type: 'interval', intervalMinutes: n, recurring: true } };
  }

  if (type === 'hourly') {
    const minute = Number(s.minute ?? 0);
    if (minute < 0 || minute > 59) return { ok: false, error: 'minute must be 0-59' };
    return { ok: true, schedule: { ...s, type: 'hourly', minute, recurring: true } };
  }

  if (type === 'daily') {
    const hour = Number(s.hour ?? 9);
    const minute = Number(s.minute ?? 0);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return { ok: false, error: 'invalid time' };
    }
    return { ok: true, schedule: { ...s, type: 'daily', hour, minute, recurring: true } };
  }

  if (type === 'weekly') {
    const dayOfWeek = Number(s.dayOfWeek ?? 1);
    const hour = Number(s.hour ?? 9);
    const minute = Number(s.minute ?? 0);
    if (dayOfWeek < 0 || dayOfWeek > 6) return { ok: false, error: 'dayOfWeek must be 0-6' };
    return { ok: true, schedule: { ...s, type: 'weekly', dayOfWeek, hour, minute, recurring: true } };
  }

  if (type === 'monthly') {
    const dayOfMonth = Number(s.dayOfMonth ?? 1);
    const hour = Number(s.hour ?? 9);
    const minute = Number(s.minute ?? 0);
    if (dayOfMonth < 1 || dayOfMonth > 31) return { ok: false, error: 'dayOfMonth must be 1-31' };
    return { ok: true, schedule: { ...s, type: 'monthly', dayOfMonth, hour, minute, recurring: true } };
  }

  return { ok: false, error: `unknown schedule type: ${type}` };
}

function computeNextRun(schedule, after = new Date()) {
  const type = normalizeType(schedule.type);
  const tz = schedule.timezone || defaultTimezone();

  if (type === 'now') return new Date().toISOString();
  if (type === 'once') return schedule.runAt || after.toISOString();
  if (type === 'manual' || type === 'campaign_day') return null;

  if (type === 'interval') {
    const mins = Number(schedule.intervalMinutes) || 30;
    return new Date(after.getTime() + mins * 60 * 1000).toISOString();
  }

  const now = getZonedParts(after, tz);

  if (type === 'hourly') {
    const minute = Number(schedule.minute) || 0;
    let candidate = zonedTimeToUtc(now.year, now.month, now.day, now.hour, minute, tz);
    if (candidate <= after) {
      candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
    }
    return candidate.toISOString();
  }

  if (type === 'daily') {
    const hour = Number(schedule.hour ?? 9);
    const minute = Number(schedule.minute) || 0;
    let candidate = zonedTimeToUtc(now.year, now.month, now.day, hour, minute, tz);
    if (candidate <= after) {
      const tomorrow = new Date(after.getTime() + 25 * 60 * 60 * 1000);
      const tp = getZonedParts(tomorrow, tz);
      candidate = zonedTimeToUtc(tp.year, tp.month, tp.day, hour, minute, tz);
    }
    return candidate.toISOString();
  }

  if (type === 'weekly') {
    const targetDow = Number(schedule.dayOfWeek) ?? 1;
    const hour = Number(schedule.hour ?? 9);
    const minute = Number(schedule.minute) || 0;
    let daysAhead = (targetDow - now.dayOfWeek + 7) % 7;
    let candidate = zonedTimeToUtc(now.year, now.month, now.day, hour, minute, tz);
    if (daysAhead > 0) candidate = new Date(candidate.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const cp = getZonedParts(candidate, tz);
    candidate = zonedTimeToUtc(cp.year, cp.month, cp.day, hour, minute, tz);
    if (candidate <= after) {
      candidate = new Date(candidate.getTime() + 7 * 24 * 60 * 60 * 1000);
      const np = getZonedParts(candidate, tz);
      candidate = zonedTimeToUtc(np.year, np.month, np.day, hour, minute, tz);
    }
    return candidate.toISOString();
  }

  if (type === 'monthly') {
    const dom = Number(schedule.dayOfMonth) || 1;
    const hour = Number(schedule.hour ?? 9);
    const minute = Number(schedule.minute) || 0;
    const day = clampDayOfMonth(now.year, now.month, dom);
    let candidate = zonedTimeToUtc(now.year, now.month, day, hour, minute, tz);
    if (candidate <= after) {
      let m = now.month + 1;
      let y = now.year;
      if (m > 12) { m = 1; y += 1; }
      const d = clampDayOfMonth(y, m, dom);
      candidate = zonedTimeToUtc(y, m, d, hour, minute, tz);
    }
    return candidate.toISOString();
  }

  return after.toISOString();
}

function prepareSchedule(schedule, after = new Date()) {
  const v = validateSchedule(schedule);
  if (!v.ok) throw new Error(v.error);
  const s = { ...v.schedule };
  const type = normalizeType(s.type);

  if (type === 'manual') return s;
  if (type === 'campaign_day') return s;
  if (type === 'now') {
    s.runAt = new Date().toISOString();
    return s;
  }
  if (type === 'once') return s;

  s.runAt = computeNextRun(s, after);
  return s;
}

function isDue(schedule, now = new Date()) {
  const type = normalizeType(schedule?.type);
  if (type === 'manual' || type === 'campaign_day') return false;
  if (type === 'now') return true;
  if (!schedule?.runAt) return false;
  return new Date(schedule.runAt) <= now;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute) || 0;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${pad(m)} ${ampm}`;
}

function formatScheduleLabel(schedule) {
  if (!schedule) return 'Scheduled';
  const type = normalizeType(schedule.type);
  if (type === 'manual') return 'Manual';
  if (type === 'now') return 'Queued';
  if (type === 'once' || type === 'datetime') {
    if (!schedule.runAt) return 'Once';
    return `Once · ${new Date(schedule.runAt).toLocaleString()}`;
  }
  if (type === 'campaign_day') return `Day ${schedule.campaignDay || '?'}`;
  if (type === 'interval') return `Every ${schedule.intervalMinutes || 30} min`;
  if (type === 'hourly') return `Hourly at :${pad(schedule.minute || 0)}`;
  if (type === 'daily') return `Daily at ${formatTime(schedule.hour ?? 9, schedule.minute)}`;
  if (type === 'weekly') {
    const d = DAY_NAMES[schedule.dayOfWeek ?? 1] || 'Monday';
    return `Every ${d} at ${formatTime(schedule.hour ?? 9, schedule.minute)}`;
  }
  if (type === 'monthly') {
    return `Monthly day ${schedule.dayOfMonth || 1} at ${formatTime(schedule.hour ?? 9, schedule.minute)}`;
  }
  if (schedule.runAt) return `Next · ${new Date(schedule.runAt).toLocaleString()}`;
  return type;
}

module.exports = {
  RECURRING_TYPES,
  normalizeType,
  isRecurring,
  validateSchedule,
  computeNextRun,
  prepareSchedule,
  isDue,
  formatScheduleLabel,
  defaultTimezone,
  getZonedParts,
  zonedTimeToUtc,
};
