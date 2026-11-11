// Local state, views and reducer of the offline mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../web/js/errors.js';
import { fromSnapshot, listTasks, getTask, counts, searchTasks, projectTree, listSections } from '../../web/js/sync/state.js';
import { reduce } from '../../web/js/sync/reduce.js';

const today = '2026-10-07';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P1 = uid(1);
const S1 = uid(2);

function task(id, extra = {}) {
  return {
    id, project_id: 'inbox', section_id: null, parent_id: null, title: id, description: '',
    priority: 3, due_date: null, recurrence: null, location: null, position: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
  };
}

function makeState() {
  return fromSnapshot(structuredClone({
    projects: [
      { id: 'inbox', parent_id: null, name: 'Inbox', position: 0, sort_by: 'manual', created_at: '2026-01-01T00:00:00Z' },
      { id: P1, parent_id: null, name: 'Work', position: 1, sort_by: 'manual', created_at: '2026-01-01T00:00:00Z' },
    ],
    sections: [{ id: S1, project_id: P1, name: 'Todo', position: 1, created_at: '2026-01-01T00:00:00Z' }],
    tasks: [
      task('a', { position: 1 }), task('b', { position: 2 }), task('c', { position: 3 }),
      task('b1', { parent_id: 'b', position: 1 }), task('b2', { parent_id: 'b', position: 2 }),
    ],
  }));
}

const apply = (state, type, args) => reduce(state, { id: uid(99), type, args });
const inboxIds = (state) => listTasks(state, 'inbox', '', 'manual', today).map((t) => t.id);

test('task.create goes last, or right after after_id', () => {
  const s = makeState();
  apply(s, 'task.create', { id: uid(10), project_id: 'inbox', title: ' New ' });
  assert.deepEqual(inboxIds(s), ['a', 'b', 'c', uid(10)]);
  assert.equal(s.tasks[uid(10)].title, 'New');
  apply(s, 'task.create', { id: uid(11), project_id: 'inbox', title: 'Mid', after_id: 'a' });
  assert.deepEqual(inboxIds(s), ['a', uid(11), 'b', 'c', uid(10)]);
  const positions = Object.values(s.tasks).filter((t) => !t.parent_id).sort((x, y) => x.position - y.position).map((t) => t.position);
  assert.deepEqual(positions, [1, 2, 3, 4, 5]);
});

test('task.create returns the task and is idempotent', () => {
  const s = makeState();
  const t = apply(s, 'task.create', { id: uid(10), title: 'X' });
  assert.equal(t.project_name, 'Inbox');
  assert.deepEqual(t.subtasks, []);
  apply(s, 'task.create', { id: uid(10), title: 'X again' });
  assert.equal(Object.keys(s.tasks).length, 6);
  assert.equal(s.tasks[uid(10)].title, 'X');
});

test('a subtask takes the project and section of its parent', () => {
  const s = makeState();
  apply(s, 'task.move', { id: 'a', project_id: P1, section_id: S1 });
  apply(s, 'task.create', { id: uid(10), parent_id: 'a', title: 'Sub', project_id: 'inbox' });
  const sub = s.tasks[uid(10)];
  assert.equal(sub.project_id, P1);
  assert.equal(sub.section_id, S1);
  assert.deepEqual(getTask(s, 'a').subtasks.map((t) => t.id), [uid(10)]);
});

test('task.move takes subtasks along; moving into a descendant fails and changes nothing', () => {
  const s = makeState();
  apply(s, 'task.move', { id: 'b', project_id: P1, section_id: S1 });
  for (const id of ['b', 'b1', 'b2']) {
    assert.equal(s.tasks[id].project_id, P1, id);
    assert.equal(s.tasks[id].section_id, S1, id);
  }
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'task.move', { id: 'b', parent_id: 'b1' }), (e) => e instanceof ApiError && e.status === 400);
  assert.throws(() => apply(s, 'task.move', { id: 'b', parent_id: 'b' }), ApiError);
  assert.deepEqual(s, before);
});

test('task.move honours before_id and after_id', () => {
  const s = makeState();
  apply(s, 'task.move', { id: 'c', before_id: 'a' });
  assert.deepEqual(inboxIds(s), ['c', 'a', 'b']);
  apply(s, 'task.move', { id: 'c', after_id: 'b' });
  assert.deepEqual(inboxIds(s), ['a', 'b', 'c']);
  assert.throws(() => apply(s, 'task.move', { id: 'c', after_id: 'nope' }), ApiError);
});

