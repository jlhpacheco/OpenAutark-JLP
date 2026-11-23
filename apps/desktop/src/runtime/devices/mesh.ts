// DeviceService: the linked PCs – peers, each home of its own data, one live connection each (pinned keys, channel.ts).
// Owns: storing a proven PC (`add`, after the connect flow of remote/* or the roster), peer connections (one per linked
// PC), their status, forwarding calls (dialing on demand), the exchange of addresses, the method registry, rename/revoke.
// Dialing (reach.ts): stored and meeting-seen addresses at once (never this PC's own), WebRTC, then a tunnel through the
// meeting server (`setMeeting`). `reconnect()` dials every linked PC without a live link (start, resume/unlock/online,
// the peer listener opened). Only the smaller deviceId retries with backoff (≤ 30 s; both in a row's first minute) – not
// after a refusal (4003), except once right after linking (mesh-retry.ts); if both dial at once, the smaller id's link
// stays (once per race window). B-077/B-087: both ends ping every 15 s (keepalive.ts) and only the keepalive judges a live
// link; a close soon after a trigger found it live gets one retry on the larger id too (TRIGGER_MS, 5 s); a PC already
// offline stays 'offline' while redialed; dials, closes (with their code) and refusals are info lines.
// 19.11.2026: `bye` tells every live link why this PC goes, a received `device.bye` is Device.away until the link is back
// (away.ts; a 'left' one drops the PC); `wake` sends a signed wake to an own PC's wake helper (`setWaker`, wake.ts); start() announces the wake key.
// Addresses: at link-up and on every change of this PC's addresses or caps each PC sends both (`device.addresses`); the
// receiver keeps that list plus one older address and the caps as sent (a phone attached to one PC shows in every PC's
// prompt, phone/linked.ts). Link kinds (sync/home.ts): an employee's PC (`personId`) reaches only methods registered for
// 'employee' (ping, caps, addresses, bye, sync.rows of its person – sync/employee.ts – and what a module opens with
// `register(m, h, kinds)`, e.g. device.sibling, calendar.ask); my own PCs and an employer reach every other method.
// Never: links a PC without a finished connect flow, polls (only backoff timers), cuts a live link or runs tools itself.

import type { Bus } from '../bus.ts';
import type { Clock, DeviceService, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Device, DeviceCaps } from '../../shared/model/devices.ts';
import { acceptSecure, type SocketLike } from './channel.ts';
import type { DeviceIdentity } from './identity.ts';
import { b64url, fingerprintOf, fromB64url } from './keys.ts';
import { validAddress, type PeerInfo } from './pair-proof.ts';
import { DevicesRepo, publicDevice, type DeviceRecord } from './repo.ts';
import { MAX_ADDRESSES, mergeAddresses, openChannel, firstOpen, seenText, type MeshMeeting } from './reach.ts';
import type { Timers } from '../schedules/scheduler.ts';
import type { DeviceLoad } from './load.ts';
import { withLink } from './link-quality.ts';
import { RpcPeer, type PeerHandler } from './rpc-peer.ts';
import { FRESH_MS, MeshRetries, TRIGGER_MS, TRIGGER_STEP, pairedWithin, realTimers } from './mesh-retry.ts';
import { BYE_METHOD, awayOf, isLeft, sayBye, type ByeReason } from './away.ts';
import { sendWake, wakeKey, type Waker } from './wake.ts';

export type { Timers };
export { BACKOFF_MS } from './mesh-retry.ts';

export interface MeshDeps {
  db: Db;
  identity: DeviceIdentity;
  clock: Clock;
  log: Logger;
  bus: Bus;
  /** Opens a WebSocket to a peer runtime at its base URL (compose/peer-dial.ts maps it to ws(s)://…/peer). */
  dial(address: string): Promise<SocketLike>;
  timers?: Timers;
  load?(): DeviceLoad; // this PC's load, answered with every ping (load.ts; devices.list shows it)
}

