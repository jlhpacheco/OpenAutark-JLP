// Team-Call 21.11.2026: people on their own PCs in one call (src/runtime/calls/call-peer.ts, call-log.ts, ring.ts). The CEO's
// PC holds a call in a chat it shares with Momo; Momo's PC joins it: the join note goes there by the mesh (that sync takes no
// system rows) and is written there as the same note; the peers of each window are the other people's PC windows, never this
// person's other devices; a signal goes only to a peer and arrives as the event calls.signal after its checks; the holder
// leaving while Momo is still in keeps the call with the CEO's PC (holderOut) until the last one is out, or it is back;
// calls.live on a seat lists running calls, and another person's call says `others`.
// Owns: these assertions only. Never: audio or a real link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { callDeviceNames, callRecord, type CallRecord } from '../../../src/shared/model/call.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { CallLog, writeCallRow } from '../../../src/runtime/calls/call-log.ts';
import { PEER_METHOD, callPeers, sendSignal, servePeer } from '../../../src/runtime/calls/call-peer.ts';
import { Rings } from '../../../src/runtime/calls/ring.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { agent, harness } from '../chat/harness.ts';

const PC = { key: 'pc', name: 'office' };
const pcRecord = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ id, name: id.slice(4), kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra });

/** One PC (`self`) with the chat Momo is in, and the PCs it links to; `sent` collects what goes over the mesh. */
function setup(self: string, profile: string, linked: DeviceRecord[]) {
  const h = harness();
  h.org.add(agent('ag_jonas', 'Jonas'));
  const chat = h.chats.create({ agentIds: ['ag_jonas'], createdBy: HUMAN_ID, lead: 'ag_jonas' });
  h.db.run("INSERT INTO members (conversation_id, member_id, kind, joined_at) VALUES (?, 'per_momo', 'human', 1)", [chat.id]);
  const repo = new DevicesRepo(h.db);
  repo.upsert(pcRecord(self, { self: true }));
  for (const record of linked) repo.upsert(record);
  const sent: Array<{ pc: string; method: string; params: Record<string, unknown> }> = [];
  const signals: unknown[] = [];
  h.bus.on('calls.signal', (event) => signals.push(event));
  Object.assign(h.services, {
    settings: { get: () => ({ profile: { name: profile } }) },
    devices: { online: (id: string) => linked.some((record) => record.id === id), call: async (pc: string, method: string, params: Record<string, unknown>) => { sent.push({ pc, method, params }); return { ok: true }; } },
  });
  const s = h.services as RuntimeServices;
  const log = new CallLog(() => s);
  const record = (callId: string): CallRecord => h.chats.messages(chat.id, { limit: 200 }).map((m) => callRecord(m)).find((call) => call?.id === callId)!;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  return { ...h, s, chat, log, record, sent, signals, tick };
}

test('the CEO\'s PC: Momo\'s join note by the mesh is written there, peers are the other people\'s windows, signals go to a peer only', async () => {
  const h = setup('dev_ceo', 'Dominik', [pcRecord('dev_momo', { personId: 'per_momo' }), pcRecord('dev_laptop')]);
  const id = h.log.start(h.chat.id, PC);
  assert.equal(h.record(id).person, 'Dominik', 'the holder names its person');
  const momo = { participant: 'device:pc', name: 'MacBook', pc: 'dev_momo', person: 'Momo' };
  assert.deepEqual(servePeer(h.s, { op: 'note', conversationId: h.chat.id, callId: id, device: momo, left: false }, 'dev_momo'), { ok: true });
  assert.deepEqual(h.record(id).joined, [momo]);
  assert.equal(callDeviceNames(h.record(id)), 'Dominik and Momo', 'several people by name');
  writeCallRow(h.s, h.chats.messages(h.chat.id, { limit: 50 }).find((m) => callRecord(m)?.id === id)!.id, (record) => ({ ...record, joined: [...record.joined!, { participant: 'device:pc', name: 'laptop', pc: 'dev_laptop', person: 'Dominik' }] }));
  assert.deepEqual(callPeers(h.s, h.chat.id, id, 'pc'), { me: 'dev_ceo/device:pc', peers: [{ id: 'dev_momo/device:pc', name: 'Momo' }] }, 'never my own laptop');
  assert.deepEqual(callPeers(h.s, h.chat.id, id, 'dev_phone').peers, [], 'only the PC window talks to people');

  assert.equal(await sendSignal(h.s, h.chat.id, id, 'pc', 'dev_laptop/device:pc', { op: 'hello' }), false, 'not a peer');
  assert.equal(await sendSignal(h.s, h.chat.id, id, 'pc', 'dev_momo/device:pc', { op: 'offer', sdp: 'v=0' }), true);
  assert.deepEqual(h.sent.at(-1), { pc: 'dev_momo', method: PEER_METHOD, params: { op: 'signal', conversationId: h.chat.id, callId: id, from: 'dev_ceo/device:pc', to: 'dev_momo/device:pc', data: { op: 'offer', sdp: 'v=0' } } });

  servePeer(h.s, { op: 'signal', conversationId: h.chat.id, callId: id, from: 'dev_momo/device:pc', to: 'dev_ceo/device:pc', data: { op: 'answer', sdp: 'v=0' } }, 'dev_momo');
  assert.deepEqual(h.signals, [{ conversationId: h.chat.id, callId: id, from: 'dev_momo/device:pc', data: { op: 'answer', sdp: 'v=0' } }]);
  assert.throws(() => servePeer(h.s, { op: 'signal', conversationId: h.chat.id, callId: id, from: 'dev_momo/device:pc', to: 'dev_ceo/device:pc', data: { op: 'answer', sdp: 'v=0' } }, 'dev_laptop'), /Not a call signal/, 'a PC speaks only for its own devices');
  assert.throws(() => servePeer(h.s, { op: 'note', conversationId: h.chat.id, callId: id, device: { ...momo, pc: 'dev_laptop' }, left: false }, 'dev_momo'), /own PC/);
  h.db.run("UPDATE members SET left_at = 1 WHERE member_id = 'per_momo'");
  assert.throws(() => servePeer(h.s, { op: 'signal', conversationId: h.chat.id, callId: id, from: 'dev_momo/device:pc', to: 'dev_ceo/device:pc', data: { op: 'hello' } }, 'dev_momo'), /not in this chat/);
  assert.throws(() => servePeer(h.s, { op: 'note', conversationId: h.chat.id, callId: 'call_none', device: momo }, 'dev_momo'), /does not run here/);
});

