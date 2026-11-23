// Live work between the CEO's own PCs (src/runtime/devices/sync/live.ts, live-wire.ts, chat/live.ts; feedback F10/F21
// 16.11.2026): what A runs shows in B's live bar and chat list (deviceId A) and in what B's windows hear as
// agent.activity, a step and the end follow, A's state leaves B when the link goes, an employee's PC is refused, a Stop
// on B reaches A's dispatcher, a PC without the method is asked again only after its next link-up. 22.11.2026 (owner:
// "nur das, was eben neu ist … mit den IDs … kurzen Befehlen"): after the whole state, a change travels as a short
// command with the run's id and the next number, an end at once; a lost command (a gap) or a pulse whose hash differs
// brings the whole state; a pulse goes only while A has running work; B drops A's runs when A's messages stop; a PC on
// 0.3.16 sends and gets the whole state {runs} and its state never expires; a context fold travels with its mark. Review:
// a lost first whole state comes with the next pulse round; a pulse on a slow line asks for nothing; empty answers of a
// 0.3.16 PC announce nothing; a whole state is kept as it came (the sender's hash, whatever its limits).
// Owns: these assertions only. Never: network, Electron, engines.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { AgentActivity, RunItem } from '../../../src/shared/model/runs.ts';
import { allActivity, chatLiveOf } from '../../../src/runtime/chat/live.ts';
import { CANCEL_METHOD, LIVE_METHOD, LiveSync } from '../../../src/runtime/devices/sync/live.ts';
import { diffOf, pack, patched, shareOf, stateHash, unpack } from '../../../src/runtime/devices/sync/live-wire.ts';
import { agent } from '../chat/harness.ts';
import { Net, link, makePc, record, settle, type Pc } from './sync-net.ts';

/** `pulseMs`/`ttlMs`: the pulse and the expiry (long by default: none within a test unless it asks for one). */
function withLive(pc: Pc, cancelled: string[], pulseMs = 60_000, ttlMs = 60_000) {
  const live = new LiveSync(pc.h.services, chatLiveOf(pc.h.bus)!, async (runId) => { cancelled.push(runId); return runId.startsWith('run_') ? 'stopped' : undefined; }, 0, pulseMs, ttlMs);
  pc.handlers.set(LIVE_METHOD, async (params, from) => live.receive(params, from));
  pc.handlers.set(CANCEL_METHOD, (params, from) => live.cancel(params, from));
  const off = live.attach();
  after(off);
  return live;
}

function setup(pulseMs?: number, ttlMs?: number) {
  const net = new Net();
  const a = makePc(net, 'pc_a');
  const b = makePc(net, 'pc_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_tom', 'Tom'));
  const cancelledA: string[] = [];
  const liveA = withLive(a, cancelledA, pulseMs, ttlMs);
  const liveB = withLive(b, [], pulseMs, ttlMs);
  const sent = () => net.calls.filter((entry) => entry.method === LIVE_METHOD && entry.from === 'pc_a').map((entry) => entry.params as Record<string, unknown>);
  return { net, a, b, liveA, liveB, cancelledA, sent };
}