/** Two links attached this close together count as simultaneous dials (tie-break below). */
const RACE_MS = 10_000;
/** The longest a single liveness ping waits for its answer (devices.list, list-tool.ts); it never cuts a link. */
export const PROBE_MS = 5_000;
export const ADDRESSES_METHOD = 'device.addresses';
/** Which links reach a method: 'ceo' (my own PCs), 'employee' (a PC that joined here as an employee), 'employer'. */
export type LinkKind = 'ceo' | 'employee' | 'employer';
export const EVERY_LINK: readonly LinkKind[] = ['ceo', 'employee', 'employer'];
const kindOf = (record: DeviceRecord | undefined): LinkKind => (record?.personId ? 'employee' : record?.joinedAs === 'employee' ? 'employer' : 'ceo');
/** What a dial to a (valid) address reaches: scheme, host and port (compose/peer-dial.ts sets the path itself). */
const originOf = (address: string): string => new URL(address).origin;

/**
 * `raced`: this link already closed one dial of the other PC in the race window (B-087: a second one replaces it).
 * `triggeredAt`: when a trigger (resume, unlock, online) last found it live – a close within TRIGGER_MS gets one retry on
 * the larger id too (B-087).
 */
interface Link { peer: RpcPeer; dialer: string; at: number; raced?: boolean; triggeredAt?: number }

/** Nothing was sent: the device is unknown, revoked, or the mesh is closed. */
const notLinked = (deviceId: string) => new WorkforceError('not_found', 'This device is not linked.', { details: { deviceId, reachable: false } });
/** Stopped before anything was sent (reachable: false → a plain failure, not an unknown effect). */
const cancelled = (deviceId: string) => new WorkforceError('cancelled', 'Cancelled.', { details: { deviceId, reachable: false } });

export class DeviceMesh implements DeviceService {
  private readonly deps: MeshDeps;
  private readonly repo: DevicesRepo;
  private readonly timers: Timers;
  private links = new Map<string, Link>();
  private dialing = new Map<string, Promise<RpcPeer>>();
  private readonly retries: MeshRetries;
  /** Linked PCs whose last dial failed or whose link closed (status 'offline'). */
  private unreachable = new Set<string>();
  private handlers = new Map<string, { handler: PeerHandler; kinds: ReadonlySet<LinkKind> }>();
  private meeting?: MeshMeeting;
  private waker?: Waker;
  /** The addresses and caps this PC last sent its links (a change goes out, sendAddresses). */
  private ownState = '';
  private closed = false;

  constructor(deps: MeshDeps) {
    this.deps = deps;
    this.repo = new DevicesRepo(deps.db);
    this.timers = deps.timers ?? realTimers;
    this.retries = new MeshRetries(this.timers, (deviceId) => { void this.connect(deviceId).catch(() => undefined); });
    this.register('ping', async (_params, from) => ({ ok: true, at: deps.clock.now(), ...(deps.load && kindOf(this.repo.get(from)) === 'ceo' ? { load: deps.load() } : {}) }), EVERY_LINK); // load: my own PCs only
    this.register('device.caps', async () => this.self().caps, EVERY_LINK);
    this.register(ADDRESSES_METHOD, async (params, from) => this.received(params, from), EVERY_LINK);
    this.register(BYE_METHOD, async (params, from) => { if (isLeft(params)) setTimeout(() => { try { this.revoke(from); } catch { /* gone already */ } }, 0); else { const away = awayOf(params, deps.clock.now()); if (away && this.repo.patch(from, { away })) this.emit(from); } return { ok: true }; }, EVERY_LINK); // a PC that left: dropped after this answer
  }

  // ---------------------------------------------------------------- DeviceService

  self(): Device {
    return publicDevice(this.repo.get(this.deps.identity.deviceId)!);
  }

  list(): Device[] {
    return this.repo.list().map((record) => this.view(record));
  }

