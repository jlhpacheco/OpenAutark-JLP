// Umzug 21.11.2026 – an agent moves to another of the person's PCs (agents/move.ts, dispatcher.leave, agents.update
// device): the own turn ends at its next tool boundary with a continue-wake and its wakes wait in the queue; agents.update
// moves an agent with its record – refused while the PC is out of reach, the result says what happens –, the PC it leaves
// sends the record first and only then the wakes, the PC it reaches drops its stale native sessions and the agent reads
// one line about it; noteMove keeps one move line among the other notes; the environment line names it. Round 2: the new
// PC asks the old one for the hand-over (agents.handover) and starts no turn until it answers – only after its turn ended
// and its record is on the new PC –, goes on when the link drops, asks nothing of an offline PC; the app's "Works on"
// refuses an unreachable PC with the tool's reason.
// Owns: these assertions only. Never: real engines, network or timers of the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { flush, setup } from '../dispatcher/fakes.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { CUT_NOTE, HANDOVER_METHOD, isArriving, isLeaving, noteMove, startMoves } from '../../../src/runtime/agents/move.ts';
import { updateAgent } from '../../../src/runtime/rpc/handlers/org.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import { MemoryLogger } from '../fakes.ts';
import { saveRepairNotes, takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { homeElsewhere } from '../../../src/runtime/devices/sync/home.ts';
import { agentTools, OWN_MOVE_IN_PART } from '../../../src/runtime/tools/builtin/agents.ts';
import { companiesLine } from '../../../src/runtime/context/environment.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { link, Net, settle } from '../devices/sync-net.ts';
import { ShareSync } from '../../../src/runtime/devices/sync/share.ts';
import { homeOf, ledgerPc, MARA, record, row, type LedgerPc } from '../devices/sync-ledger-rig.ts';

const pc = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

/** Tom works in a chat on this PC (the dispatcher's rig); his row then says Tower. */
async function working() {
  const h = setup();
  const repo = new DevicesRepo(h.db);
  repo.upsert(pc('dev_here', { self: true }));
  repo.upsert(pc('dev_tower'));
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'Render the intro on the Tower.', authorId: 'human' });
  await flush();
  const first = h.executor.last();
  h.org.add({ ...h.org.require('ag_tom'), deviceId: 'dev_tower' });
  return { h, chat, first };
}

test('leave: a move stops the work at once like the Stop – a long call in flight is cut, and it is over fast', async () => {
  const { h, first } = await working();
  h.dispatcher.setCall({ agentId: 'ag_tom', runId: first.request.runId, callId: 'call_render' }, true); // a 4-minute render
  const left = h.dispatcher.leave('ag_tom', CUT_NOTE);
  assert.equal(first.request.signal.aborted, true, 'the call in flight is cut through its signal');
  assert.equal(await left, true, 'over without waiting for the call');
  assert.equal(first.request.control.stopKind, 'urgent', 'its wakes are kept, the task is not paused');
});

test('leave: the own agents.update call is not cut – the turn ends right after it, with a continue-wake; its wakes wait', async () => {
  const { h, chat, first } = await working();
  const ctx = { agentId: 'ag_tom', runId: first.request.runId, callId: 'call_move' };
  h.dispatcher.setCall(ctx, true); // agents.update itself is in flight
  const left = h.dispatcher.leave('ag_tom', CUT_NOTE, first.request.runId);
  await flush();
  assert.equal(first.request.signal.aborted, false, 'never inside its own call');
  h.dispatcher.setCall(ctx, false); // the call returned: its result is kept, then the cut
  assert.equal(await left, true);
  assert.equal(first.request.control.stopKind, 'urgent');
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no turn of Tom here any more');
  const waiting = h.wakeRows().filter((wake) => wake.agent_id === 'ag_tom');
  assert.ok(waiting.length >= 1, 'the wakes wait, unclaimed, for the hand-over');
  assert.ok(waiting.some((wake) => wake.note?.includes(CUT_NOTE) && wake.conversation_id === chat.id), 'a continue-wake in that chat carries the note');
  assert.equal(await h.dispatcher.leave('ag_tom', CUT_NOTE), false, 'nothing runs: nothing to end');
});