const tom = (chatId: string, extra: Partial<AgentActivity> = {}): AgentActivity => ({ agentId: 'ag_tom', runId: 'run_tom', conversationId: chatId, note: 'bash', startedAt: 100, modelName: 'Opus 5.5', effort: 'high', toolCalls: 2, ...extra });
const call = (runId: string, file = 'C:/data/invoices.pdf'): RunItem => ({ id: 'ri_1', runId, seq: 1, kind: 'tool_call', name: 'Read', data: { callId: 'c1', args: { file_path: file } }, createdAt: 1 });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a run on A shows in B\'s live bar, chat list and agent.activity with A as its PC; its step and its end follow', async () => {
  const { a, b, liveA } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', title: 'Invoices' });
  await settle();
  assert.ok(b.h.chats.get(chat.id), 'the chat came over');
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  const live = b.h.chats.summary(chat.id).live;
  assert.deepEqual(live?.map((run) => [run.runId, run.deviceId, run.model, run.note]), [['run_tom', 'pc_a', 'Opus 5.5', 'bash']]);
  assert.deepEqual(b.h.chats.summary(chat.id).working, ['ag_tom'], 'the chat list marks it working');
  assert.equal(a.h.chats.summary(chat.id).live?.[0].deviceId, undefined, 'on A it is A\'s own run');
  assert.deepEqual(allActivity(b.h.bus, []).map((entry) => [entry.runId, entry.deviceId, entry.toolCalls]), [['run_tom', 'pc_a', undefined]]);
  assert.ok(b.h.of('agent.activity').length > 0, 'B\'s windows hear it');
  assert.ok(b.h.of('conversation.upserted').some((summary) => summary.id === chat.id && summary.live?.length === 1), 'B\'s chat list hears it');

  a.h.bus.emit('run.item', call('run_tom'));
  await settle();
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /invoices\.pdf/, 'the step follows');

  a.h.bus.emit('agent.activity', { active: [] });
  await settle();
  assert.equal(b.h.chats.summary(chat.id).live, undefined, 'the end follows');
  assert.deepEqual(allActivity(b.h.bus, []), []);
  void liveA;
});

test('22.11.2026: after the whole state a change is a short command – the run\'s id, the next number, only what changed; an end goes at once', async (t) => {
  const { a, b, sent } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.ok(Array.isArray(sent()[0]?.runs) && typeof sent()[0]?.s === 'number', 'first the whole state, with A\'s number (B had not answered in this form yet)');
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/q3.pdf'));
  await settle();
  const step = sent().at(-1)!;
  assert.deepEqual(Object.keys(step), ['c']);
  const [command] = step.c as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(command).sort(), ['d', 'i', 's']);
  assert.equal(command.i, 'run_tom');
  assert.deepEqual(Object.keys(command.d as object), ['p'], 'only the step');
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /q3\.pdf/);
  t.diagnostic(`a step change: ${JSON.stringify(step).length} characters`);

  a.h.bus.emit('agent.activity', { active: [tom(chat.id, { runId: 'run_two', startedAt: 200 })] }); // Tom's run ends, another starts
  await settle();
  const last = sent().at(-1)!.c as Array<Record<string, unknown>>;
  assert.deepEqual(last.map((entry) => Object.keys(entry).filter((key) => key !== 's')[0]), ['a', 'e'], 'a start with the run, an end with its id');
  assert.deepEqual(last.map((entry) => entry.s), [Number(command.s) + 1, Number(command.s) + 2], 'one number per change');
  assert.deepEqual(b.h.chats.summary(chat.id).live?.map((run) => run.runId), ['run_two']);
});

test('22.11.2026: a lost command (a gap) or a pulse whose number or hash differs makes B ask for the whole state once', async (t) => {
  const { a, b, sent } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  const receive = b.handlers.get(LIVE_METHOD)!;
  let drop = 1;
  b.handlers.set(LIVE_METHOD, async (params, from) => {
    if (Array.isArray((params as { c?: unknown }).c) && drop-- > 0) throw new WorkforceError('unavailable', 'The link to this PC was replaced.');
    return receive(params, from);
  });
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/lost.pdf')); // lost on the way
  await settle();
  assert.doesNotMatch(b.h.chats.summary(chat.id).live?.[0].step ?? '', /lost/, 'B missed it');
  const wholes = () => sent().filter((params) => Array.isArray(params.runs));
  const before = wholes().length;
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/next.pdf')); // its number is not the one after B's
  await settle();
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /next\.pdf/, 'the whole state came at once');
  assert.equal(wholes().length - before, 1, 'once');

  // A pulse: A's number and the hash of what A runs – B answers in this form, and asks for the whole state when either differs.
  const s = Number(wholes().at(-1)!.s);
  const h = stateHash(new Map(chatLiveOf(a.h.bus)!.snapshot().map((share) => [share.activity.runId, pack(shareOf(share)!)])));
  assert.deepEqual(await receive({ s, h }, 'pc_a'), { v: 2 }, 'what B holds');
  assert.deepEqual(await receive({ s, h: 'zzzzzz' }, 'pc_a'), { v: 2, w: 1 });
  assert.deepEqual(await receive({ s: s + 1, h }, 'pc_a'), { v: 2, w: 1 });
  t.diagnostic(`a pulse: ${JSON.stringify({ s, h }).length} characters`);
  assert.ok(JSON.stringify({ s, h }).length <= 24);
});

