// Port of internal/parser (due.go, recurrence.go). The Go code is the
// reference: tests/fixtures/next_due.json is checked against both. All the
// calendar arithmetic is done in UTC, so daylight saving never shifts a day.

import { todayISO } from './dates.js';

const SIMPLE_RULES = new Set(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']);
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const DUE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
const DAY_MS = 86400000;

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Like Go's strconv.Atoi: NaN unless s is an optionally signed integer. */
function atoi(s) {
  return /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
}

/** Midnight UTC of a day; month is 0-based. Also right for years 0-99. */
function utcDate(year, month, day) {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return d;
}

/** Splits a due string into its UTC-midnight day and "HH:MM"; null when invalid. */
function parseDay(s) {
  if (typeof s !== 'string' || !DUE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const date = utcDate(y, m - 1, d);
  // Impossible days (February 30) roll over to the next month: reject them.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  let clock = '';
  if (s.length > 10) {
    clock = s.slice(11);
    if (Number(clock.slice(0, 2)) > 23 || Number(clock.slice(3)) > 59) return null;
  }
  return { date, clock };
}

function formatDay(date, clock) {
  const s = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return clock ? `${s} ${clock}` : s;
}

function addDaysUTC(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Adds months without overflowing: January 31 + 1 month is February 28 or 29. */
function addMonthsClamped(date, months) {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = utcDate(year, month + 1, 0).getUTCDate();
  return utcDate(year, month, Math.min(date.getUTCDate(), lastDay));
}

/** True when due is "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" and a real date. */
export function validDue(due) {
  return parseDay(due) !== null;
}

/** Moves a due date by days, keeping its time; null when due is invalid. */
export function shiftDue(due, days) {
  const p = parseDay(due);
  return p ? formatDay(addDaysUTC(p.date, days), p.clock) : null;
}

/** Calendar days from a to b (b - a); null when either is invalid. */
export function daysBetween(a, b) {
  const pa = parseDay(a);
  const pb = parseDay(b);
  if (!pa || !pb) return null;
  return Math.trunc((pb.date - pa.date) / DAY_MS);
}

/** True when rule is a supported recurrence rule. */
export function validRecurrence(rule) {
  if (SIMPLE_RULES.has(rule)) return true;
  if (rule.startsWith('weekly:')) return Object.hasOwn(WEEKDAYS, rule.slice(7));
  if (rule.startsWith('cron:')) {
    const fields = fieldsOf(rule.slice(5));
    return fields.length === 5 && fields.every((f, i) => validCronField(f, ...CRON_RANGES[i]));
  }
  return false;
}

/** Trims a rule and canonicalizes the spacing of cron rules. */
export function normalizeRecurrence(rule) {
  rule = rule.trim();
  return rule.startsWith('cron:') ? `cron:${fieldsOf(rule.slice(5)).join(' ')}` : rule;
}

function fieldsOf(s) {
  return s.split(/\s+/).filter(Boolean);
}

function cut(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', false] : [s.slice(0, i), s.slice(i + 1), true];
}

function validCronField(field, min, max) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = atoi(part.slice(2));
      if (!(step > 0)) return false;
    } else if (part.includes('-')) {
      const [lo, hi] = cut(part, '-');
      const a = atoi(lo);
      const b = atoi(hi);
      if (Number.isNaN(a) || Number.isNaN(b) || a < min || b > max || a > b) return false;
    } else {
      const n = atoi(part);
      if (Number.isNaN(n) || n < min || n > max) return false;
    }
  }
  return true;
}

function matchCronField(val, field) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = atoi(part.slice(2));
      if (step > 0 && val % step === 0) return true;
    } else if (part.includes('-')) {
      const [lo, hi] = cut(part, '-');
      const a = atoi(lo);
      const b = atoi(hi);
      if (!Number.isNaN(a) && !Number.isNaN(b) && val >= a && val <= b) return true;
    } else if (atoi(part) === val) {
      return true;
    }
  }
  return false;
}

/** First day after base matching the day-of-month, month and day-of-week fields. */
function nextCronDate(base, fields) {
  if (fields.length !== 5) return addDaysUTC(base, 1);
  const [, , domF, monthF, dowF] = fields;
  let cur = addDaysUTC(base, 1);
  for (let i = 0; i < 366 * 5; i++) {
    const dow = cur.getUTCDay();
    const domOK = matchCronField(cur.getUTCDate(), domF);
    const dowOK = matchCronField(dow, dowF) || (dow === 0 && matchCronField(7, dowF));
    // As in standard cron: when both are restricted, either one is enough.
    const dayOK = domF !== '*' && dowF !== '*' ? domOK || dowOK : domOK && dowOK;
    if (dayOK && matchCronField(cur.getUTCMonth() + 1, monthF)) return cur;
    cur = addDaysUTC(cur, 1);
  }
  return addDaysUTC(base, 1);
}

function normalizeToday(s) {
  s = (s ?? '').trim();
  return s.length === 10 && validDue(s) ? s : todayISO();
}

/**
 * Next occurrence of a recurring task. It starts from the later of the due
 * date and today, so completing an overdue task never schedules it in the
 * past. The time of day is kept.
 */
export function nextDueDate(due, rule, today) {
  let base = parseDay(normalizeToday(today)).date;
  let clock = '';
  const p = parseDay(due);
  if (p) {
    clock = p.clock;
    if (p.date > base) base = p.date;
  }
  let next;
  if (rule === 'daily') {
    next = addDaysUTC(base, 1);
  } else if (rule === 'weekdays') {
    next = addDaysUTC(base, 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next = addDaysUTC(next, 1);
  } else if (rule === 'weekly') {
    next = addDaysUTC(base, 7);
  } else if (rule === 'monthly') {
    next = addMonthsClamped(base, 1);
  } else if (rule === 'yearly') {
    next = addMonthsClamped(base, 12);
  } else if (rule.startsWith('weekly:')) {
    let days = (WEEKDAYS[rule.slice(7)] ?? 0) - base.getUTCDay();
    if (days <= 0) days += 7;
    next = addDaysUTC(base, days);
  } else if (rule.startsWith('cron:')) {
    next = nextCronDate(base, fieldsOf(rule.slice(5)));
  } else {
    next = addDaysUTC(base, 1);
  }
  return formatDay(next, clock);
}