test('noteMove: the newest line of each kind among the other notes – a newer one of the same kind replaces the older', () => {
  const h = harness();
  saveRepairNotes(h.services, 'ag_tom', 'main', ['A block was not posted.']);
  noteMove(h.services, 'ag_tom', 'Since 09:00 I run on Tower, moved from Laptop.', 'arrival');
  noteMove(h.services, 'ag_tom', 'Since 09:05 I run on Tower, moved from Attic.', 'arrival');
  noteMove(h.services, 'ag_tom', 'Laptop is reachable again; I stay on Tower.', 'back');
  noteMove(h.services, 'ag_tom', 'While Laptop could not reach Tower I also worked on Laptop: 3 items.'); // the record sync's line (kind branch)
  assert.deepEqual(takeRepairNotes(h.services, 'ag_tom', 'main'), [
    'A block was not posted.', 'Since 09:05 I run on Tower, moved from Attic.', 'Laptop is reachable again; I stay on Tower.',
    'While Laptop could not reach Tower I also worked on Laptop: 3 items.',
  ], 'the newest of each kind; different kinds stand together');
});

/** Two PCs with the record sync (LEDGER's rig): Mara runs on A; an org fake that saves and announces an edit. */
function pair() {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  for (const pc of [a, b]) {
    Object.assign(pc.h.org, {
      update: (id: string, patch: Partial<Agent>) => {
        const next = { ...pc.h.org.require(id), ...patch };
        pc.h.org.add(next);
        pc.h.bus.emit('agent.upserted', next);
        return next;
      },
    });
  }
  return { net, a, b };
}

const toolCtx = (pc: LedgerPc): ToolContext => ({
  agent: pc.h.org.require(MARA), services: pc.h.services, runId: 'run_move', mode: 'general', signal: new AbortController().signal, status: () => {},
} as unknown as ToolContext);

/** The fake mesh's register: a peer method on that PC's handlers. */
const meshOf = (pc: LedgerPc) => ({ register: (method: string, handler: PeerHandler) => { pc.handlers.set(method, (params, from) => handler(params, from, new AbortController().signal)); } });

test('the app\'s "Works on": the same refusal for one of my PCs that cannot be reached', () => {
  const { net, a, b } = pair();
  net.pcs.delete('dev_b');
  const ctx = { services: a.h.services } as unknown as HandlerContext;
  assert.throws(() => updateAgent({ id: MARA, patch: { deviceId: 'dev_b' } }, ctx, 'human'), (error: Error & { code?: string }) =>
    error.code === 'unavailable' && error.message === 'dev_b cannot be reached right now, so the record cannot go there – nothing changed.');
  assert.equal(a.h.org.require(MARA).deviceId, 'dev_a', 'nothing changed');
  net.pcs.set('dev_b', b); // reachable again
  assert.equal(updateAgent({ id: MARA, patch: { deviceId: 'dev_b' } }, ctx, 'human').deviceId, 'dev_b');
});

/** The dispatcher's rig with Tom on dev_a (one of my PCs) and a devices fake whose hand-over answer the test gives. */
function arrival(online: boolean) {
  const h = setup();
  const repo = new DevicesRepo(h.db);
  repo.upsert(pc('dev_here', { self: true }));
  repo.upsert(pc('dev_a'));
  const log = new MemoryLogger();
  h.services.log = log;
  const calls: Array<{ to: string; method: string; params: unknown }> = [];
  let answer!: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  h.services.devices = {
    self: () => repo.self()!, list: () => repo.list(), online: (id: string) => online && id === 'dev_a',
    call: (to: string, method: string, params: unknown) => { calls.push({ to, method, params }); return new Promise((resolve, reject) => { answer = { resolve, reject }; }); },
  } as unknown as RuntimeServices['devices'];
  h.org.add(agent('ag_tom', 'Tom', { deviceId: 'dev_a' }));
  const off = startMoves(h.services);
  h.dispatcher.start();
  const arrive = () => { h.bus.emit('agent.upserted', h.org.add({ ...h.org.require('ag_tom'), deviceId: undefined })); };
  return { h, log, calls, answer: () => answer, arrive, off };
}