test('22.11.2026: a pulse goes only while A has running work; B drops A\'s runs when A\'s messages stop', async () => {
  const { a, b, liveA, sent } = setup(40, 10_000);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await wait(250);
  const pulses = () => sent().filter((params) => typeof params.h === 'string').length;
  assert.ok(pulses() >= 2, `pulses while Tom works (${pulses()})`);
  a.h.bus.emit('agent.activity', { active: [] });
  await settle();
  const quiet = pulses();
  await wait(200);
  assert.equal(pulses(), quiet, 'nothing runs on A: no pulse');
  void liveA;

  const { a: a2, b: b2 } = setup(60_000, 400);
  const chat2 = a2.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a2.h.bus.emit('agent.activity', { active: [tom(chat2.id)] });
  await settle();
  assert.equal(b2.h.chats.summary(chat2.id).live?.length, 1);
  await wait(800); // A's next pulse is far away: as if its messages stopped
  assert.equal(b2.h.chats.summary(chat2.id).live, undefined, 'gone after the expiry');
  assert.deepEqual(allActivity(b2.h.bus, []), [], 'and B\'s windows hear it');
  void b;
});

test('22.11.2026: a PC on 0.3.16 sends and gets the whole state {runs}; its state never expires', async () => {
  const { net, a, b } = setup(30, 60);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  const old: unknown[] = [];
  const theirs = { activity: { ...tom(chat.id), runId: 'run_old', startedAt: 50 }, chats: [chat.id] };
  b.handlers.set(LIVE_METHOD, async (params) => { old.push(params); return { ok: true, runs: [theirs] }; }); // what a 0.3.16 runtime answers
  a.h.running.push(tom(chat.id)); // what A's dispatcher reports (taking B's runs announces A's own activity again)
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  a.h.bus.emit('run.item', call('run_tom'));
  await wait(150);
  assert.ok(old.length >= 2 && old.every((params) => Array.isArray((params as { runs?: unknown }).runs)), 'every change as the whole state, never a command or a pulse');
  assert.deepEqual(a.h.chats.summary(chat.id).live?.map((run) => [run.runId, run.deviceId ?? 'here']), [['run_old', 'pc_b'], ['run_tom', 'here']], 'its answer brings its runs');
  await wait(150);
  assert.equal(a.h.chats.summary(chat.id).live?.length, 2, 'they do not expire: that PC never repeats them');
  void net;
});

test('22.11.2026 review: when the first whole state does not arrive, the next pulse round brings it – B holds the run within one pulse period', async () => {
  const { a, b } = setup(300, 10_000);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  const receive = b.handlers.get(LIVE_METHOD)!;
  let failing = 1;
  b.handlers.set(LIVE_METHOD, async (params, from) => {
    if (failing-- > 0) throw new WorkforceError('timeout', 'The linked device did not answer in time.'); // behind a long catch-up, or a swap ate it
    return receive(params, from);
  });
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.equal(b.h.chats.summary(chat.id).live, undefined, 'the first whole state was lost');
  await wait(700);
  assert.equal(b.h.chats.summary(chat.id).live?.[0].runId, 'run_tom', 'the next round brought it');
});

