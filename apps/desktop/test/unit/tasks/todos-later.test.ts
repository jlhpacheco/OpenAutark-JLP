// The For-you query (F04, tasks/repo.ts todos via TaskService.todos – what todos.list returns):
// the person's unfinished to-dos (Quests round: "Later" and a repeating timer move the to-do's `at`, it stays open),
// finished to-dos and agent work are not listed; by time – a small limit keeps what is due now; the shared rule
// (shared/model/todo-later.ts, for the badge and the wf CLI) counts only what is due now (a to-do on a later day waits
// under Later).
// Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { countNow, isLater } from '../../../src/shared/model/todo-later.ts';
import { agent, harness } from '../chat/harness.ts';

const M = 60_000;
const H = 60 * M;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const todo = (title: string, extra: Record<string, unknown> = {}) => h.tasks.create({
    conversationId: chat.id, title, assigneeKind: 'human', createdBy: 'ag_ava', ...extra,
  });
  const listed = (limit?: number) => h.tasks.todos(limit).map((task) => task.title);
  return { ...h, chat, todo, listed };
}

test('a to-do moved later stays on the list, open, after the ones with an earlier time', () => {
  const h = setup();
  const bread = h.todo('Take the bread out', { widget: { type: 'timer', label: 'Bread', duration: 'PT5M' } });
  h.todo('Sign the form', { at: h.clock.now() + 2 * M });
  const later = h.tasks.snooze(bread.id, h.clock.now() + 10 * M);
  assert.equal(later.status, 'open');
  assert.deepEqual(h.tasks.todos().map((task) => task.title), ['Sign the form', 'Take the bread out'], 'by time');
});

test('a repeating timer ticked off stays listed, open, at its next time', () => {
  const h = setup();
  const nine = new Date(h.clock.now());
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= h.clock.now()) nine.setDate(nine.getDate() + 1);
  const pills = h.todo('Take the pills', { widget: { type: 'timer', label: 'Pills', at: nine.toISOString(), repeat: 'daily' } });
  h.clock.set(nine.getTime() + 1000);
  h.tasks.answer({ taskId: pills.id, answer: { event: 'done' }, by: HUMAN_ID });
  const entry = h.tasks.todos().find((task) => task.id === pills.id);
  assert.equal(entry?.status, 'open');
  assert.equal(entry?.at, nine.getTime() + 24 * H);
});



test('the shared rule over todos.list counts only what is due now – a far timer waits under Later, one moved a little later waits to ring', () => {
  const h = setup();
  const now = h.clock.now();
  const bread = h.todo('Take the bread out', { widget: { type: 'timer', label: 'Bread', duration: 'PT5M' } });
  h.tasks.snooze(bread.id, now + 10 * M);
  h.todo('Dentist', { widget: { type: 'timer', label: 'Dentist', at: new Date(now + 3 * 24 * H).toISOString() } });
  h.todo('Sign the form');
  const list = h.tasks.todos();
  assert.equal(list.length, 3, 'todos.list keeps the Later ones');
  assert.equal(countNow(list, now), 1, 'the count a phone tab shows');
  assert.deepEqual(list.filter((task) => isLater(task, now)).map((task) => task.title).sort(), ['Dentist']);
  assert.equal(countNow(list, now + 3 * 24 * H - 12 * H + 1), 2, 'the bread rang and needs the person; the dentist within 12 h waits until it rings');
});

test('B-041: a to-do due on a later day stays listed and waits under Later – the count leaves it out until its day', () => {
  const h = setup();
  const now = h.clock.now();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  h.todo('File the taxes', { at: midnight.getTime() + 9 * H });
  h.todo('Sign the form');
  const list = h.tasks.todos();
  assert.equal(list.length, 2, 'todos.list keeps it');
  assert.equal(countNow(list, now), 1);
  assert.deepEqual(list.filter((task) => isLater(task, now)).map((task) => task.title), ['File the taxes']);
  assert.equal(countNow(list, midnight.getTime()), 2, 'it counts from its day on');
});