test('task.update moves the dates of subtasks with the due date', () => {
  const s = makeState();
  s.tasks.b.due_date = '2026-10-10';
  s.tasks.b1.due_date = '2026-10-11 09:00';
  apply(s, 'task.update', { id: 'b', fields: { due_date: '2026-10-12' } });
  assert.equal(s.tasks.b1.due_date, '2026-10-13 09:00');
  assert.equal(s.tasks.b2.due_date, null);
  apply(s, 'task.update', { id: 'b', fields: { title: 'Renamed' } });
  assert.equal(s.tasks.b.due_date, '2026-10-12');
  apply(s, 'task.update', { id: 'b', fields: { due_date: null } });
  assert.equal(s.tasks.b.due_date, null);
  assert.equal(s.tasks.b1.due_date, '2026-10-13 09:00');
  assert.throws(() => apply(s, 'task.update', { id: 'b', fields: { priority: 0 } }), /Priority must be 1, 2 or 3/);
});

test('task.complete: recurring moves on, one-off disappears and can be restored', () => {
  const s = makeState();
  s.tasks.a.recurrence = 'daily';
  s.tasks.a.due_date = '2026-10-07';
  const r = apply(s, 'task.complete', { id: 'a', today, due_date: '2026-10-07' });
  assert.equal(r.deleted, false);
  assert.equal(r.previous_due_date, '2026-10-07');
  assert.equal(s.tasks.a.due_date, '2026-10-08');
  // The same completion replayed on a stale date does nothing.
  apply(s, 'task.complete', { id: 'a', today, due_date: '2026-10-07' });
  assert.equal(s.tasks.a.due_date, '2026-10-08');

  const done = apply(s, 'task.complete', { id: 'b', today, due_date: null });
  assert.equal(done.deleted, true);
  assert.deepEqual(done.task.subtasks.map((t) => t.id), ['b1', 'b2']);
  assert.equal(s.tasks.b, undefined);
  assert.equal(s.tasks.b1, undefined);

  apply(s, 'task.restore', { tasks: [done.task], updates: [] });
  assert.deepEqual(inboxIds(s), ['a', 'b', 'c']);
  assert.deepEqual(getTask(s, 'b').subtasks.map((t) => t.id), ['b1', 'b2']);
  apply(s, 'task.restore', { tasks: [done.task], updates: [] }); // twice is harmless
  assert.equal(Object.keys(s.tasks).length, 5);
});

test('task.restore falls back to the inbox and resets recurring dates', () => {
  const s = makeState();
  s.tasks.a.recurrence = 'daily';
  s.tasks.a.due_date = '2026-10-08';
  const lost = task('lost', { project_id: uid(77), section_id: uid(78), position: 9 });
  apply(s, 'task.restore', { tasks: [lost], updates: [{ id: 'a', due_date: '2026-10-07' }] });
  assert.equal(s.tasks.lost.project_id, 'inbox');
  assert.equal(s.tasks.lost.position, 9);
  assert.equal(s.tasks.a.due_date, '2026-10-07');
});

test('project.delete removes sections and tasks, subprojects included', () => {
  const s = makeState();
  const child = uid(3);
  apply(s, 'project.create', { id: child, name: 'Sub', parent_id: P1 });
  apply(s, 'section.create', { id: uid(4), project_id: child, name: 'S' });
  apply(s, 'task.move', { id: 'a', project_id: P1, section_id: S1 });
  apply(s, 'task.move', { id: 'c', project_id: child });
  apply(s, 'project.delete', { id: P1 });
  assert.deepEqual(Object.keys(s.projects), ['inbox']);
  assert.deepEqual(s.sections, {});
  assert.deepEqual(Object.keys(s.tasks).sort(), ['b', 'b1', 'b2']);
  assert.throws(() => apply(s, 'project.delete', { id: 'inbox' }), ApiError);
});

test('projects: tree, rename, move, cycles', () => {
  const s = makeState();
  const child = uid(3);
  apply(s, 'project.create', { id: child, name: 'Sub', parent_id: P1 });
  assert.equal(projectTree(s)[0].children[0].id, child);
  assert.throws(() => apply(s, 'project.move', { id: P1, parent_id: child }), /inside itself/);
  apply(s, 'project.move', { id: child, parent_id: '' });
  assert.deepEqual(projectTree(s).map((p) => p.id), [P1, child]);
  apply(s, 'project.move', { id: child, before_id: P1 });
  assert.deepEqual(projectTree(s).map((p) => p.id), [child, P1]);
  apply(s, 'project.rename', { id: P1, name: 'Job' });
  s.tasks.a.project_id = P1;
  assert.equal(getTask(s, 'a').project_name, 'Job');
  assert.throws(() => apply(s, 'project.rename', { id: 'inbox', name: 'x' }), /inbox cannot be renamed/);
});