  online(deviceId: string): boolean {
    if (deviceId === this.deps.identity.deviceId) return true;
    const link = this.links.get(deviceId);
    return Boolean(link && !link.peer.channel.closed);
  }

  /** Runs `method` on a device; a linked PC without a live link is dialed first. A stop during the dial sends nothing. */
  async call(deviceId: string, method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    if (deviceId === this.deps.identity.deviceId) {
      const entry = this.handlers.get(method);
      if (!entry) throw new WorkforceError('not_found', `Unknown device method ${method}.`);
      return entry.handler(params, deviceId, signal ?? new AbortController().signal);
    }
    const peer = await this.connectUntil(deviceId, signal);
    if (signal?.aborted) throw cancelled(deviceId);
    return peer.call(method, params, { signal, timeoutMs, ...(method === 'tools.call' ? { timeoutMs: 2 ** 31 - 1 } : {}) }); // a tool's own limits and the turn's stop bound it
  }

  // ---------------------------------------------------------------- management

  /** The one extension point for peer methods of any module; `kinds`: the links that reach it (EVERY_LINK: employees' PCs too). */
  register(method: string, handler: PeerHandler, kinds: readonly LinkKind[] = ['ceo', 'employer']): void {
    this.handlers.set(method, { handler, kinds: new Set(kinds) });
  }

  /** The meeting server's extra ways in, and (setWaker) the connection a wake goes through (wake.ts) – undefined: none. */
  setMeeting(meeting: MeshMeeting | undefined): void { this.meeting = meeting; }
  setWaker(waker: Waker | undefined): void { this.waker = waker; }
  /** Before a deliberate stop: why this PC goes, to every live link (away.ts, at most BYE_MS). */
  bye(reason: ByeReason): Promise<void> { return sayBye([...this.links.values()].filter((link) => !link.peer.channel.closed).map((link) => link.peer), reason); }
  /** Wakes a linked own PC whose app is closed, through its wake helper (wake.ts). */
  wake(deviceId: string): Promise<void> { return sendWake(this.waker, this.repo.get(deviceId), (data) => this.deps.identity.sign(data), this.deps.clock.now()); }

  /** This PC's identity as the connect flow presents it. */
  selfInfo(): PeerInfo {
    const self = this.repo.get(this.deps.identity.deviceId)!;
    return { id: self.id, name: self.name, role: 'home', pub: b64url(this.deps.identity.publicKey), addresses: self.addresses.filter(validAddress).slice(0, MAX_ADDRESSES) };
  }

  /**
   * Stores a PC the connect flow proved (remote/*) and connects: the requester ('joiner') dials at
   * once, the accepting side waits for that dial and retries after the first backoff step.
   * A device id with another key is never that PC, and a key another device holds never a second one: refused, nothing changes.
   */
  add(info: PeerInfo, options: { side: 'joiner' | 'inviter'; personId?: string; joinedAs?: 'ceo' | 'employee' }): Device {
    if (info.id === this.deps.identity.deviceId) throw new WorkforceError('bad_request', 'A device cannot link with itself.');
    const existing = this.repo.get(info.id);
    const active = existing && !existing.revokedAt && existing.status !== 'revoked';
    if (active && (existing.kind !== 'pc' || existing.publicKey !== info.pub)) {
      throw new WorkforceError('forbidden', 'This device id already belongs to a linked device with another key. Remove that device first.');
    }
    const holder = this.repo.byFingerprint(fingerprintOf(fromB64url(info.pub))); // one key, one device (mine included)
    if (holder && holder.id !== info.id) throw new WorkforceError('forbidden', 'This key already belongs to another device.');
    const now = this.deps.clock.now();
    const record = this.repo.upsert({
      id: info.id, name: info.name, kind: 'pc', role: 'home', fingerprint: fingerprintOf(fromB64url(info.pub)), publicKey: info.pub,
      addresses: info.addresses, caps: active ? existing.caps : {}, status: 'offline', self: false, pairedAt: now, lastSeenAt: now,
      ...(options.personId ? { personId: options.personId } : {}), ...(options.joinedAs ? { joinedAs: options.joinedAs } : {}),
    });
    this.emit(record.id);
    this.linked(record.id, options.side);
    return this.view(record);
  }

