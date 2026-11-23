// The target side of connect requests: another PC asks this PC to connect over POST /peer/pair
// (kinds remote1, remote2, remote3, remoteCancel – remote/sas.ts has the exchange), directly or
// sealed through the meeting server. After remote2 the request shows in Settings › Devices with the
// 4-digit code the other PC shows too (and one notification); the requester's name as plain text.
// The other PC is stored with its proven key – as the CEO's own PC, or an employee's PC with the
// person the accepting side picked – only when the requester collects the acceptance with its
// session key (remote3): one that gave up never leaves a one-sided link. Decline, cancel, 5 minutes
// or requests turned off (closeAll) end it. Limits: only while findable; 3 open; 5 per address per
// 10 minutes; one per PC; remote2 ≤ 60 s.
// B-078 (D5): a phone app asks the same way with role 'phone' and its own key (its device info has role 'client'); an
// instance takes only the roles it is made for (`roles`: PCs here, phones in rendezvous/phone-pair.ts), and what `link`
// returns rides in the accepted answer (a phone's device token – the answer travels sealed through the meeting server).
// B-084: a request may name my own Remote ID or my person code (remote/code.ts); the first answer carries my chain to it.
// F13: Accept of an employee's PC or a phone names its person – one of the people, or a new one (`newPerson`), which `link`
// makes when the device collects the answer, so a requester that gave up leaves no person behind. My own PC (role 'ceo')
// never becomes a person's. The first answer wins: a second one hears the request is no longer open.
// Eine-ID 22.11.2026: this side decides the role from the ID the requester typed (`target.remoteId` in remote1): my own ID
// (remote/code.ts meFor) → 'ceo', one of my devices; the company's ID or this PC's own device ID, or no ID (an address) →
// 'employee', a new member. The requester's own `role` never decides: an older PC asking 'ceo' with any other ID hears to
// update. The answer to remote1 carries `role`, `company` (its name, plain) and the chain that proves the ID asked. The new
// member's proposed name arrives MAC'd with the session key (`remoteName`, kept as `proposedName`); Accept without a name
// or a person takes it. `link` may be async (an admit through the company, devices/company-admit.ts); an `employer` it
// returns rides in the accepted answer with its own MAC (`employerMac`), so the requester links that PC only when proven.
// Review 22.11.2026: a 'ceo' answer also names this PC's person (`person`), so the requester's person says yes to joining
// exactly their devices before anything goes on (remote/join.ts 'confirm').
// Owns: the request lifecycle (in memory only), limits and waiters on this side.
// Never: links without the person's answer, or keeps nonces/keys beyond the request.

import { randomBytes, type KeyObject } from 'node:crypto';
import type { JoinRole, NewPerson, RemoteIncoming } from '../../shared/model/remote.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import { b64url, fingerprintOf, fromB64url } from '../devices/keys.ts';
import { fail, mac, macOk, parseInfo, type PeerInfo, type Reply } from '../devices/pair-proof.ts';
import { codeFor, meFor, type Chain } from './code.ts';
import { remoteIdOf } from './id.ts';
import { bytes, commitment, matchCode, newEphemeral, newNonce, sessionKey, signedBytes, transcript, verifySide } from './sas.ts';

export const REQUEST_TTL_MS = 5 * 60_000;
export const COMMIT_TTL_MS = 60_000;
/** How long an accepted answer stays collectable at least (the requester may be between two waits). */
export const DELIVERY_GRACE_MS = 60_000;
export const MAX_OPEN = 3;
export const PER_ADDRESS = 5;
export const ADDRESS_WINDOW_MS = 10 * 60_000;
export const WAIT_MAX_MS = 55_000;
/** Review L8: remote2 failing is also what two PCs of different versions see (the role is inside the transcript). */
export const IDENTITY_FAILED = 'The other PC could not prove its identity – or one of the two PCs runs an older Autark: update both.';

type Stage = 'committed' | 'shown' | 'accepted' | 'declined' | 'expired' | 'cancelled';
/** How the requester joins: one of the CEO's own PCs, an employee's PC, or the owner's phone app (B-078). */
export type AskRole = JoinRole | 'phone';

