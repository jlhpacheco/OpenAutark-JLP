// Umzug part 2, 21.11.2026 – "settled" and "busy" (devices/sync/ledger-settled.ts, ops of 'sync.ledger'): the PC an agent
// runs on tells each online PC the agent is at home on – and no other – that its record is complete there, once no run of
// it is open and every row was acknowledged; the moment a run starts it says 'busy', before the run's first row. The
// receiver keeps the last "settled" per PC and agent; 'busy', a newer row and that PC's next link-up clear it, and only the
// agent's own PC is believed. home.ts goesOn takes an agent over only from that state (with sync-takeover.test.ts).
// Owns: these assertions only. Never: real timers, network or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASLEEP_MS, goesOn, settledHere as held, TAKEOVER_MS, watchAwayFrom } from '../../../src/runtime/devices/sync/home.ts';
import { LedgerSync } from '../../../src/runtime/devices/sync/ledger.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { link, Net, settle } from './sync-net.ts';
import { ledgerCalls, ledgerPc, MARA, record, row, type LedgerPc } from './sync-ledger-rig.ts';

/** Mara runs on dev_a and is at home on `homes`, as every PC knows. */
function pcs(homes: string[] | undefined, ids = ['dev_a', 'dev_b']) {
  const net = new Net();
  const all = ids.map((id) => ledgerPc(net, id, 'dev_a'));
  for (const pc of all) pc.h.org.add({ ...pc.h.org.get(MARA)!, ...(homes ? { homes } : {}) });
  for (const [index, pc] of all.entries()) for (const other of all.slice(index + 1)) link(pc, other);
  return { net, all, a: all[0], b: all[1], c: all[2] };
}

/** Whether `pc` holds Mara's settled state as `from` announced it. */
const settledHere = (pc: LedgerPc, from: string, agentId: string) => held(pc.h.services, from, agentId);
/** `ms` pass on `pc` while its runtime stays awake (a tick every 10 s). */
const pass = (pc: LedgerPc, ms: number) => { for (let left = ms; left > 0; left -= 10_000) { pc.h.clock.advance(Math.min(left, 10_000)); pc.ledger.tick(); } };
const said = (net: Net, op: string) => ledgerCalls(net, op).map((call) => `${call.from}>${call.to}`);
const tick = async (pc: LedgerPc) => { pc.ledger.tick(); await settle(); pc.ledger.tick(); await settle(); };
/** A run of Mara on `pc` with that status, announced like the run journal does. */
function run(pc: LedgerPc, id: string, status: string): void {
  pc.h.db.run(`INSERT INTO runs (id, agent_id, trigger, status, started_at, device_id) VALUES (?, ?, 'message', ?, 1, NULL)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status`, [id, MARA, status]);
  pc.h.bus.emit('run.upserted', { id, agentId: MARA, status } as unknown as Run);
}

test('settled: once every row is acknowledged and no run is open, each PC she is at home on holds it – once per head; a newer row clears it until it is acknowledged', async () => {
  const { net, a, b } = pcs(['dev_a', 'dev_b']);
  row(a, 'message', { ref: 'msg:msg_1' });
  a.ledger.tick();
  await settle();
  assert.deepEqual(said(net, 'settled'), [], 'nothing before that PC\'s link-up got to the record');
  assert.equal(settledHere(b, 'dev_a', MARA), false);

  await a.ledger.catchUp('dev_b');
  await tick(a);
  assert.deepEqual(said(net, 'settled'), ['dev_a>dev_b']);
  assert.equal(settledHere(b, 'dev_a', MARA), true);
  await tick(a);
  assert.equal(said(net, 'settled').length, 1, 'said once');

  row(a, 'assistant');
  a.ledger.tick(); // the push; the head is not acknowledged yet
  assert.equal(said(net, 'settled').length, 1);
  await settle();
  assert.equal(record(b).length, 2);
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'the newer row cleared it');
  await tick(a);
  assert.equal(said(net, 'settled').length, 2, 'the new head');
  assert.equal(settledHere(b, 'dev_a', MARA), true);
});

test('busy: the moment a run starts, before its first row; nothing is settled while it is open, and again once it ended and its rows are there', async () => {
  const { net, a, b } = pcs(['dev_b']); // the PC she runs on counts anyway
  const off = a.ledger.attach();
  await a.ledger.catchUp('dev_b');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true);

  run(a, 'run_1', 'running');
  await settle();
  assert.deepEqual(said(net, 'busy'), ['dev_a>dev_b']);
  assert.equal(ledgerCalls(net, 'rows').length, 0, 'before any row');
  assert.equal(settledHere(b, 'dev_a', MARA), false);
  row(a, 'assistant', { runId: 'run_1' });
  await tick(a);
  assert.equal(record(b).length, 1, 'her rows travel while she works');
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'not settled while the run is open');
  assert.equal(said(net, 'busy').length, 1, 'said once');

  run(a, 'run_1', 'done');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true);
  off();
});

