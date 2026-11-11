// Local state of the app, rebuilt from the server snapshot, and the read
// functions (the views) that replace the GET calls when working offline.
//
// State: { projects: { [id]: Project }, sections: { [id]: Section }, tasks: { [id]: Task } }
// Records are flat: no children / subtasks arrays, and project_name is not
// stored (it is computed from projects, so a rename shows everywhere at once).
// Every read function returns new objects: callers may modify them freely.

import { ApiError } from '../errors.js';
import { addDays, todayISO } from '../dates.js';
import { validDue } from '../recurrence.js';

// Used before the first download. The inbox always exists on the server, so it
// exists here too: tasks can be added right away.
export const EMPTY = {
  projects: [{ id: 'inbox', parent_id: null, name: 'Inbox', position: 0, sort_by: 'manual', created_at: '1970-01-01T00:00:00Z' }],
  sections: [],
  tasks: [],
};

const UPCOMING_DAYS = 7;
const SEARCH_LIMIT = 50;

/** Turns a server snapshot into the local state. */
export function fromSnapshot(snap) {
  const state = { projects: {}, sections: {}, tasks: {} };
  for (const p of snap.projects) {
    delete p.children;
    state.projects[p.id] = p;
  }
  for (const s of snap.sections) state.sections[s.id] = s;
  for (const t of snap.tasks) {
    delete t.subtasks;
    delete t.project_name;
    state.tasks[t.id] = t;
  }
  return state;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const time = (s) => Date.parse(s) || 0;

/** Order of siblings: position, then creation time. */
export function byPosition(a, b) {
  return a.position - b.position || time(a.created_at) - time(b.created_at);
}

/**
 * Ids of the tasks sharing a place, in order, without excludeId. The place is
 * { project_id, section_id, parent_id }: the subtasks of a parent, or the
 * top-level tasks of a section (or of a project outside any section).
 */
export function siblingsOf(state, slot, excludeId = '') {
  const same = (t) => (slot.parent_id
    ? t.parent_id === slot.parent_id
    : t.parent_id == null && t.project_id === slot.project_id && (t.section_id ?? null) === (slot.section_id ?? null));
  return Object.values(state.tasks)
    .filter((t) => t.id !== excludeId && same(t))
    .sort(byPosition)
    .map((t) => t.id);
}

/** Task as the API returns it: with its project name and an empty subtask list. */
export function taskOut(state, t) {
  return { ...t, project_name: state.projects[t.project_id]?.name ?? '', subtasks: [] };
}

function projectOut(p) {
  return { ...p, children: [] };
}

/** Projects as a tree, without the inbox. */
export function projectTree(state) {
  const all = Object.values(state.projects)
    .filter((p) => p.id !== 'inbox')
    .sort(byPosition)
    .map(projectOut);
  const byId = new Map(all.map((p) => [p.id, p]));
  const roots = [];
  for (const p of all) {
    const parent = p.parent_id ? byId.get(p.parent_id) : null;
    if (parent) {
      parent.children.push(p);
    } else {
      p.parent_id = null;
      roots.push(p);
    }
  }
  return roots;
}

/** One project (the inbox included), without its children. */
export function getProject(state, id) {
  const p = state.projects[id];
  if (!p) throw new ApiError('Not found', 404);
  return projectOut(p);
}

/** Sections of a project in display order. */
export function listSections(state, projectId) {
  return Object.values(state.sections)
    .filter((s) => s.project_id === projectId)
    .sort(byPosition)
    .map((s) => ({ ...s }));
}

/** Index parent id -> children, in order. */
function childrenIndex(state) {
  const index = new Map();
  for (const t of Object.values(state.tasks).sort(byPosition)) {
    if (!t.parent_id) continue;
    if (!index.has(t.parent_id)) index.set(t.parent_id, []);
    index.get(t.parent_id).push(t);
  }
  return index;
}

/** Ids of all the descendants of a task. */
export function descendants(state, id) {
  const index = childrenIndex(state);
  const out = [];
  const walk = (parent) => {
    for (const c of index.get(parent) ?? []) {
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** A task with all its subtasks. */
export function getTask(state, id) {
  const root = state.tasks[id];
  if (!root) throw new ApiError('Not found', 404);
  const index = childrenIndex(state);
  const build = (t) => ({ ...taskOut(state, t), subtasks: (index.get(t.id) ?? []).map(build) });
  return build(root);
}

const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const dueLast = (a, b) => (a.due_date == null) - (b.due_date == null);

// Same orders as the SQL of the server (sortClauses in tasks.go).
const SORTS = {
  manual: byPosition,
  priority: (a, b) => a.priority - b.priority || byPosition(a, b),
  date: (a, b) => dueLast(a, b) || cmp(a.due_date, b.due_date) || a.priority - b.priority || byPosition(a, b),
  title: (a, b) => cmp(asciiLower(a.title), asciiLower(b.title)) || byPosition(a, b),
};
const UPCOMING_SORT = (a, b) => cmp(a.due_date, b.due_date) || a.priority - b.priority || byPosition(a, b);

/** The user's day: today when valid, otherwise this device's today. */
export function normalizeToday(today) {
  return typeof today === 'string' && today.length === 10 && validDue(today) ? today : todayISO();
}

function dueBy(t, last) {
  return t.due_date != null && t.due_date.slice(0, 10) <= last;
}

/**
 * Tasks of a view: inbox and project views return a tree, the upcoming view a
 * flat list ordered by due date.
 */
export function listTasks(state, view, projectId, sort, today) {
  let tasks;
  let order = SORTS[sort] ?? SORTS.manual;
  if (view === 'inbox') {
    tasks = Object.values(state.tasks).filter((t) => t.project_id === 'inbox');
  } else if (view === 'project') {
    if (!state.projects[projectId]) throw new ApiError('Not found', 404);
    tasks = Object.values(state.tasks).filter((t) => t.project_id === projectId);
  } else if (view === 'upcoming') {
    const last = addDays(normalizeToday(today), UPCOMING_DAYS - 1);
    return Object.values(state.tasks).filter((t) => dueBy(t, last)).sort(UPCOMING_SORT).map((t) => taskOut(state, t));
  } else {
    throw new ApiError(`unknown view "${view}"`, 400);
  }
  return buildTree(tasks.sort(order).map((t) => taskOut(state, t)));
}

/** Attaches each task to its parent when the parent is in the list. */
function buildTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const roots = [];
  for (const t of tasks) {
    const parent = t.parent_id ? byId.get(t.parent_id) : null;
    if (parent) parent.subtasks.push(t);
    else roots.push(t);
  }
  return roots;
}

/** Tasks whose title, description or location contains query (any case). */
export function searchTasks(state, query) {
  const q = asciiLower(String(query ?? '').trim());
  if (!q) return [];
  const has = (s) => s != null && asciiLower(s).includes(q);
  return Object.values(state.tasks)
    .filter((t) => has(t.title) || has(t.description) || has(t.location))
    .sort((a, b) => a.priority - b.priority || dueLast(a, b) || cmp(a.due_date, b.due_date)
      || time(b.created_at) - time(a.created_at))
    .slice(0, SEARCH_LIMIT)
    .map((t) => taskOut(state, t));
}

/** Sidebar summary: inbox and upcoming counts, projects with overdue tasks or tasks due today. */
export function counts(state, today) {
  today = normalizeToday(today);
  const last = addDays(today, UPCOMING_DAYS - 1);
  const out = { inbox: 0, upcoming: 0, projects: {} };
  const earliest = {};
  for (const t of Object.values(state.tasks)) {
    if (t.project_id === 'inbox') out.inbox += 1;
    if (!dueBy(t, last)) continue;
    out.upcoming += 1;
    const day = t.due_date.slice(0, 10);
    if (day <= today && (earliest[t.project_id] === undefined || day < earliest[t.project_id])) {
      earliest[t.project_id] = day;
    }
  }
  for (const [id, day] of Object.entries(earliest)) out.projects[id] = day < today ? 'overdue' : 'today';
  return out;
}
