// A call as one value in its chat (src/runtime/calls/call-log.ts) with the real chat service: calls.start opens one quiet
// row per device and chat (and returns it again), every line after it in that chat joins its lines while it is open –
// the person's, every agent's answer once final (also one that arrives by the bus like a synced row), quiet lines only
// with the call's id, a hand-over note of the call – edits and deletions follow, also after the end and only in this PC's
// call rows; the newest CALL_LINES stay; it ends with calls.end (only its device's), the device's connection, or – let go
// at a stop – at the next start, at its last line.
// The RPC: calls.start/calls.end with the connection's device, the connection closing ends the call.
// Owner 19.11.2026: devices join a running call beside its holder (here and from another PC), each leaves alone, the holder's
// place goes to the next device, the last one ends it; calls.start with join.
// Team-Call 21.11.2026: records and join notes name the person of the device (the PC's profile name, here Gerd).
// Owns: these assertions only. Never: audio or a real device.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { CALL_LINES, CALL_LINE_TEXT, callLength, callRecord, type CallRecord } from '../../../src/shared/model/call.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { CallLog, writeCallRow } from '../../../src/runtime/calls/call-log.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { createCalls, stopCalls } from '../../../src/runtime/calls/wiring.ts';
import { fakeVoice } from './voice-fake.ts';
import { CallTalker } from '../../../src/runtime/calls/talker.ts';
import { register as calls } from '../../../src/runtime/rpc/handlers/calls.ts';
import { agent, harness } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture, s1Table } from '../rpc/s1-helpers.ts';

const PC = { key: 'pc', name: 'laptop' };
const PHONE_DEVICE = { key: 'dev_phone', name: 'Pixel' };

function setup() {
  const h = harness();
  h.org.add(agent('ag_jonas', 'Jonas'));
  h.org.add(agent('ag_mia', 'Mia'));
  const chat = h.chats.create({ agentIds: ['ag_jonas', 'ag_mia'], createdBy: HUMAN_ID, lead: 'ag_jonas' });
  Object.assign(h.services, { settings: { get: () => ({ profile: { name: 'Gerd' } }) } });
  const log = new CallLog(() => h.services as RuntimeServices);
  const record = (callId: string): CallRecord => h.chats.messages(chat.id, { limit: 200 }).map((m) => callRecord(m)).find((call) => call?.id === callId)!;
  const say = (body: string, extra: Partial<Parameters<typeof h.chats.send>[0]> = {}) => h.chats.send({ conversationId: chat.id, body, authorId: HUMAN_ID, authorKind: 'human', ...extra });
  const answer = (agentId: string, body: string, extra: Partial<Parameters<typeof h.chats.send>[0]> = {}) => h.chats.send({ conversationId: chat.id, body, authorId: agentId, authorKind: 'agent', ...extra });
  return { ...h, chat, log, record, say, answer };
}

test('calls.start: one quiet row per device and chat, returned again while open; an unknown chat is not found', () => {
  const h = setup();
  const before = h.say('Before the call');
  const id = h.log.start(h.chat.id, PC);
  assert.equal(h.log.start(h.chat.id, PC), id, 'the open one again');
  assert.equal(h.log.start(h.chat.id, PC, undefined, 'call_unknown'), id, 'a call it does not know: the open one');
  assert.notEqual(h.log.start(h.chat.id, PHONE_DEVICE), id, 'another device has its own');
  const row = h.chats.messages(h.chat.id, { limit: 10 }).find((m) => callRecord(m)?.id === id)!;
  assert.deepEqual([row.kind, row.silent, row.body, row.authorKind], ['status', true, 'Call from laptop', 'system']);
  assert.deepEqual(callRecord(row), { id, participant: 'device:pc', name: 'laptop', person: 'Gerd', startedAt: h.clock.now(), lines: [] });
  assert.equal(callRecord(before), undefined);
  assert.throws(() => h.log.start('ch_missing', PC), /Chat not found/);
});

