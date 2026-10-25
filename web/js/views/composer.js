// Task composer: title with live token parsing, description, and chips for
// date, priority and location. Used inline in lists and in the quick add
// dialog.

import { h, icon, autoGrow } from '../dom.js';
import { formatDue, recurrenceLabel } from '../dates.js';
import { parseQuickAdd } from '../quickadd.js';
import { openPopover, closePopover, menuList } from '../ui/overlay.js';
import { datePicker } from '../ui/datepicker.js';

const MAX_TITLE = 500;

export const PRIORITY_LABELS = { 1: 'Priority 1 · Urgent', 2: 'Priority 2 · High', 3: 'Priority 3 · Normal' };

/**
 * Creates a composer element.
 *   defaults  { dueDate, priority } prefilled for the current view
 *   submit(fields) async; receives { title, description, priority, due_date,
 *             recurrence, location } and returns true once the task is saved
 *   cancel()  called on Cancel / Escape
 *   submitLabel  text of the submit button
 */
export function createComposer({ defaults = {}, submit, cancel, submitLabel = 'Add task' }) {
  // Values chosen with the chips win over values typed in the title.
  let chosen = {};
  let ignored = new Set();
  let parsed = parseQuickAdd('');
  let busy = false;

  const title = h('input', {
    type: 'text', class: 'composer-title', placeholder: 'Task name', maxLength: MAX_TITLE,
    autocomplete: 'off', attrs: { 'aria-label': 'Task name', enterkeyhint: 'send' },
  });
  const chips = h('div', { class: 'token-chips' });
  const description = h('textarea', { class: 'composer-description', rows: 1, placeholder: 'Description', attrs: { 'aria-label': 'Description' } });
  const dateChip = h('button', { type: 'button', class: 'chip' });
  const priorityChip = h('button', { type: 'button', class: 'chip' });
  const locationChip = h('button', { type: 'button', class: 'chip' });
  const submitButton = h('button', { type: 'button', class: 'button primary composer-submit', title: 'Add task (Enter)' },
    h('span', { class: 'composer-submit-label' }, submitLabel), icon('arrowUp', 'composer-submit-icon'));

  const value = (field, fallback = null) => {
    if (field in chosen) return chosen[field];
    if (parsed[field] !== null && parsed[field] !== undefined) return parsed[field];
    return defaults[field] ?? fallback;
  };

  const render = () => {
    parsed = parseQuickAdd(title.value, { ignored });
    chips.replaceChildren(...parsed.tokens.map((token) => h('button', {
      type: 'button',
      class: ['token-chip', token.type, token.type === 'priority' && `p${parsed.priority}`],
      title: 'Click to keep this text in the title',
      onmousedown: (e) => e.preventDefault(), // keep the focus in the title
      onclick: () => {
        ignored.add(token.type);
        render();
      },
    }, token.label, ' ×')));
    chips.hidden = parsed.tokens.length === 0;

    const due = value('dueDate');
    const recurrence = value('recurrence');
    dateChip.replaceChildren(icon('calendar'), h('span', null,
      due ? formatDue(due).text : 'Date', recurrence ? ` · ${recurrenceLabel(recurrence)}` : ''));
    dateChip.classList.toggle('has-value', !!due);
    const priority = value('priority', 3);
    priorityChip.replaceChildren(icon('flag'), h('span', null, `P${priority}`));
    priorityChip.className = `chip has-value p${priority}`;
    const location = value('location');
    locationChip.replaceChildren(icon('pin'), h('span', { class: 'chip-text' }, location || 'Location'));
    locationChip.classList.toggle('has-value', !!location);
  };

  const choose = (field, v) => {
    chosen[field] = v;
    closePopover();
    render();
    title.focus();
  };

  dateChip.addEventListener('click', () => openPopover(dateChip,
    datePicker(value('dueDate'), (due) => choose('dueDate', due)), { title: 'Due date' }));
  priorityChip.addEventListener('click', () => openPopover(priorityChip, menuList([1, 2, 3].map((p) => ({
    label: PRIORITY_LABELS[p], icon: 'flag', className: `p${p}`, selected: value('priority', 3) === p, run: () => choose('priority', p),
  }))), { title: 'Priority' }));
  locationChip.addEventListener('click', () => {
    const input = h('input', { type: 'text', class: 'input', value: value('location') || '', placeholder: 'Place or address', maxLength: 500 });
    const save = () => choose('location', input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    openPopover(locationChip, h('div', { class: 'popover-form' },
      input,
      h('div', { class: 'popover-actions' },
        h('button', { type: 'button', class: 'button', onclick: () => choose('location', null) }, 'Clear'),
        h('button', { type: 'button', class: 'button primary', onclick: save }, 'Set'))), { title: 'Location' });
    requestAnimationFrame(() => input.focus());
  });

  const reset = () => {
    title.value = '';
    description.value = '';
    autoGrow(description);
    chosen = {};
    ignored = new Set();
    render();
  };

  const doSubmit = async () => {
    if (busy) return;
    if (!parsed.title && !title.value.trim()) {
      title.focus();
      return;
    }
    busy = true;
    submitButton.disabled = true;
    try {
      const saved = await submit({
        title: parsed.title || title.value.trim(),
        description: description.value.trim(),
        priority: value('priority', 3),
        due_date: value('dueDate'),
        recurrence: value('recurrence'),
        location: value('location'),
      });
      if (saved) reset();
    } finally {
      busy = false;
      submitButton.disabled = false;
      if (root.isConnected) title.focus();
    }
  };

  // A long paste is split: the first 500 characters go to the title, the
  // rest to the description.
  title.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const start = title.selectionStart ?? title.value.length;
    const end = title.selectionEnd ?? title.value.length;
    const combined = title.value.slice(0, start) + text + title.value.slice(end);
    if (combined.length <= MAX_TITLE) return;
    e.preventDefault();
    title.value = combined.slice(0, MAX_TITLE);
    description.value = [description.value, combined.slice(MAX_TITLE)].filter(Boolean).join('\n');
    autoGrow(description);
    render();
  });
  title.addEventListener('input', render);
  description.addEventListener('input', () => autoGrow(description));

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!closePopover()) cancel();
    } else if (e.key === 'Enter' && !e.isComposing && (e.target === title || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doSubmit();
    }
  };
  title.addEventListener('keydown', onKey);
  description.addEventListener('keydown', onKey);
  submitButton.addEventListener('mousedown', (e) => e.preventDefault()); // do not blur the title first
  submitButton.addEventListener('click', doSubmit);

  const root = h('div', { class: 'composer' },
    title,
    chips,
    description,
    h('div', { class: 'composer-bar' },
      h('div', { class: 'composer-chips' }, dateChip, priorityChip, locationChip),
      h('div', { class: 'composer-actions' },
        h('button', { type: 'button', class: 'button composer-cancel', onclick: () => cancel() }, 'Cancel'),
        submitButton)));
  root.focusTitle = () => title.focus();
  render();
  return root;
}
