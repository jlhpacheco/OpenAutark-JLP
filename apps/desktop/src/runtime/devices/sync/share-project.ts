// Umzug 21.11.2026, part 2: an agent's home project (agent.json `home`, agent-core/home.ts) is the same folder on every
// PC the agent is at home on – whole files by sha256 at the same absolute path. A PC mirrors it when the path is one
// of this system's own disks, no part of the app's data, the folder (or the one above it – then it is made) is there
// and changing files in it is open to the agent under this PC's security rules; else it says why, and the agent hears
// that once on the PC it runs on (share.ts). One mirror per folder (round 3): agents with the same home project share
// it, and it reaches every PC one of them is at home on. Each PC remembers every file as it last saw it and, per home
// PC, the version both agreed on (share-tree.ts). A change goes at once (a watch on the folder, gathered for LOOK_MS)
// and at link-up as the whole list in numbered pages; what the other PC holds is taken by share-take.ts.
// Round 3 (review R3): the folder has an identity (share-tree.ts rootId). Before and after every look this PC checks
// that the folder is still there and still that one (alive); if not, the mirror stops, nothing it saw is told – a
// missing folder never reads as its files deleted – and the agent hears it once. It starts again when a folder is
// there (another one starts fresh: nothing counts as deleted on either side). A file that cannot be read stays as it
// was remembered; one that is a link, a folder or over the limit now is no deletion. This PC's rules are asked again
// on every settings change (share.ts) and before every take.
// Owns: the mirrors, their watches, looks and lists. Never: carries .git, node_modules, .venv, __pycache__, links or
// files over 256 MiB, follows a link, writes outside the home folder, or talks to a PC that is no home of an agent
// whose project it is.

import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync, watch as fsWatch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { localAbsolute } from '../landing.ts';
import { readPiece } from './file-io.ts';
import { haveOf, take, type ListPage, type Mirror, type TakeCtx } from './share-take.ts';
import { Guard, carried, forgetIndex, freshIndex, inside, look, readIndex, rootId, walk, writeIndex, type Have } from './share-tree.ts';

const PAGE = 500;
/** Changes the watch reports gather this long before they are looked at. */
export const LOOK_MS = 500;

export interface ProjectDeps {
  /** One call of the share method on a home PC of the agent. */
  call(peer: string, params: Record<string, unknown>): Promise<unknown>;
  /** The agent's other home PCs (my own PCs only); empty when it is at home only here, or not here. */
  peers(agentId: string): string[];
  /** PC `pc` (undefined: this one) said why it does not mirror the agent's project (`why` undefined: it does). */
  told(agentId: string, pc: string | undefined, why: string | undefined): void;
}

type Watch = (root: string, changed: (rel: string) => void) => { close(): void } | undefined;

const isDir = (target: string): boolean => { try { return statSync(target).isDirectory(); } catch { return false; } };
const realDir = (target: string): boolean => { try { return lstatSync(target).isDirectory(); } catch { return false; } };
const fold = (text: string) => (process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text);
const within = (root: string, target: string): boolean => { const rel = path.relative(fold(root), fold(target)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const errorText = (error: unknown) => String((error as Error)?.message ?? error);
const unref = (timer: ReturnType<typeof setTimeout>) => { (timer as { unref?: () => void }).unref?.(); return timer; };
const peersOf = (mirror: Mirror): string[] => [...new Set([...mirror.agents.values()].flat())];

const watchFolder: Watch = (root, changed) => {
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, name) => changed(name ? String(name).split(path.sep).join('/') : ''));
    watcher.on('error', () => changed('')); // the folder may have gone: the look finds out
    return watcher;
  } catch {
    return undefined; // no watch on this system: link-ups and leaves still carry the changes
  }
};

export class ProjectShare {
  private readonly s: RuntimeServices;
  private readonly deps: ProjectDeps;
  /** The mirrors by folder (its real path). */
  private readonly mirrors = new Map<string, Mirror>();
  /** Folders whose mirror stopped because the folder went or became another one, with the reason. */
  private readonly lost = new Map<string, string>();
  private readonly ctx: TakeCtx;
  /** Where a home project lies on this PC's disk (tests give each PC its own). */
  place: (home: string) => string = (home) => home;
  watch: Watch = watchFolder;
  /** One file's look (tests make one fail). */
  lookAt: typeof look = look;
  retryMs: readonly number[] = [10_000, 60_000];