test('only the PCs she is at home on hear it; without homes nobody does; only her own PC is believed', async () => {
  const three = pcs(['dev_a', 'dev_c'], ['dev_a', 'dev_b', 'dev_c']);
  const off = three.a.ledger.attach();
  row(three.a, 'message', { ref: 'msg:msg_1' });
  for (const peer of ['dev_b', 'dev_c']) await three.a.ledger.catchUp(peer);
  await tick(three.a);
  run(three.a, 'run_1', 'running');
  await settle();
  assert.deepEqual(said(three.net, 'settled'), ['dev_a>dev_c']);
  assert.deepEqual(said(three.net, 'busy'), ['dev_a>dev_c']);
  assert.equal(record(three.b).length, 1, 'the mirror itself goes to every own PC as before');
  off();

  const none = pcs(undefined);
  const offNone = none.a.ledger.attach();
  await none.a.ledger.catchUp('dev_b');
  await tick(none.a);
  run(none.a, 'run_1', 'running');
  await settle();
  assert.deepEqual([...said(none.net, 'settled'), ...said(none.net, 'busy')], []);
  offNone();

  const { a, b } = pcs(['dev_a', 'dev_b']);
  await b.h.services.devices.call('dev_a', 'sync.ledger', { op: 'settled', agentId: MARA, head: 9 }); // from a mirror to her own PC
  assert.equal(settledHere(a, 'dev_b', MARA), false);
});

test('a link that comes up: what that PC announced before goes, and it says it again', async () => {
  const { net, a, b } = pcs(['dev_a', 'dev_b']);
  await a.ledger.catchUp('dev_b');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true);

  await b.ledger.catchUp('dev_a'); // B saw its link to A come up again (A may not have seen it go)
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'it may be older than A\'s record');
  assert.deepEqual(said(net, 'resettle'), ['dev_a>dev_b', 'dev_b>dev_a']);
  await tick(a);
  assert.equal(said(net, 'settled').length, 2, 'A says it again');
  assert.equal(settledHere(b, 'dev_a', MARA), true);

  b.ledger.dropCursor('dev_a'); // a removed PC
  assert.equal(settledHere(b, 'dev_a', MARA), false);
});

test('goesOn: her PC gone for 2 minutes – this PC goes on with her from a settled record, and waits when the contact broke while she was at work', async () => {
  const { net, a, b } = pcs(['dev_a', 'dev_b']);
  const off = a.ledger.attach();
  watchAwayFrom(b.h.db, b.h.clock.now());
  await a.ledger.catchUp('dev_b');
  await tick(a);
  net.pcs.delete('dev_a');
  assert.deepEqual(goesOn(b.h.services, MARA), { soon: true });
  pass(b, TAKEOVER_MS);
  assert.deepEqual(goesOn(b.h.services, MARA), { to: 'dev_b' });

  net.pcs.set('dev_a', a); // back, and a run starts there
  run(a, 'run_2', 'running');
  await settle();
  net.pcs.delete('dev_a'); // the link breaks mid-turn
  pass(b, TAKEOVER_MS);
  assert.deepEqual(goesOn(b.h.services, MARA), { unsettled: true }, 'she waits for her PC');
  off();
});

test('review H3: a kept "settled" does not outlive the runtime, a sleep, or the link it came on', async () => {
  const { net, a, b } = pcs(['dev_a', 'dev_b']);
  const offs = [a.ledger.attach(), b.ledger.attach()];
  await a.ledger.catchUp('dev_b');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true);

  // The PC slept: its clock jumps between two ticks. Nothing kept before counts – not even before the next tick ran.
  net.pcs.delete('dev_a');
  b.h.clock.advance(ASLEEP_MS + 1_000);
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'the heartbeat is too old');
  watchAwayFrom(b.h.db, 0);
  b.h.clock.advance(TAKEOVER_MS);
  assert.deepEqual(goesOn(b.h.services, MARA), { unsettled: true }, 'she waits for her PC');
  net.pcs.set('dev_a', a);
  b.ledger.tick();
  await settle();
  assert.deepEqual(new KvRepo(b.h.db).list('sync.settled'), [], 'cleared at the first tick after it');
  assert.deepEqual(said(net, 'resettle').slice(-1), ['dev_b>dev_a'], 'and her PC is asked again');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'said again on the living link');

  // The link went and came up again without this PC's link-up reaching the record: what was kept is of the old link.
  const repo = new DevicesRepo(b.h.db);
  b.h.bus.emit('device.upserted', { ...repo.get('dev_a')!, status: 'offline' });
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'the drop itself is what it is kept for');
  b.h.bus.emit('device.upserted', { ...repo.get('dev_a')!, status: 'online' });
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'a new link');

  // A new runtime on the same database (the app started again): nothing is kept.
  new KvRepo(b.h.db).set('sync.settled', `dev_a/${MARA}`, { head: 1, state: 'x', mark: 'old' }, 1);
  new LedgerSync(b.h.services, () => undefined);
  assert.deepEqual(new KvRepo(b.h.db).list('sync.settled'), []);
  for (const off of offs) off();
});

