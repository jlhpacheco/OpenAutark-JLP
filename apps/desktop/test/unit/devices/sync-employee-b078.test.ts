// B-078 employees (devices/sync/rows.ts, employee.ts): a person's status change of their task on their own PC runs the
// task service's path on the company PC (the owner hears "done" like from her phone); her own open to-dos travel to
// the company as tasks assigned to her – also those made before the link (first link-up), "Only me" ones too (it hides nothing) – and
// once there, their later changes follow; rows from the employer go on to her other PCs with their origin, so those
// send her lines straight back to the company. A stale status in her row (an offline edit) or a row that loses moves
// no status; a to-do an agent of her PC made reaches the company too, with her as its maker there.
// Owns: these assertions only. Never: a real mesh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { link, makePc, Net, record, settle } from './sync-net.ts';

const LENA = 'per_lena000001';

function company() {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  return { net, a, e };
}

test('her "done" on her own PC runs the completion on the company PC: status, result and the owner\'s notice', async () => {
  const { a, e } = company();
  const task = a.h.tasks.create({ title: 'Call the client', assigneeKind: 'human', assigneeId: LENA, createdBy: 'human' });
  await settle();
  assert.equal(e.h.tasks.get(task.id)?.status, 'open');
  e.h.tasks.finish(task.id, { status: 'done' as const, ...{ summary: 'Called them', evidence: [], verification: 'reported_by_human' } }, 'human');
  await settle();
  const there = a.h.tasks.get(task.id)!;
  assert.equal(there.status, 'done');
  assert.equal(there.result?.summary, 'Called them');
  assert.equal(there.result?.verification, 'reported_by_human');
  assert.ok(a.h.notified.some((note) => note.kind === 'done' && note.taskId === task.id), 'the owner hears it, as from her phone');
  assert.equal(e.h.tasks.get(task.id)?.status, 'done', 'and it stays done on her PC');
});

test('her own open to-dos reach the company as hers; an "Only me" one too; a done one follows once it went', async () => {
  const { net, a, e } = company();
  const mine = e.h.tasks.create({ title: 'Prepare the slides', assigneeKind: 'human', createdBy: 'human' });
  await settle();
  const there = a.h.tasks.get(mine.id);
  assert.ok(there, 'it went to the company');
  assert.deepEqual([there!.assigneeKind, there!.assigneeId, there!.createdBy], ['human', LENA, LENA]);

  e.h.tasks.finish(mine.id, { status: 'done' as const, ...{ summary: 'Sent', evidence: [], verification: 'reported_by_human' } }, 'human');
  await settle();
  assert.equal(a.h.tasks.get(mine.id)?.status, 'done', 'its change followed');

  net.up = false;
  const before = e.h.tasks.create({ title: 'Book the train', assigneeKind: 'human', createdBy: 'human' });
  const own = e.h.tasks.create({ title: 'Dentist', assigneeKind: 'human', createdBy: 'human', private: true });
  await settle();
  net.up = true;
  assert.ok(await e.sync.catchUp('dev_a', undefined));
  await settle();
  assert.ok(a.h.tasks.get(before.id), 'one made while the company was away goes at the link-up');
  assert.equal(a.h.tasks.get(own.id)?.private, true, 'her "Only me" one goes too, marked "Only me"');
});

test('a PC that held her own life before it joined keeps her own to-dos: only a seat PC sends them', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  const pharmacy = e.h.tasks.create({ title: 'Pick up the prescription', assigneeKind: 'human', createdBy: 'human' });
  e.h.clock.advance(60_000);
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const later = e.h.tasks.create({ title: 'Call the bank', assigneeKind: 'human', createdBy: 'human' });
  await settle();
  assert.ok(await e.sync.catchUp('dev_a', undefined));
  await settle();
  assert.equal(a.h.tasks.get(pharmacy.id), undefined, 'not at the first link-up');
  assert.equal(a.h.tasks.get(later.id), undefined, 'nor one made later');
  const fromThere = a.h.tasks.create({ title: 'Call the client', assigneeKind: 'human', assigneeId: LENA, createdBy: 'human' });
  await settle();
  assert.equal(e.h.tasks.get(fromThere.id)?.status, 'open', 'the tasks of the company still reach her');
});


test('a to-do an agent on her PC made for her reaches the company as hers, with her as its maker there', async () => {
  const { a, e } = company();
  e.h.org.add(agent('ag_helper', 'Helper'));
  const todo = e.h.tasks.create({ title: 'Sign the contract', assigneeKind: 'human', createdBy: 'ag_helper' });
  await settle();
  const there = a.h.tasks.get(todo.id);
  assert.ok(there, 'it went to the company although an agent made it');
  assert.deepEqual([there!.assigneeKind, there!.assigneeId, there!.createdBy], ['human', LENA, LENA], 'the unknown agent stands as Lena here');
});

test('the employer\'s rows go on to her other PC with their origin, and that PC sends her line straight back', async () => {
  const { net, a, e } = company();
  const e2 = makePc(net, 'dev_e2');
  link(e, e2); // her second PC, linked as her own device
  const chat = a.h.chats.create({ agentIds: [], people: [LENA], createdBy: 'human', title: 'With Lena' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Hi Lena' });
  await settle();
  assert.equal(e2.h.chats.get(chat.id)?.title, 'With Lena', 'her other PC has the chat through her first PC');
  assert.ok(net.calls.filter((call) => call.from === 'dev_e' && call.to === 'dev_e2').some((call) => (call.params as { items?: Array<{ origin?: string }> }).items?.some((item) => item.origin === 'dev_a')));

  // The company stores her second PC (device.sibling, roster.ts); her line from there goes straight to it.
  a.repo.upsert(record('dev_e2', { personId: LENA }));
  e2.repo.upsert(record('dev_a', { joinedAs: 'employee' }));
  const line = e2.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'From my laptop' });
  await settle();
  assert.equal(a.h.chats.message(line.id)?.authorId, LENA);
  assert.ok(net.calls.some((call) => call.from === 'dev_e2' && call.to === 'dev_a'), 'sent from her second PC directly');
});