  constructor(s: RuntimeServices, deps: ProjectDeps) {
    this.s = s;
    this.deps = deps;
    this.ctx = {
      s, call: deps.call, pc: () => this.pc(), alive: (mirror) => this.alive(mirror), look: (...args) => this.lookAt(...args),
      save: (mirror) => this.save(mirror), announce: (mirror, entries, only) => this.announce(mirror, entries, only), askAgain: (mirror, from, failed) => this.askAgain(mirror, from, failed),
    };
  }

  private pc(): string {
    try { return this.s.devices.self().name || 'this PC'; } catch { return 'this PC'; }
  }

  /** The folder a home path names here – by the real path of the folder above it, so the key stays when the folder itself goes, and two spellings are one mirror. */
  private key(home: string): string {
    const root = path.resolve(this.place(home));
    let above = path.dirname(root);
    try { above = realpathSync(above); } catch { /* not there: as written */ }
    return fold(path.join(above, path.basename(root)));
  }

  /** How many folders are mirrored now. */
  count(): number {
    return this.mirrors.size;
  }

  /** Why this PC does not mirror `home` for `agentId` (undefined: it does). */
  problem(agentId: string, home: string): string | undefined {
    const pc = this.pc();
    const root = this.place(home);
    if (!localAbsolute(home)) return `${home} is no folder path on ${pc}`;
    const data = this.s.paths?.data;
    if (path.dirname(root) === root || (data && (within(data, root) || within(root, data)))) return `${home} is no project folder on ${pc}`; // a whole disk, or the app's own data
    let verdict = 'open';
    try { if (this.s.security) verdict = this.s.security.check({ agentId, capability: 'write', path: home, fingerprint: '' }); } catch { verdict = 'ask'; }
    if (verdict !== 'open') return `changing files in ${home} is closed to me on ${pc}`;
    const why = this.lost.get(this.key(home));
    if (why && !isDir(root)) return why; // it stopped while it ran: it starts again when a folder is there
    if (isDir(root)) return undefined;
    try { statSync(root); return `${home} is a file on ${pc}`; } catch { /* not there: made when the folder above is */ }
    return isDir(path.dirname(root)) ? undefined : `the folder above ${home} does not exist on ${pc}`;
  }

  /** Which folders this PC mirrors now, from the agents' rows, agent.json and this PC's rules; a new mirror or home PC gets the whole list. */
  refresh(): void {
    const wanted = new Map<string, { home: string; agents: Map<string, string[]> }>();
    let agents: Array<{ id: string }> = [];
    try { agents = this.s.org.list(); } catch { agents = []; }
    for (const { id } of agents) {
      const peers = this.deps.peers(id);
      const home = peers.length ? this.s.agentCore?.homes.stored(id) : undefined;
      if (!home || this.problem(id, home)) continue;
      const key = this.key(home);
      const want = wanted.get(key) ?? { home, agents: new Map<string, string[]>() };
      want.agents.set(id, peers);
      wanted.set(key, want);
    }
    for (const mirror of [...this.mirrors.values()]) {
      const want = wanted.get(mirror.key);
      if (!want) { this.close(mirror); continue; }
      const before = peersOf(mirror);
      mirror.agents = want.agents;
      for (const peer of peersOf(mirror)) if (!before.includes(peer)) this.offer(mirror, peer);
    }
    for (const [key, want] of wanted) if (!this.mirrors.has(key)) this.open(key, want.home, want.agents);
  }