test('22.11.2026 review: on a slow line a pulse names what is queued before it – no whole state is asked for while changes stream', async () => {
  const { a, b, sent } = setup(25, 10_000);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  const receive = b.handlers.get(LIVE_METHOD)!;
  const asked: unknown[] = [];
  b.handlers.set(LIVE_METHOD, async (params, from) => { await wait(30); const answer = await receive(params, from); asked.push(answer); return answer; }); // each message takes a while
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await wait(150); // the whole state went; B answered in this form
  const wholes = () => sent().filter((params) => Array.isArray(params.runs)).length;
  const before = wholes();
  for (let i = 0; i < 8; i++) { await wait(20); a.h.bus.emit('run.item', call('run_tom', `C:/data/part-${i}.pdf`)); }
  await wait(900);
  assert.ok(sent().filter((params) => typeof params.h === 'string').length >= 2, 'pulses went between the changes');
  assert.equal(asked.filter((answer) => (answer as { w?: unknown }).w).length, 0, 'never asked for the whole state');
  assert.equal(wholes(), before, 'no whole state while the changes streamed');
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /part-7\.pdf/);
});

test('22.11.2026 review: a 0.3.16 PC\'s empty answers announce nothing here; a whole state is kept as it came, so its hash is the sender\'s', async () => {
  const { a, b } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  b.handlers.set(LIVE_METHOD, async () => ({ ok: true, runs: [] })); // a 0.3.16 PC with nothing running
  a.h.running.push(tom(chat.id));
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  const heard = a.h.of('agent.activity').length;
  for (let i = 0; i < 3; i++) { a.h.bus.emit('run.item', call('run_tom', `C:/data/${i}.pdf`)); await settle(); }
  assert.equal(a.h.of('agent.activity').length, heard, 'no announcement to every window and phone per change');

  const liveB = new LiveSync(b.h.services, chatLiveOf(b.h.bus)!, async () => undefined, 0);
  const raw = { activity: { ...tom(chat.id), toolCalls: undefined, note: 'n'.repeat(400) }, step: 's'.repeat(350), chats: [chat.id] }; // a later version's limits
  assert.deepEqual(liveB.receive({ runs: [raw], s: 7 }, 'pc_a'), { v: 2 });
  const h = stateHash(new Map([['run_tom', pack(JSON.parse(JSON.stringify(raw)))]]));
  assert.deepEqual(liveB.receive({ s: 7, h }, 'pc_a'), { v: 2 }, 'the same bytes, the same hash: no whole state every pulse');
  assert.equal(b.h.chats.summary(chat.id).live?.[0].note?.length, 300, 'the bar shows it trimmed');
});

test('A\'s state leaves B when the link goes; it comes back at the next link-up', async () => {
  const { net, a, b, liveA, liveB } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.equal(b.h.chats.summary(chat.id).live?.length, 1);
  net.up = false;
  liveB.linkDown('pc_a');
  assert.equal(b.h.chats.summary(chat.id).live, undefined, 'dropped with the link');
  net.up = true;
  liveA.linkUp('pc_b');
  await settle();
  assert.equal(b.h.chats.summary(chat.id).live?.[0].deviceId, 'pc_a', 'sent again at link-up');
});

// Owner 19.11.2026 ("irgendwann wird es nicht mehr schön synchronisiert"): B dropped A's state on a link drop A never
// noticed, so A did not send again – A's next pulse finds B without it and brings the whole state.
test('B dropped A\'s state on a drop only B saw: A\'s next pulse brings it back', async () => {
  const { a, b, liveB } = setup(50, 10_000);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  liveB.linkDown('pc_a'); // only B saw the link go
  assert.equal(b.h.chats.summary(chat.id).live, undefined);
  await wait(200);
  assert.deepEqual(b.h.chats.summary(chat.id).live?.map((run) => run.runId), ['run_tom']);
});

test('22.11.2026: a context fold travels with its mark – B\'s bar knows it is one', async () => {
  const { a, b } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id, { runId: 'run_fold', fold: true })] });
  await settle();
  assert.deepEqual(b.h.chats.summary(chat.id).live?.map((run) => [run.runId, run.fold]), [['run_fold', true]]);
  assert.equal(a.h.chats.summary(chat.id).live?.[0].fold, true, 'and A\'s own');
});