test('sections: create, move to another project with their tasks', () => {
  const s = makeState();
  const other = uid(3);
  apply(s, 'project.create', { id: other, name: 'Other' });
  apply(s, 'task.move', { id: 'a', project_id: P1, section_id: S1 });
  apply(s, 'section.move', { id: S1, project_id: other });
  assert.equal(s.tasks.a.project_id, other);
  assert.deepEqual(listSections(s, other).map((x) => x.id), [S1]);
  assert.throws(() => apply(s, 'section.create', { id: uid(5), project_id: 'inbox', name: 'x' }), /no sections/);
  apply(s, 'section.delete', { id: S1 });
  assert.equal(s.tasks.a, undefined);
});

test('counts and the upcoming view', () => {
  const s = makeState();
  s.tasks.a.due_date = '2026-10-05'; // overdue
  s.tasks.b.due_date = '2026-10-07 18:00'; // today
  s.tasks.c.due_date = '2026-10-13'; // today + 6: in
  s.tasks.b1.due_date = '2026-10-14'; // today + 7: out
  s.tasks.b1.project_id = P1;
  s.tasks.b2.due_date = '2026-10-06';
  s.tasks.b2.project_id = P1;
  const c = counts(s, today);
  assert.equal(c.inbox, 3);
  assert.equal(c.upcoming, 4);
  assert.deepEqual(c.projects, { inbox: 'overdue', [P1]: 'overdue' });
  const up = listTasks(s, 'upcoming', '', 'manual', today);
  assert.deepEqual(up.map((t) => t.id), ['a', 'b2', 'b', 'c']);
  assert.ok(up.every((t) => t.subtasks.length === 0));
  assert.throws(() => listTasks(s, 'nope', '', 'manual', today), (e) => e.status === 400);
  assert.throws(() => listTasks(s, 'project', 'missing', 'manual', today), (e) => e.status === 404);
});

test('listTasks sorts and nests', () => {
  const s = makeState();
  s.tasks.a.title = 'banana';
  s.tasks.b.title = 'Apple';
  s.tasks.c.title = 'cherry';
  s.tasks.c.priority = 1;
  s.tasks.a.due_date = '2026-10-09';
  assert.deepEqual(listTasks(s, 'inbox', '', 'title', today).map((t) => t.id), ['b', 'a', 'c']);
  assert.deepEqual(listTasks(s, 'inbox', '', 'priority', today).map((t) => t.id), ['c', 'a', 'b']);
  assert.deepEqual(listTasks(s, 'inbox', '', 'date', today).map((t) => t.id), ['a', 'c', 'b']);
  const tree = listTasks(s, 'inbox', '', 'manual', today);
  assert.deepEqual(tree.find((t) => t.id === 'b').subtasks.map((t) => t.id), ['b1', 'b2']);
});

test('searchTasks: case, fields, order and limit', () => {
  const s = makeState();
  s.tasks.a.title = 'Buy MILK';
  s.tasks.b.description = 'the milk run';
  s.tasks.c.location = 'Milkyway';
  s.tasks.c.priority = 1;
  assert.deepEqual(searchTasks(s, ' milk ').map((t) => t.id), ['c', 'a', 'b']);
  assert.deepEqual(searchTasks(s, '  '), []);
  for (let i = 0; i < 60; i++) s.tasks[`m${i}`] = task(`m${i}`, { title: 'milk' });
  assert.equal(searchTasks(s, 'milk').length, 50);
});

test('an invalid change throws and leaves the state untouched', () => {
  const s = makeState();
  const before = structuredClone(s);
  for (const [type, args] of [
    ['task.create', { id: uid(10), title: '  ' }],
    ['task.create', { id: uid(10), title: 'x', due_date: '2026-02-30' }],
    ['task.create', { id: uid(10), title: 'x', recurrence: 'cron:0 0 32 * *' }],
    ['task.create', { id: uid(10), title: 'x', after_id: 'nope' }],
    ['task.create', { id: 'x', title: 'x' }],
    ['task.update', { id: 'a', fields: { title: 'ok', due_date: 'garbage' } }],
    ['task.update', { id: 'missing', fields: {} }],
    ['task.fly', {}],
  ]) {
    assert.throws(() => apply(s, type, args), (e) => e instanceof ApiError && [400, 404].includes(e.status), type);
    assert.deepEqual(s, before, type);
  }
});
