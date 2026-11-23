// A person's timer, "Later" and repeating to-dos (F03; Quests round 20.11.2026: the ring is the to-do's own `at`, the
// watcher pushes once when it comes – no schedule row rings): a timer's duration is its to-do's time; "Later" moves the
// time (the to-do stays open, no receipt, nobody woken) and it rings again then; a daily timer's Done posts a receipt and
// moves its time to the next day – its author hears only the first Done – and "Stop repeating" ends it; an older widget's
// {event:'snoozed'} answer moves it too; a timer block posted again with its id moves the time, and "Later" or an answer on
// the newer message reaches the same to-do; an ask block sent in a <chat> block is a to-do ("todo": false is not); a
// To-do-only phone link may use "Later" and stop repeating; a day without a time rings at the start of work, not at
// midnight; Repeat › Daily · Weekdays · Weekly makes a to-do repeat at its time; a timer's wall time (and a block's due
// time) is read in the person's zone.
// Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { countNow, isLater } from '../../../src/shared/model/todo-later.ts';
import { isDayOnly, nextWorkStart } from '../../../src/shared/model/day-settings.ts';
import { addDays, wallOf, wallTime } from '../../../src/shared/text/when.ts';
import { dayZone } from '../../../src/runtime/day/clock.ts';
import { prepareWidget } from '../../../src/runtime/tasks/timers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { canSnooze } from '../../../src/ui/blocks/snooze.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { ChatOutbox } from '../../../src/runtime/agents/chat-out.ts';
import { agent, harness } from '../chat/harness.ts';

const M = 60_000;
const H = 60 * M;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const watcher = h.ownership as unknown as { ring(): number };
  watcher.ring(); // the rings start here
  const timer = (widget: Record<string, unknown>, title = 'Take the bread out') => h.tasks.create({
    conversationId: chat.id, title, assigneeKind: 'human', createdBy: 'ag_ava', widget: { type: 'timer', label: title, ...widget },
  });
  const at = (ms: number) => { h.clock.set(ms); watcher.ring(); };
  /** Pushes for the ring of a to-do (not the 'new to-do' notice). */
  const rings = (title: string) => h.notified.filter((note) => note.kind === 'todo' && note.title === title).length;
  /** B-076: an answer in the chat wakes the author as the person's typed line does ('message'). */
  const answerWakes = () => h.wakes.list('ag_ava').filter((wake) => wake.reason === 'message' || wake.reason === 'answer');
  const receipts = () => h.chats.messages(chat.id).filter((message) => message.kind === 'answer');
  return { ...h, chat, timer, at, answerWakes, receipts, rings };
}

test('a timer\'s duration is its to-do\'s time; it rings once then', () => {
  const h = setup();
  const start = h.clock.now();
  const todo = h.timer({ duration: 'PT5M' });
  assert.equal(todo.at, start + 5 * M);
  h.at(start + 4 * M);
  assert.equal(h.rings('Take the bread out'), 0);
  h.at(start + 5 * M + 1000);
  assert.equal(h.rings('Take the bread out'), 1, 'it rang');
  h.at(start + 6 * M);
  assert.equal(h.rings('Take the bread out'), 1, 'once');
});

test('"Later": the time moves, the to-do stays open – no receipt, nobody woken – and rings again then', () => {
  const h = setup();
  const start = h.clock.now();
  const todo = h.timer({ duration: 'PT5M' });
  h.at(start + 5 * M + 1000);
  const wakes = h.wakes.list('ag_ava').length;
  const later = h.tasks.snooze(todo.id, h.clock.now() + 10 * M);
  assert.deepEqual([later.status, later.at, later.waitingOn], ['open', start + 15 * M + 1000, undefined]);
  assert.equal(h.receipts().length, 0);
  assert.equal(h.wakes.list('ag_ava').length, wakes, 'nobody woken');
  assert.equal(countNow([h.tasks.get(todo.id)!], h.clock.now()), 0, 'not due now while its time is ahead');
  h.at(start + 15 * M + 2000);
  assert.equal(h.rings('Take the bread out'), 2, 'it rings at its new time');
  assert.throws(() => h.tasks.snooze(todo.id, h.clock.now() + 1000), /at least a minute/);
});

test('an older widget\'s snooze answer moves the time instead of finishing', () => {
  const h = setup();
  const todo = h.timer({ duration: 'PT5M' });
  const now = h.clock.now();
  h.tasks.answer({ taskId: todo.id, answer: { event: 'snoozed', minutes: 15 }, by: HUMAN_ID });
  const after = h.tasks.get(todo.id)!;
  assert.deepEqual([after.status, after.at], ['open', now + 15 * M]);
  assert.equal(h.receipts().length, 0);
});

