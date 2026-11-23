// Team-Call 21.11.2026 (owner: "die sollten ja eigentlich ihr Audio wirklich hören, wie beim WhatsApp-Call … wenn zwei
// Menschen in der Gruppe sind, müssen die joinen können"): a call between people on their own PCs goes over the mesh link of
// those PCs (devices/mesh.ts – the pinned channel, direct or through the meeting server). One peer method 'calls.peer':
//   note   – a device of the sending PC joined or left a call this PC holds (call-log.ts note). The sync of an employee's
//            PC takes only the person's own lines back, so the join note travels this way; it is stored here as the same
//            quiet note, and the row's devices follow it (call-log.ts noted).
//   signal – a WebRTC signal (shared/model/call.ts CallSignal) for this PC's window, emitted as the event calls.signal.
// calls.peers names whom a PC window talks to: the PC windows of the other people in its call – never another window of
// this person (this PC or one of my own PCs: one person's devices may stand in one room, they hear the agent, not each
// other). calls.signal goes only to one of them. The receiving PC checks that the sending PC is the device's PC, the call
// runs here in that chat, and an employee is a member of that chat. Audio never passes here: it goes straight between the
// windows (ui/chat/call/people-audio.ts).
// Owns: that method, the peers and who counts as another person. Never: audio, or writes of the call row (call-log.ts).

import { WorkforceError } from '../../shared/errors.ts';
import { callDevices, callHolder, callMember, callRecord, callSignal, callState, type CallJoin, type CallPeer, type CallRecord, type CallSignal } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { links } from '../devices/sync/home.ts';
import { membership } from '../people/access.ts';
import { callRowId, deviceNote, notedDevice, quiet, thisPc } from './call-row.ts';

export const PEER_METHOD = 'calls.peer';
/** How long a note or signal may take to reach the other PC. */
const SEND_MS = 5_000;
const LINKS = ['ceo', 'employee', 'employer'] as const;

/** The PC `pc` is another person's: an employee's PC here, or the employer's PC on an employee's seat (not one of my own PCs). */
export function otherPerson(s: Pick<RuntimeServices, 'db'>, pc: string): boolean {
  return quiet(() => links(s.db).some(({ record, link }) => record.id === pc && link.kind !== 'ceo'), false);
}

/** The running call `callId` of the chat as this PC reads it, else undefined. */
function runningHere(s: RuntimeServices, conversationId: string, callId: string): CallRecord | undefined {
  const rowId = callRowId(s, conversationId, callId);
  const row = rowId ? quiet(() => s.chats.message(rowId), undefined) : undefined;
  const record = row && row.conversationId === conversationId ? callRecord(row) : undefined;
  return record && callState(record, s.clock.now()) === 'running' ? record : undefined;
}

/** A join or leave of a device here for a call another person's PC (`pc`) holds goes there by the mesh; false: it is written here. */
export function noteByPeer(s: RuntimeServices, pc: string | undefined, conversationId: string, callId: string, device: CallJoin, left: boolean): boolean {
  if (!pc || pc === thisPc(s) || !otherPerson(s, pc)) return false;
  void Promise.resolve().then(() => s.devices.call(pc, PEER_METHOD, { op: 'note', conversationId, callId, device, left }, undefined, SEND_MS))
    .catch((error: unknown) => s.log.warn('call note did not reach the PC holding the call', { callId, error: String(error) }));
  return true;
}

/** Whom the device `deviceKey` of this PC hears in its call: the other people's PC windows in it (only this PC's window talks to them). */
export function callPeers(s: RuntimeServices, conversationId: string, callId: string, deviceKey: string): { me: string; peers: CallPeer[] } {
  const pc = thisPc(s);
  const me = callHolder({ ...(pc ? { pc } : {}), participant: `device:${deviceKey}` });
  const record = runningHere(s, conversationId, callId);
  if (!record || deviceKey !== 'pc' || !callMember(record, me)) return { me, peers: [] };
  const peers = new Map<string, CallPeer>();
  for (const device of callDevices(record)) {
    if (device.participant !== 'device:pc' || !device.pc || device.pc === pc || !otherPerson(s, device.pc)) continue;
    peers.set(callHolder(device), { id: callHolder(device), name: device.person || device.name });
  }
  return { me, peers: [...peers.values()] };
}

/** A signal of this PC's window to one of its peers; false when `to` is no peer now or its PC did not take it. */
export async function sendSignal(s: RuntimeServices, conversationId: string, callId: string, deviceKey: string, to: string, data: CallSignal): Promise<boolean> {
  const { me, peers } = callPeers(s, conversationId, callId, deviceKey);
  if (!peers.some((peer) => peer.id === to)) return false;
  try {
    await s.devices.call(to.slice(0, to.indexOf('/')), PEER_METHOD, { op: 'signal', conversationId, callId, from: me, to, data }, undefined, SEND_MS);
    return true;
  } catch (error) {
    s.log.info('call signal not delivered', { callId, op: data.op, error: String(error).slice(0, 120) });
    return false;
  }
}

interface PeerParams { op?: unknown; conversationId?: unknown; callId?: unknown; device?: unknown; left?: unknown; from?: unknown; to?: unknown; data?: unknown }

/** 'calls.peer' from the linked PC `from` (see the header). */
export function servePeer(s: RuntimeServices, params: unknown, from: string): { ok: true } {
  const o = (params ?? {}) as PeerParams;
  if (typeof o.conversationId !== 'string' || typeof o.callId !== 'string') throw new WorkforceError('bad_request', 'A call and its chat are needed.');
  const record = runningHere(s, o.conversationId, o.callId);
  if (!record) throw new WorkforceError('not_found', 'That call does not run here.');
  const link = quiet(() => links(s.db).find(({ record: peer }) => peer.id === from)?.link, undefined);
  if (link?.kind === 'employee' && !quiet(() => membership(s.db, link.personId, o.conversationId as string), undefined)) throw new WorkforceError('forbidden', 'That person is not in this chat.');
  const pc = thisPc(s);
  if (o.op === 'note') {
    const noted = notedDevice({ kind: 'status', meta: { status: { type: 'note', text: '', details: { callId: o.callId, device: o.device, left: o.left } } } } as unknown as Message);
    if (!noted || noted.device.pc !== from || record.pc !== pc) throw new WorkforceError('forbidden', 'Only the device\'s own PC tells its join, to the PC holding the call.');
    s.chats.send(deviceNote(o.conversationId, o.callId, noted.device, noted.left));
    return { ok: true };
  }
  const data = o.op === 'signal' ? callSignal(o.data) : undefined;
  if (!data || typeof o.from !== 'string' || !o.from.startsWith(`${from}/`) || o.to !== callHolder({ ...(pc ? { pc } : {}), participant: 'device:pc' })) throw new WorkforceError('bad_request', 'Not a call signal for this PC.');
  s.bus.emit('calls.signal', { conversationId: o.conversationId, callId: o.callId, from: o.from, data });
  return { ok: true };
}

/** Opens 'calls.peer' to every link kind on the mesh (a fake without a registry: nothing). */
export function registerCallPeer(s: RuntimeServices): void {
  const mesh = s.devices as unknown as { register?: (method: string, handler: (params: unknown, from: string) => Promise<unknown>, kinds?: readonly string[]) => void } | undefined;
  if (typeof mesh?.register !== 'function') return;
  mesh.register(PEER_METHOD, async (params, from) => servePeer(s, params, from), LINKS);
}
