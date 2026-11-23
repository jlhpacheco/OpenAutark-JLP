// F17 (owner 15.11.2026: "auf jedem verbundenen Gerät … jeder, der unter meinem Ding praktisch eingeloggt ist"): a
// connect request waiting on one of my PCs shows on my other PCs too – and on the phones that read their PC's
// remote.state. The PC that holds requests sends its whole list (mesh method 'remote.requests') to each online 'ceo' link
// – my own PCs – whenever that list changes and once when such a link comes up; a receiver keeps each PC's last list
// until the next one, until that link goes, or until a request's time is up (the holder's remaining time, so the two
// clocks may differ). Accept or Decline on a mirrored row is 'remote.decide' on the holder, which runs its own decide:
// the first answer wins, a later one hears that the request is no longer open, and the holder's next list removes the
// row everywhere. Both methods are registered for 'ceo' links only, so an employer's or an employee's PC neither gets the
// list nor answers a request here. readDecide is the one check of decide params (also the RPC's, rpc/handlers/remote.ts).
// Eine-ID 22.11.2026: a new member's row carries the name they proposed (`proposedName`, plain), so Accept on my other PC
// prefills it too.
// Owns: the mirrored rows, the two peer methods and readDecide.
// Never: decides a request itself, passes on rows it got (only this PC's own), or sends to a link that is not 'ceo'.

import type { Device } from '../../shared/model/devices.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { NewPerson, RemoteIncoming } from '../../shared/model/remote.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import type { Bus } from '../bus.ts';
import type { LinkKind } from '../devices/mesh.ts';
import type { PeerHandler } from '../devices/rpc-peer.ts';
import { linkOf } from '../devices/sync/home.ts';
import { bad, input, onlyKeys, optBool, optObj, optOneOf, optText, text } from '../rpc/params.ts';
import { DELIVERY_GRACE_MS, MAX_OPEN, REQUEST_TTL_MS, type Timers } from './requests.ts';

export const REQUESTS_METHOD = 'remote.requests';
export const DECIDE_METHOD = 'remote.decide';
/** How long a decide on the holder may take (its own decide is instant; the rest is the link). */
export const DECIDE_MS = 15_000;
const SEND_MS = 10_000;
/** A holder has at most MAX_OPEN PC requests plus as many phone requests open. */
const MAX_ROWS = 2 * MAX_OPEN;
const CEO_ONLY: readonly LinkKind[] = ['ceo'];
const REQUEST_ID = /^rr_[0-9a-f]{16}$/;

/** The answer to a request (remote.decide): with the person a device belongs to, or the person to make (F13). */
export interface Decision { id: string; accept: boolean; personId?: string; newPerson?: NewPerson }

/** remote.decide's params, checked; `knows`: is this a person of the organisation here. */
export function readDecide(params: unknown, knows: (personId: string) => boolean): Decision {
  const o = input(params);
  onlyKeys(o, ['id', 'accept', 'personId', 'newPerson']);
  const id = text(o, 'id', { max: 40 });
  if (!REQUEST_ID.test(id)) bad('id', 'a request id');
  const accept = optBool(o, 'accept') ?? bad('accept', 'true or false');
  const personId = optText(o, 'personId', { max: 80 });
  if (personId !== undefined && !knows(personId)) bad('personId', 'a person of the organisation');
  const fresh = optObj(o, 'newPerson');
  if (fresh && personId !== undefined) bad('newPerson', 'either personId or newPerson');
  if (!fresh) return { id, accept, ...(personId ? { personId } : {}) };
  onlyKeys(fresh, ['name', 'title', 'managerId', 'role'], 'newPerson');
  const name = text(fresh, 'name', { max: 80 }).trim();
  const title = optText(fresh, 'title', { max: 80, allowEmpty: true })?.trim();
  const managerId = optText(fresh, 'managerId', { max: 80 });
  const role = optOneOf(fresh, 'role', ['member', 'ceo'] as const); // F13: a second CEO
  return { id, accept, newPerson: { name, ...(title ? { title } : {}), ...(managerId ? { managerId } : {}), ...(role ? { role } : {}) } };
}

