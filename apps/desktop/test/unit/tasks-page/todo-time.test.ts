// The person's to-dos and time (src/ui/tasks/todo-time.ts; one "when", the to-do's `at`): the "Later" choices (in 10
// minutes, in 1 hour, tomorrow at the start of work – before 04:00 "tomorrow" is the coming morning), the next moment
// the For-you list reads differently by time alone (a time passing, a timer coming within 12 h, midnight), and the
// store's badge (store.forYouCount): what needs the person now, never "Later", following the For-you clock.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { LATER_MS } from '../../../src/shared/model/todo-later.ts';
import { time } from '../../../src/ui/lib/format.ts';
import { forYouCount, todoClock, todos } from '../../../src/ui/lib/store.ts';
import { HOUR_MS, MINUTE_MS, nextListChange, nextMorning, snoozeChoices } from '../../../src/ui/tasks/todo-time.ts';

const NOW = new Date(2026, 9, 20, 16, 55, 0).getTime(); // local time, 16:55
let seq = 0;

function todo(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: `task_${seq}`, kind: 'todo', title: `To-do ${seq}`, notes: '', status: 'open', assigneeKind: 'human', createdBy: 'ag_ava', priority: 0,
    ledger: {}, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW, steps: [], progress: { done: 0, total: 0 }, conversationTitle: '', running: false,
    ...patch,
  };
}

const timer = (at: number) => todo({ widget: { type: 'timer', label: 'Stretch' }, at });

test('"Later": 10 minutes, 1 hour, tomorrow at the start of work – before 04:00 "tomorrow" is the coming morning', () => {
  const choices = snoozeChoices(NOW, '08:30');
  const morning = new Date(2026, 9, 21, 8, 30, 0).getTime();
  assert.deepEqual(choices.map((choice) => choice.until), [NOW + 10 * MINUTE_MS, NOW + HOUR_MS, morning]);
  assert.deepEqual(choices.map((choice) => choice.label), ['In 10 minutes', 'In 1 hour', `Tomorrow ${time(morning)}`]);
  assert.equal(nextMorning(new Date(2026, 9, 21, 0, 40, 0).getTime(), '08:00'), new Date(2026, 9, 21, 8, 0, 0).getTime(), '00:40: the coming morning, same date');
  assert.equal(nextMorning(new Date(2026, 9, 21, 4, 0, 0).getTime(), '08:00'), new Date(2026, 9, 22, 8, 0, 0).getTime(), 'from 04:00 on: the next date');
  assert.equal(nextMorning(NOW, 'later'), new Date(2026, 9, 21, 8, 0, 0).getTime(), 'an unreadable work start: 08:00');
});

test('the list\'s next change: a time passing, a timer coming within 12 h, midnight once any to-do has a time', () => {
  const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
  assert.equal(nextListChange([todo()], NOW), undefined, 'no time: nothing changes by time alone');
  assert.equal(nextListChange([todo({ at: NOW + 10 * MINUTE_MS })], NOW), NOW + 10 * MINUTE_MS);
  assert.equal(nextListChange([todo({ at: NOW - MINUTE_MS })], NOW), midnight, 'a passed one: its words change at midnight');
  const far = timer(NOW + LATER_MS + 2 * HOUR_MS);
  assert.equal(nextListChange([far], NOW), NOW + 2 * HOUR_MS, 'the timer leaves Later');
  assert.equal(nextListChange([todo({ at: NOW + MINUTE_MS, assigneeKind: 'agent' })], NOW), undefined, 'not on the list');
});

test('the badge: what needs the person now – overdue, rung, asked by someone else –, never Later, following the clock', () => {
  const asked = todo();
  const own = todo({ createdBy: 'human' });
  const far = timer(NOW + LATER_MS + HOUR_MS);
  const overdue = todo({ createdBy: 'human', at: NOW - MINUTE_MS });
  const before = { list: todos.value, clock: todoClock.value };
  try {
    todoClock.value = NOW;
    todos.value = [asked, own, far, overdue];
    assert.equal(forYouCount.value, 2, 'the asked one and the overdue one');
    todoClock.value = far.at! + 1;
    assert.equal(forYouCount.value, 3, 'the timer rang');
  } finally {
    todos.value = before.list;
    todoClock.value = before.clock;
  }
});