test('a Stop on B reaches A\'s dispatcher; a run nobody has is no run', async () => {
  const { a, b, liveB, cancelledA } = setup();
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.equal(liveB.deviceOf('run_tom'), 'pc_a');
  assert.equal(await liveB.cancelOn('pc_a', 'run_tom'), true);
  assert.deepEqual(cancelledA, ['run_tom'], 'A stops its own run');
  assert.equal(liveB.deviceOf('run_unknown'), undefined, 'no PC runs it');
  void b;
});

test('20.11.2026: a Stop from a bar a moment behind stops the run of that agent its chat shows on A now', async () => {
  const { net, a, liveB } = setup();
  const cancelled: string[] = [];
  const liveA = new LiveSync(a.h.services, chatLiveOf(a.h.bus)!, async (runId) => { cancelled.push(runId); return runId === 'run_tom' ? 'stopped' : 'ended'; }, 0);
  a.handlers.set(CANCEL_METHOD, (params, from) => liveA.cancel(params, from));
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.equal(await liveB.cancelOn('pc_a', 'run_old', { agentId: 'ag_tom', chatId: chat.id }), true);
  assert.deepEqual(cancelled, ['run_old', 'run_tom'], 'the old run is over there; the one the chat shows now stops');
  a.h.bus.emit('agent.activity', { active: [] });
  await settle();
  assert.equal(await liveB.cancelOn('pc_a', 'run_old', { agentId: 'ag_tom', chatId: chat.id }), true, 'over and nothing else running: done');
  net.up = false;
  assert.equal(await liveB.cancelOn('pc_a', 'run_tom'), false, 'a PC that does not answer stops nothing');
});

test('only a CEO link sends live work or a Stop', async () => {
  const { a, liveA } = setup();
  a.repo.upsert(record('pc_emp', { personId: 'per_1' }));
  assert.throws(() => liveA.receive({ runs: [] }, 'pc_emp'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  await assert.rejects(liveA.cancel({ runId: 'run_tom' }, 'pc_emp'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
});

test('a PC without sync.live is asked again only after its next link-up', async () => {
  const { a, b, liveA, sent } = setup();
  b.handlers.set(LIVE_METHOD, async () => { throw new WorkforceError('not_found', 'Unknown peer method sync.live.'); }); // what a runtime before 16.11. answers
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.equal(sent().length, 1);
  a.h.bus.emit('agent.activity', { active: [{ ...tom(chat.id), note: 'editing' }] });
  await settle();
  assert.equal(sent().length, 1, 'not asked again');
  liveA.linkUp('pc_b');
  await settle();
  assert.equal(sent().length, 2, 'asked again at its link-up');
});

test('a run from another PC takes only the live bar\'s fields and never its own deviceId; the short form goes there and back', () => {
  assert.equal(shareOf({ activity: { agentId: 'ag_tom' } }), undefined, 'no run id, no run');
  const share = shareOf({ activity: { agentId: 'ag_tom', runId: 'run_1', startedAt: 1, note: 7, deviceId: 'pc_x', toolCalls: 3 }, step: 'Reading a.pdf', chats: ['ch_1', 4] });
  assert.deepEqual(share, { activity: { agentId: 'ag_tom', runId: 'run_1', startedAt: 1, note: '' }, step: 'Reading a.pdf', chats: ['ch_1'] });
  const packed = pack(shareOf({ activity: { ...tom('ch_1'), fold: true, future: 'x' }, step: 'Reading a.pdf', chats: ['ch_1'] })!);
  assert.deepEqual(pack(unpack(packed)!), packed, 'there and back unchanged (a newer field keeps its name)');
  assert.equal(packed.future, 'x');
  const next: Record<string, unknown> = { ...packed, p: 'Editing b.ts' };
  delete next.e;
  assert.deepEqual(diffOf(packed, next), { p: 'Editing b.ts', e: null });
  assert.deepEqual(patched(packed, diffOf(packed, next)), next);
  assert.equal(stateHash(new Map([['run_tom', packed]])), stateHash(new Map([['run_tom', { ...packed }]])), 'the same runs, the same hash');
  assert.equal(stateHash(new Map([['run_tom', packed]])).length, 6);
});
