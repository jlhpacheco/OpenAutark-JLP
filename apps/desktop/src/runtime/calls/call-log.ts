// A call is one value in its chat (owner 04.11.2026: "ein Anrufprotokoll … auf diese Bubble … draufklicken"): one quiet
// status row per call, written only by the PC of the device the person calls from. calls.start opens it (or returns the
// device's call open in that chat); its meta.call (shared/model/call.ts CallRecord) is the call: id, the device
// (participant 'device:<key>', name), startedAt, endedAt and the lines – every line after the row in that chat (the
// person's, every agent's answer, also one synced from the agent's home PC; a quiet line only with this call's id), the
// newest CALL_LINES. The row syncs like any message; one writer means no conflicts. It ends with calls.end, its device's
// connection closing, or this runtime stopping (then at the next start, endLeftOpen, at its last line). A line follows its
// row for good: an edit gives it the new text, a deletion takes it out – in every call row this PC wrote, also by sync.
// B-081: a device takes a call (it answers an agent's ring, ring.ts, or takes over from another device): the row becomes
// that device's and this PC writes it from then on. A PC whose open call shows another holder in the synced row lets it go
// without an end (`gone`): a late line of the old device still joins that call instead of opening a second bubble.
// KI-Runde 17.11.2026: `running` and `inCall` say which calls run on this PC and whether an agent is in one (the context
// fold starts no turn then); `onStart`/`onEnd` tell the call's voice (talker.ts) – an end without a hand-over when the call
// left this PC another way (another PC took it, its row was deleted).
// Owner 19.11.2026 ("mit dem anderen Gerät auch noch reingehen"): more devices join a running call (joinDevice) and stand
// in record.joined. A device leaves alone; when the holder leaves, the next device holds the call – one of this PC first,
// else one whose PC is reachable (that PC writes it from then on) – and it ends with the last one. A join or leave is a
// quiet note of the call in its chat ("laptop joined the call", details {callId, device, left}), a transcript line, and only
// the PC that holds the call writes it into the row. A device of this PC in a call another PC holds is a guest here: its
// lines join that call (plain ones marked relay for the holder PC's voice), and the row naming it the holder makes this PC
// the writer. A line naming a running call its device is not in (its connection had closed) joins it again – not one of a
// device that left with calls.end or was taken over (`gone`).
// Team-Call 21.11.2026: a device names its person (personHere). A note for another person's PC holding the call goes there
// by the mesh (call-peer.ts – that link's sync carries no system rows). The holder leaving while only other people's
// devices are in hands nothing on: the call stays with this PC (holderOut) until the last one is out, or it is back (again).
// Owns: the open calls, their rows and lines, the devices in them, the takes, the list kept for the next start (kv
// 'calls'/'open') and who is told of an end. Never: audio, wakes, rings, a line's own row or another PC's call row.

import { WorkforceError } from '../../shared/errors.ts';
import { SYSTEM_ID, newId } from '../../shared/ids.ts';
import { CALL_LINES, callHolder, callMember, callRecord, callState, type CallDevice, type CallJoin, type CallRecord } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { callRowId, callRunning, deviceNote, followLines, lineOf, notedDevice, personHere, quiet, thisPc, withoutDevices, writeCallRow } from './call-row.ts';
import { noteByPeer, otherPerson } from './call-peer.ts';
import { KvRepo } from '../store/kv.ts';

const KV_NS = 'calls';
const KV_KEY = 'open';

/** A device of this PC in a call; its connection closing makes it leave (`off` stops that). */
interface Member { device: CallDevice; off: () => void }
/** A call this PC writes: its holder (a device of this PC) and the devices of this PC joined beside it. */
interface OpenCall { id: string; rowId: string; conversationId: string; seq: number; holder: Member; joined: Member[] }
/** Owner 19.11.2026: a call another PC holds that devices of this PC joined. */
interface Guest { id: string; rowId: string; conversationId: string; seq: number; members: Member[] }

/** KI-Runde 17.11.2026: a call running on this PC right now – its chat, so the fold and the voice can read the live state. */
export interface RunningCall { callId: string; conversationId: string }

const release = (members: readonly Member[]) => { for (const member of members) member.off(); };

export { callRowId, callRunning, thisPc, writeCallRow } from './call-row.ts'; // their home; named here as before

/** What a take gave: the call, its holder now, whether it answered a ring, and the row as it reads now. */
export interface Taken { callId: string; holder: string; answered: boolean; record: CallRecord }