  /** Updates this device's advertised addresses/caps/name; new addresses and caps go to every online PC. */
  updateSelf(patch: { addresses?: string[]; caps?: DeviceCaps; name?: string }): Device {
    const current = this.repo.get(this.deps.identity.deviceId)!;
    const next = this.repo.patch(current.id, {
      addresses: patch.addresses ?? current.addresses,
      caps: patch.caps ? { ...current.caps, ...patch.caps } : current.caps,
      name: patch.name ?? current.name,
    })!;
    this.deps.bus.emit('device.upserted', publicDevice(next));
    const own = JSON.stringify([next.addresses, next.caps]);
    if (own !== this.ownState) {
      this.ownState = own;
      for (const id of this.links.keys()) if (this.online(id)) this.sendAddresses(id);
    }
    return publicDevice(next);
  }

  rename(id: string, name: string): Device {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new WorkforceError('bad_request', 'Name is empty.');
    const next = this.repo.patch(id, { name: clean });
    if (!next) throw new WorkforceError('not_found', 'Device not found.');
    this.deps.bus.emit('device.upserted', this.view(next));
    return this.view(next);
  }

  revoke(id: string): void {
    if (id === this.deps.identity.deviceId) throw new WorkforceError('bad_request', 'This device cannot remove itself.');
    const next = this.repo.patch(id, { status: 'revoked', revokedAt: this.deps.clock.now() });
    if (!next) throw new WorkforceError('not_found', 'Device not found.');
    this.cancelRetry(id);
    const link = this.links.get(id);
    this.links.delete(id);
    this.unreachable.delete(id);
    link?.peer.stop();
    this.deps.bus.emit('device.upserted', publicDevice(next));
  }

  /** Called once at startup, after the peer listener is up: connects every linked PC. */
  start(): void { this.updateSelf({ caps: { wakeKey: wakeKey(this.deps.db, this.deps.clock.now()).pub } }); this.reconnect(); }

  /**
   * Dials every linked PC without a live link (event-driven, never a timer). A live link is the keepalive's to judge;
   * if it closes within TRIGGER_MS, the larger id retries it once too (`triggeredAt`), after the smaller id's first step.
   */
  reconnect(): void {
    if (this.closed) return;
    for (const record of this.repo.list({ kinds: ['pc'] })) {
      if (!this.linkable(record)) continue;
      const link = this.links.get(record.id);
      if (link && !link.peer.channel.closed) link.triggeredAt = this.deps.clock.now();
      else this.redial(record.id);
    }
  }

  /** A PC was just added: the joiner dials at once; the inviter waits for that dial and retries after the first step. */
  linked(deviceId: string, side: 'joiner' | 'inviter'): void {
    if (this.closed || this.online(deviceId)) return;
    this.unreachable.delete(deviceId);
    this.cancelRetry(deviceId);
    if (side === 'joiner') { void this.connect(deviceId).catch(() => undefined); return; }
    this.emit(deviceId); // connecting
    this.scheduleRetry(deviceId);
  }

  close(): void {
    this.closed = true;
    this.retries.clear();
    for (const link of this.links.values()) link.peer.stop();
    this.links.clear();
  }

  // ---------------------------------------------------------------- connections

  /** Server side of `/peer` (the HTTP server, the peer listener or a meeting-server tunnel); undefined: the other link stays (race). */
  async accept(socket: SocketLike, expect?: string): Promise<string | undefined> { // expect: only this PC (pc-rtc.ts)
    const channel = await acceptSecure(socket, this.signer(), (peerPub) => {
      const record = this.repo.byFingerprint(fingerprintOf(peerPub));
      return record && this.linkable(record) && record.publicKey === b64url(peerPub) && (!expect || record.fingerprint === expect) ? record.id : undefined;
    }); (socket as { trusted?: () => void }).trusted?.(); // a data channel (rtc-socket.ts) lifts its pre-handshake caps
    const peer = this.peerOf(channel.peerId, channel);
    return this.attach(channel.peerId, peer, channel.peerId) === peer ? channel.peerId : undefined;
  }

