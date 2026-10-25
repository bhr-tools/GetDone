// Task area: the inbox, project and upcoming views, and task rows.

import { h, icon, mapsUrl } from '../dom.js';
import { addDays, formatDue, parseISO, recurrenceLabel, WEEKDAYS_SHORT, MONTHS_SHORT, splitDue } from '../dates.js';
import { openMenu } from '../ui/overlay.js';

/**
 * Renders the current view into `area`. Returns the tasks in display order
 * (used by keyboard navigation) and the list elements by key, so that an open
 * composer can be put back where it was.
 */
export function renderTasks(app, area) {
  const ctx = { app, order: [], lists: new Map() };
  const s = app.state;
  let content;
  if (s.view === 'upcoming') content = upcomingView(ctx);
  else if (s.view === 'project') content = projectView(ctx);
  else content = inboxView(ctx);
  area.replaceChildren(content);
  return { order: ctx.order, lists: ctx.lists };
}

// A list of tasks that accepts drops and new tasks.
//   key      identifies the list for the composer ("root", "section:<id>", "day:<iso>")
//   target   where dropped or added tasks go: { projectId, sectionId } or { date }
function taskList(ctx, key, tasks, target, { emptyText = '', addLabel = 'Add task' } = {}) {
  const list = h('div', {
    class: 'task-list',
    dataset: { drop: 'list', listKey: key, ...dropData(target) },
  });
  for (const t of tasks) list.append(taskTree(ctx, t, 0));
  if (!tasks.length && emptyText) list.append(h('div', { class: 'empty-list' }, emptyText));
  ctx.lists.set(key, list);
  const add = h('button', {
    type: 'button', class: 'add-task',
    onclick: () => ctx.app.openInlineComposer(key, target),
  }, icon('plus'), h('span', null, addLabel));
  return [list, add];
}

function dropData(target) {
  if (target.date) return { date: target.date };
  return { projectId: target.projectId, sectionId: target.sectionId || '' };
}

function taskTree(ctx, task, depth) {
  const row = taskRow(ctx, task);
  if (!task.subtasks?.length) return row;
  return h('div', { class: 'task-tree' },
    row,
    h('div', { class: 'subtasks' }, task.subtasks.map((st) => taskTree(ctx, st, depth + 1))));
}

/** One task row; also used by the detail panel for subtasks. */
export function taskRow(ctx, task, { compact = false } = {}) {
  const { app } = ctx;
  ctx.order?.push(task);
  const row = h('div', {
    class: ['task-row', `p${task.priority}`, app.state.selection.has(task.id) && 'selected'],
    dataset: compact ? { id: task.id } : { id: task.id, drag: 'task', drop: 'task' },
    onclick: (e) => {
      if (e.target.closest('a, button')) return;
      app.openDetail(task.id);
    },
  },
  h('button', {
    type: 'button', class: 'task-check', title: 'Complete',
    attrs: { 'aria-label': `Complete "${task.title}"` },
    onclick: () => app.completeTasks([task.id]),
  }, icon('check')),
  h('div', { class: 'task-body' },
    h('div', { class: 'task-title' }, task.title),
    !compact && task.description ? h('div', { class: 'task-description' }, task.description) : null,
    taskMeta(task, app.state.today, { showProject: !compact && app.state.view === 'upcoming' })));
  return row;
}