interface Request {
  id: string; session: string; role: AskRole; info: PeerInfo; address: string;
  /** The requester's name as shown (plain text); `info.name` stays raw for the transcript. */
  label: string;
  /** This PC's identity as sent in the answer to remote1 (the transcript covers exactly that). */
  mine: PeerInfo;
  eph: KeyObject; ephA: Buffer; ephB: Buffer; na: Buffer; commit: string; t?: Buffer; key?: Buffer; code?: string;
  stage: Stage; expiresAt: number; timer?: unknown; reason?: string; personId?: string; newPerson?: NewPerson; delivered?: boolean;
  /** What `link` handed back for the accepted answer (a phone's token), repeated to a requester that asks again. */
  extras?: Record<string, unknown>;
  /** Eine-ID: the name the new member proposed (remoteName), plain. */
  proposedName?: string;
  /** The one running `link` (a repeated wait awaits the same). */
  linking?: Promise<Reply | undefined>;
  waiters: Set<() => void>;
}

/** What `link` hands back for the accepted answer (a phone's token, the employer PC a new member links). */
type Linked = void | Record<string, unknown>;

export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } // one-shot; tests pass fakes

export interface TargetDeps {
  now(): number;
  timers: Timers;
  /** Is this PC accepting requests now (settings.devices.findable and the peer listener)? */
  findable(): boolean;
  self(): PeerInfo;
  signer: { sign(data: Uint8Array): Buffer };
  /**
   * Stores the accepted device with its proven key (`info.name` already plain); `personId` for an employee's device, or
   * `newPerson` to make that person first (F13). Throws to refuse. Fields it returns join the accepted answer (a phone's
   * device token).
   */
  link(info: PeerInfo, personId: string | undefined, newPerson: NewPerson | undefined, role: AskRole): Linked | Promise<Linked>;
  /** The roles this side takes (default: the CEO's own PCs and employees' PCs). */
  roles?: readonly AskRole[];
  /** Eine-ID: this company's name, told in the answer to remote1 ("Joining Dojo as a new member"). */
  company?(): string;
  /** Review H1: this PC's person, told to a PC that would become one of their devices ("Add this PC to Momo's devices?"). */
  person?(): string;
  /** A request is shown: tell the person once (a notification). */
  shown(view: RemoteIncoming): void;
  changed(): void;
  log: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const PC_ROLES: readonly AskRole[] = ['ceo', 'employee'];

/** A phone app's identity: like a PC's, with role 'client' (pair-proof.ts parseInfo takes the PC roles). */
export function phoneInfo(value: unknown): PeerInfo | undefined {
  const device = value as { role?: unknown } | null;
  if (!device || typeof device !== 'object' || device.role !== 'client') return undefined;
  const info = parseInfo({ ...device, role: 'node' });
  return info ? { ...info, role: 'client', addresses: [] } : undefined;
}
const isOpen = (request: Request) => request.stage === 'committed' || request.stage === 'shown';

/**
 * Eine-ID: what the ID typed makes here, with the chain that proves it – this PC's own device ID or no ID (an address):
 * a new member; the company's ID: a new member; my own ID: one of my devices. Undefined: not an ID of this PC.
 */
export function decided(typed: unknown, selfFp: string): { role: JoinRole; chain?: Chain } | undefined {
  if (typed === undefined) return { role: 'employee' };
  if (typeof typed !== 'string') return undefined;
  const me = meFor(selfFp); // first: a member's PC that kept its old ID as its own has My ID == its device ID
  if (typed === me?.code()) return { role: 'ceo', chain: me.chain() };
  if (typed === remoteIdOf(selfFp)) return { role: 'employee' };
  const company = codeFor(selfFp);
  if (typed === company?.code()) return { role: 'employee', chain: company.chain() };
  return undefined;
}

export class TargetRequests {
  private readonly deps: TargetDeps;
  private readonly bySession = new Map<string, Request>();
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(deps: TargetDeps) { this.deps = deps; }

  /** True when this side holds the request with this session (remote2, remote3 and remoteCancel carry no role). */
  owns(session: unknown): boolean {
    return typeof session === 'string' && this.bySession.has(session);
  }

  /** True when this side holds the shown request with this id. */
  holds(id: string): boolean {
    return [...this.bySession.values()].some((request) => request.id === id);
  }

  /** The role of the shown request `id` (the service checks a new member's Accept before it runs). */
  roleOf(id: string): AskRole | undefined {
    return [...this.bySession.values()].find((request) => request.id === id && request.stage === 'shown')?.role;
  }