  /** Returns a live connection to a linked PC, dialing it if needed. */
  connect(deviceId: string): Promise<RpcPeer> {
    const live = this.links.get(deviceId);
    if (live && !live.peer.channel.closed) return Promise.resolve(live.peer);
    const inflight = this.dialing.get(deviceId);
    if (inflight) return inflight;
    const record = this.repo.get(deviceId);
    if (this.closed || !record || !this.linkable(record)) return Promise.reject(notLinked(deviceId));
    const attempt = this.dial(record).then(
      (peer) => { this.dialing.delete(deviceId); return peer; },
      (error: unknown) => {
        this.dialing.delete(deviceId);
        if (error instanceof WorkforceError && error.code === 'unavailable') {
          const was = this.unreachable.has(deviceId);
          this.unreachable.add(deviceId);
          if (!was) this.emit(deviceId); // B-087: a PC already offline is not announced again on every retry
          // the other PC unlinked this one – or, right after linking, has not stored this one yet (one more dial)
          if (error.details?.refused) this.retries.refused(deviceId, this.repo.get(deviceId)?.pairedAt, this.deps.clock.now());
          else this.scheduleRetry(deviceId);
        }
        throw error;
      },
    );
    this.dialing.set(deviceId, attempt);
    if (!this.unreachable.has(deviceId)) this.emit(deviceId); // connecting (B-087: a PC already offline stays offline while redialed)
    return attempt;
  }

