// 17.11.2026 (Konrad #88/#117, "Mein Tag" Paket 2): the change log of a task (ledger.changes, runtime/tasks/changes.ts) and tasks.undo: an agent's close, move
// or hand-over leaves one entry (who, when, before and after of the fields that changed); notes, plan and facts leave none; the person takes the latest back
// within 24 hours – the fields return, the owner reads why and is told it is open again – and an older entry cannot be undone over a later change.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, harness } from '../chat/harness.ts';

const HOUR = 3600_000;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida', { role: 'QA' }));
  h.org.add(agent('ag_jonas', 'Jonas', { role: 'Dev' }));
  const chat = h.chats.create({ agentIds: ['ag_ida'], createdBy: HUMAN_ID });
  const todo = h.tasks.create({ conversationId: chat.id, title: 'Release the memory', assigneeKind: 'human', createdBy: 'ag_ida', at: h.clock.now() + 2 * HOUR, widget: { type: 'confirm', instructions: 'Release' } });
  return { ...h, chat, todo };
}

test('an agent that closes a to-do leaves one entry with the values before and after; a line of notes or facts leaves none', () => {
  const h = setup();
  h.tasks.update(h.todo.id, { notes: 'More detail', fact: 'Looked at it' }, 'ag_ida');
  assert.equal(h.tasks.get(h.todo.id)!.ledger.changes, undefined, 'working text is not logged');
  h.clock.advance(1000);
  h.tasks.finish(h.todo.id, { status: 'done', summary: 'No longer needed' }, 'ag_ida');
  const changes = h.tasks.get(h.todo.id)!.ledger.changes!;
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.by, 'ag_ida');
  assert.equal(changes[0]!.kind, 'finish');
  assert.equal(changes[0]!.before.status, 'open');
  assert.equal(changes[0]!.after.status, 'done');
  assert.ok(changes[0]!.after.completedAt, 'the end time is part of it');
  assert.equal(changes[0]!.before.completedAt, null, 'it had none');
  assert.equal(changes[0]!.after.at, undefined, 'the unchanged time is not in it');
});

test('undo puts a closed to-do back: open, no result, its due time, the owner reads why; a second undo finds nothing', () => {
  const h = setup();
  const due = h.todo.at;
  h.clock.advance(1000);
  h.tasks.finish(h.todo.id, { status: 'dropped', summary: 'Not needed any more' }, 'ag_ida');
  assert.equal(h.tasks.get(h.todo.id)!.status, 'dropped');
  h.clock.advance(60_000);
  const back = h.tasks.undo(h.todo.id, HUMAN_ID);
  assert.equal(back.status, 'open');
  assert.equal(back.result, undefined);
  assert.equal(back.completedAt, undefined);
  assert.equal(back.at, due);
  assert.ok(back.ledger.facts?.some((fact) => /^Undone by .*: it was closed as dropped\.$/.test(fact)), 'a fact says what happened, for whoever works on it next');
  assert.equal(back.ledger.changes![0]!.undone !== undefined, true, 'the entry stays, marked undone');
  assert.throws(() => h.tasks.undo(h.todo.id, HUMAN_ID), /nothing to undo/i);
});

test('a moved time and a hand-over can be undone; an older entry cannot be undone over a later change of the same field', () => {
  const h = setup();
  const first = h.todo.at!;
  h.clock.advance(1000);
  h.tasks.update(h.todo.id, { at: first + HOUR }, 'ag_ida');
  const earlier = h.tasks.get(h.todo.id)!.ledger.changes![0]!.id;
  h.clock.advance(1000);
  h.tasks.update(h.todo.id, { at: first + 3 * HOUR }, 'ag_ida');
  assert.throws(() => h.tasks.undo(h.todo.id, HUMAN_ID, earlier), (error: unknown) => (error as { code?: string }).code === 'conflict', 'the time was changed again afterwards');
  assert.equal(h.tasks.undo(h.todo.id, HUMAN_ID).at, first + HOUR, 'the latest goes first');
  assert.equal(h.tasks.undo(h.todo.id, HUMAN_ID, earlier).at, first, 'then the older one is next');
});

test('the log keeps 10 entries and 24 hours; an entry older than that cannot be undone', () => {
  const h = setup();
  for (let i = 0; i < 14; i++) { h.clock.advance(1000); h.tasks.update(h.todo.id, { priority: i % 2 === 0 ? 1 : 0 }, 'ag_ida'); }
  assert.equal(h.tasks.get(h.todo.id)!.ledger.changes!.length, 10);
  h.clock.advance(25 * HOUR);
  assert.throws(() => h.tasks.undo(h.todo.id, HUMAN_ID), /nothing to undo/i);
  h.clock.advance(1000);
  h.tasks.update(h.todo.id, { priority: 2 }, 'ag_ida');
  assert.equal(h.tasks.get(h.todo.id)!.ledger.changes!.length, 1, 'the old ones went with the next write');
});

test('a task given on can be taken back: the owner is the one before again', async () => {
  const h = setup();
  const mine = h.tasks.create({ conversationId: h.chat.id, title: 'Check the login', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.clock.advance(1000);
  await h.tasks.give(mine.id, 'ag_jonas', 'ag_ida', {});
  assert.equal(h.tasks.get(mine.id)!.assigneeId, 'ag_jonas');
  h.clock.advance(1000);
  assert.equal(h.tasks.undo(mine.id, HUMAN_ID).assigneeId, 'ag_ida');
});
