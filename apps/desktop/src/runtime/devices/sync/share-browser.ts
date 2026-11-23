// Umzug 21.11.2026, part 2: an agent's browser sign-ins are the same on every PC it is at home on. A Chromium profile's
// cookie store is bound to its PC's OS key, so the state travels through the browser itself: Playwright's storage state
// (cookies, and per site localStorage and IndexedDB) is read from the agent's open profile right before it closes and
// at a leave (browser/sessions.ts profileHooks, share.ts shareNow), kept here encrypted with this PC's keychain
// (<data>/share/browser-<agentId>.bin: what this profile last held – the base of the next comparison) and sent in
// pieces to the agent's other home PCs – at once to those linked, at link-up to the others. A state that comes waits
// encrypted beside it (….in.bin) and is put into the profile before the agent's next page here: when the profile
// opens, or at once when it is open (share-state.ts putIn: what I changed here since stays, a sign-out travels and
// does not come back).
// No clock of one PC is ever compared with another's (round 3): a state carries its sender's own time, and a PC takes
// one only when it is later than the last state it got from that same sender. A state that cannot be put in is tried
// at the next openings and dropped after APPLY_TRIES; it never keeps this PC from reading and sending its own.
// Owns: reading, keeping, sending and applying that state. Never: copies a profile's files, or lets a cookie or a
// stored value reach a log, a prompt, the UI or a PC that is not one of the agent's homes (only ids, sizes and times
// are logged).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { ContextLike, StorageStateLike } from '../../browser/page.ts';
import type { ProfileHooks, Session } from '../../browser/sessions.ts';
import { KvRepo } from '../../store/kv.ts';
import { isState, joinRemoved, mergeStates, putIn, removals, type SharedState } from './share-state.ts';

const NS = 'share.browser';
const PIECE = 1024 * 1024;
/** A larger state goes without IndexedDB; one still larger stays on its PC. */
export const MAX_STATE = 32 * 1024 * 1024;
/** How long a closing or leaving browser waits for its state to be read, and an opening one for a state to be put in. */
const READ_MS = 8_000;
const APPLY_MS = 20_000;
/** A state that could not be put in this often is dropped. */
export const APPLY_TRIES = 3;
/** At most this many states arrive at once (the oldest unfinished one goes). */
const ARRIVING = 4;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** This PC's own last read: its time (this PC's clock only) and the hash of what was read. */
interface Held { at: number; sha: string }

export interface BrowserDeps {
  call(peer: string, params: Record<string, unknown>): Promise<unknown>;
  /** The agent's other home PCs (my own PCs only); empty when it is at home only here, or not here. */
  peers(agentId: string): string[];
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => new Promise<T | undefined>((resolve) => {
  const timer = setTimeout(() => resolve(undefined), ms);
  (timer as { unref?: () => void }).unref?.();
  promise.then(resolve, () => resolve(undefined)).finally(() => clearTimeout(timer));
});
const code = (error: unknown) => (error instanceof WorkforceError ? error.code : 'failed'); // an error text could quote a value

export class BrowserShare {
  private readonly s: RuntimeServices;
  private readonly deps: BrowserDeps;
  private readonly kv: KvRepo;
  /** The agents' profiles open here. */
  private readonly open = new Map<string, Session>();
  /** States arriving in pieces, by PC, agent and send. */
  private readonly arriving = new Map<string, { at: number; total: number; size: number; chunks: Buffer[] }>();
  /** One job after the other per agent (reads, put-ins) and per agent and PC (sends). */
  private readonly lines = new Map<string, Promise<unknown>>();

  constructor(s: RuntimeServices, deps: BrowserDeps) {
    this.s = s;
    this.deps = deps;
    this.kv = new KvRepo(s.db);
  }

  private line<T>(key: string, job: () => Promise<T>): Promise<T | undefined> {
    const next = (this.lines.get(key) ?? Promise.resolve()).then(job).catch(() => undefined);
    this.lines.set(key, next);
    void next.finally(() => { if (this.lines.get(key) === next) this.lines.delete(key); });
    return next;
  }

  /** What browser/sessions.ts calls: a profile opened (before its first page) and is about to close. */
  hooks(): ProfileHooks {
    return {
      opened: async (session) => { this.open.set(session.agentId, session); await within(this.line(session.agentId, () => this.apply(session)), APPLY_MS); },
      closing: async (session) => { await within(this.line(session.agentId, () => this.read(session)), READ_MS); if (this.open.get(session.agentId) === session) this.open.delete(session.agentId); },
    };
  }

  private file(agentId: string, incoming = false): string {
    if (!AGENT_ID.test(agentId)) throw new WorkforceError('bad_request', 'Invalid agent id for a browser state.');
    return path.join(this.s.paths.data, 'share', `browser-${agentId}${incoming ? '.in' : ''}.bin`);
  }