test('lines: the person\'s and every agent\'s final lines after the row, quiet ones only with the call\'s id; edits and deletions follow', () => {
  const h = setup();
  const old = h.say('An older line');
  const id = h.log.start(h.chat.id, PC);
  h.clock.advance(1000);
  const spoken = h.say('Jonas, wie weit bist du?', { speech: { source: 'endpoint', live: true }, meta: { call: { id, participant: 'device:pc', name: 'laptop' } } });
  h.answer('ag_mia', 'Background note', { silent: true }); // quiet, not of the call
  const held = h.say('Held for the talker', { silent: true, meta: { call: { id, participant: 'device:pc', name: 'laptop' } } });
  h.chats.postAgentMessage(h.chat.id, 'ag_jonas', 'run_1', { body: 'Fast fertig.', meta: { model: 'GPT-6' } });
  h.chats.status(h.chat.id, { type: 'note', text: 'Handed over in the call: export', details: { callId: id } }, { authorId: 'ag_jonas' });
  h.chats.status(h.chat.id, { type: 'note', text: 'Some other note' });
  h.chats.edit(old.id, 'An older line, edited', HUMAN_ID); // before the call: no line
  h.chats.edit(spoken.id, 'Jonas, wie weit bist du jetzt?', HUMAN_ID);
  assert.deepEqual(h.record(id).lines.map((line) => [line.from, line.name, line.text, line.messageId === undefined]), [
    ['device:pc', 'Gerd', 'Jonas, wie weit bist du jetzt?', false],
    ['device:pc', 'Gerd', 'Held for the talker', false],
    ['agent:ag_jonas', 'Jonas', 'Fast fertig.', false],
    ['agent:ag_jonas', 'Jonas', 'Handed over in the call: export', false],
  ]);
  assert.equal(h.record(id).lines[0].at, spoken.createdAt);
  h.chats.removeMessage(held.id, HUMAN_ID);
  assert.deepEqual(h.record(id).lines.map((line) => line.text), ['Jonas, wie weit bist du jetzt?', 'Fast fertig.', 'Handed over in the call: export']);
});

test('a row that arrives by the bus like a synced one joins; the newest CALL_LINES stay, each line capped', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  const synced = h.answer('ag_jonas', 'From the home PC');
  h.bus.emit('message.created', synced); // the sync's event for an applied row: no second line
  assert.equal(h.record(id).lines.filter((line) => line.messageId === synced.id).length, 1);
  for (let index = 0; index < CALL_LINES + 5; index++) h.say(`Line ${index}`);
  const lines = h.record(id).lines;
  assert.equal(lines.length, CALL_LINES);
  assert.equal(lines.at(-1)?.text, `Line ${CALL_LINES + 4}`);
  h.say('x'.repeat(CALL_LINE_TEXT + 50));
  assert.equal(h.record(id).lines.at(-1)?.text.length, CALL_LINE_TEXT);
});

test('end: only its device ends it, later answers stay outside; the connection closing ends it', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  h.clock.advance(282_000);
  assert.throws(() => h.log.end(id, PHONE_DEVICE.key), /another device/);
  h.log.end(id, PC.key);
  h.log.end(id, PC.key); // again: nothing to end
  assert.equal(h.record(id).endedAt, h.record(id).startedAt + 282_000);
  assert.equal(callLength(h.record(id).endedAt! - h.record(id).startedAt), '4:42');
  h.answer('ag_jonas', 'Late answer');
  assert.equal(h.record(id).lines.length, 0, 'an answer after the end stays a row of its own');
  assert.notEqual(h.log.start(h.chat.id, PC), id, 'a new call after the end');

  const connection = new AbortController();
  const phone = h.log.start(h.chat.id, PHONE_DEVICE, connection.signal);
  connection.abort();
  assert.ok(h.record(phone).endedAt !== undefined, 'the device left');
});