  /** Shown requests waiting for the person. */
  incoming(): RemoteIncoming[] {
    this.sweep();
    return [...this.bySession.values()].filter((request) => request.stage === 'shown').map((request) => this.view(request));
  }

  /** POST /peer/pair with a remote kind. Never throws. */
  async handle(body: Record<string, unknown>, remote: { address?: string }): Promise<Reply> {
    try {
      this.sweep();
      switch (body.kind) {
        case 'remote1': return this.onAsk(body, remote.address ?? '');
        case 'remote2': return this.onReveal(body);
        case 'remote3': return await this.onWait(body);
        case 'remoteCancel': return this.onCancel(body);
        case 'remoteName': return this.onName(body);
        default: return fail('bad_request', 'Unknown request.');
      }
    } catch (error) {
      this.deps.log.warn('connect request failed', { error: errorText(error) });
      return fail('bad_request', error instanceof WorkforceError ? error.message : 'The request failed.');
    }
  }

  /**
   * The person's answer (remote.decide): a new member needs a name (`newPerson`, else the one they proposed) or the person
   * it belongs to (`personId`), a phone takes either (none: my own phone), my own device takes no new person.
   */
  decide(id: string, accept: boolean, personId?: string, newPerson?: NewPerson): void {
    const request = [...this.bySession.values()].find((entry) => entry.id === id && entry.stage === 'shown');
    if (!request) throw new WorkforceError('not_found', 'This request is no longer open: it was answered or has ended.');
    if (!accept) return this.end(request, 'declined', 'The other PC declined.');
    if (request.role === 'ceo' && newPerson) throw new WorkforceError('bad_request', `${request.label} asks to be one of your devices, not a person's.`);
    const named = newPerson ?? (request.role === 'employee' && !personId && request.proposedName ? { name: request.proposedName } : undefined);
    if (request.role === 'employee' && !personId && !named) throw new WorkforceError('bad_request', 'Name the new member, or pick the person this PC belongs to.');
    request.personId = request.role === 'ceo' ? undefined : personId;
    request.newPerson = request.role === 'ceo' || personId ? undefined : named;
    const until = Math.max(request.expiresAt, this.deps.now() + DELIVERY_GRACE_MS);
    if (until !== request.expiresAt) {
      request.expiresAt = until;
      this.deps.timers.clear(request.timer);
      request.timer = this.deps.timers.set(() => this.expire(request), until - this.deps.now());
    }
    this.end(request, 'accepted');
  }

  /** Requests were turned off (settings.devices.findable): every open request ends, declined. */
  closeAll(reason = 'This PC stopped accepting connection requests.'): void {
    for (const request of [...this.bySession.values()]) if (isOpen(request)) this.end(request, 'declined', reason);
  }

  // ---------------------------------------------------------------- protocol steps

  private onAsk(body: Record<string, unknown>, address: string): Reply {
    if (!this.deps.findable()) return fail('forbidden', 'This PC does not accept connection requests (settings.devices.findable).');
    const phone = body.role === 'phone';
    if (phone !== (this.deps.roles ?? PC_ROLES).includes('phone')) return fail('bad_request', phone ? 'Update Autark on this PC.' : 'Not a connect request.');
    const info = phone ? phoneInfo(body.device) : parseInfo(body.device);
    const ephB = bytes(body.eph);
    if (!info || !ephB || body.v !== 1) return fail('bad_request', phone ? 'Update the Autark app on this phone.' : 'Update Autark on the other PC.');
    const self = this.deps.self();
    if (info.id === self.id) return fail('bad_request', 'A PC cannot connect to itself.');
    const found = decided((body.target as { remoteId?: unknown } | undefined)?.remoteId, fingerprintOf(fromB64url(self.pub)));
    if (!found) return fail('not_found', 'This is not the PC that was asked for.');
    const role: AskRole = phone ? 'phone' : found.role;
    if (body.role === 'ceo' && role !== 'ceo') return fail('bad_request', 'Update Autark on the other PC: this ID adds a new member, not one of your devices.');
    const chain = found.chain;
    const now = this.deps.now();
    if (!this.take(address || 'unknown', now)) return fail('rate_limited', 'Too many requests from this address. Try again in a few minutes.');
    const open = [...this.bySession.values()].filter(isOpen);
    if (open.some((request) => request.info.id === info.id)) return fail('conflict', 'A request from this PC already waits for an answer.');
    if (open.length >= MAX_OPEN) return fail('rate_limited', 'Other PCs are already asking this PC. Try again in a few minutes.');
    const eph = newEphemeral();
    const na = newNonce();
    const request: Request = {
      id: `rr_${randomBytes(8).toString('hex')}`, session: randomBytes(16).toString('base64url'), role, info, label: plainLabel(info.name) || (role === 'phone' ? 'Phone' : 'PC'), mine: self,
      address: /^(127\.|::1$|$)/.test(address) ? '' : address, eph: eph.privateKey, ephA: eph.pub, ephB, na, commit: commitment(eph.pub, ephB, na),
      stage: 'committed', expiresAt: now + COMMIT_TTL_MS, waiters: new Set(),
    };
    this.bySession.set(request.session, request);
    request.timer = this.deps.timers.set(() => this.expire(request), COMMIT_TTL_MS);
    const company = phone ? '' : this.companyName();
    return {
      ok: true, session: request.session, device: self, eph: b64url(eph.pub), commit: request.commit, ...(chain?.links.length ? { chain } : {}),
      ...(phone ? {} : { role }), ...(company ? { company } : {}), ...(role === 'ceo' && this.personName() ? { person: this.personName() } : {}),
    };
  }