  private open(key: string, home: string, agents: Map<string, string[]>): void {
    const root = this.place(home);
    const mirror: Mirror = { key, home, root, id: '', agents, index: { home, id: '', files: {}, agreed: {} }, work: Promise.resolve(), queued: new Set(), lists: new Map(), again: new Map() };
    this.mirrors.set(key, mirror);
    this.lost.delete(key);
    void this.run(mirror, async () => {
      // A folder that is not there is made and filled from the other PCs; what this PC remembered counts only for the
      // very folder it was remembered of.
      // A folder this PC makes now is new, whatever inode the file system gives it (an old list never counts for it).
      const made = !isDir(root);
      if (made) await mkdir(root);
      mirror.id = rootId(root) ?? '';
      mirror.index = made ? freshIndex(home, mirror.id) : await readIndex(this.s.paths.data, key, home, mirror.id);
      if (this.mirrors.get(key) !== mirror) return;
      mirror.watcher = this.watch(root, (rel) => this.soon(mirror, rel));
      for (const agentId of mirror.agents.keys()) this.deps.told(agentId, undefined, undefined);
    });
    for (const peer of peersOf(mirror)) this.offer(mirror, peer);
  }

  private close(mirror: Mirror): void {
    if (this.mirrors.get(mirror.key) === mirror) this.mirrors.delete(mirror.key);
    mirror.watcher?.close();
    if (mirror.timer) clearTimeout(mirror.timer);
    for (const { timer } of mirror.again.values()) if (timer) clearTimeout(timer);
    mirror.again.clear();
  }

  /** The mirror is open and its folder still the one it was; a folder that went or is another one stops the mirror. */
  private alive(mirror: Mirror): boolean {
    if (this.mirrors.get(mirror.key) !== mirror) return false;
    const id = rootId(mirror.root);
    if (id !== undefined && id === mirror.id) return true;
    const why = id === undefined ? `${mirror.home} is no longer there on ${this.pc()}` : `${mirror.home} was replaced by another folder on ${this.pc()}`;
    this.close(mirror);
    this.lost.set(mirror.key, why);
    mirror.gone = true;
    void forgetIndex(this.s.paths.data, mirror.key).catch(() => undefined); // gone is forgotten: a folder in its place starts fresh
    this.s.log.info('home project mirror stopped', { agents: [...mirror.agents.keys()], gone: id === undefined });
    for (const agentId of mirror.agents.keys()) this.deps.told(agentId, undefined, why);
    return false;
  }

  /** Ends every watch and timer (the sync stops). */
  stop(): void {
    for (const mirror of [...this.mirrors.values()]) this.close(mirror);
  }

  private of(agentId: string): Mirror | undefined {
    for (const mirror of this.mirrors.values()) if (mirror.agents.has(agentId)) return mirror;
    return undefined;
  }

  /** One job after the other per folder: looks, takes and lists never run into each other. */
  private run<T>(mirror: Mirror, job: () => Promise<T>): Promise<T | undefined> {
    const next = mirror.work.then(job).catch((error: unknown) => { this.s.log.info('home project not mirrored', { agents: [...mirror.agents.keys()], error: errorText(error) }); return undefined; });
    mirror.work = next;
    return next;
  }

  // ---------------------------------------------------------------- this PC's changes

  private soon(mirror: Mirror, rel: string): void {
    if (rel && !carried(rel)) return;
    mirror.queued.add(rel);
    mirror.timer ??= unref(setTimeout(() => { mirror.timer = undefined; void this.run(mirror, () => this.lookQueued(mirror)); }, LOOK_MS));
  }

  /** Looks at what the watch reported ('' = everything; a folder with all below it) and tells the other home PCs. */
  private async lookQueued(mirror: Mirror): Promise<void> {
    const queued = [...mirror.queued];
    mirror.queued.clear();
    if (!queued.length || !this.alive(mirror)) return;
    const guard = new Guard(mirror.root);
    const rels = new Set<string>();
    if (queued.includes('')) for (const rel of await this.all(mirror)) rels.add(rel);
    else {
      const known = Object.keys(mirror.index.files);
      for (const rel of queued) {
        rels.add(rel);
        for (const key of known) if (key.startsWith(`${rel}/`)) rels.add(key);
        const folder = inside(mirror.root, rel)!;
        if (realDir(folder) && await guard.ok(`${rel}/x`)) for (const below of await walk(folder)) rels.add(`${rel}/${below}`);
      }
    }
    this.announce(mirror, await this.changed(mirror, rels, guard));
  }

  private async all(mirror: Mirror): Promise<Set<string>> {
    return new Set([...await walk(mirror.root), ...Object.keys(mirror.index.files)]);
  }

