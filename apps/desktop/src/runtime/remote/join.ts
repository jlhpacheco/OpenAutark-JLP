// The requester side of a connect request: "Connect" with a Remote ID or an address, or a PC on
// this network. Finds the PC (remote/find.ts), runs the exchange of remote/sas.ts against the address
// that answered (an http(s) address or the meeting server's sealed route), shows the code here while
// the other PC's person decides, and holds one long remote3 request at a time (<= 55 s, sent again
// while open) that receives the decision. A network failure is retried with growing one-shot pauses
// (<= 15 s) until the request expired on both sides; giving up tells the other PC (remoteCancel), so
// it never stores this PC alone. Accepted: the other PC is stored with its proven key and dialed
// (mesh.add 'joiner'). The role – 'ceo' for my other device (B-078: no role of its own, a full mirror; the roster then
// makes it whatever this PC is elsewhere) or 'employee' – is part of the transcript both codes cover.
// One request at a time: a second connect while one starts is refused, a new one cancels the previous.
// Eine-ID 22.11.2026: nobody picks the role here – the PC asked decides it from the ID typed and answers it (and its
// company's name) to remote1; an older PC that answers none makes this a new member ('employee', never a full mirror by
// accident) – remote1 asks 'employee' for exactly that PC. As a new member this side proposes its name (`name` at connect,
// `rename` while it waits): a `remoteName` message MAC'd with the session key; accepted, that name goes with the link
// (Fest 22.11.2026: the PC keeps it as its person's name where none is set – devices/connect.ts finishFirstRun). A member
// PC that admits me through its company answers with that company's PC (`employer`, MAC'd on its own): I link that PC,
// not the one I asked.
// Review 22.11.2026: an answer that makes this PC one of someone's devices ('ceo', a full mirror both ways) stops at
// 'confirm' before remote2 – with whose devices (`person`) – until this side says yes (`confirm`, only the person: the
// agents' tool never does) or cancels; no yes within CONFIRM_MS ends it. Several PCs found for an ID are asked in order
// until one answers (a stale or wrong entry does not end the search).
// Owns: the outgoing request and its waiting chain. Never: stores an unproven key, or waits without
// a request in flight (no timer polling).

import { randomBytes } from 'node:crypto';
import type { JoinRole, RemoteOutgoing } from '../../shared/model/remote.ts';
import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import { b64url, fingerprintOf, fromB64url } from '../devices/keys.ts';
import { mac, macOk, parseInfo, workingFirst, type PeerInfo } from '../devices/pair-proof.ts';
import { belongs } from './code.ts';
import { parseTarget, remoteIdOf, type RemoteTarget } from './id.ts';
import { notFoundText, type Found } from './find.ts';
import type { Timers } from './requests.ts';
import { COMMIT_TTL_MS, DELIVERY_GRACE_MS, IDENTITY_FAILED, REQUEST_TTL_MS, WAIT_MAX_MS } from './requests.ts';
import { bytes, commitment, matchCode, newEphemeral, newNonce, sessionKey, signedBytes, transcript, verifySide } from './sas.ts';

const STEP_TIMEOUT_MS = 15_000;
const MAX_PAUSE_MS = 15_000;
const KNOWN_CODES: ReadonlySet<string> = new Set(['bad_request', 'not_found', 'conflict', 'forbidden', 'rate_limited', 'unavailable']);