test('after the end, edits and deletions still follow – in the call rows this PC wrote, never in another PC\'s', () => {
  const h = setup();
  const device = (id: string, name: string, self: boolean): DeviceRecord => ({ id, name, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self });
  new DevicesRepo(h.db).upsert(device('dev_book', 'laptop', true));
  const id = h.log.start(h.chat.id, PC);
  const secret = h.say('my secret thing');
  const kept = h.answer('ag_jonas', 'Noted.');
  h.log.end(id, PC.key);
  assert.equal(h.record(id).pc, 'dev_book', 'the PC that writes it');
  const far: CallRecord = { id: 'call_far', participant: 'device:pc', name: 'office-pc', pc: 'dev_server', startedAt: 1, endedAt: 2, lines: [{ at: 1, from: 'agent:ag_jonas', name: 'Jonas', text: 'Noted.', messageId: kept.id }] };
  const theirs = h.chats.send({ conversationId: h.chat.id, body: 'Call from office-pc', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Call from office-pc' }, call: far } });
  h.chats.edit(kept.id, 'Noted, I am on it.', 'ag_jonas');
  h.chats.removeMessage(secret.id, HUMAN_ID);
  assert.deepEqual(h.record(id).lines.map((line) => [line.messageId, line.text]), [[kept.id, 'Noted, I am on it.']], 'the deleted line is gone, the edited one says the new words');
  assert.deepEqual(callRecord(h.chats.message(theirs.id)!)?.lines.map((line) => line.text), ['Noted.'], 'another PC\'s call row is that PC\'s to write');
});

test('a stop lets calls go; the next start ends them at their last line, announced so they travel', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  h.clock.advance(5000);
  const line = h.say('Last words');
  h.log.stop();
  h.clock.advance(3_600_000);
  h.say('After the stop');
  assert.equal(h.record(id).endedAt, undefined);
  assert.equal(h.record(id).lines.length, 1, 'nothing joins after the stop');
  const next = new CallLog(() => h.services as RuntimeServices);
  const announced: Message[] = [];
  h.bus.on('message.updated', (message) => announced.push(message));
  assert.equal(next.endLeftOpen(), 1);
  assert.equal(h.record(id).endedAt, line.createdAt);
  assert.ok(announced.some((message) => callRecord(message)?.id === id));
  assert.equal(next.endLeftOpen(), 0, 'once');
});

test('B-081 take: another device of this PC takes the call over – no end, no second row; a late line of the old one joins it', () => {
  const h = setup();
  const told: string[] = [];
  h.log.onStart((_chat, callId) => told.push(`start ${callId}`));
  h.log.onEnd((_chat, callId, handOver) => told.push(`end ${callId} ${handOver}`));
  const id = h.log.start(h.chat.id, PC);
  const taken = h.log.take(h.chat.id, id, PHONE_DEVICE);
  assert.deepEqual(told, [`start ${id}`, `start ${id}`], 'the voice hears of the start (and of the take: it keeps its session), no end');
  assert.deepEqual([taken.callId, taken.answered, taken.holder], [id, false, '/device:dev_phone']);
  assert.deepEqual([h.record(id).participant, h.record(id).name, h.record(id).endedAt], ['device:dev_phone', 'Pixel', undefined]);
  assert.equal(h.log.start(h.chat.id, PC, undefined, id), id, 'a late line of the PC window joins the call');
  assert.equal(h.chats.messages(h.chat.id, { limit: 20 }).filter((m) => callRecord(m)).length, 1, 'one bubble');
  h.say('Weiter am Handy');
  assert.deepEqual(h.record(id).lines.map((line) => line.text), ['Weiter am Handy'], 'the lines go on in the same row');
  assert.throws(() => h.log.end(id, PC.key), /another device/);
  h.log.end(id, PHONE_DEVICE.key);
  assert.ok(h.record(id).endedAt !== undefined);
  assert.throws(() => h.log.take(h.chat.id, id, PC), /already ended/);
  assert.throws(() => h.log.take(h.chat.id, 'call_none', PC), /Call not found/);
  assert.deepEqual(told.at(-1), `end ${id} true`);

  // A call whose row is deleted leaves this PC: its voice hears it, without a hand-over (review r2-2 finding 9).
  const gone = h.log.start(h.chat.id, PC);
  const row = h.chats.messages(h.chat.id, { limit: 20 }).find((m) => callRecord(m)?.id === gone)!;
  h.bus.emit('message.removed', { id: row.id, conversationId: h.chat.id } as never);
  assert.deepEqual(told.at(-1), `end ${gone} false`);
});

test('B-081 take by another PC: the synced row with another holder lets the call go here without an end; the next start leaves it', () => {
  const h = setup();
  new DevicesRepo(h.db).upsert({ id: 'dev_book', name: 'laptop', kind: 'pc', role: 'home', fingerprint: 'fp_book', addresses: [], caps: {}, status: 'online', self: true });
  const ends: string[] = [];
  h.log.onEnd((_chat, callId, handOver) => ends.push(`${callId} ${handOver}`));
  const id = h.log.start(h.chat.id, PC);
  const rowId = h.chats.messages(h.chat.id, { limit: 10 }).find((m) => callRecord(m)?.id === id)!.id;
  writeCallRow(h.services as RuntimeServices, rowId, (record) => ({ ...record, participant: 'device:pc', name: 'office-pc', pc: 'dev_server' })); // as the sync applies it
  assert.deepEqual(ends, [`${id} false`], 'the voice here closes its session without a hand-over: the other PC holds the call now');
  h.say('Said on the other PC');
  assert.equal(h.record(id).lines.length, 0, 'this PC writes its lines no more');
  h.log.end(id, PC.key);
  assert.equal(h.record(id).endedAt, undefined, 'not this PC\'s call to end');
  assert.equal(h.log.start(h.chat.id, PC, undefined, id), id, 'a late line joins the call there');
  h.log.stop();
  assert.equal(new CallLog(() => h.services as RuntimeServices).endLeftOpen(), 0);
  assert.equal(h.record(id).endedAt, undefined, 'the next start leaves another PC\'s row');
});

test('B-081 take of a ring that rang out is refused', () => {
  const h = setup();
  const ring: CallRecord = { id: 'call_ring', participant: 'agent:ag_jonas', name: 'Jonas', startedAt: h.clock.now(), lines: [], ring: { by: 'ag_jonas', why: 'x', until: h.clock.now() + 1000 } };
  h.chats.send({ conversationId: h.chat.id, body: 'Jonas calls: x', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Jonas calls: x' }, call: ring } });
  h.clock.advance(1000);
  assert.throws(() => h.log.take(h.chat.id, 'call_ring', PC), /already ended/);
});

test('rpc: calls.start and calls.end with the connection\'s device; its connection closing ends its call', async (t) => {
  const table = s1Table();
  calls(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  f.org.add(agent('ag_jonas', 'Jonas'));
  createCalls(f.services as RuntimeServices, { voice: fakeVoice(() => '').opener });
  t.after(() => stopCalls(f.services));
  const chat = f.chats.create({ agentIds: ['ag_jonas'], createdBy: HUMAN_ID });
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, PHONE);
  const { callId } = await owner.call<{ callId: string }>('calls.start', { conversationId: chat.id });
  assert.equal((await owner.call<{ callId: string }>('calls.start', { conversationId: chat.id })).callId, callId);
  const record = (id: string) => f.chats.messages(chat.id, { limit: 20 }).map((m) => callRecord(m)).find((call) => call?.id === id)!;
  assert.equal(record(callId).participant, 'device:pc');
  await assert.rejects(phone.call('calls.end', { callId }), /another device/);
  const own = await phone.call<{ callId: string }>('calls.start', { conversationId: chat.id });
  assert.equal(record(own.callId).participant, 'device:dev_phone');
  await owner.call('calls.end', { callId });
  assert.ok(record(callId).endedAt !== undefined);
  phone.detach();
  assert.ok(record(own.callId).endedAt !== undefined, 'the phone\'s connection closed');
});

test('B-081 rpc: calls.live lists a ring; calls.start with its id answers it with the opening line, another device takes it over; calls.decline', async (t) => {
  const table = s1Table();
  calls(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  f.org.add(agent('ag_jonas', 'Jonas'));
  Object.assign(f.services, { secrets: { redact: (text: string) => text } });
  const { rings } = createCalls(f.services as RuntimeServices, { voice: fakeVoice(() => '').opener });
  t.after(() => stopCalls(f.services));
  const chat = f.chats.create({ agentIds: ['ag_jonas'], createdBy: HUMAN_ID });
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, PHONE);
  const rung = await rings.ring({ conversationId: chat.id, agentId: 'ag_jonas', why: 'Budget', say: 'Kurz zum Budget.' });
  const listed = await phone.call<{ calls: Array<{ callId: string; state: string }> }>('calls.live');
  assert.deepEqual(listed.calls.map((call) => [call.callId, call.state]), [[rung.callId, 'ringing']]);
  assert.deepEqual(await phone.call('calls.start', { conversationId: chat.id, callId: rung.callId }), { callId: rung.callId, holder: '/device:dev_phone', say: 'Kurz zum Budget.' });
  assert.deepEqual(await owner.call('calls.start', { conversationId: chat.id, callId: rung.callId }), { callId: rung.callId, holder: '/device:pc' }, 'the PC window takes it over');
  const other = f.chats.create({ agentIds: ['ag_jonas'], createdBy: HUMAN_ID });
  const second = await rings.ring({ conversationId: other.id, agentId: 'ag_jonas', why: 'Later' });
  assert.deepEqual(await owner.call('calls.decline', { callId: second.callId }), { ok: true });
  await assert.rejects(owner.call('calls.decline', { callId: second.callId }), /no longer rings/);
  await assert.rejects(owner.call('calls.start', { conversationId: other.id, callId: second.callId }), /already ended/);
});

// ------------------------------------------------------------------ owner 19.11.2026: several devices in one call

test('join: a second device of this PC joins beside the holder – its lines join the call, it leaves alone, the holder leaving hands the call to it, the last one ends it', () => {
  const h = setup();
  const told: string[] = [];
  h.log.onStart((_chat, callId) => told.push(`start ${callId}`));
  h.log.onEnd((_chat, callId, handOver) => told.push(`end ${callId} ${handOver}`));
  const id = h.log.start(h.chat.id, PC);
  const phone = new AbortController();
  assert.equal(h.log.joinDevice(h.chat.id, id, PHONE_DEVICE, phone.signal), '/device:dev_phone', 'how the call names it');
  assert.equal(h.log.joinDevice(h.chat.id, id, PC), '/device:pc', 'the holder joining is already in');
  assert.deepEqual(h.record(id).joined, [{ participant: 'device:dev_phone', name: 'Pixel', person: 'Gerd' }]);
  assert.equal(h.log.start(h.chat.id, PHONE_DEVICE, undefined, id), id, 'a line of the joined device names the call');
  assert.equal(h.log.start(h.chat.id, PHONE_DEVICE), id, 'and finds it without its id');
  h.say('Vom Handy', { speech: { source: 'endpoint', live: true }, meta: { call: { id, participant: 'device:dev_phone', name: 'Pixel' } } });
  assert.deepEqual(h.record(id).lines.map((line) => line.text), ['Pixel joined the call', 'Vom Handy'], 'the join is a line of the call');
  assert.equal(h.chats.messages(h.chat.id, { limit: 20 }).filter((m) => callRecord(m)).length, 1, 'one bubble');

  h.log.end(id, PHONE_DEVICE.key);
  assert.deepEqual([h.record(id).joined, h.record(id).endedAt, h.record(id).participant], [undefined, undefined, 'device:pc'], 'only the phone left');
  assert.equal(h.record(id).lines.at(-1)?.text, 'Pixel left the call');
  h.log.joinDevice(h.chat.id, id, PHONE_DEVICE, phone.signal);
  h.log.end(id, PC.key);
  assert.deepEqual([h.record(id).participant, h.record(id).name, h.record(id).joined, h.record(id).endedAt], ['device:dev_phone', 'Pixel', undefined, undefined], 'the holder left: the phone holds the call');
  assert.equal(h.log.holder(id), '/device:dev_phone');
  assert.deepEqual(told, [`start ${id}`], 'no end and no new start while the call goes on');
  h.say('Weiter');
  assert.equal(h.record(id).lines.at(-1)?.text, 'Weiter', 'its lines go on in the same row');
  phone.abort();
  assert.ok(h.record(id).endedAt !== undefined, 'the last device\'s connection closed: the call ended');
  assert.deepEqual(told.at(-1), `end ${id} true`);
  assert.throws(() => h.log.joinDevice(h.chat.id, id, PC), /not running/);
  assert.throws(() => h.log.joinDevice(h.chat.id, 'call_none', PC), /Call not found/);
  assert.throws(() => h.log.end(h.log.start(h.chat.id, PC), PHONE_DEVICE.key), /another device/, 'a device not in the call ends nothing');
});

test('join: a take keeps the devices joined; a line of a device whose connection closed joins the running call again, one of a device that left with calls.end is a line only', () => {
  const h = setup();
  const LAPTOP = { key: 'dev_laptop', name: 'Laptop' };
  const id = h.log.start(h.chat.id, PC);
  h.log.joinDevice(h.chat.id, id, PHONE_DEVICE);
  h.log.joinDevice(h.chat.id, id, LAPTOP);
  h.log.take(h.chat.id, id, LAPTOP);
  assert.deepEqual([h.record(id).participant, h.record(id).joined?.map((device) => device.participant)], ['device:dev_laptop', ['device:dev_phone']], 'the taker holds it, the phone stays in');
  h.log.end(id, LAPTOP.key);
  assert.deepEqual([h.record(id).participant, h.record(id).endedAt], ['device:dev_phone', undefined]);
  const tablet = { key: 'dev_tablet', name: 'Tablet' };
  const connection = new AbortController();
  h.log.joinDevice(h.chat.id, id, tablet, connection.signal);
  connection.abort();
  assert.equal(h.record(id).joined, undefined, 'its connection closed: it left');
  assert.equal(h.log.start(h.chat.id, tablet, undefined, id), id, 'its next line names the running call: in again, no second call');
  assert.deepEqual(h.record(id).joined?.map((device) => device.name), ['Tablet']);
  h.log.end(id, tablet.key); // the person hung up there (review: its late line sent after the end)
  assert.equal(h.log.start(h.chat.id, tablet, undefined, id), id, 'a late line still belongs to the call');
  assert.equal(h.record(id).joined, undefined, 'but the device stays out: no member nobody can end');
  assert.equal(h.log.start(h.chat.id, LAPTOP, undefined, id), id, 'the laptop that left with calls.end too');
  assert.equal(h.record(id).joined, undefined);
  h.log.joinDevice(h.chat.id, id, tablet); // its Join brings it back
  assert.deepEqual(h.record(id).joined?.map((device) => device.name), ['Tablet']);
});

test('join across PCs: a device here joins a call another PC holds (a guest) by a note, never by writing that row; the row naming it the holder makes this PC the writer', () => {
  const h = setup();
  new DevicesRepo(h.db).upsert({ id: 'dev_book', name: 'laptop', kind: 'pc', role: 'home', fingerprint: 'fp_book', addresses: [], caps: {}, status: 'online', self: true });
  Object.assign(h.services, { devices: { online: (id: string) => id === 'dev_server' } });
  const told: string[] = [];
  h.log.onStart((_chat, callId) => told.push(`start ${callId}`));
  const far: CallRecord = { id: 'call_far', participant: 'device:dev_phone', name: 'Pixel', pc: 'dev_server', startedAt: h.clock.now(), lines: [] };
  const row = h.chats.send({ conversationId: h.chat.id, body: 'Call from Pixel', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Call from Pixel' }, call: far } });
  const sync = (change: (record: CallRecord) => CallRecord) => writeCallRow(h.services as RuntimeServices, row.id, change); // as the other PC's write arrives
  const notes = () => h.chats.messages(h.chat.id, { limit: 50 }).filter((m) => m.meta.status?.details?.callId === 'call_far').map((m) => [m.body, m.meta.status?.details?.device]);
  const written = JSON.stringify(h.record('call_far'));
  assert.equal(h.log.joinDevice(h.chat.id, 'call_far', PC), 'dev_book/device:pc');
  assert.equal(JSON.stringify(h.record('call_far')), written, 'the other PC\'s row is not written here');
  assert.deepEqual(notes(), [['laptop joined the call', { participant: 'device:pc', name: 'laptop', pc: 'dev_book', person: 'Gerd' }]], 'the note the holder PC applies');
  assert.equal(h.log.relays(h.chat.id, 'call_far'), true, 'its plain lines go to the holder PC\'s voice');
  assert.equal(h.log.start(h.chat.id, PC, undefined, 'call_far'), 'call_far', 'its lines go into that call');
  sync((record) => ({ ...record, joined: [{ participant: 'device:pc', name: 'laptop', pc: 'dev_book' }] })); // the holder applied the note
  sync((record) => ({ ...record, participant: 'device:pc', name: 'laptop', pc: 'dev_book', joined: undefined })); // the phone left there
  assert.equal(h.log.holder('call_far'), 'dev_book/device:pc', 'this PC writes the call now');
  assert.equal(h.log.relays(h.chat.id, 'call_far'), false);
  assert.deepEqual(told, ['start call_far']);
  h.say('Jetzt hier');
  assert.equal(h.record('call_far').lines.at(-1)?.text, 'Jetzt hier');
  h.log.end('call_far', PC.key);
  assert.ok(h.record('call_far').endedAt !== undefined, 'the last device');

  const two = h.chats.send({ conversationId: h.chat.id, body: 'Call from Pixel', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Call from Pixel' }, call: { ...far, id: 'call_two', lines: [] } } });
  h.log.joinDevice(h.chat.id, 'call_two', PC);
  writeCallRow(h.services as RuntimeServices, two.id, (record) => ({ ...record, joined: [{ participant: 'device:pc', name: 'laptop', pc: 'dev_book' }] })); // applied there
  h.log.stop();
  assert.equal(new CallLog(() => h.services as RuntimeServices).endLeftOpen(), 1);
  const last = h.chats.messages(h.chat.id, { limit: 50 }).at(-1)!;
  assert.deepEqual([last.body, last.meta.status?.details?.callId, last.meta.status?.details?.left], ['laptop left the call', 'call_two', true], 'after a stop this PC\'s device leaves by note');
  assert.equal(h.record('call_two').endedAt, undefined, 'the call is the other PC\'s');
});

test('join notes on the PC that holds the call: a synced join or leave changes the row\'s devices; a note of a call held elsewhere changes nothing here', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  const office = { participant: 'device:pc', name: 'office-pc', pc: 'dev_server' };
  const synced = (callId: string, left: boolean) => h.chats.send({ conversationId: h.chat.id, body: 'x', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'x', details: { callId, device: office, ...(left ? { left: true } : {}) } } } });
  synced(id, false);
  synced(id, false);
  assert.deepEqual(h.record(id).joined, [office], 'once');
  synced(id, true);
  assert.equal(h.record(id).joined, undefined);
  h.log.end(id, PC.key);
  synced(id, false); // a join that arrives after the end
  assert.deepEqual([h.record(id).joined, h.record(id).endedAt !== undefined], [undefined, true], 'the ended call stays ended');
});

test('relay: a line said on a device joined from another PC is answered by the voice of the PC that holds the call; a voice of a PC that does not hold it does not serve', async () => {
  const h = setup();
  Object.assign(h.services, { secrets: { redact: (text: string) => text }, settings: { get: () => ({ profile: { name: 'Gerd' }, voice: {} }) } });
  const id = h.log.start(h.chat.id, PC);
  const fake = fakeVoice(() => '<as name="Jonas">Bin dran.');
  const talker = new CallTalker({ services: () => h.services as RuntimeServices, voice: fake.opener, calls: h.log });
  assert.equal(talker.serves(h.chat.id, id), true);
  assert.equal(talker.serves(h.chat.id, 'call_elsewhere'), false, 'another PC holds that call');
  h.say('Vom Laptop', { silent: true, speech: { source: 'endpoint', live: true }, meta: { call: { id, participant: 'device:pc', name: 'laptop', relay: true } } }); // as the sync brings it
  for (let round = 0; round < 8; round++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const voice = h.chats.messages(h.chat.id, { limit: 20 }).filter((m) => m.meta.call?.voice === 'talker');
  assert.deepEqual(voice.map((m) => [m.authorId, m.body]), [['ag_jonas', 'Bin dran.']]);
  talker.stop();
});

test('join: the holder leaving with only a device on another PC in hands the call to that PC when it is reachable, else ends it', () => {
  const h = setup();
  new DevicesRepo(h.db).upsert({ id: 'dev_book', name: 'laptop', kind: 'pc', role: 'home', fingerprint: 'fp_book', addresses: [], caps: {}, status: 'online', self: true });
  let online = true;
  Object.assign(h.services, { devices: { online: (id: string) => online && id === 'dev_server' } });
  const ends: string[] = [];
  h.log.onEnd((_chat, callId, handOver) => ends.push(`${callId} ${handOver}`));
  const id = h.log.start(h.chat.id, PC);
  const rowId = h.chats.messages(h.chat.id, { limit: 10 }).find((m) => callRecord(m)?.id === id)!.id;
  writeCallRow(h.services as RuntimeServices, rowId, (record) => ({ ...record, joined: [{ participant: 'device:pc', name: 'office-pc', pc: 'dev_server' }] })); // that PC's guest joined
  h.log.end(id, PC.key);
  assert.deepEqual([h.record(id).pc, h.record(id).participant, h.record(id).name, h.record(id).joined, h.record(id).endedAt], ['dev_server', 'device:pc', 'office-pc', undefined, undefined]);
  assert.deepEqual(ends, [`${id} false`], 'it left this PC without an end');
  online = false;
  const next = h.log.start(h.chat.id, PC);
  const nextRow = h.chats.messages(h.chat.id, { limit: 10 }).find((m) => callRecord(m)?.id === next)!.id;
  writeCallRow(h.services as RuntimeServices, nextRow, (record) => ({ ...record, joined: [{ participant: 'device:pc', name: 'office-pc', pc: 'dev_server' }] }));
  h.log.end(next, PC.key);
  assert.ok(h.record(next).endedAt !== undefined, 'nobody reachable takes it: it ends');
});

test('rpc: calls.start with join joins the running call beside the holder (joined), the voice conversation finds it, the phone\'s connection makes only it leave', async (t) => {
  const table = s1Table();
  calls(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  f.org.add(agent('ag_jonas', 'Jonas'));
  createCalls(f.services as RuntimeServices, { voice: fakeVoice(() => '').opener });
  t.after(() => stopCalls(f.services));
  const chat = f.chats.create({ agentIds: ['ag_jonas'], createdBy: HUMAN_ID });
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, PHONE);
  const record = (id: string) => f.chats.messages(chat.id, { limit: 20 }).map((m) => callRecord(m)).find((call) => call?.id === id)!;
  const { callId } = await owner.call<{ callId: string }>('calls.start', { conversationId: chat.id });
  await assert.rejects(phone.call('calls.start', { conversationId: chat.id, join: true }), /join/);
  assert.deepEqual(await phone.call('calls.start', { conversationId: chat.id, callId, join: true }), { callId, holder: '/device:dev_phone', joined: true });
  assert.deepEqual(await phone.call('calls.start', { conversationId: chat.id }), { callId, holder: '/device:dev_phone', joined: true }, 'the voice conversation\'s own start finds it');
  assert.deepEqual(await owner.call('calls.start', { conversationId: chat.id }), { callId, holder: '/device:pc' }, 'the holder');
  assert.deepEqual(record(callId).joined?.map((device) => device.participant), ['device:dev_phone']);
  phone.detach();
  assert.deepEqual([record(callId).joined, record(callId).endedAt], [undefined, undefined], 'only the phone left');
  await owner.call('calls.end', { callId });
  assert.ok(record(callId).endedAt !== undefined);
});