  /**
   * Looks at each path; returns those whose content is another one than this PC last saw (and remembers them). A file
   * that cannot be read, or is not carried any more, stays as it was remembered; nothing is returned when the folder
   * is not the one it was.
   */
  private async changed(mirror: Mirror, rels: Iterable<string>, guard: Guard): Promise<Have[]> {
    const out: Have[] = [];
    let moved = false;
    for (const rel of rels) {
      const old = mirror.index.files[rel];
      let now;
      try { now = await this.lookAt(mirror.root, rel, old, guard); } catch { continue; } // unknown, never gone
      if (now === 'skip' || now === old) continue;
      const next = now === 'gone' ? undefined : now;
      if (!next && !old) continue;
      moved = true;
      if (next) mirror.index.files[rel] = next; else delete mirror.index.files[rel];
      if ((old?.sha ?? '') !== (next?.sha ?? '')) out.push(haveOf(rel, next));
    }
    if (!this.alive(mirror)) return []; // it went while this PC looked: what looked gone is not told
    if (moved) await this.save(mirror);
    return out;
  }

  private async save(mirror: Mirror): Promise<void> {
    if (mirror.gone) return; // its folder went: what it remembered is forgotten, not written again
    mirror.index.id = mirror.id;
    await writeIndex(this.s.paths.data, mirror.key, mirror.index).catch((error: unknown) => this.s.log.info('home project list not kept', { error: errorText(error) }));
  }

  /** The agent on whose behalf this PC talks to `peer` about the folder. */
  private agentFor(mirror: Mirror, peer: string): string | undefined {
    for (const [agentId, peers] of mirror.agents) if (peers.includes(peer)) return agentId;
    return undefined;
  }

  /** Tells `entries` to the folder's other home PCs that are linked now (only `only`, when given). */
  private announce(mirror: Mirror, entries: Have[], only?: string): void {
    if (!entries.length) return;
    for (const peer of only ? [only] : peersOf(mirror)) {
      if (!this.s.devices.online(peer)) continue;
      for (let index = 0; index < entries.length; index += PAGE) void this.post(mirror, peer, { entries: entries.slice(index, index + PAGE) });
    }
  }

  private async post(mirror: Mirror, peer: string, params: Record<string, unknown>): Promise<{ ok?: boolean; why?: string } | undefined> {
    const agentId = this.agentFor(mirror, peer);
    if (!agentId) return undefined;
    try {
      return await this.deps.call(peer, { op: 'have', agentId, home: mirror.home, ...params }) as { ok?: boolean; why?: string } | undefined;
    } catch (error) {
      this.s.log.info('home project not told', { agentId, peer, error: errorText(error) });
      return undefined;
    }
  }

  /** What is waiting from the watch goes now (a leave: the other PC starts on what I left). */
  async flush(agentId: string): Promise<void> {
    const mirror = this.of(agentId);
    if (!mirror) return;
    if (mirror.timer) { clearTimeout(mirror.timer); mirror.timer = undefined; }
    await this.run(mirror, () => this.lookQueued(mirror));
  }

  /** A link came up: every folder `peer` shares gets this PC's whole list. */
  catchUp(peer: string): void {
    this.refresh();
    for (const mirror of this.mirrors.values()) {
      if (!peersOf(mirror).includes(peer)) continue;
      this.askAgain(mirror, peer, false); // a new link: failed takes are asked for from the start again
      this.offer(mirror, peer);
    }
  }