function taskMeta(task, today, { showProject = false } = {}) {
  const items = [];
  if (task.due_date) {
    const due = formatDue(task.due_date, today);
    items.push(h('span', { class: ['badge', 'due', due.status] }, icon('calendar'), due.text));
  }
  if (task.recurrence) items.push(h('span', { class: 'badge recurrence' }, icon('repeat'), recurrenceLabel(task.recurrence)));
  if (task.location) {
    items.push(h('a', {
      class: 'badge location', href: mapsUrl(task.location), target: '_blank', rel: 'noopener noreferrer',
      title: 'Open in Google Maps',
    }, icon('pin'), h('span', { class: 'badge-text' }, task.location)));
  }
  if (showProject && task.project_name) {
    items.push(h('span', { class: 'badge project' },
      icon(task.project_id === 'inbox' ? 'inbox' : 'hash'), h('span', { class: 'badge-text' }, task.project_name)));
  }
  return items.length ? h('div', { class: 'task-meta' }, items) : null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function inboxView(ctx) {
  const tasks = ctx.app.state.tasks;
  return h('section', { class: 'task-group' },
    taskList(ctx, 'root', tasks, { projectId: 'inbox' }, { emptyText: 'Your inbox is empty.' }));
}

function projectView(ctx) {
  const { app } = ctx;
  const s = app.state;
  const projectId = s.projectId;
  const blocks = [h('section', { class: 'task-group' },
    taskList(ctx, 'root', s.tasks.filter((t) => !t.section_id), { projectId },
      { emptyText: s.sections.length ? '' : 'No tasks yet.' }))];

  for (const sec of s.sections) {
    const tasks = s.tasks.filter((t) => t.section_id === sec.id);
    const menuButton = h('button', { type: 'button', class: 'icon-button', title: 'Section actions' }, icon('more'));
    menuButton.addEventListener('click', () => openMenu(menuButton, [
      { label: 'Add task', icon: 'plus', run: () => app.openInlineComposer(`section:${sec.id}`, { projectId, sectionId: sec.id }) },
      { label: 'Rename', icon: 'edit', run: () => app.renameSection(sec) },
      { label: 'Move to project…', icon: 'folder', run: () => app.pickSectionDestination(sec) },
      'separator',
      { label: 'Delete section', icon: 'trash', danger: true, run: () => app.deleteSection(sec) },
    ], { title: sec.name }));
    blocks.push(h('section', { class: 'task-group', dataset: { sectionId: sec.id, drop: 'section' } },
      h('header', { class: 'group-header', dataset: { drag: 'section', id: sec.id } },
        h('h2', { class: 'group-title' }, sec.name),
        h('span', { class: 'group-count' }, countTasks(tasks) || ''),
        menuButton),
      taskList(ctx, `section:${sec.id}`, tasks, { projectId, sectionId: sec.id })));
  }
  return h('div', { class: 'task-groups' }, blocks);
}

function upcomingView(ctx) {
  const { app } = ctx;
  const today = app.state.today;
  const tasks = app.state.tasks;
  const blocks = [];

  const overdue = tasks.filter((t) => splitDue(t.due_date).date < today);
  if (overdue.length) {
    const list = h('div', { class: 'task-list' });
    for (const t of overdue) list.append(taskRow(ctx, t));
    blocks.push(h('section', { class: 'task-group overdue' },
      h('header', { class: 'group-header' },
        h('h2', { class: 'group-title' }, 'Overdue'),
        h('span', { class: 'group-count' }, overdue.length),
        h('button', {
          type: 'button', class: 'group-action',
          onclick: () => app.rescheduleTasks(overdue.map((t) => t.id), today),
        }, icon('today'), h('span', null, 'Reschedule to today'))),
      list));
  }

  for (let i = 0; i < 7; i++) {
    const iso = addDays(today, i);
    const d = parseISO(iso);
    const name = `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
    const label = i === 0 ? `Today · ${name}` : i === 1 ? `Tomorrow · ${name}` : name;
    const dayTasks = tasks.filter((t) => splitDue(t.due_date).date === iso);
    blocks.push(h('section', { class: ['task-group', i === 0 && 'today'], id: `day-${iso}`, dataset: { drop: 'list', date: iso } },
      h('header', { class: 'group-header' },
        h('h2', { class: 'group-title' }, label),
        h('span', { class: 'group-count' }, dayTasks.length || '')),
      taskList(ctx, `day:${iso}`, dayTasks, { date: iso })));
  }
  return h('div', { class: 'task-groups' }, blocks);
}

/** The week strip shown above the upcoming view. */
export function renderWeekStrip(app, strip) {
  const today = app.state.today;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const iso = addDays(today, i);
    const d = parseISO(iso);
    const busy = app.state.tasks.some((t) => splitDue(t.due_date).date === iso);
    days.push(h('button', {
      type: 'button', class: ['week-day', i === 0 && 'today', busy && 'busy'],
      onclick: () => document.getElementById(`day-${iso}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    },
    h('span', { class: 'week-day-name' }, WEEKDAYS_SHORT[d.getDay()]),
    h('span', { class: 'week-day-number' }, d.getDate()),
    h('span', { class: 'week-day-dot' })));
  }
  strip.replaceChildren(...days);
}

function countTasks(tasks) {
  return tasks.reduce((n, t) => n + 1 + countTasks(t.subtasks || []), 0);
}
