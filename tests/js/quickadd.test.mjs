// Unit tests for the browser-side parser and date helpers.
// Run: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from '../../web/js/quickadd.js';
import { formatDue, quickDates, recurrenceLabel, withDate, addDays } from '../../web/js/dates.js';

const today = '2026-10-07'; // Wednesday
const parse = (text, ignored) => parseQuickAdd(text, { today, ignored });

const cases = [
  ['Acheter du pain p1', { title: 'Acheter du pain', priority: 1 }],
  ['Rendez-vous dentiste demain 14h30 p2', { title: 'Rendez-vous dentiste', priority: 2, dueDate: '2026-10-08 14:30' }],
  ["Réunion d'équipe @Salle 204 tous les lundis 09:00", { title: "Réunion d'équipe", dueDate: '2026-10-12 09:00', recurrence: 'weekly:monday', location: 'Salle 204' }],
  ['Faire du sport chaque jour !3', { title: 'Faire du sport', priority: 3, recurrence: 'daily' }],
  ['Review roadmap october 23 p1', { title: 'Review roadmap', priority: 1, dueDate: '2026-10-23' }],
  ['Team retrospective 23 october', { title: 'Team retrospective', dueDate: '2026-10-23' }],
  ['Ship feature 23 oct 18:00', { title: 'Ship feature', dueDate: '2026-10-23 18:00' }],
  ['Release notes 23 octobre', { title: 'Release notes', dueDate: '2026-10-23' }],
  ['Client demo octobre 23', { title: 'Client demo', dueDate: '2026-10-23' }],
  ['Year end review 15 décembre', { title: 'Year end review', dueDate: '2026-12-15' }],
  ['Annual tax report 5 oct', { title: 'Annual tax report', dueDate: '2027-10-05' }],
  ['Team sync fri', { title: 'Team sync', dueDate: '2026-10-09' }],
  ['Hiking trip this weekend', { title: 'Hiking trip', dueDate: '2026-10-10' }],
  ['Contract renewal 15 janvier', { title: 'Contract renewal', dueDate: '2027-01-15' }],
  ['Deploy 2026-10-05', { title: 'Deploy', dueDate: '2026-10-05' }],
  ['Call 3pm', { title: 'Call', dueDate: '2026-10-07 15:00' }],
  // Regressions fixed by the rewrite:
  ['Pain @Boulangerie demain', { title: 'Pain', dueDate: '2026-10-08', location: 'Boulangerie' }],
  ['Mon rendez-vous chez le coiffeur', { title: 'Mon rendez-vous chez le coiffeur', dueDate: null }],
  ['Help1 p1', { title: 'Help1', priority: 1 }],
  ['Meet @"Café de Flore" tomorrow', { title: 'Meet', location: 'Café de Flore', dueDate: '2026-10-08' }],
  ['Backup cron:0 3 * * 1', { title: 'Backup', recurrence: 'cron:0 3 * * 1' }],
  ['Impossible 31/02', { title: 'Impossible 31/02', dueDate: null }],
];

for (const [input, want] of cases) {
  test(`parse: ${input}`, () => {
    const got = parse(input);
    for (const [key, value] of Object.entries(want)) {
      assert.equal(got[key], value, `${key} of "${input}"`);
    }
  });
}

test('dismissed tokens stay in the title', () => {
  const got = parse('Read p1 tomorrow', new Set(['date']));
  assert.equal(got.title, 'Read tomorrow');
  assert.equal(got.priority, 1);
  assert.equal(got.dueDate, null);
});

test('tokens describe what was found', () => {
  const got = parse('Gym tomorrow 7am every day p2 @Club');
  assert.deepEqual(got.tokens.map((t) => t.type), ['priority', 'recurrence', 'date', 'location']);
  assert.equal(got.tokens[2].label, 'Tomorrow 07:00');
});

test('formatDue', () => {
  assert.deepEqual(formatDue('2026-10-07', today), { text: 'Today', status: 'today' });
  assert.deepEqual(formatDue('2026-10-08 09:00', today), { text: 'Tomorrow 09:00', status: 'future' });
  assert.deepEqual(formatDue('2026-10-06', today), { text: 'Yesterday', status: 'overdue' });
  assert.equal(formatDue('2026-10-10', today).text, 'Saturday');
  assert.equal(formatDue('2026-10-20', today).text, '20 Oct');
  assert.equal(formatDue('2027-01-02', today).text, '2 Jan 2027');
});

test('quickDates', () => {
  assert.deepEqual(quickDates(today), { today, tomorrow: '2026-10-08', weekend: '2026-10-10', nextWeek: '2026-10-12' });
  assert.equal(quickDates('2026-10-10').weekend, '2026-10-10'); // on Saturday, this weekend is today
});

test('date helpers keep the time and cross month ends', () => {
  assert.equal(withDate('2026-10-07 14:30', '2026-11-01'), '2026-11-01 14:30');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // across the DST change in Europe
  assert.equal(recurrenceLabel('weekly:friday'), 'Every Friday');
});