export class CallLog {
  private readonly services: () => RuntimeServices;
  private readonly calls = new Map<string, OpenCall>();
  /** Owner 19.11.2026: calls another PC holds that devices of this PC joined. */
  private readonly guests = new Map<string, Guest>();
  private readonly listening: Array<() => void>;
  /** Devices that went out of a call – taken over, or left with calls.end ('<callId> <key>', newest last, bounded): a late line of theirs is a line of it, never the device again. */
  private gone: string[] = [];
  /** Who is told that a call of this PC ended (the call voice's hand-over; `handOver` false: it left this PC another way). */
  private ending: Array<(conversationId: string, callId: string, handOver: boolean) => void> = [];
  /** Who is told that a call opened on this PC (the call voice opens its session). */
  private starting: Array<(conversationId: string, callId: string) => void> = [];

  constructor(services: () => RuntimeServices) {
    this.services = services;
    const bus = this.s.bus;
    this.listening = [
      bus.on('message.created', (message) => { this.noted(message); this.heard(message); }),
      bus.on('message.updated', (message) => {
        this.left(message);
        this.guest(message);
        this.heard(message);
        if (message.editedAt !== undefined && message.state === 'final' && !callRecord(message)) this.follow(message.conversationId, message.id, message);
      }),
      bus.on('message.removed', ({ id, conversationId }) => this.follow(conversationId, id)),
    ];
  }

  private get s(): RuntimeServices { return this.services(); }