export interface MirrorMesh {
  register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void;
  call(deviceId: string, method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  list(): Device[];
}

export interface MirrorDeps {
  mesh: MirrorMesh;
  bus: Pick<Bus, 'on'>;
  now(): number;
  timers: Timers;
  /** The requests this PC holds itself (PCs and phones, as remote.state shows them). */
  own(): RemoteIncoming[];
  /** This PC's own decide (never a mirrored row's): what a decide from another of my PCs runs here. */
  decide(decision: Decision): void;
  /** Is this a person of the organisation here (a decide from another PC names one). */
  knows(personId: string): boolean;
  /** The mirrored rows changed: remote.updated. */
  changed(): void;
  log: { warn(message: string, data?: Record<string, unknown>): void };
}

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** What travels: the public view of a request (never a key or session secret). */
function wire(request: RemoteIncoming): Record<string, unknown> {
  const { id, role, deviceId, name, remoteId, fingerprint, code, address, expiresAt, proposedName } = request;
  return { id, role, deviceId, name, remoteId, fingerprint, code, ...(address ? { address } : {}), expiresAt, ...(proposedName ? { proposedName } : {}) };
}

/** A received row, checked, its expiry moved onto this PC's clock (`left`: the holder's time left, capped). */
function parseRow(value: unknown, at: number, now: number, via: RemoteIncoming['via']): RemoteIncoming | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const { id, role, deviceId, remoteId, fingerprint, code, address, expiresAt } = row;
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return undefined;
  if (role !== 'ceo' && role !== 'employee' && role !== 'phone') return undefined;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(deviceId)) return undefined;
  if (typeof remoteId !== 'string' || !/^\d{9}$/.test(remoteId)) return undefined;
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return undefined;
  if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
  const left = Math.min(Math.max(expiresAt - at, 0), REQUEST_TTL_MS + DELIVERY_GRACE_MS);
  if (left <= 0) return undefined;
  const name = plainLabel(row.name) || (role === 'phone' ? 'Phone' : 'PC');
  const from = typeof address === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(address) ? { address } : {};
  const proposedName = role === 'employee' ? plainLabel(row.proposedName, 80) : '';
  return { id, role, deviceId, name, remoteId, fingerprint, code, ...from, expiresAt: now + left, ...(via ? { via } : {}), ...(proposedName ? { proposedName } : {}) };
}

export class RequestMirror {
  private readonly deps: MirrorDeps;
  /** Each of my PCs' last list (device id → its rows). */
  private readonly byPc = new Map<string, RemoteIncoming[]>();
  /** The list last sent to every link (unchanged lists are not sent again). */
  private sent = '[]';
  private timer?: unknown;
  private readonly offs: Array<() => void>;

  constructor(deps: MirrorDeps) {
    this.deps = deps;
    deps.mesh.register(REQUESTS_METHOD, async (params, from) => this.received(params, from), CEO_ONLY);
    deps.mesh.register(DECIDE_METHOD, async (params) => {
      deps.decide(readDecide(params, deps.knows));
      return { ok: true };
    }, CEO_ONLY);
    this.offs = [
      deps.bus.on('device.upserted', (device) => this.linkChanged(device)),
      deps.bus.on('device.removed', ({ id }) => this.drop(id)),
    ];
  }

  /** The requests waiting on my other PCs (expired ones left out). */
  rows(): RemoteIncoming[] {
    const now = this.deps.now();
    return [...this.byPc.values()].flat().filter((row) => row.expiresAt > now);
  }

  /** The PC holding the mirrored request `id`, if it is one. */
  holderOf(id: string): string | undefined {
    const now = this.deps.now();
    for (const [pc, rows] of this.byPc) if (rows.some((row) => row.id === id && row.expiresAt > now)) return pc;
    return undefined;
  }

