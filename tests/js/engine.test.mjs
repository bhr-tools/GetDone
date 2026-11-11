// The sync engine, with a fake server (Node has no IndexedDB: the engine
// falls back to memory storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../../web/js/sync/engine.js';
import { EMPTY, fromSnapshot } from '../../web/js/sync/state.js';
import { reduce } from '../../web/js/sync/reduce.js';

const inbox = { id: 'inbox', parent_id: null, name: 'Inbox', position: 0, sort_by: 'manual', created_at: '2026-01-01T00:00:00Z' };
const SNAP = { projects: [inbox], sections: [], tasks: [] };

async function makeEngine(t) {
  const engine = new SyncEngine({ dbName: 'test', empty: EMPTY, fromSnapshot, reduce });
  engine.events = { status: [], rejected: [], auth: 0, changes: 0 };
  engine.onStatus = (s) => engine.events.status.push(s.status);
  engine.onRejected = (m) => engine.events.rejected.push(...m);
  engine.onAuthRequired = () => { engine.events.auth += 1; };
  engine.onChange = () => { engine.events.changes += 1; };
  await engine.init();
  t.after(() => engine.channel?.close()); // an open channel keeps Node alive
  return engine;
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const newTask = (id) => ({ id, project_id: 'inbox', title: 'T' });

test('offline: the change is applied locally and kept in the queue', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  const engine = await makeEngine(t);
  const task = await engine.mutate('task.create', newTask('11111111-1111-4111-8111-111111111111'));
  assert.equal(task.title, 'T');
  assert.equal(engine.pending, 1);
  await engine.sync();
  assert.ok(engine.events.status.includes('offline'));
  assert.equal(engine.status, 'offline');
  assert.equal(engine.pending, 1);
  assert.ok(engine.state.tasks['11111111-1111-4111-8111-111111111111']);
});

test('online: an acknowledged change leaves the queue, the snapshot replaces the state', async (t) => {
  const id = '22222222-2222-4222-8222-222222222222';
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sent = JSON.parse(opts.body);
    const task = { id, project_id: 'inbox', section_id: null, parent_id: null, title: 'T', description: '', priority: 3,
      due_date: null, recurrence: null, location: null, position: 1, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' };
    return json(200, { results: [{ id: sent.ops[0].id, status: 'ok' }], etag: '"e1"', snapshot: { ...SNAP, tasks: [task] } });
  });
  const engine = await makeEngine(t);
  await engine.mutate('task.create', newTask(id));
  await engine.sync();
  assert.equal(sent.ops[0].type, 'task.create');
  assert.equal(engine.pending, 0);
  assert.equal(engine.status, 'synced');
  assert.equal(engine.etag, '"e1"');
  assert.equal(engine.state.tasks[id].created_at, '2026-01-02T00:00:00Z');
  assert.ok(engine.events.changes > 0);
});

test('a refused change leaves the queue and its effect disappears', async (t) => {
  const id = '33333333-3333-4333-8333-333333333333';
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const { ops } = JSON.parse(opts.body);
    return json(200, { results: [{ id: ops[0].id, status: 'invalid', error: 'Nope' }], etag: '"e2"', snapshot: SNAP });
  });
  const engine = await makeEngine(t);
  await engine.mutate('task.create', newTask(id));
  assert.ok(engine.state.tasks[id]);
  await engine.sync();
  assert.deepEqual(engine.events.rejected, ['Nope']);
  assert.equal(engine.pending, 0);
  assert.equal(engine.state.tasks[id], undefined);
});

test('401: the app is asked to log in and the queue is kept', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json(401, { error: 'Unauthorized' }));
  const engine = await makeEngine(t);
  await engine.mutate('task.create', newTask('44444444-4444-4444-8444-444444444444'));
  await engine.sync();
  assert.equal(engine.events.auth, 1);
  assert.equal(engine.status, 'auth');
  assert.equal(engine.pending, 1);
});

test('304: nothing changes', async (t) => {
  let calls = 0;
  let headers;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls += 1;
    headers = opts.headers;
    return calls === 1 ? json(200, { etag: '"e3"', snapshot: SNAP }) : json(304);
  });
  const engine = await makeEngine(t);
  await engine.sync();
  assert.ok(engine.ready);
  const state = engine.state;
  const changes = engine.events.changes;
  await engine.sync();
  assert.equal(headers['If-None-Match'], '"e3"');
  assert.equal(engine.state, state);
  assert.equal(engine.events.changes, changes);
  assert.equal(engine.status, 'synced');
});

test('a change made while a request is in flight is replayed on the new snapshot', async (t) => {
  const first = '55555555-5555-4555-8555-555555555555';
  const second = '66666666-6666-4666-8666-666666666666';
  let engine;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const { ops } = JSON.parse(opts.body);
    calls += 1;
    if (calls === 2) assert.ok(engine.state.tasks[second]); // replayed over the new snapshot
    if (calls === 1) await engine.mutate('task.create', newTask(second)); // the user types during the request
    return json(200, { results: ops.map((o) => ({ id: o.id, status: 'ok' })), etag: '"e4"', snapshot: SNAP });
  });
  engine = await makeEngine(t);
  await engine.mutate('task.create', newTask(first));
  await engine.sync();
  assert.equal(calls, 2); // the second change is sent right after the first
  assert.equal(engine.pending, 0);
});
