// Date picker content: a free-text field ("tomorrow 9am", "15/11"),
// shortcut days, a month calendar, a time field and "No date". Used inside a
// popover.

import { h, icon } from '../dom.js';
import { MONTHS, WEEKDAYS_SHORT, MONTHS_SHORT, isoDate, joinDue, parseISO, quickDates, splitDue, todayISO } from '../dates.js';
import { parseQuickAdd } from '../quickadd.js';

/**
 * value: current due string or null. onPick(due | null) receives the new due
 * date. Picking a day keeps the time shown in the time field; the time alone
 * is applied with Enter or "Set" (on today when there is no date yet).
 */
export function datePicker(value, onPick) {
  const today = todayISO();
  const days = quickDates(today);
  const { date: current, time: currentTime } = splitDue(value);
  let time = currentTime;
  const pickDay = (iso) => onPick(joinDue(iso, time));

  const input = h('input', {
    type: 'text', class: 'input', placeholder: 'Type a date, e.g. "fri 9am"', autocomplete: 'off',
    attrs: { 'aria-label': 'Due date' },
  });
  const hint = h('div', { class: 'datepicker-hint' });
  input.addEventListener('input', () => {
    const parsed = parseQuickAdd(input.value, { today }).tokens.find((t) => t.type === 'date');
    hint.textContent = input.value.trim() ? (parsed ? parsed.label : 'Not recognized') : '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = input.value.trim();
    if (/^(no date|none|clear|aucune)$/i.test(text)) return onPick(null);
    const parsed = parseQuickAdd(text, { today });
    if (parsed.dueDate) onPick(parsed.dueDate);
  });

  const choice = (label, iso, iconName) => h('button', {
    type: 'button', class: ['menu-item', current === iso && 'selected'], onclick: () => pickDay(iso),
  }, icon(iconName), h('span', { class: 'menu-label' }, label), h('span', { class: 'menu-hint' }, dayHint(iso, today)));

  const root = h('div', { class: 'datepicker' },
    input,
    hint,
    h('div', { class: 'menu' },
      choice('Today', days.today, 'today'),
      choice('Tomorrow', days.tomorrow, 'tomorrow'),
      choice('This weekend', days.weekend, 'weekend'),
      choice('Next week', days.nextWeek, 'nextWeek')),
    calendar(current || today, current, today, pickDay),
    timeField(currentTime, (t) => { time = t; }, () => onPick(joinDue(current || today, time))),
    h('div', { class: 'menu' },
      h('button', { type: 'button', class: 'menu-item danger', onclick: () => onPick(null) },
        icon('noDate'), h('span', { class: 'menu-label' }, 'No date'))));
  requestAnimationFrame(() => {
    if (window.matchMedia('(pointer: fine)').matches) input.focus();
  });
  return root;
}

/** "HH:MM" field with "Set" and, when a time is set, "No time". */
function timeField(initial, onChange, onApply) {
  const input = h('input', {
    type: 'time', class: 'input', value: initial,
    attrs: { 'aria-label': 'Time' },
  });
  const set = h('button', { type: 'button', class: 'button primary', disabled: true, onclick: onApply }, 'Set');
  input.addEventListener('input', () => {
    // A half-typed time reads as "": keep the previous value meanwhile.
    if (input.value || !input.validity.badInput) onChange(input.value);
    set.disabled = input.value === initial || input.validity.badInput;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!set.disabled) onApply();
  });
  const clearTime = initial ? h('button', {
    type: 'button', class: 'button', onclick: () => { onChange(''); onApply(); },
  }, 'No time') : null;
  return h('div', { class: 'datepicker-time' }, input, clearTime, set);
}

function dayHint(iso, today) {
  const d = parseISO(iso);
  const weekday = WEEKDAYS_SHORT[d.getDay()];
  return iso === today ? weekday : `${weekday} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/** Month grid starting on Monday. */
function calendar(startIso, selected, today, onPick) {
  const start = parseISO(startIso);
  let year = start.getFullYear();
  let month = start.getMonth();
  const title = h('span', { class: 'calendar-title' });
  const grid = h('div', { class: 'calendar-grid' });

  const render = () => {
    title.textContent = `${MONTHS[month]} ${year}`;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(year, month, 1 - offset + i);
      const iso = isoDate(d);
      cells.push(h('button', {
        type: 'button',
        class: ['calendar-day', d.getMonth() !== month && 'outside', iso === today && 'today', iso === selected && 'selected'],
        attrs: { 'aria-label': iso },
        onclick: () => onPick(iso),
      }, String(d.getDate())));
    }
    grid.replaceChildren(...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l) => h('span', { class: 'calendar-weekday' }, l)), ...cells);
  };
  const shift = (delta) => {
    month += delta;
    year += Math.floor(month / 12);
    month = ((month % 12) + 12) % 12;
    render();
  };
  render();
  return h('div', { class: 'calendar' },
    h('div', { class: 'calendar-header' },
      title,
      h('div', { class: 'calendar-nav' },
        h('button', { type: 'button', class: 'icon-button', title: 'Previous month', onclick: () => shift(-1) }, '‹'),
        h('button', {
          type: 'button', class: 'icon-button', title: 'This month',
          onclick: () => { const t = parseISO(today); year = t.getFullYear(); month = t.getMonth(); render(); },
        }, '•'),
        h('button', { type: 'button', class: 'icon-button', title: 'Next month', onclick: () => shift(1) }, '›'))),
    grid);
}