export interface JoinDeps {
  now(): number;
  timers: Timers;
  self(): PeerInfo;
  signer: { sign(data: Uint8Array): Buffer };
  /** Candidates for the target (remote/find.ts); none: rejects not_found with what was searched. */
  find(target: RemoteTarget): Promise<Found[]>;
  /** Keeps the peer listener open while the request runs (the other PC dials the addresses sent). */
  holdListener(): Promise<(() => void) | undefined>;
  /** POST JSON to `<address>/peer/pair`; plain Error on network failure or timeout. */
  post(address: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  /**
   * Stores the accepted device with its proven key (`info.name` already plain) and dials it – as `role` answered; `name`:
   * the name I proposed as a new member, when I proposed one (Fest 22.11.2026: this PC keeps it as its person's name).
   */
  link(info: PeerInfo, role: JoinRole, name?: string): void;
  changed(): void;
  log: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

/** `name`: the name I propose as a new member (the other side may change it). */
export interface ConnectInput { target: string; name?: string }

interface Outgoing {
  view: RemoteOutgoing;
  address: string;
  session: string;
  key: Buffer;
  t: Buffer;
  info: PeerInfo;
  /** What remote2 checks: the two ephemeral keys and the other PC's commitment. */
  ephA: Buffer;
  ephB: Buffer;
  commit: string;
  abort: AbortController;
  release?: () => void;
  /** Review H1: the timer that ends an unanswered 'confirm'. */
  yes?: unknown;
}

/** How long my yes may take: within the other PC's time for remote2 (requests.ts COMMIT_TTL_MS), with a margin for the way. */
export const CONFIRM_MS = COMMIT_TTL_MS - 10_000;
/** Refusals after which the next PC found is asked (a stale or wrong entry); a busy PC or an open request stops the search. */
const NEXT_ON: ReadonlySet<string> = new Set(['unavailable', 'not_found', 'forbidden', 'bad_request']);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const labelOf = (name: string) => plainLabel(name) || 'PC';

export class RemoteJoiner {
  private readonly deps: JoinDeps;
  private current?: Outgoing;
  private last?: RemoteOutgoing;
  private starting = false;

  constructor(deps: JoinDeps) { this.deps = deps; }

  /** The request this PC made (open or its last outcome), for Settings › Devices. */
  outgoing(): RemoteOutgoing | undefined { return this.current?.view ?? this.last; }

  async connect(input: ConnectInput): Promise<RemoteOutgoing> {
    if (this.starting) throw new WorkforceError('conflict', 'A connection request is starting already. Try again in a moment.');
    this.starting = true;
    try {
      return await this.start(input);
    } finally {
      this.starting = false;
    }
  }

  /** Cancels the open request (the other PC's to-do closes) or closes the last outcome. */
  cancel(): void {
    void this.withdraw();
  }

  /** The name I propose while my request as a new member waits; the other PC shows it at once. */
  async rename(name: string): Promise<void> {
    const out = this.current;
    if (!out || out.view.status !== 'waiting' || out.view.role !== 'employee') throw new WorkforceError('not_found', 'No request of this PC waits to join as a new member.');
    out.view = { ...out.view, myName: plainLabel(name, 80) };
    this.deps.changed();
    await this.sendName(out);
  }

  private async start(input: ConnectInput): Promise<RemoteOutgoing> {
    let target: RemoteTarget;
    try { target = parseTarget(input.target); } catch (error) { throw new WorkforceError('bad_request', errorText(error)); }
    const found = await this.deps.find(target);
    if (!found.length) throw new WorkforceError('not_found', notFoundText(target));
    await this.withdraw(); // one request at a time: the other PC hears of the old one's end first
    this.last = undefined;
    const release = await this.deps.holdListener(); // the addresses sent to the other PC are listening
    try {
      const out = await this.askFirst(found, target, input.name);
      out.release = release;
      if (out.view.status === 'confirm') return this.holdForYes(out);
      await this.reveal(out);
      return await this.begin(out);
    } catch (error) {
      release?.();
      throw error;
    }
  }

  /** Review H1: yes to becoming one of the other person's devices – the request goes on (remote2) and shows its code. */
  async confirm(): Promise<RemoteOutgoing> {
    const out = this.current;
    if (!out || out.view.status !== 'confirm') throw new WorkforceError('not_found', 'No request of this PC waits for your yes.');
    if (this.starting) throw new WorkforceError('conflict', 'A connection request is starting already. Try again in a moment.');
    this.starting = true;
    try {
      this.deps.timers.clear(out.yes);
      await this.reveal(out);
    } catch (error) {
      this.end(out, 'failed', error instanceof WorkforceError ? error.message : 'The other PC is not reachable.');
      void this.tellCancel(out);
      throw error;
    } finally {
      this.starting = false;
    }
    if (this.current !== out) throw new WorkforceError('not_found', 'This request was cancelled.');
    return this.begin(out);
  }

  /** 'confirm': the request waits here for my yes (CONFIRM_MS); the other PC shows nothing yet. */
  private holdForYes(out: Outgoing): RemoteOutgoing {
    this.current = out;
    out.yes = this.deps.timers.set(() => {
      if (this.current !== out || out.view.status !== 'confirm') return;
      this.end(out, 'expired', 'Nobody said yes in time.');
      void this.tellCancel(out);
    }, CONFIRM_MS);
    this.deps.changed();
    return out.view;
  }

  /** The request runs: its code shows, my proposed name goes, the long wait starts. */
  private async begin(out: Outgoing): Promise<RemoteOutgoing> {
    this.current = out;
    this.deps.changed();
    if (out.view.myName) await this.sendName(out).catch((error: unknown) => this.deps.log.warn('proposed name not sent', { error: errorText(error) }));
    void this.wait(out);
    return out.view;
  }

  /** Ends the open request here and tells the other PC (≤ 3 s); clears the last outcome. */
  private async withdraw(): Promise<void> {
    const open = this.current;
    const had = Boolean(open ?? this.last);
    if (open) this.finish(open, 'cancelled');
    this.last = undefined;
    if (had) this.deps.changed();
    if (open) await this.tellCancel(open);
  }

  private tellCancel(out: Outgoing): Promise<unknown> {
    const body = { kind: 'remoteCancel', session: out.session, mac: mac(out.key, 'remote-cancel', out.session) };
    return this.deps.post(out.address, body, { timeoutMs: 3_000 }).catch(() => undefined);
  }

  /** The proposed name to the PC asked, MAC'd with the session key. */
  private async sendName(out: Outgoing): Promise<void> {
    const name = out.view.myName ?? '';
    await this.call(out.address, { kind: 'remoteName', session: out.session, name, mac: mac(out.key, 'remote-name', out.session, name) }, STEP_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------- the exchange

  /** remote1 to the PCs found, in order, until one answers; the first refusal is the one told when none does. */
  private async askFirst(found: readonly Found[], target: RemoteTarget, name: string | undefined): Promise<Outgoing> {
    let first: unknown;
    for (const candidate of found) {
      try { return await this.ask(candidate, target, name); } catch (error) {
        if (!(error instanceof WorkforceError) || !NEXT_ON.has(error.code)) throw error;
        first ??= error;
        this.deps.log.warn('connect request: next PC found', { deviceId: candidate.deviceId, error: errorText(error) });
      }
    }
    throw first;
  }

  /** remote1: the other PC's identity, its commitment and the role it decided ('ceo' stops at 'confirm'). */
  private async ask(candidate: Found, target: RemoteTarget, name: string | undefined): Promise<Outgoing> {
    const mine = this.deps.self();
    const eph = newEphemeral();
    const first = await this.postAny(candidate.addresses, {
      // 'employee' is for an older PC only (it would take no role as 'ceo'); a current one decides from the ID.
      kind: 'remote1', v: 1, device: mine, eph: b64url(eph.pub), role: 'employee', ...('remoteId' in target ? { target: { remoteId: target.remoteId } } : {}),
    });
    const role: JoinRole = first.reply.role === 'ceo' ? 'ceo' : 'employee';
    const company = plainLabel(first.reply.company, 80);
    const myName = role === 'employee' ? plainLabel(name, 80) : '';
    const info = parseInfo(first.reply.device);
    const ephA = bytes(first.reply.eph);
    const commit = typeof first.reply.commit === 'string' ? first.reply.commit : '';
    const session = typeof first.reply.session === 'string' ? first.reply.session : '';
    if (!info || !ephA || !commit || !session) throw new WorkforceError('bad_request', 'Update Autark on the other PC.');
    const fingerprint = fingerprintOf(fromB64url(info.pub));
    // B-084: a PC answering for the person code proves it with its chain (remote/code.ts); its own ID needs none.
    const proven = (id: string) => belongs(id, fingerprint, first.reply.chain) || belongs(id, fingerprint, candidate.chain);
    if (info.id !== candidate.deviceId || fingerprint !== candidate.fingerprint || ('remoteId' in target && !proven(target.remoteId))) {
      throw new WorkforceError('forbidden', 'A different PC answered than the one that was found.');
    }
    const t = transcript({ a: info, b: mine, ephA, ephB: eph.pub, commit, role });
    const person = role === 'ceo' ? plainLabel(first.reply.person, 80) : '';
    const confirm = role === 'ceo' && first.reply.role === 'ceo';
    const view: RemoteOutgoing = {
      id: `ro_${randomBytes(8).toString('hex')}`, role, ...(company ? { company } : {}), ...(myName ? { myName } : {}), ...(person ? { person } : {}),
      deviceId: info.id, name: labelOf(info.name), remoteId: 'remoteId' in target ? target.remoteId : remoteIdOf(fingerprint), fingerprint,
      code: '', status: confirm ? 'confirm' : 'waiting', expiresAt: this.deps.now() + (confirm ? CONFIRM_MS : REQUEST_TTL_MS),
    };
    return {
      view, address: first.address, session, key: sessionKey(eph.privateKey, ephA, t), t,
      info: { ...info, addresses: directFirst(first.address, info.addresses) }, ephA, ephB: eph.pub, commit, abort: new AbortController(),
    };
  }

  /** remote2: both sides prove their keys and reveal their nonces – the code shows on both screens. */
  private async reveal(out: Outgoing): Promise<void> {
    const nb = newNonce();
    const second = await this.call(out.address, { kind: 'remote2', session: out.session, nb: b64url(nb), sig: b64url(this.deps.signer.sign(signedBytes('B', out.t))) }, STEP_TIMEOUT_MS);
    const na = bytes(second.na, 16);
    if (!na || commitment(out.ephA, out.ephB, na) !== out.commit || !verifySide(out.info.pub, 'A', out.t, second.sig)) {
      throw new WorkforceError('forbidden', IDENTITY_FAILED);
    }
    out.view = { ...out.view, code: matchCode(out.t, na, nb), status: 'waiting', expiresAt: this.deps.now() + REQUEST_TTL_MS };
    this.deps.log.info('connect request sent', { id: out.view.id, role: out.view.role });
  }

  /**
   * The long-request chain: one remote3 at a time until the other PC decides or the request ends.
   * Network failures are retried (2, 4, 8, 15 … s) until the request expired there too.
   */
  private async wait(out: Outgoing): Promise<void> {
    const deadline = out.view.expiresAt + DELIVERY_GRACE_MS;
    let failures = 0;
    while (this.current === out && out.view.status === 'waiting') {
      const started = this.deps.now();
      let reply: Record<string, unknown>;
      try {
        reply = await this.call(out.address, { kind: 'remote3', session: out.session, mac: mac(out.key, 'remote-wait', out.session) }, WAIT_MAX_MS + 15_000, out.abort.signal);
        failures = 0;
      } catch (error) {
        if (out.abort.signal.aborted || this.current !== out) return;
        this.deps.log.warn('connect wait failed', { error: errorText(error) });
        if (this.deps.now() >= deadline) return this.giveUp(out);
        failures++;
        await this.pause(Math.min(MAX_PAUSE_MS, 2_000 * 2 ** (failures - 1), Math.max(0, deadline - this.deps.now())), out.abort.signal);
        continue;
      }
      if (this.current !== out) return;
      if (reply.status === 'accepted') return this.accepted(out, reply);
      if (reply.status === 'declined') return this.end(out, 'declined', typeof reply.reason === 'string' ? labelOfReason(reply.reason) : 'The other PC declined.');
      if (reply.status !== 'pending') return this.end(out, 'expired', 'Nobody accepted it in time.');
      if (this.deps.now() - started < 1_000) await this.pause(3_000, out.abort.signal); // an early answer never spins
    }
  }

  /** The other PC stayed unreachable until the request expired: it hears that this side gave up. */
  private giveUp(out: Outgoing): void {
    this.end(out, 'failed', 'The other PC is not reachable any more.');
    void this.tellCancel(out);
  }

  private accepted(out: Outgoing, reply: Record<string, unknown>): void {
    const info = parseInfo(reply.device);
    if (!info || info.id !== out.info.id || info.pub !== out.info.pub || !macOk(mac(out.key, 'remote-accept', reply.device, b64url(out.t)), reply.mac)) {
      return this.end(out, 'failed', 'The other PC could not prove its identity.');
    }
    const role = out.view.role ?? 'employee';
    let linked: PeerInfo = { ...info, name: labelOf(info.name), addresses: directFirst(out.address, info.addresses) };
    if (reply.employer !== undefined) { // admitted through the company: its PC is the one I link
      const employer = parseInfo(reply.employer);
      if (role !== 'employee' || !employer || employer.id === this.deps.self().id || !macOk(mac(out.key, 'remote-employer', reply.employer, b64url(out.t)), reply.employerMac)) {
        return this.end(out, 'failed', 'The other PC could not prove its company\'s PC.');
      }
      linked = { ...employer, name: labelOf(employer.name) };
    }
    try {
      this.deps.link(linked, role, out.view.myName || undefined);
    } catch (error) {
      return this.end(out, 'failed', error instanceof WorkforceError ? error.message : 'This PC could not store the other PC.');
    }
    this.end(out, 'accepted');
  }

  private end(out: Outgoing, status: RemoteOutgoing['status'], reason?: string): void {
    if (this.current !== out) return;
    this.finish(out, status, reason);
    this.last = out.view;
    this.deps.changed();
  }

  private finish(out: Outgoing, status: RemoteOutgoing['status'], reason?: string): void {
    out.view = { ...out.view, status, ...(reason ? { reason } : {}) };
    this.deps.timers.clear(out.yes);
    out.abort.abort();
    out.release?.();
    out.release = undefined;
    if (this.current === out) this.current = undefined;
    this.deps.log.info('connect request ended', { id: out.view.id, status });
  }

  /** One-shot pause (aborted with the request). */
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => { signal.removeEventListener('abort', done); this.deps.timers.clear(handle); resolve(); };
      const handle = this.deps.timers.set(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  // ---------------------------------------------------------------- transport

  private async call(address: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const reply = (await this.deps.post(address, body, { timeoutMs, signal })) as { ok?: unknown; error?: { code?: string; message?: string } } & Record<string, unknown>;
    if (reply?.ok === true) return reply;
    const code = (KNOWN_CODES.has(String(reply?.error?.code)) ? reply.error!.code : 'forbidden') as ErrorCode;
    throw new WorkforceError(code, typeof reply?.error?.message === 'string' ? reply.error.message.slice(0, 300) : 'The other PC refused the request.');
  }

  /** remote1 to the first address that answers; an answer (even a refusal) ends the search. */
  private async postAny(addresses: string[], body: unknown): Promise<{ reply: Record<string, unknown>; address: string }> {
    let last: unknown;
    for (const address of addresses) {
      try { return { reply: await this.call(address, body, STEP_TIMEOUT_MS), address }; } catch (error) {
        if (error instanceof WorkforceError) throw error;
        last = error;
      }
    }
    this.deps.log.warn('connect request: no address answered', { error: errorText(last) });
    throw new WorkforceError('unavailable', 'The other PC is not reachable.');
  }
}

/** A reason the other PC sent: one line, at most 200 characters. */
function labelOfReason(reason: string): string {
  return reason.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'The other PC declined.';
}

/** The http(s) address that answered first, then the other PC's own list (a meeting-server route is no address to store). */
function directFirst(address: string, reported: readonly string[]): string[] {
  return /^https?:\/\//.test(address) ? workingFirst(address, reported) : [...reported].slice(0, 8);
}
