// Applies changes to the local state as the server will (a port of the store
// methods in internal/db). The server stays the authority: when this code
// and the server disagree on a detail, the next snapshot corrects it.

import { ApiError } from '../errors.js';
import { byPosition, siblingsOf, getTask, descendants, normalizeToday } from './state.js';
import { nextDueDate, normalizeRecurrence as trimRule, shiftDue, daysBetween, validDue, validRecurrence } from '../recurrence.js';

const MAX_NAME = 200;
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 20000;
const MAX_LOCATION = 500;
const DEFAULT_PRIORITY = 3;
const SORTS = ['manual', 'date', 'priority', 'title'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies one change to the local state, as the server will, and returns
 * what the matching API call returns. Validates everything before changing
 * anything; throws an ApiError (400 or 404) when the change cannot apply.
 */
export function reduce(state, op) {
  const fn = Object.hasOwn(handlers, op.type) ? handlers[op.type] : null;
  if (!fn) throw new ApiError(`Unknown operation ${op.type}`, 400);
  return fn(state, op.args ?? {});
}

// ---- Errors and validation -------------------------------------------------

const invalid = (msg) => new ApiError(msg, 400);
const notFound = () => new ApiError('Not found', 404);
const nowISO = () => new Date().toISOString();
const runes = (s) => [...s].length;

/** An optional string argument: null, or a string; anything else is malformed. */
function optional(v) {
  if (v == null) return null;
  if (typeof v !== 'string') throw invalid('Invalid arguments');
  return v;
}

/** Trims an optional string and turns "" into null. */
function clean(v) {
  v = optional(v);
  if (v === null) return null;
  v = v.trim();
  return v === '' ? null : v;
}

/** The id of a created record: required here, since replaying must give the same id. */
function createdId(v) {
  const id = (optional(v) ?? '').trim();
  if (id === '') throw invalid('Missing id');
  if (!UUID_RE.test(id)) throw invalid('invalid id');
  return id.toLowerCase();
}

function normalizeName(name, what) {
  name = (optional(name) ?? '').trim();
  if (name === '') throw invalid(`${what} name is required`);
  if (runes(name) > MAX_NAME) throw invalid(`${what} name is too long (${MAX_NAME} characters max)`);
  return name;
}

function normalizeTitle(s) {
  s = (optional(s) ?? '').trim();
  if (s === '') throw invalid('Task title is required');
  if (runes(s) > MAX_TITLE) throw invalid(`Task title is too long (${MAX_TITLE} characters max)`);
  return s;
}

function normalizeDescription(s) {
  s = (optional(s) ?? '').trim();
  if (runes(s) > MAX_DESCRIPTION) throw invalid(`Description is too long (${MAX_DESCRIPTION} characters max)`);
  return s;
}

function normalizePriority(p) {
  if (p == null || p === 0) return DEFAULT_PRIORITY;
  if (!Number.isInteger(p) || p < 1 || p > 3) throw invalid('Priority must be 1, 2 or 3');
  return p;
}

function normalizeDue(v) {
  const s = clean(v);
  if (s !== null && !validDue(s)) {
    throw invalid(`Invalid due date ${JSON.stringify(s)} (expected YYYY-MM-DD or YYYY-MM-DD HH:MM)`);
  }
  return s;
}

function normalizeRecurrence(v) {
  const s = clean(v);
  if (s === null) return null;
  const rule = trimRule(s);
  if (!validRecurrence(rule)) throw invalid(`Invalid recurrence ${JSON.stringify(s)}`);
  return rule;
}

function normalizeLocation(v) {
  const s = clean(v);
  if (s !== null && runes(s) > MAX_LOCATION) throw invalid(`Location is too long (${MAX_LOCATION} characters max)`);
  return s;
}

/** Runs a normalizer that may throw; on error returns fallback (used when restoring). */
function lenient(fn, value, fallback) {
  try {
    return fn(value);
  } catch {
    return fallback;
  }
}

// ---- Positions -------------------------------------------------------------

/** Inserts id among siblings (which must not contain id): before_id, after_id, or at the end. */
function place(siblings, id, { before_id: before, after_id: after } = {}) {
  const anchor = before || after || '';
  if (anchor === '') return [...siblings, id];
  const idx = siblings.indexOf(anchor);
  if (idx < 0) throw invalid('the reference item is not in the destination list');
  const out = [...siblings];
  out.splice(before ? idx : idx + 1, 0, id);
  return out;
}

/** Writes positions 1..n following the order of ids. */
function renumber(records, ids) {
  ids.forEach((id, i) => {
    if (records[id]) records[id].position = i + 1;
  });
}

const maxPosition = (records) => records.reduce((m, r) => Math.max(m, r.position), 0);

// ---- Places ---------------------------------------------------------------

function requireSectionProject(state, projectId, sectionId) {
  if (!state.projects[projectId]) throw invalid('the project does not exist');
  if (sectionId == null) return;
  const sec = state.sections[sectionId];
  if (!sec || sec.project_id !== projectId) throw invalid('the section does not belong to this project');
}

/** Validates a destination for a task. A subtask takes the project and section of its parent. */
function resolveSlot(state, projectId, sectionId, parentId) {
  if (parentId != null) {
    const parent = state.tasks[parentId];
    if (!parent) throw invalid('the parent task does not exist');
    return { project_id: parent.project_id, section_id: parent.section_id ?? null, parent_id: parentId };
  }
  projectId = projectId || 'inbox';
  requireSectionProject(state, projectId, sectionId);
  return { project_id: projectId, section_id: sectionId, parent_id: null };
}

function slotTasks(state, slot) {
  return siblingsOf(state, slot).map((id) => state.tasks[id]);
}

function projectDescendants(state, id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const p of Object.values(state.projects)) {
      if (p.parent_id === out[i] && !out.includes(p.id)) out.push(p.id);
    }
  }
  return out;
}

