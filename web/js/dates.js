// Calendar helpers. Days are "YYYY-MM-DD" strings in the user's local time;
// due dates are "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". Never use toISOString()
// for days: it converts to UTC and shifts the date around midnight.

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = WEEKDAYS.map((d) => d.slice(0, 3));

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local "YYYY-MM-DD" of a Date. */
export function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayISO() {
  return isoDate(new Date());
}

/** Date at local midnight for "YYYY-MM-DD", or null when invalid. */
export function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

export function addDays(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** Calendar days from a to b (both "YYYY-MM-DD"). */
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

/** Splits a due string into { date, time }; time is "" when absent. */
export function splitDue(due) {
  if (!due) return { date: '', time: '' };
  const [date, time = ''] = due.split(' ');
  return { date, time };
}

export function joinDue(date, time) {
  if (!date) return null;
  return time ? `${date} ${time}` : date;
}

/** Changes the day of a due date, keeping its time. */
export function withDate(due, date) {
  return joinDue(date, splitDue(due).time);
}

/** First day strictly after `iso` falling on `weekday` (0 = Sunday). */
export function nextWeekday(iso, weekday) {
  const d = parseISO(iso);
  let diff = weekday - d.getDay();
  if (diff <= 0) diff += 7;
  return addDays(iso, diff);
}

/** "23 Oct", or "23 Oct 2027" outside the current year. */
export function shortDate(iso, today = todayISO()) {
  const d = parseISO(iso);
  const label = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return iso.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${d.getFullYear()}`;
}

/**
 * Human label of a due date relative to today:
 * { text: 'Tomorrow 14:00', status: 'overdue' | 'today' | 'future' }.
 */
export function formatDue(due, today = todayISO()) {
  const { date, time } = splitDue(due);
  if (!parseISO(date)) return { text: due || '', status: 'future' };
  const diff = daysBetween(today, date);
  let text;
  if (diff === 0) text = 'Today';
  else if (diff === 1) text = 'Tomorrow';
  else if (diff === -1) text = 'Yesterday';
  else if (diff > 1 && diff < 7) text = WEEKDAYS[parseISO(date).getDay()];
  else text = shortDate(date, today);
  return {
    text: time ? `${text} ${time}` : text,
    status: diff < 0 ? 'overdue' : diff === 0 ? 'today' : 'future',
  };
}

/** The shortcut days offered by date pickers. */
export function quickDates(today = todayISO()) {
  const day = parseISO(today).getDay();
  return {
    today,
    tomorrow: addDays(today, 1),
    weekend: day === 6 ? today : nextWeekday(today, 6),
    nextWeek: nextWeekday(today, 1),
  };
}

const RECURRENCE_LABELS = {
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};

export function recurrenceLabel(rule) {
  if (!rule) return '';
  if (RECURRENCE_LABELS[rule]) return RECURRENCE_LABELS[rule];
  if (rule.startsWith('weekly:')) {
    const name = rule.slice(7);
    return `Every ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  }
  if (rule.startsWith('cron:')) return `Cron ${rule.slice(5)}`;
  return rule;
}
