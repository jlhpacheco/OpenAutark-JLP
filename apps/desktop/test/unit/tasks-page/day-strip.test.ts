// The Tasks page's day line and month view (src/ui/tasks/day-strip.ts): how many days fit, where the line starts (the
// chosen day's week when seven fit, else from the day before; where the arrows left it), paging, the month's six weeks
// Monday first across month and year edges, the span the calendar window must hold, and what the page keeps across a
// switch to the chats (the view always, the day only on the day it was chosen).
// Owns: these assertions only. Never: the DOM, signals or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoStart, dayCount, lineDays, monthGrid, monthShort, monthTitle, pageLine, restoreView, shiftMonth, windowSpan } from '../../../src/ui/tasks/day-strip.ts';

test('the line holds as many days as fit, three to seven, five before it is measured', () => {
  assert.equal(dayCount(0), 5);
  assert.equal(dayCount(NaN), 5);
  assert.equal(dayCount(60), 3);
  assert.equal(dayCount(190), 5); // a 390 px phone: about 190 px between the arrows and the buttons
  assert.equal(dayCount(266), 7);
  assert.equal(dayCount(2000), 7);
});

test('unpaged, the line starts the day before the chosen day, or on its Monday when a week fits', () => {
  assert.equal(autoStart('2026-11-16', 5), '2026-11-15');
  assert.equal(autoStart('2026-11-19', 7), '2026-11-16'); // Thu → Mon
  assert.equal(autoStart('2026-11-22', 7), '2026-11-16'); // Sun belongs to the week before
  assert.deepEqual(lineDays('2026-11-15', 4, null), ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']);
  assert.deepEqual(lineDays('2026-12-01', 3, null), ['2026-11-30', '2026-12-01', '2026-12-02']);
});

test('the arrows page by a whole line and the line stays where they left it', () => {
  const days = lineDays('2026-11-16', 5, null);
  assert.equal(pageLine(days, 1), '2026-11-20');
  assert.equal(pageLine(days, -1), '2026-11-10');
  assert.deepEqual(lineDays('2026-11-16', 5, '2026-11-20'), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
});

test('months step across the year and have their names', () => {
  assert.equal(shiftMonth('2026-11', 1), '2026-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-11', -23), '2024-12');
  assert.equal(monthTitle('2026-11'), 'November 2026');
  assert.equal(monthShort('2027-01'), 'Jan');
});

test('a month is six weeks, Monday first, with the neighbouring months around it', () => {
  const grid = monthGrid('2026-11'); // 1 Nov 2026 is a Sunday
  assert.equal(grid.length, 6);
  assert.ok(grid.every((week) => week.length === 7));
  assert.deepEqual(grid[0][0], { date: '2026-10-26', inMonth: false });
  assert.deepEqual(grid[0][6], { date: '2026-11-01', inMonth: true });
  assert.deepEqual(grid[4][6], { date: '2026-11-29', inMonth: true });
  assert.deepEqual(grid[5][1], { date: '2026-12-01', inMonth: false });
  assert.equal(grid.flat().filter((day) => day.inMonth).length, 30);
  const feb = monthGrid('2027-02'); // 1 Feb 2027 is a Monday
  assert.deepEqual(feb[0][0], { date: '2027-02-01', inMonth: true });
});

test('the window holds the chosen week, the line and, on today, the next two days', () => {
  assert.deepEqual(windowSpan('2026-11-19', '2026-11-19', lineDays('2026-11-19', 5, null)), { first: '2026-11-16', days: 7 });
  assert.deepEqual(windowSpan('2026-11-22', '2026-11-22', lineDays('2026-11-22', 5, null)), { first: '2026-11-16', days: 10 }); // Sun: the line runs to Wed
  assert.deepEqual(windowSpan('2026-11-19', '2026-11-18', ['2026-11-27', '2026-11-28', '2026-11-29']), { first: '2026-11-16', days: 14 });
});

test('the kept view comes back; the chosen day only on the day it was chosen', () => {
  assert.deepEqual(restoreView({ view: 'calendar', date: '2026-11-25', on: '2026-11-23' }, '2026-11-23'), { view: 'calendar', date: '2026-11-25' });
  assert.deepEqual(restoreView({ view: 'list', date: '2026-11-25', on: '2026-11-23' }, '2026-11-24'), { view: 'list', date: null });
  assert.deepEqual(restoreView({ view: 'list', date: 'tomorrow', on: '2026-11-23' }, '2026-11-23'), { view: 'list', date: null });
  assert.equal(restoreView({ view: 'grid' }, '2026-11-23'), null);
  assert.equal(restoreView('calendar', '2026-11-23'), null);
  assert.equal(restoreView(null, '2026-11-23'), null);
});
