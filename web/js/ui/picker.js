// Command-palette style picker: a filter field over a list of choices,
// navigated with the arrows and Enter.

import { h, icon } from '../dom.js';
import { openModal } from './overlay.js';

/**
 * Opens a picker.
 *   placeholder  text of the filter field
 *   items(query) returns (or resolves to) [{ label, icon?, badge?, run }]
 *   emptyText    shown when nothing matches
 */
export function openPicker({ placeholder, items, emptyText = 'No match' }) {
  const input = h('input', { type: 'text', class: 'picker-input', placeholder, autocomplete: 'off', attrs: { 'aria-label': placeholder } });
  const list = h('div', { class: 'picker-list', attrs: { role: 'listbox' } });
  let current = [];
  let active = 0;
  let requestId = 0;

  const highlight = (index) => {
    const rows = list.querySelectorAll('.picker-item');
    if (!rows.length) return;
    active = (index + rows.length) % rows.length;
    rows.forEach((row, i) => row.classList.toggle('active', i === active));
    rows[active].scrollIntoView({ block: 'nearest' });
  };

  const choose = (item) => {
    modal.close();
    item.run();
  };

  const refresh = async () => {
    const id = ++requestId;
    const result = await items(input.value.trim());
    if (id !== requestId) return; // a newer query is in flight
    current = result;
    list.replaceChildren(...(current.length ? current.map((item, i) => h('button', {
      type: 'button',
      class: 'picker-item',
      attrs: { role: 'option' },
      onclick: () => choose(item),
      onmousemove: () => { if (active !== i) highlight(i); },
    },
    item.icon ? icon(item.icon) : null,
    h('span', { class: 'picker-label' }, item.label),
    item.badge ? h('span', { class: 'picker-badge' }, item.badge) : null)) : [h('div', { class: 'picker-empty' }, emptyText)]));
    highlight(0);
  };

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      highlight(active + 1);
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      highlight(active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current[active]) choose(current[active]);
    }
  });

  const modal = openModal({
    className: 'picker',
    body: [h('div', { class: 'picker-search' }, icon('search'), input), list],
  });
  refresh();
  return modal;
}