test('arrival: the first turn waits for the answer of the PC it came from, then runs; a dropped link goes on anyway', async () => {
  const { h, calls, answer, arrive, off } = arrival(true);
  arrive();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'manual', note: 'go on' });
  await flush();
  assert.deepEqual(calls, [{ to: 'dev_a', method: HANDOVER_METHOD, params: { agentId: 'ag_tom' } }]);
  assert.equal(isArriving(h.services, 'ag_tom'), true);
  assert.equal(h.executor.calls.length, 0, 'no turn on a part of the record');
  answer().resolve({ ok: true });
  await flush();
  assert.equal(isArriving(h.services, 'ag_tom'), false);
  assert.equal(h.executor.calls.length, 1, 'then its turn runs here');
  off();

  const dropped = arrival(true);
  dropped.arrive();
  dropped.h.wakes.wake({ agentId: 'ag_tom', reason: 'manual' });
  await flush();
  assert.equal(dropped.h.executor.calls.length, 0);
  dropped.answer().reject(new Error('the link closed'));
  await flush();
  assert.equal(dropped.h.executor.calls.length, 1, 'it goes on with what is here');
  assert.ok(dropped.log.entries.some((entry) => entry.message === 'hand-over not answered, going on with the record here'));
  dropped.off();
});

test('arrival from a PC that is offline (the takeover): no request, the turn runs at once', async () => {
  const { h, calls, arrive, off } = arrival(false);
  arrive();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'manual' });
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(h.executor.calls.length, 1);
  off();
});

test('agents.update device: refused while that PC is out of reach – nothing changes', async () => {
  const { net, a } = pair();
  net.pcs.delete('dev_b');
  const update = agentTools.find((tool) => tool.name === 'agents.update')!;
  const out = await update.run({ device: 'dev_b' }, toolCtx(a));
  assert.equal(out.isError, true);
  assert.match(String((out.content[0] as { text: string }).text), /^dev_b cannot be reached right now, so the record cannot go there – nothing changed\.$/);
  assert.equal(a.h.org.require(MARA).deviceId, 'dev_a');
});