test('review M1: settled names her chats, tasks and files – the other PC goes on only while its own are the same', async () => {
  const { net, a, b } = pcs(['dev_a', 'dev_b']);
  const offs = [a.ledger.attach(), b.ledger.attach()];
  await a.ledger.catchUp('dev_b');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true);
  const before = said(net, 'settled').length;

  // A file of hers that the file sync holds on A and B does not have yet.
  const file = { sha: 'abc', size: 3, mtime: 1, at: 1 };
  new KvRepo(a.h.db).set('sync.files', `agents/${MARA}/memory/plan.md`, file, a.h.clock.now() + 1);
  await tick(a);
  assert.equal(said(net, 'settled').length, before + 1, 'her PC says the new state');
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'the file is still on its way');
  new KvRepo(b.h.db).set('sync.files', `agents/${MARA}/memory/plan.md`, { ...file, mtime: 9 }, 5);
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'it arrived (the same sha)');
  new KvRepo(a.h.db).set('sync.files', 'memory/people/anna.md', file, a.h.clock.now() + 2);
  new KvRepo(a.h.db).set('sync.files', `agents/ag_other/notes.md`, file, a.h.clock.now() + 2);
  new KvRepo(a.h.db).set('sync.files', `agents/${MARA}/old.md`, { ...file, sha: '' }, a.h.clock.now() + 2); // a removal B never knew
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'the memory counts');
  new KvRepo(b.h.db).set('sync.files', 'memory/people/anna.md', file, 6);
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'another agent\'s folder and a removal do not');

  // A chat of hers: a line travels with the rows and both sides agree again; one written here that her PC has not got keeps her waiting.
  const chat = a.h.chats.create({ title: 'Plan', agentIds: [MARA], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, body: 'the brief', authorId: 'human' });
  await settle();
  await tick(a);
  assert.equal(b.h.chats.messages(chat.id).length, 1, 'the line is on B');
  assert.equal(settledHere(b, 'dev_a', MARA), true);
  net.up = false;
  b.h.chats.send({ conversationId: chat.id, body: 'written on B while the link is down', authorId: 'human' });
  await settle();
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'B holds a line her PC never saw');

  // The contact breaks while B lacks nothing: what the person writes on B afterwards is B's own and she still goes on there.
  net.up = true;
  await a.sync.catchUp('dev_b', undefined);
  await b.sync.catchUp('dev_a', undefined);
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'both hold both lines again');
  const gone = { ...new DevicesRepo(b.h.db).get('dev_a')!, status: 'offline' as const };
  net.pcs.delete('dev_a');
  b.h.bus.emit('device.upserted', gone);
  b.h.chats.send({ conversationId: chat.id, body: 'are you there?', authorId: 'human' });
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'compared when the contact broke');
  net.pcs.set('dev_a', a);
  b.h.bus.emit('device.upserted', { ...gone, status: 'online' as const });
  await a.ledger.catchUp('dev_b');
  await b.ledger.catchUp('dev_a');

  // A task of hers: it travels with the rows; one that B holds differently when the contact breaks keeps her waiting.
  net.up = true;
  await a.sync.catchUp('dev_b', undefined);
  await b.sync.catchUp('dev_a', undefined);
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true, 'both hold both lines again');
  const task = a.h.tasks.create({ title: 'Send the plan', assigneeKind: 'agent', assigneeId: MARA, createdBy: 'human' });
  await settle();
  await tick(a);
  assert.ok(b.h.tasks.get(task.id), 'the task is on B');
  assert.equal(settledHere(b, 'dev_a', MARA), true);
  b.h.db.run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [task.id]); // B's copy differs from what her PC named
  assert.equal(settledHere(b, 'dev_a', MARA), false);
  net.pcs.delete('dev_a');
  b.h.bus.emit('device.upserted', gone);
  b.h.db.run(`UPDATE tasks SET status = 'open' WHERE id = ?`, [task.id]);
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'what counts is the moment the contact broke');
  for (const off of offs) off();
});

test('review L1: an older announcement that arrives late is left out', async () => {
  const { a, b } = pcs(['dev_a', 'dev_b']);
  await a.ledger.catchUp('dev_b');
  await tick(a);
  assert.equal(settledHere(b, 'dev_a', MARA), true);
  const kept = new KvRepo(b.h.db).get<{ head: number; state: string }>('sync.settled', `dev_a/${MARA}`)!;
  await b.ledger.receive({ op: 'busy', agentId: MARA, n: 50 }, 'dev_a');
  assert.equal(settledHere(b, 'dev_a', MARA), false);
  await b.ledger.receive({ op: 'settled', agentId: MARA, n: 49, head: kept.head, state: kept.state }, 'dev_a'); // sent before the busy
  assert.equal(settledHere(b, 'dev_a', MARA), false, 'busy stands');
  await b.ledger.receive({ op: 'settled', agentId: MARA, n: 51, head: kept.head, state: kept.state }, 'dev_a');
  assert.equal(settledHere(b, 'dev_a', MARA), true);
});