  /** Looks at the whole folder, then sends `peer` the list of every file here in numbered pages; the first one for that PC says so. */
  private offer(mirror: Mirror, peer: string): void {
    if (!this.s.devices.online(peer)) return;
    void this.run(mirror, async () => {
      if (!this.alive(mirror)) return;
      this.announce(mirror, await this.changed(mirror, await this.all(mirror), new Guard(mirror.root)));
      if (this.mirrors.get(mirror.key) !== mirror) return;
      const entries = Object.entries(mirror.index.files).map(([rel, seen]) => haveOf(rel, seen));
      const id = randomUUID();
      const first = !mirror.index.agreed[peer];
      const told = (why: string | undefined) => { for (const [agentId, peers] of mirror.agents) if (peers.includes(peer)) this.deps.told(agentId, peer, why); };
      for (let page = 0; page === 0 || page * PAGE < entries.length; page++) {
        if (!this.s.devices.online(peer)) return;
        const answer = await this.post(mirror, peer, { entries: entries.slice(page * PAGE, (page + 1) * PAGE), list: id, page, end: (page + 1) * PAGE >= entries.length, ...(first && page === 0 ? { first: true } : {}) });
        if (!answer) return;
        if (!answer.ok) { if (typeof answer.why === 'string') told(answer.why.slice(0, 400)); return; }
      }
      told(undefined);
    });
  }

  /** After a failed take: asks `from` for its list again while it stays linked; a take without one ends that. */
  private askAgain(mirror: Mirror, from: string, failed: boolean): void {
    const state = mirror.again.get(from) ?? { step: 0 };
    if (!failed) { if (state.timer) clearTimeout(state.timer); mirror.again.delete(from); return; }
    if (state.timer || state.step >= this.retryMs.length) return;
    state.timer = unref(setTimeout(() => {
      state.timer = undefined;
      state.step++;
      const agentId = this.agentFor(mirror, from);
      if (agentId && this.s.devices.online(from)) void this.deps.call(from, { op: 'want', agentId, home: mirror.home }).catch(() => undefined);
    }, this.retryMs[state.step]));
    mirror.again.set(from, state);
  }

  // ---------------------------------------------------------------- the other PC's files

  /** The share method's project part from home PC `from`: 'have' (files it holds), 'want' (its list again), 'get' (one piece). */
  async receive(p: { op?: unknown; agentId?: unknown; home?: unknown; rel?: unknown; offset?: unknown; entries?: unknown; list?: unknown; page?: unknown; end?: unknown; first?: unknown }, from: string): Promise<unknown> {
    const agentId = String(p.agentId);
    if (!this.deps.peers(agentId).includes(from)) throw new WorkforceError('forbidden', 'A home project travels only between the PCs its agent is at home on.');
    if (!this.of(agentId)) this.refresh();
    const mirror = this.of(agentId);
    if (p.op === 'get') {
      const file = mirror && typeof p.rel === 'string' && typeof p.offset === 'number' ? inside(mirror.root, p.rel) : undefined;
      const piece = file && await new Guard(mirror!.root).ok(p.rel as string) ? await readPiece(file, p.offset as number) : undefined; // never through a link
      if (!piece) throw new WorkforceError('not_found', 'That file is not here.');
      return piece;
    }
    if (!mirror || typeof p.home !== 'string' || this.key(p.home) !== mirror.key) {
      const home = this.s.agentCore?.homes.stored(agentId);
      const why = home && home === p.home ? this.problem(agentId, home) : undefined; // another home here (agent.json still on its way): quiet
      return { ok: false, ...(why ? { why } : {}) };
    }
    if (p.op === 'want') { this.offer(mirror, from); return { ok: true }; }
    if (p.op !== 'have' || !Array.isArray(p.entries)) throw new WorkforceError('bad_request', 'Unknown home project request.');
    const entries = (p.entries as Array<Partial<Have>>).filter((entry): entry is Have => typeof entry?.rel === 'string' && typeof entry.sha === 'string' && typeof entry.mtime === 'number' && carried(entry.rel))
      .map((entry) => ({ rel: entry.rel, sha: entry.sha, size: Number(entry.size) || 0, mtime: entry.mtime }));
    const list: ListPage | undefined = typeof p.list === 'string' && Number.isInteger(p.page) && (p.page as number) >= 0 ? { id: p.list, page: p.page as number, end: p.end === true, first: p.first === true } : undefined;
    // Answered at once: the sender never waits inside its own queue. Before anything is written, this PC's rules and
    // the agents' homes are read again.
    void this.run(mirror, async () => {
      this.refresh();
      if (this.mirrors.get(mirror.key) !== mirror || !mirror.agents.get(agentId)?.includes(from)) return;
      await take(this.ctx, mirror, from, agentId, entries, list);
    });
    return { ok: true };
  }
}
