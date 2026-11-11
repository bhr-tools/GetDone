import test from 'node:test';
import assert from 'node:assert/strict';
import { listGaps, nearestGap, pickDepth, resolveDrop } from '../../web/js/dropgaps.js';

// a
//   a1
//   a2
// b
const rows = [
  { id: 'a', depth: 0, top: 0, bottom: 40 },
  { id: 'a1', depth: 1, top: 42, bottom: 82 },
  { id: 'a2', depth: 1, top: 84, bottom: 124 },
  { id: 'b', depth: 0, top: 126, bottom: 166 },
];

test('gaps sit between rows with the depths allowed there', () => {
  const gaps = listGaps(rows, 0);
  assert.deepEqual(gaps.map((g) => [g.y, g.min, g.max]), [[0, 0, 0], [41, 1, 1], [83, 1, 2], [125, 0, 2], [166, 0, 1]]);
  assert.equal(nearestGap(gaps, 120).index, 3);
  assert.deepEqual(listGaps([], 50), [{ index: 0, y: 50, min: 0, max: 0 }]);
});

test('depth follows the pull, clamped, with some stickiness', () => {
  const gap = { min: 0, max: 2 };
  assert.equal(pickDepth(1.4, gap), 1);
  assert.equal(pickDepth(1.6, gap), 2);
  assert.equal(pickDepth(1.6, gap, 1), 1); // not far enough past the boundary
  assert.equal(pickDepth(1.7, gap, 1), 2);
  assert.equal(pickDepth(5, gap), 2);
  assert.equal(pickDepth(-3, { min: 1, max: 1 }), 1);
});

test('a gap and a depth become a parent and a sibling', () => {
  assert.deepEqual(resolveDrop(rows, 0, 0), { parentId: null, beforeId: 'a' });
  assert.deepEqual(resolveDrop(rows, 1, 1), { parentId: 'a', beforeId: 'a1' }); // first subtask of a
  assert.deepEqual(resolveDrop(rows, 2, 1), { parentId: 'a', afterId: 'a1' });
  assert.deepEqual(resolveDrop(rows, 2, 2), { parentId: 'a1' }); // only subtask of a1
  assert.deepEqual(resolveDrop(rows, 3, 2), { parentId: 'a2' });
  assert.deepEqual(resolveDrop(rows, 3, 1), { parentId: 'a', afterId: 'a2' });
  assert.deepEqual(resolveDrop(rows, 3, 0), { parentId: null, afterId: 'a' }); // out of a, before b
  assert.deepEqual(resolveDrop(rows, 4, 1), { parentId: 'b' });
  assert.deepEqual(resolveDrop(rows, 4, 0), { parentId: null, afterId: 'b' });
  assert.deepEqual(resolveDrop([], 0, 0), { parentId: null });
});
