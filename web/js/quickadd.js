// Quick add parser: reads priority, recurrence, due date/time and location
// out of a task title, in English or French. It follows the same rules as
// internal/parser on the server (used for CSV imports).
//
//   "Dentist tomorrow 14h30 p2 @Rue de la Paix"
//   -> title "Dentist", due "YYYY-MM-DD 14:30", priority 2, location "Rue de la Paix"

import { addDays, isoDate, nextWeekday, pad2, parseISO, recurrenceLabel, formatDue, todayISO, joinDue, splitDue } from './dates.js';

const MONTH_PATTERN = 'january|janvier|janv|jan|february|f[eé]vrier|f[eé]vr|f[eé]v|feb|march|mars|mar|april|avril|avr|apr|may|mai|june|juin|jun|july|juillet|juil|jul|august|ao[uû]t|aug|september|septembre|sept|sep|october|octobre|oct|november|novembre|nov|december|d[eé]cembre|d[eé]c|dec';

const MONTH_NUMBERS = {
  january: 1, janvier: 1, janv: 1, jan: 1,
  february: 2, fevrier: 2, fevr: 2, fev: 2, feb: 2,
  march: 3, mars: 3, mar: 3,
  april: 4, avril: 4, avr: 4, apr: 4,
  may: 5, mai: 5,
  june: 6, juin: 6, jun: 6,
  july: 7, juillet: 7, juil: 7, jul: 7,
  august: 8, aout: 8, aug: 8,
  september: 9, septembre: 9, sept: 9, sep: 9,
  october: 10, octobre: 10, oct: 10,
  november: 11, novembre: 11, nov: 11,
  december: 12, decembre: 12, dec: 12,
};

const PRIORITY_RE = /(?:^|\s)(?:p|!)([1-3])(?=\s|$)/i;
const TIME_RE = /\b(\d{1,2})(?:(?::(\d{2}))?\s*(am|pm)|h(\d{2})?|:(\d{2}))\b/i;
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(${MONTH_PATTERN})\\.?(?:\\s+(\\d{4}))?\\b`, 'i');
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th|er)?(?:,?\\s+(\\d{4}))?\\b`, 'i');
const NUMERIC_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/;
const CRON_RE = /\bcron:(\S+(?:\s+\S+){4})/i;

const RECURRENCES = [
  [/\b(?:tous les jours ouvrés|jours ouvrés|every weekday|weekdays)\b/i, 'weekdays'],
  [/\b(?:tous les jours|chaque jour|every day|daily)\b/i, 'daily'],
  [/\b(?:toutes les semaines|chaque semaine|every week|weekly)\b/i, 'weekly'],
  [/\b(?:tous les mois|chaque mois|every month|monthly)\b/i, 'monthly'],
  [/\b(?:tous les ans|chaque année|chaque annee|every year|yearly)\b/i, 'yearly'],
  [/\b(?:tous les lundis|chaque lundi|every monday)\b/i, 'weekly:monday'],
  [/\b(?:tous les mardis|chaque mardi|every tuesday)\b/i, 'weekly:tuesday'],
  [/\b(?:tous les mercredis|chaque mercredi|every wednesday)\b/i, 'weekly:wednesday'],
  [/\b(?:tous les jeudis|chaque jeudi|every thursday)\b/i, 'weekly:thursday'],
  [/\b(?:tous les vendredis|chaque vendredi|every friday)\b/i, 'weekly:friday'],
  [/\b(?:tous les samedis|chaque samedi|every saturday)\b/i, 'weekly:saturday'],
  [/\b(?:tous les dimanches|chaque dimanche|every sunday)\b/i, 'weekly:sunday'],
];

