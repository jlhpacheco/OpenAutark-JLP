// 0.3.20, no main PC (24.11.2026): the person's schedules and rings fire on the CEO PC with the smallest id among those
// that are not gone (home.ts firesHere – out of reach for TAKEOVER_MS) instead of on the smallest PC whatever it does, so
// nothing is lost while that one is off. And nothing fires twice when it comes back: a posted message of the schedule
// (meta.scheduleId/plannedAt) and a rung to-do (ledger.ringedAt) are the stamps in the synced rows.
// Owns: these assertions only. Never: real timers, network or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { TAKEOVER_MS, watchAwayFrom } from '../../../src/runtime/devices/sync/home.ts';
import { placeSchedules } from '../../../src/runtime/devices/sync/tables.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const HOUR = 3_600_000;
const due = (pc: Pc, id: string) => pc.h.db.get<{ next_at: number | null }>('SELECT next_at FROM schedules WHERE id = ?', [id])?.next_at ?? null;

/** dev_a (the smaller id) and dev_b, linked, both watching their links; `leave` takes dev_a out of reach, `back` brings it again. */
function twoPcs() {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) watchAwayFrom(pc.h.db, pc.h.clock.now());
  const leave = () => { net.pcs.delete('dev_a'); b.repo.patch('dev_a', { status: 'offline', lastSeenAt: b.h.clock.now() }); };
  const back = () => { net.pcs.set('dev_a', a); b.repo.patch('dev_a', { status: 'online', lastSeenAt: b.h.clock.now() }); };
  return { net, a, b, leave, back };
}

test('the person\'s schedule moves to the next PC once the smallest is gone for 2 minutes, and back when it returns', async () => {
  const { a, b, leave, back } = twoPcs();
  const tea = a.h.scheduler.create({ ownerId: HUMAN_ID, kind: 'message', conversationId: 'ch_tea', title: 'Tea', spec: { everyMs: HOUR }, payload: { body: 'Tea' } });
  await settle();
  assert.deepEqual([due(a, tea.id) !== null, due(b, tea.id) !== null], [true, false], 'dev_a is there: it fires on dev_a');

  leave();
  b.h.clock.advance(TAKEOVER_MS - 1_000);
  placeSchedules(b.h.services);
  assert.equal(due(b, tea.id), null, 'under 2 minutes: dev_b waits for it');
  b.h.clock.advance(1_000);
  placeSchedules(b.h.services);
  assert.notEqual(due(b, tea.id), null, 'dev_a is gone: dev_b fires the person\'s schedule');

  back();
  placeSchedules(b.h.services); // a link that comes up places them again (service.ts)
  assert.equal(due(b, tea.id), null, 'dev_a is back: it fires there again, no main PC stays on dev_b');
});

test('the smaller PC comes back after the other fired: the post is not sent twice and its old due time only moves on', async () => {
  const { a, b, leave, back } = twoPcs();
  const chat = a.h.chats.create({ agentIds: [], createdBy: HUMAN_ID });
  const tea = a.h.scheduler.create({ ownerId: HUMAN_ID, kind: 'message', conversationId: chat.id, title: 'Tea', spec: { everyMs: HOUR }, payload: { body: 'Tea' } });
  await settle();
  const posts = (pc: Pc) => pc.h.chats.messages(chat.id).filter((message) => message.meta?.via === 'schedule');
  assert.equal(due(b, tea.id), null);

  leave(); // dev_a is off from now on – its due time (in 1 h) stays in its row
  b.h.clock.advance(TAKEOVER_MS);
  placeSchedules(b.h.services);
  b.h.clock.advance(HOUR);
  b.h.scheduler.tick();
  assert.equal(posts(b).length, 1, 'dev_b fired it while dev_a was away');

  back();
  a.h.clock.advance(HOUR + TAKEOVER_MS + HOUR); // dev_a starts again: its own due time is long over
  assert.ok(await a.sync.catchUp('dev_b', undefined), 'the rows of dev_b reach dev_a');
  await settle();
  assert.equal(posts(a).length, 1, 'the post came along');
  a.h.scheduler.tick();
  assert.equal(posts(a).length, 1, 'dev_a sees the stamp (plannedAt) and does not fire the missed hour again');
  assert.ok((due(a, tea.id) ?? 0) > a.h.clock.now(), 'its due time moved on to the next hour');
  placeSchedules(b.h.services);
  assert.equal(due(b, tea.id), null, 'and dev_b stops firing it');
});

test('the person\'s to-do rings on the next PC while the smallest is gone; the PC that comes back does not ring it again', async () => {
  const { a, b, leave, back } = twoPcs();
  const ringOf = (pc: Pc) => (pc.h.ownership as unknown as { ring(): number }).ring();
  const todo = a.h.tasks.create({ title: 'Zahnarzt anrufen', assigneeKind: 'human', createdBy: HUMAN_ID, at: a.h.clock.now() + HOUR });
  await settle();
  assert.equal(ringOf(a), 0, 'the first pass only marks where the rings start');
  assert.equal(ringOf(b), 0);

  leave();
  for (const pc of [a, b]) pc.h.clock.advance(HOUR + 1_000);
  assert.equal(ringOf(b), 1, 'dev_a is gone: dev_b rings');
  assert.deepEqual(b.h.notified.map((note) => [note.kind, note.taskId]), [['todo', todo.id]]);
  assert.ok((b.h.tasks.get(todo.id)?.ledger.ringedAt ?? 0) > 0, 'it stamps the row');

  back();
  assert.ok(await a.sync.catchUp('dev_b', undefined), 'the row of dev_b reaches dev_a with its stamp');
  await settle();
  assert.equal(ringOf(a), 0, 'dev_a had not rung it: the stamp says dev_b did');
  assert.equal(a.h.notified.length, 0);
});

test('while the smaller PC is there (or no watch runs), only it fires: the old rule stands', async () => {
  const { a, b } = twoPcs();
  const ringOf = (pc: Pc) => (pc.h.ownership as unknown as { ring(): number }).ring();
  a.h.tasks.create({ title: 'Brot kaufen', assigneeKind: 'human', createdBy: HUMAN_ID, at: a.h.clock.now() + HOUR });
  await settle();
  ringOf(a); ringOf(b);
  for (const pc of [a, b]) pc.h.clock.advance(HOUR + 1_000);
  assert.equal(ringOf(b), 0, 'dev_a is online: dev_b does not ring');
  assert.equal(ringOf(a), 1);
});