  private held(agentId: string): Held | undefined {
    return this.kv.get<Held>(NS, `at/${agentId}`);
  }

  private async write(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, await this.s.host.encrypt(text), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  private async text(file: string): Promise<string | undefined> {
    try { return await this.s.host.decrypt(await readFile(file)); } catch { return undefined; }
  }

  /** The state kept in `file`, read back (undefined: none, or unreadable). */
  private async state(file: string): Promise<SharedState | undefined> {
    const text = await this.text(file);
    let state: unknown;
    try { state = text ? JSON.parse(text) : undefined; } catch { state = undefined; }
    return isState(state) ? state : undefined;
  }

  /** The agent is at home only here now: what was kept for its other PCs goes. */
  async forget(agentId: string): Promise<void> {
    for (const key of [`at/${agentId}`, `in/${agentId}`]) this.kv.delete(NS, key);
    for (const prefix of [`to/${agentId}/`, `from/${agentId}/`]) this.kv.deletePrefix(NS, prefix);
    for (const incoming of [false, true]) await rm(this.file(agentId, incoming), { force: true }).catch(() => undefined);
  }

  /** The agents this PC holds a state for (its own, or one that came). */
  agents(): string[] {
    return [...new Set(['at/', 'in/', 'from/'].flatMap((prefix) => this.kv.list<unknown>(NS, prefix).map((row) => row.key.slice(prefix.length).split('/')[0])))];
  }

  // ---------------------------------------------------------------- reading and sending

  /** The profile's state now, with what went from it since `base`. */
  private async stateText(context: ContextLike, base: SharedState | undefined): Promise<string | undefined> {
    if (!context.storageState) return undefined;
    const text = (state: StorageStateLike) => {
      const removed = removals(base, state);
      return JSON.stringify(removed.cookies.length || removed.keys.length ? { ...state, removed } : state);
    };
    let out = text(await context.storageState({ indexedDB: true }));
    if (out.length > MAX_STATE) out = text(await context.storageState());
    return out.length > MAX_STATE ? undefined : out;
  }

  /** Reads the open profile's state, keeps it and sends it to the agent's other home PCs that are linked. */
  private async read(session: Session): Promise<void> {
    const agentId = session.agentId;
    try {
      if (!this.deps.peers(agentId).length) return;
      const text = await this.stateText(session.context, await this.state(this.file(agentId)));
      if (!text) { this.s.log.info('browser state not read', { agentId }); return; }
      const sha = createHash('sha256').update(text).digest('hex');
      const before = this.held(agentId);
      if (before?.sha !== sha) {
        await this.write(this.file(agentId), text);
        this.kv.set(NS, `at/${agentId}`, { at: Math.max(session.usedAt, (before?.at ?? 0) + 1), sha }, this.s.clock.now()); // this PC's own time, always later than its last
        this.s.log.info('browser state kept', { agentId, bytes: text.length });
      }
      await this.sendAll(agentId);
    } catch (error) {
      this.s.log.info('browser state not kept', { agentId, error: code(error) });
    }
  }

  /** The state of the profile open here goes to the other home PCs now (a leave); without an open one, what is kept. */
  async now(agentId: string): Promise<void> {
    const session = this.open.get(agentId);
    await within(session ? this.line(agentId, () => this.read(session)) : this.sendAll(agentId), READ_MS);
  }

  private async sendAll(agentId: string): Promise<void> {
    await Promise.all(this.deps.peers(agentId).map((peer) => this.line(`${agentId}>${peer}`, () => this.send(agentId, peer))));
  }

  /** Sends the kept state to `peer` when that PC has not got this PC's latest. */
  private async send(agentId: string, peer: string): Promise<void> {
    const held = this.held(agentId);
    if (!held || !this.s.devices.online(peer) || (this.kv.get<number>(NS, `to/${agentId}/${peer}`) ?? 0) >= held.at) return;
    const text = await this.text(this.file(agentId));
    if (!text) return;
    const bytes = Buffer.from(text, 'utf8');
    const id = randomUUID();
    try {
      for (let offset = 0; offset < bytes.length; offset += PIECE) {
        await this.deps.call(peer, { op: 'browser', agentId, at: held.at, id, offset, total: bytes.length, data: bytes.subarray(offset, offset + PIECE).toString('base64') });
      }
      this.kv.set(NS, `to/${agentId}/${peer}`, held.at, this.s.clock.now());
    } catch (error) {
      this.s.log.info('browser state not sent', { agentId, peer, error: code(error) });
    }
  }

  /** A link came up: `peer` gets the state of every agent at home on both PCs that it has not got yet. */
  async catchUp(peer: string): Promise<void> {
    for (const agentId of this.agents()) if (this.deps.peers(agentId).includes(peer)) await this.line(`${agentId}>${peer}`, () => this.send(agentId, peer));
  }

  // ---------------------------------------------------------------- receiving and applying

  /** One piece of an agent's state from home PC `from`; with the last one the state waits here and is put in as soon as the profile is open. */
  async receive(p: { agentId?: unknown; at?: unknown; id?: unknown; offset?: unknown; total?: unknown; data?: unknown }, from: string): Promise<{ ok: true; taken?: boolean }> {
    const agentId = String(p.agentId);
    if (!AGENT_ID.test(agentId) || !this.deps.peers(agentId).includes(from)) throw new WorkforceError('forbidden', 'A browser state travels only between the PCs its agent is at home on.');
    if (typeof p.at !== 'number' || typeof p.id !== 'string' || p.id.length > 64 || typeof p.offset !== 'number' || typeof p.total !== 'number' || typeof p.data !== 'string' || p.total > MAX_STATE * 4) {
      throw new WorkforceError('bad_request', 'Unknown browser state piece.');
    }
    const key = `${from}/${agentId}/${p.id}`;
    if (p.offset === 0) {
      while (this.arriving.size >= ARRIVING) this.arriving.delete(this.arriving.keys().next().value!);
      this.arriving.set(key, { at: p.at, total: p.total, size: 0, chunks: [] });
    }
    const entry = this.arriving.get(key);
    if (!entry || entry.size !== p.offset) { this.arriving.delete(key); throw new WorkforceError('bad_request', 'A browser state piece out of order.'); }
    const chunk = Buffer.from(p.data, 'base64');
    entry.chunks.push(chunk);
    entry.size += chunk.length;
    if (entry.size < entry.total) return { ok: true };
    this.arriving.delete(key);
    let state: unknown;
    try { state = JSON.parse(Buffer.concat(entry.chunks).toString('utf8')); } catch { state = undefined; }
    if (entry.size > entry.total || !isState(state)) throw new WorkforceError('bad_request', 'That is no browser state.');
    const incoming = state;
    const taken = await this.line(agentId, async () => {
      // Later than the last state of that same PC, by that PC's own time; no other clock is asked.
      if (entry.at <= (this.kv.get<number>(NS, `from/${agentId}/${from}`) ?? 0)) return false;
      const waiting = this.kv.get<{ n: number }>(NS, `in/${agentId}`) ? await this.state(this.file(agentId, true)) : undefined;
      const next = waiting ? { ...mergeStates(waiting, incoming), removed: joinRemoved(waiting.removed, incoming.removed) } : incoming; // one of another home PC still waits: both
      await this.write(this.file(agentId, true), JSON.stringify(next));
      this.kv.set(NS, `in/${agentId}`, { n: entry.at, tries: 0 }, this.s.clock.now());
      this.kv.set(NS, `from/${agentId}/${from}`, entry.at, this.s.clock.now());
      this.s.log.info('browser state came', { agentId, from, bytes: entry.size });
      return true;
    });
    const session = this.open.get(agentId);
    if (taken && session) void within(this.line(agentId, () => this.apply(session)), APPLY_MS);
    return { ok: true, taken: taken === true };
  }

  /** Puts a state that waits here into the open profile; what the profile holds then is the base of the next comparison. */
  private async apply(session: Session): Promise<void> {
    const agentId = session.agentId;
    const waiting = this.kv.get<{ n: number; tries: number }>(NS, `in/${agentId}`);
    const context = session.context;
    if (!waiting || !context.storageState || !context.setStorageState) return;
    const done = async () => { this.kv.delete(NS, `in/${agentId}`); await rm(this.file(agentId, true), { force: true }).catch(() => undefined); };
    try {
      const incoming = await this.state(this.file(agentId, true));
      if (!incoming) { await done(); return; }
      const base = await this.state(this.file(agentId));
      const next = putIn(await context.storageState({ indexedDB: true }), incoming, base);
      await context.setStorageState(next);
      const removed = removals({ cookies: [], origins: [], removed: joinRemoved(base?.removed, incoming.removed) }, next); // those still gone are carried on
      await this.write(this.file(agentId), JSON.stringify(removed.cookies.length || removed.keys.length ? { ...next, removed } : next));
      await done();
      this.s.log.info('browser state put in', { agentId });
    } catch (error) {
      const tries = (waiting.tries ?? 0) + 1;
      if (tries >= APPLY_TRIES) await done(); else this.kv.set(NS, `in/${agentId}`, { ...waiting, tries }, this.s.clock.now());
      this.s.log.info(tries >= APPLY_TRIES ? 'browser state dropped, it could not be put in' : 'browser state not put in', { agentId, tries, error: code(error) });
    }
  }
}