test('a daily timer: Done posts a receipt and moves to the next day, its author hears only the first; Stop repeating ends it', () => {
  const h = setup();
  const nine = new Date(h.clock.now());
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= h.clock.now()) nine.setDate(nine.getDate() + 1);
  const todo = h.timer({ at: nine.toISOString(), repeat: 'daily' }, 'Take the pills');
  assert.equal(todo.at, nine.getTime());
  h.at(nine.getTime() + 1000);
  assert.equal(h.rings('Take the pills'), 1);
  const done = h.tasks.answer({ taskId: todo.id, answer: { done: true }, by: HUMAN_ID })!;
  const tomorrow = new Date(nine);
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.deepEqual([done.status, done.at, done.ledger.doneCount], ['open', tomorrow.getTime(), 1], 'open again at the same time tomorrow');
  assert.equal(isLater(done, h.clock.now()), true, 'tomorrow\'s ring waits under Later');
  assert.equal(h.receipts().length, 1);
  assert.equal(h.answerWakes().length, 1);
  h.at(tomorrow.getTime() + 1000);
  assert.equal(h.rings('Take the pills'), 2, 'it rings again the next day');
  h.tasks.answer({ taskId: todo.id, answer: { done: true }, by: HUMAN_ID });
  assert.equal(h.receipts().length, 2, 'each Done has its receipt');
  assert.equal(h.answerWakes().length, 1, 'the author hears only the first Done');
  const stopped = h.tasks.stopRepeating(todo.id, HUMAN_ID);
  assert.equal(stopped.status, 'done');
  assert.equal((stopped.widget as { repeat?: string }).repeat, undefined);
  assert.throws(() => h.tasks.stopRepeating(h.timer({ duration: 'PT1M' }).id, HUMAN_ID), /does not repeat/);
});

