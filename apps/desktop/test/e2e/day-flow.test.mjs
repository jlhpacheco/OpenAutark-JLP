// End-to-end (Quests round 20.11.2026: the Tasks page's input line, calendar and right-click): Robin's evening list
// through the line, a time the line gave, a quest, a calendar slot, check-off, "Later" and "Send to team" – over the
// real headless runtime (built app/runtime-cli.mjs) with the deterministic demo engine and real WebSocket RPC.
//   * The line (tasks.quickCreate, the one intake) makes the person's to-do at once – the first line its title, the rest
//     its notes; with a time (the phrase the page used, cut from the title) it stands on the calendar as their row.
//   * A quest the person starts (tasks.create kind 'quest'); a line typed while it is open goes into it.
//   * A click into a free slot with text in the line (quickCreate at/minutes) and an event from a connected calendar's
//     kind (calendar.add 'event') stand side by side; moving the to-do's row (calendar.move) moves its `at`.
//   * Ticking off a timed to-do keeps it on the calendar at the time it was done (the logbook).
//   * "Later" (todos.snooze) moves the to-do's time; "Undo last change" (tasks.undo) takes it back.
//   * "Send to team" (tasks.give to "team") takes a to-do off the person's list; Autark picks its one owner at once.
// Owns: this flow check. Never: touches the person's data (temp profile).
// Run: npm run build && node --test test/e2e/day-flow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const MIN = 60_000;

/** The input line's one intake: the person's to-do. */
const add = async (client, input) => (await client.call('tasks.quickCreate', input)).task;

/** YYYY-MM-DD of `at` in `tz`. */
function localDate(at, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Epoch ms of the wall time `hh:mm` on `date` in `tz` (two passes cover a DST change). */
function wallTime(date, hh, mm, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (at) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((part) => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

test('Tasks page flow: the line, a time, a quest, a slot, check-off, Later and Undo, Send to team', { timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const { tz } = await client.call('calendar.list', { from: Date.now(), to: Date.now() + MIN });
  const tomorrow = localDate(Date.now() + 24 * 60 * MIN, tz);
  const day = { from: wallTime(tomorrow, 0, 0, tz), to: wallTime(tomorrow, 23, 59, tz) };
  let taxes;

  await t.test('the line: the person\'s to-do at once – the first line its title, the rest its notes', async () => {
    taxes = await add(client, { text: 'Steuern erledigen\nBelege vom Oktober zuerst', clientId: 'e2e-tasks-line' });
    assert.deepEqual([taxes.assigneeKind, taxes.kind, taxes.title], ['human', 'todo', 'Steuern erledigen']);
    assert.match(taxes.notes, /Belege vom Oktober zuerst/);
    const again = await add(client, { text: 'Steuern erledigen\nBelege vom Oktober zuerst', clientId: 'e2e-tasks-line' });
    assert.equal(again.id, taxes.id, 'a retried line returns the first to-do');
    assert.ok((await client.call('todos.list', { limit: 200 })).some((todo) => todo.id === taxes.id), 'on the person\'s list');
  });

  let timed;
  await t.test('a time the line gave: one to-do at that time, the person\'s row on the calendar', async () => {
    const at = wallTime(tomorrow, 10, 0, tz);
    timed = await add(client, { text: 'Steuerberater anrufen', at, clientId: 'e2e-tasks-timed' });
    assert.equal(timed.at, at);
    const list = await client.call('calendar.list', day);
    assert.ok(list.events.some((row) => row.kind === 'todo' && row.id === timed.id && row.ownerId === 'human' && row.startAt === at), 'its row');
    assert.ok(list.tasks.some((task) => task.id === timed.id), 'the calendar names the task it shows');
  });

  await t.test('a quest the person starts; a line typed into it goes in', async () => {
    const quest = await client.call('tasks.create', { kind: 'quest', title: 'Steuer 2026 abgeben' });
    assert.equal(quest.kind, 'quest');
    const receipts = await add(client, { text: 'Belege sammeln', quest: quest.id, clientId: 'e2e-tasks-quest' });
    assert.equal(receipts.parentId, quest.id);
    const view = await client.call('tasks.get', { id: quest.id });
    assert.ok(view.steps.some((step) => step.id === receipts.id), 'the quest holds it');
  });

  let slot;
  await t.test('a slot with text in the line and an event stand side by side; moving the row moves the to-do', async () => {
    const at = wallTime(tomorrow, 15, 0, tz);
    slot = await add(client, { text: 'Anna anrufen', at, minutes: 30, clientId: 'e2e-tasks-slot' });
    assert.deepEqual([slot.at, slot.minutes], [at, 30]);
    const event = (await client.call('calendar.add', { text: 'Zahnarzt', startAt: wallTime(tomorrow, 11, 0, tz), endAt: wallTime(tomorrow, 12, 0, tz), kind: 'event' })).event;
    assert.equal(event.kind, 'event');
    const row = (await client.call('calendar.list', day)).events.find((entry) => entry.id === slot.id);
    const moved = await client.call('calendar.move', { id: slot.id, startAt: at + 60 * MIN, endAt: at + 90 * MIN, rev: row.rev });
    assert.equal(moved.startAt, at + 60 * MIN);
    assert.equal((await client.call('tasks.get', { id: slot.id })).at, at + 60 * MIN, 'the to-do\'s `at` moved');
  });

  await t.test('ticking off a timed to-do keeps it at the time it was done (the logbook)', async () => {
    const done = await client.call('tasks.finish', { id: timed.id, clientId: 'e2e-tasks-done' });
    assert.equal(done.status, 'done');
    const today = localDate(done.completedAt, tz);
    const list = await client.call('calendar.list', { from: wallTime(today, 0, 0, tz), to: wallTime(today, 23, 59, tz) });
    const row = list.events.find((entry) => entry.id === timed.id);
    assert.ok(row, 'still on the calendar');
    assert.deepEqual([row.state, row.startAt], ['done', done.completedAt]);
  });

  await t.test('"Later" moves the time; "Undo last change" takes it back', async () => {
    const before = await client.call('tasks.get', { id: slot.id });
    const until = before.at + 24 * 60 * MIN;
    const later = await client.call('todos.snooze', { id: slot.id, until });
    assert.equal(later.at, until);
    const back = await client.call('tasks.undo', { id: slot.id });
    assert.equal(back.at, before.at);
  });

  await t.test('Send to team: the to-do leaves the person\'s list and gets one owner of the team', async () => {
    const sent = await client.call('tasks.give', { id: taxes.id, to: 'team' });
    assert.deepEqual([sent.assigneeKind, sent.assigneeId], ['agent', manager.id], 'handed to the team: its one owner picked now');
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the owner's turn may run meanwhile
    const after = await client.call('todos.list', { limit: 200 });
    assert.ok(!after.some((task) => task.id === taxes.id), 'off the person\'s list');
    assert.equal((await client.call('tasks.get', { id: taxes.id })).assigneeId, manager.id, 'still with that owner');
  });
});