function deleteTaskTree(state, id) {
  for (const d of descendants(state, id)) delete state.tasks[d];
  delete state.tasks[id];
}

const projectOut = (p) => ({ ...p, children: [] });

// ---- Projects -------------------------------------------------------------

function projectSiblings(state, parentId, excludeId = '') {
  return Object.values(state.projects)
    .filter((p) => p.id !== 'inbox' && p.id !== excludeId && (p.parent_id ?? null) === parentId);
}

function topLevelParent(v) {
  const parent = optional(v);
  return parent === null || parent === '' || parent === 'inbox' ? null : parent;
}

const handlers = {
  'project.create'(state, a) {
    const name = normalizeName(a.name, 'Project');
    const parentId = topLevelParent(a.parent_id);
    const id = createdId(a.id);
    if (state.projects[id]) return projectOut(state.projects[id]);
    if (parentId !== null && !state.projects[parentId]) throw invalid('the parent project does not exist');
    const p = {
      id, parent_id: parentId, name, sort_by: 'manual', created_at: nowISO(),
      position: maxPosition(projectSiblings(state, parentId)) + 1,
    };
    state.projects[id] = p;
    return projectOut(p);
  },

  'project.rename'(state, a) {
    if (a.id === 'inbox') throw invalid('the inbox cannot be renamed');
    const name = normalizeName(a.name, 'Project');
    const p = state.projects[a.id];
    if (!p) throw notFound();
    p.name = name;
    return projectOut(p);
  },

  'project.delete'(state, a) {
    if (a.id === 'inbox') throw invalid('the inbox cannot be deleted');
    if (!state.projects[a.id]) throw notFound();
    const gone = new Set(projectDescendants(state, a.id));
    for (const t of Object.values(state.tasks)) if (gone.has(t.project_id)) delete state.tasks[t.id];
    for (const s of Object.values(state.sections)) if (gone.has(s.project_id)) delete state.sections[s.id];
    for (const id of gone) delete state.projects[id];
    return { deleted: true };
  },

  'project.move'(state, a) {
    if (a.id === 'inbox') throw invalid('the inbox cannot be moved');
    const parentId = topLevelParent(a.parent_id);
    if (!state.projects[a.id]) throw notFound();
    if (parentId !== null) {
      if (!state.projects[parentId]) throw invalid('the parent project does not exist');
      if (projectDescendants(state, a.id).includes(parentId)) throw invalid('a project cannot be moved inside itself');
    }
    const siblings = projectSiblings(state, parentId, a.id).sort(byPosition).map((p) => p.id);
    const order = place(siblings, a.id, a);
    state.projects[a.id].parent_id = parentId;
    renumber(state.projects, order);
    return { moved: true };
  },

  'project.sort'(state, a) {
    if (!SORTS.includes(a.sort_by)) throw invalid(`unknown sort order ${JSON.stringify(a.sort_by)}`);
    const p = state.projects[a.id];
    if (!p) throw notFound();
    p.sort_by = a.sort_by;
    return { sort_by: a.sort_by };
  },

  // ---- Sections ----

  'section.create'(state, a) {
    const name = normalizeName(a.name, 'Section');
    if (a.project_id === 'inbox') throw invalid('the inbox has no sections');
    const id = createdId(a.id);
    if (state.sections[id]) return { ...state.sections[id] };
    requireSectionProject(state, a.project_id, null);
    const sections = Object.values(state.sections).filter((s) => s.project_id === a.project_id);
    const sec = { id, project_id: a.project_id, name, position: maxPosition(sections) + 1, created_at: nowISO() };
    state.sections[id] = sec;
    return { ...sec };
  },

  'section.rename'(state, a) {
    const name = normalizeName(a.name, 'Section');
    const sec = state.sections[a.id];
    if (!sec) throw notFound();
    sec.name = name;
    return { ...sec };
  },

  'section.delete'(state, a) {
    if (!state.sections[a.id]) throw notFound();
    for (const t of Object.values(state.tasks)) {
      if (t.section_id === a.id && state.tasks[t.id]) deleteTaskTree(state, t.id);
    }
    delete state.sections[a.id];
    return { deleted: true };
  },

  'section.move'(state, a) {
    const sec = state.sections[a.id];
    if (!sec) throw notFound();
    const projectId = a.project_id || sec.project_id;
    if (projectId === 'inbox') throw invalid('the inbox has no sections');
    requireSectionProject(state, projectId, null);
    const siblings = Object.values(state.sections)
      .filter((s) => s.project_id === projectId && s.id !== a.id)
      .sort(byPosition).map((s) => s.id);
    const order = place(siblings, a.id, a);
    if (projectId !== sec.project_id) {
      sec.project_id = projectId;
      const ts = nowISO();
      for (const t of Object.values(state.tasks)) {
        if (t.section_id === a.id) Object.assign(t, { project_id: projectId, updated_at: ts });
      }
    }
    renumber(state.sections, order);
    return { moved: true };
  },

  // ---- Tasks ----

  'task.create'(state, a) {
    const title = normalizeTitle(a.title);
    const description = normalizeDescription(a.description);
    const priority = normalizePriority(a.priority);
    const due = normalizeDue(a.due_date);
    const recurrence = normalizeRecurrence(a.recurrence);
    const location = normalizeLocation(a.location);
    const id = createdId(a.id);
    if (state.tasks[id]) return getTask(state, id);
    const slot = resolveSlot(state, (optional(a.project_id) ?? '').trim(), clean(a.section_id), clean(a.parent_id));
    const afterId = optional(a.after_id) ?? '';
    const siblings = siblingsOf(state, slot);
    // Placing first: it throws when after_id is not a sibling.
    const order = afterId === '' ? null : place(siblings, id, { after_id: afterId });
    const ts = nowISO();
    state.tasks[id] = {
      id, ...slot, title, description, priority, due_date: due, recurrence, location,
      position: maxPosition(slotTasks(state, slot)) + 1, created_at: ts, updated_at: ts,
    };
    if (order) renumber(state.tasks, order);
    return getTask(state, id);
  },

  'task.update'(state, a) {
    const t = state.tasks[a.id];
    if (!t) throw notFound();
    const f = a.fields ?? {};
    const next = {};
    if (f.title != null) next.title = normalizeTitle(f.title);
    if (f.description != null) next.description = normalizeDescription(f.description);
    if (f.priority != null) {
      if (f.priority === 0) throw invalid('Priority must be 1, 2 or 3');
      next.priority = normalizePriority(f.priority);
    }
    if ('due_date' in f) next.due_date = normalizeDue(f.due_date);
    if ('recurrence' in f) next.recurrence = normalizeRecurrence(f.recurrence);
    if ('location' in f) next.location = normalizeLocation(f.location);

    const oldDue = t.due_date;
    const ts = nowISO();
    Object.assign(t, next, { updated_at: ts });
    if (oldDue != null && t.due_date != null) {
      const days = daysBetween(oldDue, t.due_date);
      if (days) {
        for (const id of descendants(state, a.id)) {
          const d = state.tasks[id];
          const shifted = d.due_date == null ? null : shiftDue(d.due_date, days);
          if (shifted) Object.assign(d, { due_date: shifted, updated_at: ts });
        }
      }
    }
    return getTask(state, a.id);
  },

  'task.move'(state, a) {
    const t = state.tasks[a.id];
    if (!t) throw notFound();
    const parentId = clean(a.parent_id);
    const projectId = (optional(a.project_id) ?? '').trim() || t.project_id;
    const below = descendants(state, a.id);
    if (parentId !== null && (parentId === a.id || below.includes(parentId))) {
      throw invalid('a task cannot be moved inside itself');
    }
    const slot = resolveSlot(state, projectId, clean(a.section_id), parentId);
    const order = place(siblingsOf(state, slot, a.id), a.id, a);
    const ts = nowISO();
    Object.assign(t, slot, { updated_at: ts });
    for (const id of below) {
      Object.assign(state.tasks[id], { project_id: slot.project_id, section_id: slot.section_id, updated_at: ts });
    }
    renumber(state.tasks, order);
    return getTask(state, a.id);
  },

  'task.delete'(state, a) {
    if (!state.tasks[a.id]) throw notFound();
    deleteTaskTree(state, a.id);
    return { deleted: true };
  },

  'task.complete'(state, a) {
    const t = state.tasks[a.id];
    if (!t) throw notFound();
    const tree = getTask(state, a.id);
    const previous = tree.due_date;
    if (t.recurrence == null) {
      deleteTaskTree(state, a.id);
      return { deleted: true, task: tree, previous_due_date: previous };
    }
    // The date moved since the client saw it: it was completed already.
    if ((t.due_date ?? null) !== (a.due_date ?? null)) {
      return { deleted: false, task: tree, previous_due_date: previous };
    }
    const next = nextDueDate(t.due_date ?? '', t.recurrence, normalizeToday(a.today));
    Object.assign(t, { due_date: next, updated_at: nowISO() });
    return { deleted: false, task: { ...tree, due_date: next }, previous_due_date: previous };
  },

  'task.restore'(state, a) {
    const updates = (a.updates ?? []).map((u) => ({ id: u.id, due: normalizeDue(u.due_date) }));
    for (const u of updates) {
      const t = state.tasks[u.id];
      if (t) Object.assign(t, { due_date: u.due, updated_at: nowISO() });
    }
    for (const tree of a.tasks ?? []) restoreTree(state, tree, null);
    return { restored: true };
  },
};