  /**
   * This device's call in the chat: the one `callId` names or the one open there (also one it joined), else a new row.
   * `signal`: the device's connection – its closing makes it leave. Throws not_found for an unknown chat.
   */
  start(conversationId: string, device: CallDevice, signal?: AbortSignal, callId?: string): string {
    const has = (members: readonly Member[]) => members.some((member) => member.device.key === device.key);
    const named = <T>(map: Map<string, T>) => [...(callId && map.has(callId) ? [map.get(callId)!] : []), ...map.values()];
    const open = named(this.calls).find((call) => call.conversationId === conversationId && has([call.holder, ...call.joined]))
      ?? named(this.guests).find((guest) => guest.conversationId === conversationId && has(guest.members));
    if (open) { this.again(open.id, device, signal); return open.id; }
    if (callId && this.gone.includes(`${callId} ${device.key}`)) return callId; // B-081: it went out of the call (taken over, left); this late line joins it
    const s = this.s;
    if (callId && callRunning(s, conversationId, callId)) {
      try { this.joinDevice(conversationId, callId, device, signal); return callId; } catch { /* not running after all: a call of its own */ }
    }
    if (!s.chats.get(conversationId)) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId } });
    const now = s.clock.now();
    const id = newId('call', now);
    const text = `Call from ${device.name}`;
    const pc = thisPc(s);
    const record: CallRecord = { id, participant: `device:${device.key}`, name: device.name, ...(pc ? { pc } : {}), ...personHere(s), startedAt: now, lines: [] };
    const row = s.chats.send({ conversationId, body: text, kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text }, call: record } });
    this.open({ id, rowId: row.id, conversationId, seq: row.seq, holder: this.member(id, device, signal), joined: [] }, signal);
    return id;
  }

  /**
   * B-081: this device takes the call `callId` of the chat – it answers a ring or takes the call over from another device
   * (also one on another PC: the synced row tells that PC). Refused when the call already ended (a ring that rang out too).
   * The devices joined beside the call stay in it.
   */
  take(conversationId: string, callId: string, device: CallDevice, signal?: AbortSignal): Taken {
    const s = this.s;
    const held = this.calls.get(callId);
    const guest = this.guests.get(callId);
    const { row, record, state } = this.row(conversationId, callId);
    if (state !== 'ringing' && state !== 'running') throw new WorkforceError('conflict', 'The call already ended.', { details: { callId } });
    const now = s.clock.now();
    const pc = thisPc(s);
    const participant = `device:${device.key}`;
    if (held && held.holder.device.key === device.key && record.participant === participant) { this.again(callId, device, signal); return { callId, holder: callHolder(record), answered: false, record }; }
    const stay = [...(held?.joined ?? []), ...(guest?.members ?? [])].filter((member) => { if (member.device.key !== device.key) return true; member.off(); return false; });
    if (held) { held.joined = []; this.letGo(held); } // another device of this PC had it
    this.guests.delete(callId);
    this.back(callId, device.key);
    const answered = state === 'ringing';
    const next: CallRecord = { ...withoutDevices(record, [this.who(device.key)]), participant, name: device.name, ...(pc ? { pc } : {}), ...personHere(s), ...(answered && record.ring ? { ring: { ...record.ring, answeredAt: now } } : {}) };
    if (!pc) delete next.pc;
    delete next.holderOut;
    writeCallRow(s, row.id, () => next);
    this.open({ id: callId, rowId: row.id, conversationId, seq: row.seq, holder: this.member(callId, device, signal), joined: stay }, signal);
    return { callId, holder: callHolder(next), answered, record: next };
  }

  /**
   * Owner 19.11.2026: this device joins the running call `callId` beside the devices already in it (the Join beside Take
   * over); only it leaves again (calls.end, its connection closing). Returns how the call names it (callHolder form).
   */
  joinDevice(conversationId: string, callId: string, device: CallDevice, signal?: AbortSignal): string {
    const { row, record, state } = this.row(conversationId, callId);
    if (state !== 'running') throw new WorkforceError('conflict', 'The call is not running.', { details: { callId } });
    const me = this.who(device.key);
    if (callHolder(record) === me) { this.again(callId, device, signal); return me; } // it holds the call already
    const member = this.member(callId, device, signal);
    const others = (members: readonly Member[]) => members.filter((other) => { if (other.device.key !== device.key) return true; other.off(); return false; });
    const call = this.calls.get(callId);
    if (call) call.joined = [...others(call.joined), member];
    else {
      this.guests.set(callId, { id: callId, rowId: row.id, conversationId, seq: row.seq, members: [...others(this.guests.get(callId)?.members ?? []), member] });
      this.keep(row.id, true);
    }
    this.back(callId, device.key);
    if (!callMember(record, me)) this.note(conversationId, callId, this.entry(device), false);
    if (signal?.aborted) this.end(callId, device.key, true);
    return me;
  }

  /** A device of this PC as a call names it (callHolder form: '<pc>/device:<key>'). */
  who(deviceKey: string): string {
    const pc = thisPc(this.s);
    return callHolder({ ...(pc ? { pc } : {}), participant: `device:${deviceKey}` });
  }

  /** B-081: the holder of an open call of this PC (callHolder of its row), else undefined. */
  holder(callId: string): string | undefined {
    const call = this.calls.get(callId);
    return call ? this.who(call.holder.device.key) : undefined;
  }

  /** B-081: the call's record (open here or in the chat), else undefined. */
  record(conversationId: string, callId: string): CallRecord | undefined {
    const rowId = this.calls.get(callId)?.rowId ?? this.guests.get(callId)?.rowId ?? callRowId(this.s, conversationId, callId);
    const row = rowId ? quiet(() => this.s.chats.message(rowId), undefined) : undefined;
    return row ? callRecord(row) : undefined;
  }

  /** B-081: an agent joins a call of this PC (the talker gave it a line): it is in record.agents from now on. */
  join(conversationId: string, callId: string, agentId: string): void {
    const rowId = this.calls.get(callId)?.rowId ?? callRowId(this.s, conversationId, callId);
    if (rowId) writeCallRow(this.s, rowId, (record) => (record.agents?.includes(agentId) ? record : { ...record, agents: [...(record.agents ?? []), agentId] }));
  }

  /**
   * A device leaves its call (no device: the whole call ends). A joined device leaves alone; the holder gives the call to
   * the next device in it (handOn), and the last one ends it. A device not in the call: forbidden. `dropped`: its
   * connection closed – unlike a leave with calls.end, its next line names the call and is in again.
   */
  end(callId: string, deviceKey?: string, dropped = false): void {
    const guest = this.guests.get(callId);
    if (guest) { this.leaveGuest(guest, deviceKey, dropped); return; }
    const call = this.calls.get(callId);
    if (!call) return;
    if (deviceKey !== undefined && deviceKey !== call.holder.device.key) {
      const out = call.joined.find((member) => member.device.key === deviceKey);
      if (!out) throw new WorkforceError('forbidden', 'This call belongs to another device.');
      out.off();
      call.joined = call.joined.filter((member) => member !== out);
      if (!dropped) this.out(callId, deviceKey);
      this.note(call.conversationId, callId, this.entry(out.device), true);
      return;
    }
    if (deviceKey !== undefined && !dropped) this.out(callId, deviceKey);
    if (deviceKey !== undefined && this.handOn(call)) return;
    this.calls.delete(callId);
    release([call.holder, ...call.joined]);
    this.write(call.rowId, (record) => ({ ...record, endedAt: this.s.clock.now() }));
    this.keep(call.rowId, false);
    // KI-Runde 17.11.2026 (decision 8.4): the call's voice does its last act with the whole call in its session.
    this.tell(call, true);
  }

  /** The listeners of a call's end; `handOver` false: it left this PC without an end here (taken by another PC, its row deleted). */
  private tell(call: OpenCall, handOver: boolean): void {
    for (const listener of this.ending) { try { listener(call.conversationId, call.id, handOver); } catch (error) { this.s.log.warn('call end listener failed', { callId: call.id, error: String(error) }); } }
  }

  /** KI-Runde 17.11.2026: told when a call of this PC ends (the voice's hand-over, wiring.ts); returns its end. */
  onEnd(listener: (conversationId: string, callId: string, handOver: boolean) => void): () => void {
    this.ending.push(listener);
    return () => { this.ending = this.ending.filter((other) => other !== listener); };
  }

  /** KI-Runde 17.11.2026 (decision 7.1): told when a call opens on this PC – started or taken (the voice opens its session); returns its end. */
  onStart(listener: (conversationId: string, callId: string) => void): () => void {
    this.starting.push(listener);
    return () => { this.starting = this.starting.filter((other) => other !== listener); };
  }

  /** KI-Runde 17.11.2026: the calls running on this PC right now (the fold asks whether its agent is in one). */
  running(): RunningCall[] {
    return [...this.calls.values()].map((call) => ({ callId: call.id, conversationId: call.conversationId }));
  }

  /** Whether an agent of this company is in a call running on this PC right now (a member of its chat). */
  inCall(agentId: string): boolean {
    return this.running().some((call) => quiet(() => this.s.chats.members(call.conversationId), []).some((member) => member.memberId === agentId && member.kind === 'agent' && member.leftAt === undefined));
  }

  /** Shutdown: the calls are let go; their rows end at the next start (endLeftOpen), when the end can travel. */
  stop(): void {
    for (const call of this.calls.values()) release([call.holder, ...call.joined]);
    for (const guest of this.guests.values()) release(guest.members);
    this.calls.clear();
    this.guests.clear();
    this.ending = []; // a shutdown is no end of a call: the voice's own stop() handles its open lines
    this.starting = [];
    for (const off of this.listening.splice(0)) off();
  }

  /** Start-up: the calls this PC left open (a stop or a crash) end at their last line; its devices leave the others. Returns how many. */
  endLeftOpen(): number {
    const kv = new KvRepo(this.s.db);
    const left = kv.get<string[]>(KV_NS, KV_KEY) ?? [];
    const pc = thisPc(this.s);
    let ended = 0;
    for (const rowId of Array.isArray(left) ? left : []) {
      // B-081: a row another PC holds by now (it took the call) is that PC's to end; this PC's devices leave it by note.
      const row = quiet(() => this.s.chats.message(rowId), undefined);
      const record = row ? callRecord(row) : undefined;
      if (!row || !record) continue;
      ended++;
      if (record.endedAt !== undefined) continue;
      if (record.pc === pc) this.write(rowId, (current) => ({ ...current, endedAt: current.lines.at(-1)?.at ?? current.startedAt }));
      else for (const device of (record.joined ?? []).filter((entry) => entry.pc === pc)) this.note(row.conversationId, record.id, device, true);
    }
    kv.delete(KV_NS, KV_KEY);
    return ended;
  }

  /** The rows of open calls, kept for the next start (endLeftOpen): a call row joins on start (or a ring) and leaves when it ends. */
  keep(rowId: string, open: boolean): void {
    const kv = new KvRepo(this.s.db);
    const known = kv.get<string[]>(KV_NS, KV_KEY);
    const rows = [...(Array.isArray(known) ? known : []).filter((entry) => entry !== rowId), ...(open ? [rowId] : [])];
    if (rows.length) kv.set(KV_NS, KV_KEY, rows, this.s.clock.now()); else kv.delete(KV_NS, KV_KEY);
  }

  /** The call row of `callId` in the chat, its record and state; not_found without one. */
  private row(conversationId: string, callId: string): { row: Message; record: CallRecord; state: string } {
    const s = this.s;
    const rowId = this.calls.get(callId)?.rowId ?? this.guests.get(callId)?.rowId ?? callRowId(s, conversationId, callId);
    const row = rowId ? quiet(() => s.chats.message(rowId), undefined) : undefined;
    const record = row ? callRecord(row) : undefined;
    if (!row || !record || row.conversationId !== conversationId) throw new WorkforceError('not_found', 'Call not found.', { details: { callId } });
    return { row, record, state: callState(record, s.clock.now()) };
  }

  /** A device of this PC in a call: its connection closing makes it leave. */
  private member(callId: string, device: CallDevice, signal?: AbortSignal): Member {
    const leave = () => { try { this.end(callId, device.key, true); } catch { /* it is out already */ } };
    signal?.addEventListener('abort', leave, { once: true });
    return { device, off: () => signal?.removeEventListener('abort', leave) };
  }

  /** The holder leaves while other devices are in: one of this PC holds the call next, else one on a reachable PC. */
  private handOn(call: OpenCall): boolean {
    const next = call.joined.shift();
    if (next) {
      call.holder.off();
      call.holder = next;
      this.write(call.rowId, (record) => ({ ...withoutDevices(record, [this.who(next.device.key)]), participant: `device:${next.device.key}`, name: next.device.name }));
      return true;
    }
    const pc = thisPc(this.s);
    const reachable = (device: CallJoin) => Boolean(device.pc && device.pc !== pc && quiet(() => this.s.devices.online(device.pc!), false));
    const joined = (this.record(call.conversationId, call.id)?.joined ?? []).filter(reachable);
    const away = joined.find((device) => !otherPerson(this.s, device.pc!));
    if (!away) { // Team-Call: other people are still in – the call stays with this PC, its row says the holder is out
      if (!joined.length) return false;
      call.holder.off();
      return this.write(call.rowId, (record) => ({ ...record, holderOut: true }));
    }
    // that PC writes the call from now on (guest() there); here left() lets it go
    return this.write(call.rowId, (record) => ({ ...withoutDevices(record, [callHolder(away)]), participant: away.participant, name: away.name, pc: away.pc, person: away.person }));
  }

  /** Devices of this PC leave a call another PC holds (no device: all of them), each with its note for the holder PC. */
  private leaveGuest(guest: Guest, deviceKey: string | undefined, dropped: boolean): void {
    const out = guest.members.filter((member) => deviceKey === undefined || member.device.key === deviceKey);
    release(out);
    guest.members = guest.members.filter((member) => !out.includes(member));
    if (!guest.members.length) { this.guests.delete(guest.id); this.keep(guest.rowId, false); }
    for (const member of out) {
      if (!dropped) this.out(guest.id, member.device.key);
      this.note(guest.conversationId, guest.id, this.entry(member.device), true);
    }
  }

  /** How the call row names a device of this PC (CallRecord.joined). */
  private entry(device: CallDevice): CallJoin {
    const pc = thisPc(this.s);
    return { participant: `device:${device.key}`, name: device.name, ...(pc ? { pc } : {}), ...personHere(this.s) };
  }

  /** A device's join or leave as a quiet note of the call (call-row.ts deviceNote): the holder PC writes it into the row (noted). */
  private note(conversationId: string, callId: string, device: CallJoin, left: boolean): void {
    const note = deviceNote(conversationId, callId, device, left); // Team-Call: to another person's PC holding the call by the mesh (its sync takes no system rows)
    try { if (!noteByPeer(this.s, this.record(conversationId, callId)?.pc, conversationId, callId, device, left)) this.s.chats.send(note); } catch (error) { this.s.log.warn('call join note not stored', { callId, error: String(error) }); }
  }

  /** A join or leave note of a call this PC holds (written here or synced): the row's devices follow it. */
  private noted(message: Message): void {
    const noted = notedDevice(message);
    const call = noted ? this.calls.get(noted.callId) : undefined;
    if (!noted || !call || message.conversationId !== call.conversationId) return;
    const who = callHolder(noted.device);
    this.write(call.rowId, (record) => (noted.left ? withoutDevices(record, [who]) : callMember(record, who) ? record : { ...record, joined: [...(record.joined ?? []), noted.device] }));
    const now = this.record(call.conversationId, call.id);
    if (noted.left && now?.holderOut && !now.joined?.length) this.end(call.id); // Team-Call: the last one is out
  }

  /** Team-Call: the holder's device is back in a call it left while other people stayed (holderOut): its connection counts again. */
  private again(callId: string, device: CallDevice, signal?: AbortSignal): void {
    const call = this.calls.get(callId);
    if (!call || call.holder.device.key !== device.key || !this.record(call.conversationId, callId)?.holderOut) return;
    call.holder.off();
    call.holder = this.member(callId, device, signal);
    this.back(callId, device.key);
    this.write(call.rowId, (record) => { const next = { ...record }; delete next.holderOut; return next; });
  }

  /** The device went out of the call with calls.end (or was taken over): a late line of it is a line only. */
  private out(callId: string, deviceKey: string): void {
    const key = `${callId} ${deviceKey}`;
    this.gone = [...this.gone.filter((entry) => entry !== key), key].slice(-50);
  }

  /** The device is in the call again (it joined or took it). */
  private back(callId: string, deviceKey: string): void {
    this.gone = this.gone.filter((entry) => entry !== `${callId} ${deviceKey}`);
  }

  /** Owner 19.11.2026: a device of this PC is a guest in `callId` and the PC that holds it is reachable – that PC's call voice answers the lines said here. */
  relays(conversationId: string, callId: string): boolean {
    const pc = this.guests.has(callId) ? this.record(conversationId, callId)?.pc : undefined;
    return pc !== undefined && quiet(() => this.s.devices.online(pc), false);
  }

  /** A row of a call devices of this PC joined as guests: ended – they go; it names one of them the holder – this PC writes the call from now on. */
  private guest(message: Message): void {
    const record = callRecord(message);
    const guest = record && !this.calls.has(record.id) ? this.guests.get(record.id) : undefined;
    if (!record || !guest) return;
    const holder = guest.members.find((member) => this.who(member.device.key) === callHolder(record));
    if (callState(record, this.s.clock.now()) === 'running' && !holder) return;
    this.guests.delete(guest.id);
    if (holder) this.open({ id: guest.id, rowId: guest.rowId, conversationId: guest.conversationId, seq: guest.seq, holder, joined: guest.members.filter((member) => member !== holder) });
    else { release(guest.members); this.keep(guest.rowId, false); }
  }

  /** A final row of an open call's chat after its row joins its lines (once; edits come through follow). */
  private heard(message: Message): void {
    for (const call of [...this.calls.values()]) {
      const line = lineOf(this.s, call, message);
      if (line) this.write(call.rowId, (record) => (record.lines.some((entry) => entry.messageId === line.messageId) ? record : { ...record, lines: [...record.lines, line].slice(-CALL_LINES) }));
    }
  }

  /**
   * A row was edited (`message`) or deleted: its line follows in every call row of this PC that names it – open or ended –
   * with the new text, or out. A deleted open call row ends that call here: nothing is left to write.
   */
  private follow(conversationId: string, messageId: string, message?: Message): void {
    for (const call of [...this.calls.values()]) {
      if (!message && call.rowId === messageId) { this.calls.delete(call.id); release([call.holder, ...call.joined]); this.keep(call.rowId, false); this.tell(call, false); }
    }
    for (const guest of [...this.guests.values()]) {
      if (!message && guest.rowId === messageId) { this.guests.delete(guest.id); release(guest.members); this.keep(guest.rowId, false); }
    }
    followLines(this.s, conversationId, messageId, message);
  }

  /** A call this PC writes from now: lines join it, the next start knows it, its voice hears it opened (a closed connection: it is out at once). */
  private open(call: OpenCall, signal?: AbortSignal): void {
    this.calls.set(call.id, call);
    this.keep(call.rowId, true);
    if (signal?.aborted) { this.end(call.id, call.holder.device.key); return; }
    for (const listener of this.starting) { try { listener(call.conversationId, call.id); } catch (error) { this.s.log.warn('call start listener failed', { callId: call.id, error: String(error) }); } }
  }

  /** B-081: an open call's row shows another holder (another device took it, here or by sync): it goes without an end. */
  private left(message: Message): void {
    const record = callRecord(message);
    const call = record ? this.calls.get(record.id) : undefined;
    if (record && call && call.rowId === message.id && this.holder(call.id) !== callHolder(record)) { this.letGo(call); this.tell(call, false); }
  }

  /** The call is another device's now: no end is written, a late line of the old device still joins it (start), and the devices of this PC joined beside it stay in as guests. */
  private letGo(call: OpenCall): void {
    this.calls.delete(call.id);
    call.holder.off();
    this.keep(call.rowId, false);
    this.out(call.id, call.holder.device.key);
    if (!call.joined.length) return;
    this.guests.set(call.id, { id: call.id, rowId: call.rowId, conversationId: call.conversationId, seq: call.seq, members: call.joined });
    this.keep(call.rowId, true);
  }

  private write(rowId: string, change: (record: CallRecord) => CallRecord): boolean {
    return writeCallRow(this.s, rowId, change);
  }
}