  /** Eine-ID: the new member's proposed name, MAC'd with the session key; a later one replaces it, an empty one clears it. */
  private onName(body: Record<string, unknown>): Reply {
    const request = this.bySession.get(String(body.session ?? ''));
    if (!request?.key || request.stage !== 'shown') return fail('not_found', 'This request is no longer open.');
    if (typeof body.name !== 'string' || body.name.length > 200 || !macOk(mac(request.key, 'remote-name', request.session, body.name), body.mac)) return fail('forbidden', 'Not your request.');
    const name = plainLabel(body.name, 80);
    if (request.role !== 'employee' || name === (request.proposedName ?? '')) return { ok: true };
    request.proposedName = name || undefined;
    this.deps.changed();
    return { ok: true };
  }

  private personName(): string {
    try { return plainLabel(this.deps.person?.() ?? '', 80); } catch { return ''; }
  }

  private companyName(): string {
    try { return plainLabel(this.deps.company?.() ?? '', 80); } catch { return ''; }
  }

  private onReveal(body: Record<string, unknown>): Reply {
    const request = this.bySession.get(String(body.session ?? ''));
    const nb = bytes(body.nb, 16);
    if (!request || request.stage !== 'committed') return fail('not_found', 'This request is no longer open.');
    // The role is hashed as its text; 'phone' is one more value of it.
    const t = transcript({ a: request.mine, b: request.info, ephA: request.ephA, ephB: request.ephB, commit: request.commit, role: request.role });
    if (!nb || !verifySide(request.info.pub, 'B', t, body.sig)) {
      this.drop(request);
      return fail('forbidden', IDENTITY_FAILED);
    }
    Object.assign(request, { t, key: sessionKey(request.eph, request.ephB, t), code: matchCode(t, request.na, nb), stage: 'shown' as Stage, expiresAt: this.deps.now() + REQUEST_TTL_MS });
    this.deps.timers.clear(request.timer);
    request.timer = this.deps.timers.set(() => this.expire(request), REQUEST_TTL_MS);
    const view = this.view(request);
    try { this.deps.shown(view); } catch { /* the request still shows in Settings › Devices */ }
    this.deps.log.info('connect request shown', { id: request.id, role: request.role });
    this.deps.changed();
    return { ok: true, na: b64url(request.na), sig: b64url(this.deps.signer.sign(signedBytes('A', t))) };
  }

  /** The requester's long wait for the decision (≤ 55 s; 'pending' → it asks again). Only its session key may ask. */
  private async onWait(body: Record<string, unknown>, maxMs = WAIT_MAX_MS): Promise<Reply> {
    const request = this.bySession.get(String(body.session ?? ''));
    if (!request || !request.key || !macOk(mac(request.key, 'remote-wait', request.session), body.mac)) return { ok: true, status: 'expired' };
    if (request.stage === 'shown') {
      await new Promise<void>((resolve) => {
        const done = () => { request.waiters.delete(done); this.deps.timers.clear(timer); resolve(); };
        const timer = this.deps.timers.set(done, Math.max(0, Math.min(maxMs, request.expiresAt - this.deps.now())));
        request.waiters.add(done);
      });
    }
    switch (request.stage) {
      case 'accepted': return await this.deliver(request);
      case 'declined': return { ok: true, status: 'declined', reason: request.reason };
      case 'shown': return { ok: true, status: 'pending', expiresAt: request.expiresAt };
      default: return { ok: true, status: 'expired' };
    }
  }