  /** Accept or Decline of a mirrored row: the holder decides; the row leaves here at once (the holder's list confirms). */
  async decide(decision: Decision): Promise<void> {
    const holder = this.holderOf(decision.id);
    if (!holder) throw new WorkforceError('not_found', 'This request is no longer open: it was answered or has ended.');
    try {
      await this.deps.mesh.call(holder, DECIDE_METHOD, decision, undefined, DECIDE_MS);
    } catch (error) {
      if (!(error instanceof WorkforceError && error.code === 'not_found')) throw error;
      this.forget(holder, decision.id); // answered elsewhere first: the row goes, the person hears why
      throw error;
    }
    this.forget(holder, decision.id);
  }

  /** This PC's own list changed: it goes to every online CEO link (to `only`, when that link just came up). */
  send(only?: string): void {
    let rows: Record<string, unknown>[];
    try { rows = this.deps.own().map(wire); } catch { return; }
    const text = JSON.stringify(rows);
    if (!only && text === this.sent) return;
    if (!only) this.sent = text;
    const body = { at: this.deps.now(), requests: rows };
    for (const device of this.deps.mesh.list()) {
      if (linkOf(device)?.kind !== 'ceo' || device.status !== 'online' || (only && device.id !== only)) continue;
      void this.deps.mesh.call(device.id, REQUESTS_METHOD, body, undefined, SEND_MS).catch((error: unknown) => {
        if (error instanceof WorkforceError && error.code === 'not_found') return; // a PC before 0.3.9 has no such method
        this.deps.log.warn('connect requests not mirrored', { deviceId: device.id, error: errorText(error) });
      });
    }
  }

  stop(): void {
    for (const off of this.offs) off();
    this.deps.timers.clear(this.timer);
    this.byPc.clear();
  }

  // ---------------------------------------------------------------- internals

  /** Another PC's whole list replaces what it sent before. */
  private received(params: unknown, from: string): { ok: true } {
    const device = this.deps.mesh.list().find((entry) => entry.id === from);
    if (!device || linkOf(device)?.kind !== 'ceo') return { ok: true }; // the mesh already refuses other links; a removed one too
    const body = (params ?? {}) as { at?: unknown; requests?: unknown };
    const now = this.deps.now();
    const at = typeof body.at === 'number' && Number.isFinite(body.at) ? body.at : now;
    const via = { deviceId: from, name: plainLabel(device.name) || 'PC' };
    const list = Array.isArray(body.requests) ? body.requests.slice(0, MAX_ROWS) : [];
    const rows = list.map((row) => parseRow(row, at, now, via)).filter((row): row is RemoteIncoming => Boolean(row));
    if (!rows.length && !this.byPc.has(from)) return { ok: true };
    this.byPc.set(from, rows);
    this.update();
    return { ok: true };
  }

  /**
   * A link came up (this PC's list goes there – again on every 'online', so a swapped link that never went 'offline'
   * still gets it; the receiver just replaces its copy) or went (its rows go).
   */
  private linkChanged(device: Device): void {
    if (device.self) return;
    if (linkOf(device)?.kind === 'ceo' && device.status === 'online') this.send(device.id);
    else this.drop(device.id);
  }

  private forget(pc: string, id: string): void {
    const rows = this.byPc.get(pc);
    if (!rows?.some((row) => row.id === id)) return;
    this.byPc.set(pc, rows.filter((row) => row.id !== id));
    this.update();
  }

  private drop(pc: string): void {
    if (this.byPc.delete(pc)) this.update();
  }

  /** Rows whose time is up go; remote.updated now, and once more when the next mirrored request's time is up. */
  private update(): void {
    this.deps.timers.clear(this.timer);
    this.timer = undefined;
    const now = this.deps.now();
    for (const [pc, rows] of [...this.byPc]) {
      const open = rows.filter((row) => row.expiresAt > now);
      if (open.length) this.byPc.set(pc, open);
      else this.byPc.delete(pc);
    }
    const next = Math.min(...[...this.byPc.values()].flat().map((row) => row.expiresAt));
    if (Number.isFinite(next)) this.timer = this.deps.timers.set(() => { this.timer = undefined; this.update(); }, next - now);
    try { this.deps.changed(); } catch (error) { this.deps.log.warn('remote state not sent', { error: errorText(error) }); }
  }
}