test('a timer block posted again with its id moves the to-do\'s time; "Later" and answers of the newer message reach it', () => {
  const h = setup();
  const start = h.clock.now();
  const post = (at: number) => {
    const body = 'Again:\n```ui\n' + JSON.stringify({ type: 'timer', id: 'tea', label: 'Tea', at: new Date(at).toISOString() }) + '\n```';
    const message = h.chats.send({ conversationId: h.chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
    const blocks = uiBlocksOf(body);
    return { message, todo: h.tasks.ingestBlocks(message, blocks.map((entry) => entry.block), blocks.map((entry) => entry.index))[0] };
  };
  const first = post(start + H);
  const second = post(start + 5 * H);
  assert.equal(second.todo.id, first.todo.id, 'the same to-do');
  assert.equal(h.tasks.get(first.todo.id)?.at, start + 5 * H, 'its time follows the new block');
  const ref = { messageId: second.message.id, blockIndex: 0 };
  assert.equal(h.tasks.snooze(ref, h.clock.now() + 10 * M).id, first.todo.id, '"Later" on the newer block finds the to-do');
  h.tasks.answer({ ...ref, answer: { event: 'done' }, by: HUMAN_ID });
  assert.equal(h.tasks.get(first.todo.id)?.status, 'done', 'answering the newer block finishes the to-do');
  h.tasks.answer({ ...ref, answer: { event: 'done' }, by: HUMAN_ID });
  assert.equal(h.receipts().length, 1, 'answering it again is a double answer: no second receipt');
  assert.equal(h.answerWakes().length, 1, 'and no second wake');
});

test('an ask block an agent posts in a <chat> block is a to-do, so "Later" works on it; "todo": false stays in the chat only', async () => {
  const h = setup();
  const body = '```ui\n{"type":"timer","duration":"PT10M","label":"Bread"}\n```\n```ui\n{"type":"timer","duration":"PT10M","label":"Tea","todo":false}\n```';
  const out = new ChatOutbox(h.services as RuntimeServices, { agentId: 'ag_ava', runId: 'run_send' });
  out.segment(`<chat to="${h.chat.id}">${body}</chat>`, true);
  await out.done();
  const messageId = h.chats.messages(h.chat.id).filter((message) => message.authorId === 'ag_ava').at(-1)!.id;
  const [todo, inline] = uiBlocksOf(body);
  const later = h.tasks.snooze({ messageId, blockIndex: todo.index }, h.clock.now() + 20 * M);
  assert.equal(later.title, 'Bread');
  assert.throws(() => h.tasks.snooze({ messageId, blockIndex: inline.index }, h.clock.now() + 10 * M), /To-do not found/);
  assert.equal(canSnooze(inline.block, { kind: 'block', messageId, blockIndex: inline.index }), false, 'so the chat does not offer it there');
});

test('a To-do-only phone link may move a to-do later and stop repeating', () => {
  const info = sessionInfo(createHandlerTable(), { kind: 'device', deviceId: 'dv_phone', capabilities: ['todo'], secure: false });
  assert.ok(info.allowedMethods.includes('todos.snooze'));
  assert.ok(info.allowedMethods.includes('todos.stopRepeating'));
});

test('the first ring after the update (or on a new PC) is not swallowed: the watcher\'s start marks the rings from then', () => {
  const h = harness();
  const watcher = h.ownership as unknown as { start(): () => void; ring(): number };
  const stop = watcher.start();
  try {
    const start = h.clock.now();
    h.tasks.create({ title: 'Water the plants', assigneeKind: 'human', createdBy: HUMAN_ID, at: start + H });
    h.clock.set(start + H + 1000);
    assert.equal(watcher.ring(), 1, 'the first ring after the start pushes');
    assert.equal(h.notified.filter((note) => note.kind === 'todo' && note.title === 'Due: Water the plants').length, 1);
  } finally { stop(); }
});

test('a day without a time rings once at the start of that working day, not at its midnight', () => {
  const h = setup();
  const zone = dayZone({}); // the harness has no settings: the process zone, as the watcher reads it
  const day = addDays(wallOf(h.clock.now(), zone).date, 2);
  const midnight = wallTime(day, 0, zone);
  const todo = h.tasks.create({ title: 'Call the tax office', assigneeKind: 'human', createdBy: HUMAN_ID, at: midnight });
  assert.equal(isDayOnly(todo, zone), true);
  h.at(midnight + M);
  assert.equal(h.rings('Due: Call the tax office'), 0, 'not at 00:00');
  const start = wallTime(day, 8 * 60, zone); // the default work start
  h.at(start + 1000);
  assert.equal(h.rings('Due: Call the tax office'), 1, 'at the start of work');
  h.at(start + 2 * H);
  assert.equal(h.rings('Due: Call the tax office'), 1, 'once');
});

test('Repeat › Daily · Weekly: a timer that repeats at the to-do\'s time – a day without a time at its work start, none from the next work start', () => {
  const h = setup();
  const zone = dayZone({}); // the harness has no settings: the process zone, as the watcher reads it
  const day = addDays(wallOf(h.clock.now(), zone).date, 1);
  const plants = h.tasks.create({ title: 'Water the plants', assigneeKind: 'human', createdBy: HUMAN_ID, at: wallTime(day, 0, zone) });
  const daily = h.tasks.changeWidget(plants.id, 'timer', 'daily');
  assert.deepEqual([daily.widget?.type, daily.widget?.repeat, daily.at], ['timer', 'daily', wallTime(day, 8 * 60, zone)]);
  const stretch = h.tasks.create({ title: 'Stretch', assigneeKind: 'human', createdBy: HUMAN_ID });
  const weekly = h.tasks.changeWidget(stretch.id, 'timer', 'weekly');
  assert.deepEqual([weekly.widget?.repeat, weekly.at], ['weekly', nextWorkStart(h.clock.now(), zone, '08:00')]);
  assert.throws(() => h.tasks.changeWidget(stretch.id, 'confirm', 'daily'), /Only a timer repeats/);
  assert.equal(h.tasks.changeWidget(stretch.id, 'confirm').widget?.repeat, undefined, 'another widget ends the repeat');
});

test('a timer\'s wall time and a block\'s due time are read in the person\'s zone; a duration counts from the message', () => {
  const from = Date.UTC(2026, 9, 20, 7, 0);
  for (const zone of ['Asia/Tokyo', 'America/New_York']) {
    const armed = prepareWidget({ type: 'timer', label: 'Tea', at: '2026-10-25T09:00' }, from, HUMAN_ID, zone);
    assert.equal(armed.at, wallTime('2026-10-25', 9 * 60, zone), zone);
  }
  assert.equal(prepareWidget({ type: 'timer', label: 'Tea', duration: 'PT10M' }, from, HUMAN_ID, 'Asia/Tokyo').at, from + 10 * M);
  const h = setup();
  (h.services as { settings?: unknown }).settings = { get: () => ({ profile: { timezone: 'Asia/Tokyo' } }) };
  const body = '```ui\n' + JSON.stringify({ type: 'confirm', instructions: 'Sign the lease', important: true, due: '2026-10-25T09:00' }) + '\n```';
  const message = h.chats.send({ conversationId: h.chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
  const blocks = uiBlocksOf(body);
  const [todo] = h.tasks.ingestBlocks(message, blocks.map((entry) => entry.block), blocks.map((entry) => entry.index));
  assert.equal(todo.at, wallTime('2026-10-25', 9 * 60, 'Asia/Tokyo'), 'the due time is 09:00 in Tokyo');
});