test('the holder leaving while Momo is in keeps the call with this PC (holderOut); it is back with Talk; the last one out ends it', () => {
  const h = setup('dev_ceo', 'Dominik', [pcRecord('dev_momo', { personId: 'per_momo' })]);
  const id = h.log.start(h.chat.id, PC);
  const momo = { participant: 'device:pc', name: 'MacBook', pc: 'dev_momo', person: 'Momo' };
  servePeer(h.s, { op: 'note', conversationId: h.chat.id, callId: id, device: momo, left: false }, 'dev_momo');
  h.log.end(id, PC.key);
  assert.deepEqual([h.record(id).holderOut, h.record(id).pc, h.record(id).endedAt, h.record(id).joined], [true, 'dev_ceo', undefined, [momo]], 'nothing handed to another person\'s PC');
  assert.deepEqual(callPeers(h.s, h.chat.id, id, 'pc').peers, [], 'out: this window hears nobody');
  assert.equal(callDeviceNames(h.record(id)), 'MacBook', 'who is in now');
  assert.equal(h.log.start(h.chat.id, PC), id, 'Talk again: the same call');
  assert.equal(h.record(id).holderOut, undefined, 'back in');
  h.log.end(id, PC.key);
  servePeer(h.s, { op: 'note', conversationId: h.chat.id, callId: id, device: momo, left: true }, 'dev_momo');
  assert.ok(h.record(id).endedAt !== undefined, 'the last one out ends it');
});

test('Momo\'s seat: the join goes to the CEO\'s PC by the mesh (no note here), the call is listed with others, Join only', async () => {
  const h = setup('dev_momo', 'Momo', [pcRecord('dev_ceo', { joinedAs: 'employee' } as Partial<DeviceRecord>)]);
  const far: CallRecord = { id: 'call_ceo', participant: 'device:pc', name: 'office', pc: 'dev_ceo', person: 'Dominik', startedAt: h.clock.now(), lines: [] };
  const row = h.chats.send({ conversationId: h.chat.id, body: 'Call from office', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Call from office' }, call: far } });
  const rings = new Rings({ services: () => h.s, log: h.log, timers: { set: () => 0, clear: () => undefined } });
  assert.deepEqual(rings.live().map((call) => [call.callId, call.others, call.device]), [['call_ceo', true, 'office']], 'a seat lists the running call it shares');
  assert.equal(h.log.joinDevice(h.chat.id, 'call_ceo', PC), 'dev_momo/device:pc');
  await h.tick();
  assert.deepEqual(h.sent.map((entry) => [entry.pc, entry.method, entry.params.op, (entry.params.device as { person?: string }).person]), [['dev_ceo', PEER_METHOD, 'note', 'Momo']]);
  assert.equal(h.chats.messages(h.chat.id, { limit: 50 }).filter((m) => m.meta.status?.details?.callId === 'call_ceo').length, 0, 'the CEO\'s PC writes the note');
  assert.deepEqual(callPeers(h.s, h.chat.id, 'call_ceo', 'pc').peers, [], 'until the row lists this window');
  writeCallRow(h.s, row.id, (record) => ({ ...record, joined: [{ participant: 'device:pc', name: 'office', pc: 'dev_momo', person: 'Momo' }] })); // the CEO's write arrives
  assert.deepEqual(callPeers(h.s, h.chat.id, 'call_ceo', 'pc').peers, [{ id: 'dev_ceo/device:pc', name: 'Dominik' }]);
  rings.stop();
});
