// The Tasks page's words about time (src/ui/tasks/when-text.ts): a to-do's "when" on its row ("since Wed" when it is
// overdue, "Today 15:00–18:00", "Tomorrow 18:00", a day without a time just "Tomorrow"), "done 09:05", the page's
// title, date steps and dictated words after typed text, a found phrase's chip – all in the person's zone; an agent's
// to-do never shows a time.
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWord, doneText, headTitle, joinSaid, minutesText, momentText, noteWhenText, phraseText, shiftDate, weekdayOf, whenOf } from '../../../src/ui/tasks/when-text.ts';
import { isDayOnly } from '../../../src/shared/model/day-settings.ts';

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const MIDNIGHT = Date.UTC(2026, 10, 19, 23); // Fri 20 Nov 2026 00:00 in Berlin (+1)
const NOW = MIDNIGHT + 9 * H + 40 * 60_000; // Fri 09:40

test('a to-do\'s time: today and tomorrow with the clock, its end from 30 minutes on, a later day by weekday or date', () => {
  assert.deepEqual(whenOf({ at: MIDNIGHT + 15 * H, minutes: 180 }, NOW, TZ), { text: 'Today 15:00–18:00', late: false });
  assert.deepEqual(whenOf({ at: MIDNIGHT + 15 * H, minutes: 20 }, NOW, TZ), { text: 'Today 15:00', late: false }, 'a short one: no end');
  assert.deepEqual(whenOf({ at: MIDNIGHT + 42 * H }, NOW, TZ), { text: 'Tomorrow 18:00', late: false });
  assert.equal(whenOf({ at: MIDNIGHT + 4 * 24 * H + 11 * H, minutes: 30 }, NOW, TZ)?.text, 'Tue 11:00–11:30');
  assert.equal(whenOf({ at: Date.UTC(2027, 0, 11, 8) }, NOW, TZ)?.text, 'Mon 11 Jan 09:00');
  assert.equal(whenOf({}, NOW, TZ), undefined, 'no time: no words');
});

test('a coming note ("At work · next: …"): its clock today, its day with the clock later (real run 20.11.: "at 17:00" for Fri 27 Nov)', () => {
  assert.equal(noteWhenText(MIDNIGHT + 17 * H, NOW, TZ), '17:00');
  assert.equal(noteWhenText(MIDNIGHT + 32 * H, NOW, TZ), 'Tomorrow 08:00');
  assert.equal(noteWhenText(MIDNIGHT + 4 * 24 * H + 11 * H, NOW, TZ), 'Tue 11:00');
  assert.equal(noteWhenText(MIDNIGHT + 7 * 24 * H + 17 * H, NOW, TZ), 'Fri 27 Nov 17:00');
});

test('a day without a time (at its local midnight, no length) is the day alone; it is late only from the next day on', () => {
  assert.equal(isDayOnly({ at: MIDNIGHT + 24 * H }, TZ), true);
  assert.equal(isDayOnly({ at: MIDNIGHT + 24 * H, minutes: 30 }, TZ), false, 'a length: a time at 00:00');
  assert.deepEqual(whenOf({ at: MIDNIGHT + 24 * H }, NOW, TZ), { text: 'Tomorrow', late: false });
  assert.deepEqual(whenOf({ at: MIDNIGHT }, NOW, TZ), { text: 'Today', late: false }, 'today is not late before it ends');
  assert.deepEqual(whenOf({ at: MIDNIGHT - 24 * H }, NOW, TZ), { text: 'since yesterday', late: true });
});

test('overdue: since a clock time today, since yesterday, since a weekday, since a date; a finished one is never late', () => {
  assert.deepEqual(whenOf({ at: MIDNIGHT + 9 * H }, NOW, TZ), { text: 'since 09:00', late: true });
  assert.deepEqual(whenOf({ at: MIDNIGHT - 7 * H }, NOW, TZ), { text: 'since yesterday', late: true });
  assert.deepEqual(whenOf({ at: MIDNIGHT - 2 * 24 * H + 17 * H }, NOW, TZ), { text: 'since Wed', late: true });
  assert.deepEqual(whenOf({ at: MIDNIGHT - 20 * 24 * H }, NOW, TZ), { text: 'since 31 Oct', late: true });
  assert.equal(whenOf({ at: MIDNIGHT + 9 * H, status: 'done' }, NOW, TZ)?.late, false);
});

test('done times, day words, the page title, steps over months, lengths and dictated words', () => {
  assert.equal(doneText(MIDNIGHT + 9 * H + 5 * 60_000, NOW, TZ), 'done 09:05');
  assert.equal(doneText(MIDNIGHT - 4 * 24 * H + 21 * H + 23 * 60_000, NOW, TZ), 'done Mon 21:23');
  assert.equal(doneText(MIDNIGHT - 30 * 24 * H, NOW, TZ), 'done 21 Oct');
  assert.equal(momentText(MIDNIGHT + 8 * H, NOW, TZ), '08:00', 'when a task was started: today its clock');
  assert.equal(momentText(MIDNIGHT - 10 * H, NOW, TZ), 'Thu 14:00');
  assert.equal(dayWord('2026-11-20', '2026-11-20'), 'Today');
  assert.equal(dayWord('2026-11-19', '2026-11-20'), 'Yesterday');
  assert.equal(dayWord('2026-11-23', '2026-11-20'), 'Mon');
  assert.equal(dayWord('2026-11-30', '2026-11-20'), 'Mon 30 Nov');
  assert.equal(headTitle('2026-11-20'), 'Friday, November 20');
  assert.equal(shiftDate('2026-11-30', 1), '2026-12-01');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(weekdayOf('2026-11-20'), 5);
  assert.equal(minutesText(95), '1 h 35 min');
  assert.equal(minutesText(30), '30 min');
  assert.equal(joinSaid('Call Anna ', ' about the offer'), 'Call Anna about the offer');
  assert.equal(joinSaid('', 'said'), 'said');
});

test('agent work shows no time (it starts now); a found phrase is said as its chip says it', () => {
  assert.equal(whenOf({ at: MIDNIGHT + 15 * H, minutes: 60, assigneeKind: 'agent' }, NOW, TZ), undefined, 'an agent\'s invented date is never shown');
  assert.equal(whenOf({ at: MIDNIGHT + 15 * H, minutes: 60, assigneeKind: 'human' }, NOW, TZ)?.text, 'Today 15:00–16:00');
  assert.equal(phraseText({ at: MIDNIGHT + 34 * H, text: 'morgen um 10' }, NOW, TZ), 'Tomorrow 10:00');
  assert.equal(phraseText({ at: MIDNIGHT + 24 * H, text: 'morgen' }, NOW, TZ), 'Tomorrow', 'a day alone');
});