function restoreTree(state, t, parentSlot) {
  if (!t || typeof t.id !== 'string' || t.id.trim() === '' || state.tasks[t.id]) return;
  const slot = parentSlot ?? originalSlot(state, t);
  const ts = nowISO();
  state.tasks[t.id] = {
    id: t.id, ...slot,
    title: lenient(normalizeTitle, t.title, 'Untitled'),
    description: lenient(normalizeDescription, t.description, ''),
    priority: lenient(normalizePriority, t.priority, DEFAULT_PRIORITY),
    due_date: lenient(normalizeDue, t.due_date, null),
    recurrence: lenient(normalizeRecurrence, t.recurrence, null),
    location: lenient(normalizeLocation, t.location, null),
    position: t.position ?? 0,
    created_at: t.created_at || ts,
    updated_at: ts,
  };
  const child = { project_id: slot.project_id, section_id: slot.section_id, parent_id: t.id };
  for (const sub of t.subtasks ?? []) restoreTree(state, sub, child);
}

/** Where a restored root task goes; the inbox when its original place is gone. */
function originalSlot(state, t) {
  const attempts = [];
  const parentId = lenient(clean, t.parent_id, null);
  if (parentId !== null) attempts.push(() => resolveSlot(state, '', null, parentId));
  const projectId = typeof t.project_id === 'string' ? t.project_id.trim() : '';
  if (projectId !== '') {
    attempts.push(() => resolveSlot(state, projectId, lenient(clean, t.section_id, null), null));
    attempts.push(() => resolveSlot(state, projectId, null, null));
  }
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch { /* try the next place */ }
  }
  return { project_id: 'inbox', section_id: null, parent_id: null };
}