const RELATIVE_DAYS = [
  [/\b(?:après-demain|apres-demain|day after tomorrow)\b/i, 2],
  [/\b(?:aujourd'hui|aujourdhui|today|ajd)\b/i, 0],
  [/\b(?:demain|tomorrow)\b/i, 1],
  [/\b(?:hier|yesterday)\b/i, -1],
];

// "mon" is left out on purpose: in French it means "my".
const WEEKDAY_WORDS = [
  [/\b(?:ce week-end|ce weekend|this weekend|weekend)\b/i, 6],
  [/\b(?:lundi|monday)\b/i, 1],
  [/\b(?:mardi|tuesday|tue)\b/i, 2],
  [/\b(?:mercredi|wednesday|wed)\b/i, 3],
  [/\b(?:jeudi|thursday|thu)\b/i, 4],
  [/\b(?:vendredi|friday|fri)\b/i, 5],
  [/\b(?:samedi|saturday|sat)\b/i, 6],
  [/\b(?:dimanche|sunday|sun)\b/i, 0],
];

const WEEKDAY_NUMBERS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function monthNumber(name) {
  return MONTH_NUMBERS[name.toLowerCase().replace(/é/g, 'e').replace(/û/g, 'u')] || 0;
}

/** "YYYY-MM-DD" for a valid calendar date, else null. */
function makeDate(year, month, day) {
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? isoDate(d) : null;
}

/** Day + month (+ optional year); without year, a past date means next year. */
function calendarDate(day, month, yearStr, today) {
  let year = parseISO(today).getFullYear();
  if (yearStr) {
    year = Number(yearStr);
    if (year < 100) year += 2000;
  }
  let iso = makeDate(year, month, Number(day));
  if (iso && !yearStr && iso < today) iso = makeDate(year + 1, month, Number(day)) || iso;
  return iso;
}

function parseClock(m) {
  let hour = Number(m[1]);
  const minute = Number(m[2] || m[4] || m[5] || 0);
  const ampm = (m[3] || '').toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return hour <= 23 && minute <= 59 ? `${pad2(hour)}:${pad2(minute)}` : null;
}

/** Removes a regex match from the string it was found in. */
function cut(work, match) {
  return `${work.slice(0, match.index)} ${work.slice(match.index + match[0].length)}`;
}

/** Finds a date and/or time in text: { due, rest } or null. */
function findDue(text, today) {
  let work = text;
  let time = '';
  const tm = TIME_RE.exec(work);
  if (tm) {
    const clock = parseClock(tm);
    if (clock) {
      time = clock;
      work = cut(work, tm);
    }
  }

  let date = null;
  const tryMatch = (re, build) => {
    if (date) return;
    const m = re.exec(work);
    if (!m) return;
    const iso = build(m);
    if (iso) {
      date = iso;
      work = cut(work, m);
    }
  };
  tryMatch(ISO_RE, (m) => makeDate(Number(m[1]), Number(m[2]), Number(m[3])));
  tryMatch(DAY_MONTH_RE, (m) => calendarDate(m[1], monthNumber(m[2]), m[3], today));
  tryMatch(MONTH_DAY_RE, (m) => calendarDate(m[2], monthNumber(m[1]), m[3], today));
  tryMatch(NUMERIC_RE, (m) => calendarDate(m[1], Number(m[2]), m[3], today));
  for (const [re, offset] of RELATIVE_DAYS) tryMatch(re, () => addDays(today, offset));
  for (const [re, weekday] of WEEKDAY_WORDS) tryMatch(re, () => nextWeekday(today, weekday));

  if (!date && !time) return null;
  return { due: joinDue(date || today, time), rest: work };
}

/**
 * Parses a quick add title. Token types listed in `ignored` (a Set of
 * 'priority' | 'recurrence' | 'date' | 'location') are left in the title.
 *
 * Returns { title, priority, dueDate, recurrence, location, tokens } where
 * tokens describe what was recognized, for the preview chips.
 */
export function parseQuickAdd(text, { today = todayISO(), ignored = new Set() } = {}) {
  const result = { title: '', priority: null, dueDate: null, recurrence: null, location: null, tokens: [] };
  let work = String(text || '');

  if (!ignored.has('priority')) {
    const m = PRIORITY_RE.exec(work);
    if (m) {
      result.priority = Number(m[1]);
      result.tokens.push({ type: 'priority', label: `P${m[1]}` });
      work = cut(work, m);
    }
  }

  if (!ignored.has('recurrence')) {
    const cron = CRON_RE.exec(work);
    if (cron) {
      result.recurrence = `cron:${cron[1].trim().split(/\s+/).join(' ')}`;
      work = cut(work, cron);
    } else {
      for (const [re, rule] of RECURRENCES) {
        const m = re.exec(work);
        if (m) {
          result.recurrence = rule;
          work = cut(work, m);
          break;
        }
      }
    }
    if (result.recurrence) result.tokens.push({ type: 'recurrence', label: recurrenceLabel(result.recurrence) });
  }

  if (!ignored.has('date')) {
    const found = findDue(work, today);
    if (found) {
      result.dueDate = found.due;
      work = found.rest;
    }
  }
  // "every monday" without a date starts on the next Monday.
  if (result.recurrence?.startsWith('weekly:') && !ignored.has('date')) {
    const weekday = WEEKDAY_NUMBERS[result.recurrence.slice(7)];
    const { date, time } = splitDue(result.dueDate);
    if (!date || date === today) result.dueDate = joinDue(nextWeekday(today, weekday), time);
  }
  if (result.dueDate) result.tokens.push({ type: 'date', label: formatDue(result.dueDate, today).text });

  if (!ignored.has('location')) {
    const quoted = /@(["'])(.+?)\1/.exec(work);
    const plain = /@(\S.*)$/.exec(work);
    const m = quoted || plain;
    const location = m ? (quoted ? quoted[2] : plain[1]).trim().replace(/\s+/g, ' ') : '';
    if (location) {
      result.location = location;
      result.tokens.push({ type: 'location', label: location });
      work = cut(work, m);
    }
  }

  result.title = work.trim().replace(/\s+/g, ' ');
  return result;
}