  /** The requester collects the acceptance: now this PC stores it (once; a repeated wait gets the same answer). */
  private async deliver(request: Request): Promise<Reply> {
    if (!request.delivered) {
      const refused = await (request.linking ??= this.linkOnce(request));
      if (refused) return refused;
    }
    const t = b64url(request.t!);
    const employer = request.extras?.employer;
    return {
      ok: true, status: 'accepted', device: request.mine, mac: mac(request.key!, 'remote-accept', request.mine, t), ...request.extras,
      ...(employer ? { employerMac: mac(request.key!, 'remote-employer', employer, t) } : {}),
    };
  }

  /** Runs `link` once; a refusal declines the request with its reason. */
  private async linkOnce(request: Request): Promise<Reply | undefined> {
    try {
      const extras = await this.deps.link({ ...request.info, name: request.label }, request.personId, request.newPerson, request.role);
      if (extras) request.extras = extras;
      request.delivered = true;
      this.deps.log.info('connect request linked', { id: request.id, role: request.role });
      return undefined;
    } catch (error) {
      request.stage = 'declined';
      request.reason = error instanceof WorkforceError ? error.message : 'The other PC could not store this PC.';
      this.deps.log.warn('connect request not linked', { id: request.id, error: errorText(error) });
      return { ok: true, status: 'declined', reason: request.reason };
    }
  }

  private onCancel(body: Record<string, unknown>): Reply {
    const request = this.bySession.get(String(body.session ?? ''));
    if (!request) return { ok: true };
    if (request.key && !macOk(mac(request.key, 'remote-cancel', request.session), body.mac)) return fail('forbidden', 'Not your request.');
    if (isOpen(request) || (request.stage === 'accepted' && !request.delivered)) this.end(request, 'cancelled', 'Cancelled on the other PC.');
    return { ok: true };
  }

  // ---------------------------------------------------------------- lifecycle

  /** A decided request stays until its expiry, so a requester that missed the answer gets it again. */
  private end(request: Request, stage: Stage, reason?: string): void {
    const shown = request.stage === 'shown';
    request.stage = stage;
    request.reason = reason;
    for (const wake of [...request.waiters]) wake();
    if (shown) this.deps.changed();
    if (stage === 'cancelled') this.drop(request);
  }

  private expire(request: Request): void {
    if (isOpen(request)) this.end(request, 'expired');
    this.drop(request);
  }

  /** Lazy expiry (a missed timer, or tests on a manual clock). */
  private sweep(): void {
    const now = this.deps.now();
    for (const request of [...this.bySession.values()]) if (now >= request.expiresAt) this.expire(request);
  }

  private drop(request: Request): void {
    this.deps.timers.clear(request.timer);
    this.bySession.delete(request.session);
  }

  /** Counts one request from `address`; false when over the limit. */
  private take(address: string, now: number): boolean {
    let entry = this.hits.get(address);
    if (!entry || now - entry.start >= ADDRESS_WINDOW_MS) {
      if (this.hits.size >= 256) for (const [key, value] of this.hits) if (now - value.start >= ADDRESS_WINDOW_MS) this.hits.delete(key);
      entry = { start: now, count: 0 };
      this.hits.set(address, entry);
    }
    entry.count++;
    return entry.count <= PER_ADDRESS;
  }

  private view(request: Request): RemoteIncoming {
    const fingerprint = fingerprintOf(fromB64url(request.info.pub));
    return {
      // 'phone' is the B-078 role of the owner's phone app (the UI names it).
      id: request.id, role: request.role, deviceId: request.info.id, name: request.label,
      remoteId: remoteIdOf(fingerprint), fingerprint, code: request.code ?? '', ...(request.address ? { address: request.address } : {}), expiresAt: request.expiresAt,
      ...(request.proposedName ? { proposedName: request.proposedName } : {}),
    };
  }
}