test('a move by the tool: the turn ends, the record goes first, then the wakes with the continue-wake; the new PC starts fresh with one line', async () => {
  const { net, a, b } = pair();
  const offs = [startMoves(a.h.services, { mesh: meshOf(a) }), startMoves(b.h.services, { mesh: meshOf(b) })];
  const atAnswer: number[] = [];
  const serve = a.handlers.get(HANDOVER_METHOD)!;
  a.handlers.set(HANDOVER_METHOD, async (params, from) => { const out = await serve(params, from); atAnswer.push(record(b).length); return out; });
  row(a, 'message', { title: 'the brief' });
  // Part 2: what else her home PCs keep the same goes at the leave (devices/sync/share.ts shareNow) – after the record, before the wakes.
  const share = new ShareSync(a.h.services);
  const shared: string[] = [];
  const at = (what: string) => async (agentId: string) => { shared.push(`${what} ${agentId}: ${record(b).length} row on B, ${b.h.wakes.pending(MARA)} wakes on B`); };
  (share.browser as { now: unknown }).now = at('browser');
  (share.project as { flush: unknown }).flush = at('project');
  let cut!: () => void;
  const notes: string[] = [];
  a.h.services.dispatcher = {
    ...a.h.services.dispatcher,
    leave: (agentId: string, note: string, ownRun?: string) => new Promise<boolean>((resolve) => {
      notes.push(note, String(ownRun));
      cut = () => { a.h.wakes.wake({ agentId, reason: 'message', conversationId: 'ch_intro', note }); resolve(true); }; // as the dispatcher does at the boundary
    }),
  } as RuntimeServices['dispatcher'];
  b.h.db.run(`INSERT INTO engine_sessions (agent_id, conversation_id, engine, session_ref, updated_at) VALUES (?, 'main', 'codex', 'thread_old', 1)`, [MARA]);

  const update = agentTools.find((tool) => tool.name === 'agents.update')!;
  const out = await update.run({ device: 'dev_b' }, toolCtx(a));
  assert.equal((out.structured as { moved?: string }).moved, 'I move to dev_b; this turn ends here, my next turn runs there with my record.');
  assert.equal(homeElsewhere(a.h.services, MARA), 'dev_b');
  assert.deepEqual(notes, [CUT_NOTE, 'run_move'], 'the own turn is told to end, right after its own call');
  assert.equal(isLeaving(a.h.services, MARA), true);

  homeOf(b, 'dev_b'); // the agents row reached B
  b.h.bus.emit('agent.upserted', b.h.org.require(MARA));
  assert.equal(b.h.db.get('SELECT 1 AS hit FROM engine_sessions WHERE agent_id = ?', [MARA]), undefined, 'B\'s stale session went');
  assert.match(takeRepairNotes(b.h.services, MARA, 'main').join('\n'), /I run on dev_b, moved from dev_a; my record came with me\./);
  assert.equal(isArriving(b.h.services, MARA), true, 'B waits for A\'s hand-over');
  assert.deepEqual(net.calls.filter((call) => call.method === HANDOVER_METHOD).map((call) => [call.from, call.to, call.params]), [['dev_b', 'dev_a', { agentId: MARA }]]);

  a.h.wakes.wake({ agentId: MARA, reason: 'manual', note: 'while the turn still ends' });
  await settle();
  assert.equal(b.h.wakes.pending(MARA), 0, 'nothing goes before the record');
  assert.equal(record(b).length, 0);
  assert.deepEqual(atAnswer, [], 'A has not answered: its turn has not ended');

  saveRepairNotes(a.h.services, MARA, 'main', ['The file intro.mp4 is in my outputs.']); // what the ending turn left for my next one
  cut();
  await settle();
  await settle();
  assert.deepEqual(record(b).map((item) => [item.title, item.pc]), [['the brief', 'dev_a']], 'the record went first');
  assert.deepEqual(atAnswer, [1], 'A answered once its record was on B');
  assert.deepEqual(shared, [`browser ${MARA}: 1 row on B, 0 wakes on B`, `project ${MARA}: 1 row on B, 0 wakes on B`], 'her browser state and project changes went at the leave: after the record, before the wakes');
  assert.equal(isArriving(b.h.services, MARA), false);
  assert.equal(a.h.wakes.pending(MARA), 0);
  assert.ok(b.h.wakeRows().some((wake) => wake.agent_id === MARA && wake.note?.includes(CUT_NOTE)), 'the continue-wake is on B');
  assert.deepEqual(takeRepairNotes(b.h.services, MARA, 'main'), ['The file intro.mp4 is in my outputs.'], 'the waiting note came along');
  assert.deepEqual(takeRepairNotes(a.h.services, MARA, 'main'), [], 'and left A');
  assert.equal(isLeaving(a.h.services, MARA), false);
  for (const off of offs) off();
});

test('agents.update device from a part of my own work is refused – the part goes on', async () => {
  const { a } = pair();
  const update = agentTools.find((tool) => tool.name === 'agents.update')!;
  const out = await update.run({ device: 'dev_b' }, { ...toolCtx(a), split: { splitId: 'sp_1' } } as unknown as ToolContext);
  assert.equal(out.isError, true);
  assert.equal((out.content[0] as { text: string }).text, OWN_MOVE_IN_PART);
  assert.equal(a.h.org.require(MARA).deviceId, 'dev_a');
});

test('the environment line: my record goes with me; while my PC is off I wait, or a PC I am at home on goes on with me', () => {
  const services = {
    host: { app: {} },
    devices: { list: () => [{ id: 'dev_t', name: 'Tower', kind: 'pc', self: false, status: 'online' }], online: () => true },
  } as unknown as RuntimeServices;
  assert.match(companiesLine(services, new Set(), {}), /Linked PCs: Tower \(online\) – my record goes with me to the PC I work on; while mine is off I wait for it – agents\.update homes names the PCs that go on with me\.$/);
  assert.match(companiesLine(services, new Set(), { homes: ['dev_t', 'dev_n'] }), /while mine is off a PC I am at home on goes on with me from my complete record\.$/);
  assert.doesNotMatch(companiesLine(services, new Set()), /record/, 'without the agent: the line as before');
});
