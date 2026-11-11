// The JavaScript port of the recurrence rules must agree with the Go code:
// both are checked against tests/fixtures/next_due.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextDueDate, validRecurrence, validDue, shiftDue, daysBetween } from '../../web/js/recurrence.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/next_due.json', import.meta.url)));

test('nextDueDate matches the Go reference', () => {
  for (const c of fixture.next) {
    assert.equal(nextDueDate(c.due, c.rule, c.today), c.want, `${c.due} ${c.rule} (today ${c.today})`);
  }
});

test('validRecurrence matches the Go reference', () => {
  for (const c of fixture.valid) assert.equal(validRecurrence(c.rule), c.valid, c.rule);
});

test('validDue matches the Go reference', () => {
  for (const c of fixture.due_valid) assert.equal(validDue(c.due), c.valid, JSON.stringify(c.due));
});

test('shiftDue and daysBetween', () => {
  assert.equal(shiftDue('2026-03-28 09:30', 2), '2026-03-30 09:30');
  assert.equal(shiftDue('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDue('nope', 1), null);
  assert.equal(daysBetween('2026-03-28', '2026-03-30 10:00'), 2);
  assert.equal(daysBetween('2026-03-30', '2026-03-28'), -2);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2); // across a DST change
  assert.equal(daysBetween('x', '2026-03-28'), null);
});