  private connectUntil(deviceId: string, signal?: AbortSignal): Promise<RpcPeer> {
    if (!signal) return this.connect(deviceId);
    if (signal.aborted) return Promise.reject(cancelled(deviceId));
    return new Promise((resolve, reject) => {
      const stop = () => reject(cancelled(deviceId));
      signal.addEventListener('abort', stop, { once: true });
      void this.connect(deviceId).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  /**
   * Direct first: every stored and meeting-seen address is opened at once and the first socket that
   * opens runs the handshake; else WebRTC agreed on through the meeting server; else a tunnel through it. `refused`: a socket opened and
   * the other PC closed it before answering the handshake – it does not accept this PC.
   */
  private async dial(record: DeviceRecord): Promise<RpcPeer> {
    const deviceId = record.id;
    // B-087: never this PC's own addresses – the same adapter address on both PCs (VirtualBox, a hotspot) or the router's
    // mapped address would reach this PC itself first, and the real socket would close as the loser
    const own = new Set((this.repo.get(this.deps.identity.deviceId)?.addresses ?? []).filter(validAddress).map(originOf));
    const direct = [...new Set([...record.addresses, ...(this.meeting?.addresses(record) ?? [])])].filter((address) => validAddress(address) && !own.has(originOf(address)));
    const routes: Array<() => Promise<SocketLike>> = [];
    if (direct.length) routes.push(() => firstOpen(direct.map((address) => () => this.deps.dial(address))));
    routes.push(() => this.meeting?.rtc?.(record) ?? Promise.reject(new Error('no direct path')), () => this.meeting?.tunnel(record) ?? Promise.reject(new Error('not at the meeting server')));
    const live = () => { const link = this.links.get(deviceId); return link && !link.peer.channel.closed ? link.peer : undefined; };
    const result = await openChannel(routes, this.signer(), record.fingerprint, () => Boolean(live()));
    if ('stale' in result) {
      const peer = live();
      if (peer) return peer; // the link the other PC dialed meanwhile stays
    } else if ('channel' in result) {
      const peer = this.attach(deviceId, this.peerOf(deviceId, result.channel), this.deps.identity.deviceId);
      if (peer.channel === result.channel) this.deps.log.info('peer dialed', { deviceId }); // accepted links log 'peer connected' (http/peer.ts)
      return peer;
    }
    const { refused, error } = 'stale' in result ? { refused: false, error: new Error('the link that came up meanwhile closed again') } : result;
    // A refusal is rare and ends the retries: worth an info line; a PC that is off fails quietly every 30 s.
    this.deps.log[refused ? 'info' : 'debug']('device dial failed', { deviceId, refused, error: String((error as Error)?.message ?? error) });
    const latest = this.repo.get(deviceId) ?? record;
    const message = `${latest.name} is not reachable (${seenText(latest.lastSeenAt, this.deps.clock.now())}).`;
    throw new WorkforceError('unavailable', message, { details: { deviceId, reachable: false, ...(refused ? { refused } : {}) } });
  }

  /** An RpcPeer for `deviceId`: its link kind reaches the methods registered for that kind. */
  private peerOf(deviceId: string, channel: ConstructorParameters<typeof RpcPeer>[0]): RpcPeer {
    return new RpcPeer(channel, (method) => {
      const entry = this.handlers.get(method);
      const kind = kindOf(this.repo.get(deviceId));
      if (!entry || entry.kinds.has(kind)) return entry?.handler;
      return async () => { throw new WorkforceError('forbidden', kind === 'employee' ? 'An employee\'s PC does not run tools on this PC.' : 'This link does not run that method on this PC.'); };
    });
  }

  private redial(deviceId: string): void {
    this.cancelRetry(deviceId);
    void this.connect(deviceId).catch(() => undefined); // a failure schedules the retry
  }

  /** Makes `peer` the link to `deviceId` and returns the link that stays (see the tie-break). */
  private attach(deviceId: string, peer: RpcPeer, dialer: string): RpcPeer {
    const record = this.repo.get(deviceId);
    if (this.closed || !record || !this.linkable(record)) {
      peer.channel.close();
      throw notLinked(deviceId);
    }
    const now = this.deps.clock.now();
    const current = this.links.get(deviceId);
    if (current && current.peer !== peer && !current.peer.channel.closed) {
      // Both sides dialed at once: each side keeps the link dialed by the smaller id. B-087: once – a second dial of the
      // other PC shows it does not hold that link (live 09.11.: 20 of its dials closed in 10 s while nothing synced).
      const smaller = this.deps.identity.deviceId < deviceId ? this.deps.identity.deviceId : deviceId;
      if (current.dialer === smaller && dialer !== smaller && now - current.at < RACE_MS && !current.raced) {
        current.raced = true;
        peer.channel.close();
        return current.peer;
      }
      current.peer.channel.close();
    }
    const link: Link = { peer, dialer, at: now };
    this.links.set(deviceId, link);
    this.unreachable.delete(deviceId);
    this.cancelRetry(deviceId);
    this.markSeen(deviceId, 'online');
    peer.channel.onClose((code, why) => {
      if (this.links.get(deviceId) !== link) return;
      this.links.delete(deviceId);
      this.unreachable.add(deviceId);
      this.markSeen(deviceId, 'offline');
      // B-087: the close a trigger led to gets one retry on the larger id too – after this PC slept, the other PC may sit
      // in its 30 s backoff (the probe that redialed at once is gone). At 5 s: when the smaller id saw the close as well,
      // its own 1 s dial comes first and its link cancels this one, so both PCs never dial at once.
      const keeps = this.keeps(deviceId);
      const once = !keeps && link.triggeredAt !== undefined && this.deps.clock.now() - link.triggeredAt < TRIGGER_MS;
      if (!this.closed) this.deps.log.info('peer link closed', { deviceId, code, retries: keeps || once, ...why }); // why: a socket error's cause (channel.ts)
      if (keeps || once) this.retries.schedule(deviceId, keeps ? 0 : TRIGGER_STEP);
    });
    void peer.call('device.caps', null, { timeoutMs: 10_000 }).then(
      (caps) => { if (caps && typeof caps === 'object') { this.repo.patch(deviceId, { caps: caps as DeviceCaps }); this.emit(deviceId); } }, // F25: windows and main hear its caps (its version)
      () => undefined,
    );
    this.sendAddresses(deviceId);
    return peer;
  }

  /** `device.addresses` from an authenticated linked PC: its own list becomes the truth (plus one older one), and its
   *  caps as it sends them now (an older PC sends none: the ones it answered at link-up stay). */
  private received(params: unknown, from: string): { ok: true } {
    const sent = (params ?? {}) as { addresses?: unknown; caps?: unknown };
    const addresses = Array.isArray(sent.addresses) ? sent.addresses.filter((item): item is string => typeof item === 'string' && validAddress(item)).slice(0, MAX_ADDRESSES) : [];
    const record = this.repo.get(from);
    if (!record || !this.linkable(record)) return { ok: true };
    const next = mergeAddresses(addresses, record.addresses);
    if (JSON.stringify(next) !== JSON.stringify(record.addresses)) this.repo.patch(from, { addresses: next });
    const caps = sent.caps && typeof sent.caps === 'object' && !Array.isArray(sent.caps) ? (sent.caps as DeviceCaps) : undefined;
    if (caps && JSON.stringify(caps) !== JSON.stringify(record.caps)) { this.repo.patch(from, { caps }); this.emit(from); }
    return { ok: true };
  }

  private sendAddresses(deviceId: string): void {
    const addresses = this.selfInfo().addresses;
    const caps = this.self().caps; // with them, so a phone that attaches here shows on that PC too (phone/linked.ts)
    const peer = this.links.get(deviceId)?.peer;
    void peer?.call(ADDRESSES_METHOD, { addresses, caps }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  /** A linked PC this mesh connects to: not revoked, not this PC. */
  private linkable(record: DeviceRecord): boolean {
    return record.kind === 'pc' && !record.self && !record.revokedAt && record.status !== 'revoked' && record.status !== 'pairing';
  }

  /** The side with the smaller deviceId keeps the link: it alone retries after a close or failure – both do in a row's first minute. */
  private keeps(deviceId: string): boolean {
    const record = this.closed ? undefined : this.repo.get(deviceId);
    if (!record || !this.linkable(record)) return false;
    return this.deps.identity.deviceId < deviceId || pairedWithin(record.pairedAt, this.deps.clock.now(), FRESH_MS);
  }

  private scheduleRetry(deviceId: string): void { if (this.keeps(deviceId)) this.retries.schedule(deviceId); }

  private cancelRetry(deviceId: string): void { this.retries.cancel(deviceId); }

  private markSeen(deviceId: string, status: 'online' | 'offline'): void {
    if (this.repo.patch(deviceId, { status, lastSeenAt: this.deps.clock.now(), ...(status === 'online' ? { away: undefined } : {}) })) this.emit(deviceId); // back: its goodbye is over
  }

  private emit(deviceId: string): void { const record = this.repo.get(deviceId); if (record) this.deps.bus.emit('device.upserted', this.view(record)); }

  private view(record: DeviceRecord): Device { return withLink(publicDevice({ ...record, status: this.statusOf(record) })); } // G: the connection now (link-quality.ts)

  private statusOf(record: DeviceRecord): Device['status'] {
    if (record.revokedAt) return 'revoked';
    if (record.self) return 'online';
    if (record.kind !== 'pc') return record.status;
    if (this.online(record.id)) return 'online';
    return this.unreachable.has(record.id) ? 'offline' : 'connecting'; // B-087: offline while redialed, no flip per retry
  }

  private signer() { const id = this.deps.identity; return { deviceId: id.deviceId, publicKey: id.publicKey, sign: (data: Uint8Array) => id.sign(data) }; }
}
