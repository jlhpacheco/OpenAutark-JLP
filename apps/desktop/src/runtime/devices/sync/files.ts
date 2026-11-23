// Files between the CEO's own PCs (mesh method 'sync.file'): whole files by sha256 – from <data> theme.css, prompts/,
// modes/, agents/** (SYSTEM.md, Main Skills, agent.json, images; not the generated agents/README.md), memory/**,
// connectors/mcp.json and mail.json, security/<mode>/<topic>.md (19.11.2026: the security texts; a pulled one is
// accepted by runtime/security/topics.ts before it is put in place, so Secure mode never puts it back as an edit; FX1 H5:
// one goes out only while its text is the one the app accepted – an edit about to be put back never travels; REVIEW-2 12:
// its entry is the hash of exactly the text that was checked, and 'get' checks the text again before it serves it), and
// the workspace's skills/**. A manifest (kv ns 'sync.files': path → sha, size,
// mtime, at; sha '' = removed) says what this PC has; a scan finds changes by size and mtime, then by hash. A catch-up
// (service.ts: at link-up and in rhythm) sends the settings and the entries stored after that PC's 'files' cursor (all
// the first time; what is left when its link goes, the next one) – the scan of every root first only at link-up – and a
// change seen later goes at once ('have': the data folder watcher's tap when it has one, else the owners' events).
// The other PC pulls what is newer (`at`:
// the file's mtime, a removal's time) in pieces of at most 1 MiB like send-file.ts into a *.tmp file (the watcher
// ignores those) and puts it in place (file-io.ts: a rename, a copy where Windows refuses it) – so the file's owner
// (agent core, memory, theme …) takes it like an edit. A pull that failed leaves the catch-up incomplete: the cursor
// moves only up to the page it was in, and the next one – at most REFRESH_MS later, with a rescan – offers it again. A file that changed
// here while its pull ran stays (the pull is dropped). What a 'have' finds changed here and does not replace goes out
// at once, to its sender too; a look that a pull overtook leaves the entry to the pull. B-087 for agents/<id>/SYSTEM.md,
// whose text also travels in the agents row: one that came before its row is taken over at once as the echo of that
// PC's change (stamps.ts) – unless the row here had already brought newer instructions, then the row stands –, and a
// rewrite with the same bytes (a save back to what the file says) is a new version. settings.json travels here as op 'settings'
// (settings.ts), stored files' bytes as op 'blob' (blobs.ts).
// Owns: the manifest, scans, pulls and which paths may be written. Never: writes outside these roots, follows a
// link, or talks to a PC that is no 'ceo' link.

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { KvRepo } from '../../store/kv.ts';
import { DevicesRepo } from '../repo.ts';
import { blobPiece } from './blobs.ts';
import { hashFile, pullPieces, readPiece, replaceWithSync } from './file-io.ts';
import { isCeoPc, linkOf, links } from './home.ts';
import { SettingsSync, type SettingsMessage } from './settings.ts';
import { wins, type Stamps } from './stamps.ts';
import { SECURITY_DIR } from '../../../shared/model/security-settings.ts';
import { securityTopics, topicOfRel } from '../../security/topics.ts';

const DATA_ROOTS = ['theme.css', 'prompts', 'modes', 'agents', 'memory', 'connectors/mcp.json', 'connectors/mail.json', SECURITY_DIR];
const WORKSPACE_ROOTS = ['skills'];
const NEVER: ReadonlySet<string> = new Set(['agents/README.md']);
const NS = 'sync.files';
const PAGE = 500;
const MAX_FILES = 200_000;
const SYSTEM_MD = /^agents\/([^/]+)\/SYSTEM\.md$/;

interface Entry { sha: string; size: number; mtime: number; at: number }
interface Have { rel: string; sha: string; at: number }

/** An owner's watcher tap (RootWatcher.tap when it exists): `name` the data folder entry, `parts` below it. */
export type WatcherTap = (listener: (name: string, parts?: readonly string[]) => void) => () => void;

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export class FileSync {
  private readonly s: RuntimeServices;
  private readonly kv: KvRepo;
  private readonly stamps: Stamps;
  readonly settings: SettingsSync;
  private readonly roots = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  /** The rename that puts a pulled file in place (tests make it refuse; default file-io.ts's). */
  move?: (from: string, to: string) => void;

  constructor(s: RuntimeServices, stamps: Stamps) {
    this.s = s;
    this.kv = new KvRepo(s.db);
    this.stamps = stamps;
    this.settings = new SettingsSync(s, stamps, (message, except) => { void this.toCeo({ op: 'settings', ...message }, except); });
  }

  /** Change triggers: the watcher tap (if any) and the owners' events; returns the off switch. */
  attach(tap?: WatcherTap): () => void {
    const bus = this.s.bus;
    const offs = [
      this.settings.attach(),
      bus.on('theme.updated', () => this.soon('theme.css')),
      bus.on('modes.changed', () => this.soon('modes')),
      bus.on('apps.changed', () => { this.soon('connectors/mcp.json'); this.soon('connectors/mail.json'); }),
      bus.on('skills.changed', () => this.soon('skills')),
      bus.on('agent.upserted', (agent) => this.soon(`agents/${agent.id}`)),
    ];
    if (tap) offs.push(tap((name, parts) => this.soon([name, ...(parts ?? [])].join('/'))));
    return () => {
      for (const off of offs) off();
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /** A path (or a folder of them) changed: looked at once, a second later. */
  private soon(rel: string): void {
    if (!this.allowed(rel, true)) return;
    this.roots.add(rel);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.scanQueued(); }, 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async scanQueued(): Promise<void> {
    const roots = [...this.roots];
    this.roots.clear();
    const changed: Have[] = [];
    for (const root of roots) changed.push(...await this.scan(root));
    if (changed.length) await this.toCeo({ op: 'have', entries: changed });
  }

  // ---------------------------------------------------------------- paths and the manifest

  /** Whether `rel` lies in a synced root (`prefix`: it may also be a folder above files). */
  private allowed(rel: string, prefix = false): boolean {
    const parts = rel.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\:\u0000]/.test(part)) || NEVER.has(rel)) return false;
    if (/\.(tmp|part)$/i.test(rel)) return false;
    if (parts[0] === SECURITY_DIR && parts.length > 2 && !topicOfRel(rel)) return false; // only the topic files, never a rejected copy
    return [...DATA_ROOTS, ...WORKSPACE_ROOTS].some((root) => rel === root || rel.startsWith(`${root}/`) || (prefix && root.startsWith(`${rel}/`)));
  }

  private abs(rel: string): string | undefined {
    if (!this.allowed(rel)) return undefined;
    const base = WORKSPACE_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`)) ? this.s.paths.workspace : this.s.paths.data;
    return path.join(base, ...rel.split('/'));
  }

  private toRel(file: string): string {
    const workspace = path.relative(this.s.paths.workspace, file);
    const rel = !workspace.startsWith('..') && !path.isAbsolute(workspace) && workspace.split(path.sep)[0] === 'skills' ? workspace : path.relative(this.s.paths.data, file);
    return rel.split(path.sep).join('/');
  }

  /** Looks at one file: a changed (or removed) one gets a new manifest entry, returned. */
  private async check(rel: string): Promise<Have | undefined> {
    const file = this.abs(rel);
    if (!file) return undefined;
    const old = this.kv.get<Entry>(NS, rel);
    // A pull (or another look) stored this path while this one waited: it looks again – a pulled file then matches its
    // entry, a newer state than an older look stored goes on top.
    const moved = () => JSON.stringify(this.kv.get<Entry>(NS, rel)) !== JSON.stringify(old);
    const info = await lstat(file).catch(() => undefined);
    // FX1 H5: a topic file only with the app's text – read once, and that very text is what its entry hashes (REVIEW-2 12)
    const accepted = topicOfRel(rel) ? this.topicBytes(rel, file, info?.isFile() === true) : undefined;
    if (accepted === false) return undefined;
    const now = this.s.clock.now();
    if (!info?.isFile()) {
      if (!old?.sha) return undefined;
      if (moved()) return this.check(rel);
      const gone: Entry = { sha: '', size: 0, mtime: 0, at: Math.max(now, old.at + 1) };
      this.kv.set(NS, rel, gone, now);
      return { rel, sha: '', at: gone.at };
    }
    if (old?.sha && old.size === info.size && old.mtime === info.mtimeMs) return undefined;
    const sha = accepted ? createHash('sha256').update(accepted).digest('hex') : await hashFile(file);
    if (moved()) return this.check(rel);
    const rewritten = old?.sha === sha && SYSTEM_MD.test(rel) && Math.floor(info.mtimeMs) > old.at; // a save back to what SYSTEM.md says
    if (old?.sha === sha && !rewritten) { this.s.db.run('UPDATE kv SET value = ? WHERE ns = ? AND key = ?', [JSON.stringify({ ...old, size: info.size, mtime: info.mtimeMs }), NS, rel]); return undefined; }
    const entry: Entry = { sha, size: info.size, mtime: info.mtimeMs, at: Math.max(Math.floor(info.mtimeMs), (old?.at ?? 0) + 1) };
    this.kv.set(NS, rel, entry, now);
    return { rel, sha, at: entry.at };
  }

  /**
   * A security topic file's bytes when they say what the app accepted (topics.ts isAccepted), undefined for a missing file
   * the app has none of either; false when it is not the app's text (yet) or cannot be read.
   */
  private topicBytes(rel: string, file: string, exists: boolean): Buffer | undefined | false {
    let bytes: Buffer | undefined;
    if (exists) { try { bytes = readFileSync(file); } catch { return false; } }
    return securityTopics(this.s).isAccepted(rel, bytes ? bytes.toString('utf8') : null) ? bytes : false;
  }

  /** Every file under `root` (a synced root, a folder in one, or one file) plus the removed ones it had. */
  private async scan(root: string): Promise<Have[]> {
    const rels = new Set<string>();
    for (const top of [...DATA_ROOTS, ...WORKSPACE_ROOTS].filter((name) => name === root || name.startsWith(`${root}/`) || root.startsWith(`${name}/`))) {
      const start = top.length >= root.length ? top : root;
      const file = this.abs(start);
      const info = file ? await lstat(file).catch(() => undefined) : undefined;
      if (info?.isFile()) rels.add(start);
      if (!info?.isDirectory()) continue;
      for (const entry of await readdir(file!, { recursive: true, withFileTypes: true }).catch(() => [])) {
        if (rels.size >= MAX_FILES) break;
        const rel = this.toRel(path.join(entry.parentPath, entry.name));
        if (entry.isFile() && this.allowed(rel)) rels.add(rel);
      }
    }
    for (const row of this.s.db.all<{ key: string }>('SELECT key FROM kv WHERE ns = ? AND (key = ? OR substr(key, 1, ?) = ?)', [NS, root, root.length + 1, `${root}/`])) rels.add(row.key);
    const changed: Have[] = [];
    for (const rel of rels) {
      try { const have = await this.check(rel); if (have) changed.push(have); } catch (error) { this.s.log.info('synced file not read', { rel, error: errorText(error) }); }
    }
    return changed;
  }

  // ---------------------------------------------------------------- sending

  private async toCeo(params: Record<string, unknown>, except?: string): Promise<void> {
    for (const { record, link } of links(this.s.db)) {
      if (link.kind !== 'ceo' || record.id === except || !this.s.devices.online(record.id)) continue;
      await this.post(record.id, params);
    }
  }

  /** False when the call failed or the other PC could not pull a file it wanted (it is offered again). */
  private async post(peer: string, params: Record<string, unknown>): Promise<boolean> {
    try {
      const answer = await this.s.devices.call(peer, 'sync.file', params) as { failed?: unknown } | undefined;
      return !(typeof answer?.failed === 'number' && answer.failed > 0);
    } catch (error) {
      this.s.log.info('sync files not sent', { peer, op: params.op, error: errorText(error) });
      return false;
    }
  }

  /**
   * What a catch-up owes a CEO PC: the settings, then the manifest entries stored after `since` (all the first time);
   * `scan`: every root is looked at first (a link-up, or the round after one that did not complete; else a round sends
   * what the live changes stored). True when all arrived; else the time before which every entry arrived (up to the
   * first page that did not – the 'files' cursor may move there), or false.
   */
  async catchUp(peer: string, since: number | undefined, { scan = true }: { scan?: boolean } = {}): Promise<boolean | number> {
    if (!isCeoPc(this.s.db, peer)) return true;
    const settled = await this.post(peer, { op: 'settings', ...this.settings.current() });
    if (scan) for (const root of [...DATA_ROOTS, ...WORKSPACE_ROOTS]) await this.scan(root);
    const rows = this.s.db.all<{ key: string; value: string; updated_at: number }>('SELECT key, value, updated_at FROM kv WHERE ns = ? AND updated_at > ? ORDER BY updated_at, key', [NS, since ?? -1]);
    let upTo: number | undefined;
    for (let index = 0; index < rows.length; index += PAGE) {
      if (!this.s.devices.online(peer)) { upTo ??= Number(rows[index].updated_at) - 1; break; } // B-087: the link is gone – no dial per page; the next catch-up offers the rest
      const entries = rows.slice(index, index + PAGE).map((row) => { const entry = JSON.parse(row.value) as Entry; return { rel: row.key, sha: entry.sha, at: entry.at }; });
      if (!(await this.post(peer, { op: 'have', entries }))) upTo ??= Number(rows[index].updated_at) - 1;
    }
    return upTo ?? settled;
  }

  // ---------------------------------------------------------------- receiving

  /** 'sync.file' from a CEO PC: settings, a list of what it has, one piece of a file or of a stored file's bytes. */
  async receive(params: unknown, from: string): Promise<unknown> {
    const record = new DevicesRepo(this.s.db).get(from);
    if (linkOf(record)?.kind !== 'ceo') throw new WorkforceError('forbidden', 'Files come only from the CEO\'s own PCs.');
    const p = (params ?? {}) as { op?: unknown; rel?: unknown; id?: unknown; offset?: unknown; entries?: unknown };
    if (p.op === 'settings') { this.settings.receive(p as unknown as SettingsMessage, from, Boolean(record?.joinedAs)); return { ok: true }; }
    if (p.op === 'have' && Array.isArray(p.entries)) return { ok: true, ...await this.have(p.entries, from, Boolean(record?.joinedAs)) };
    if (typeof p.offset !== 'number' || !(p.op === 'get' && typeof p.rel === 'string') && !(p.op === 'blob' && typeof p.id === 'string')) {
      throw new WorkforceError('bad_request', 'Unknown file sync request.');
    }
    const file = p.op === 'get' ? this.abs(p.rel as string) : undefined;
    if (file && topicOfRel(p.rel as string) && !this.topicBytes(p.rel as string, file, true)) throw new WorkforceError('not_found', 'That file is not here.'); // REVIEW-2 12: only the accepted text goes out
    const piece = p.op === 'blob' ? await blobPiece(this.s, p.id as string, p.offset) : file ? await readPiece(file, p.offset) : undefined;
    if (!piece) throw new WorkforceError('not_found', 'That file is not here.');
    return piece;
  }

  /** Takes every entry that is newer than this PC's (removes or pulls the file), then tells the other CEO PCs; `failed`: pulls that did not work. */
  private async have(list: unknown[], from: string, joined: boolean): Promise<{ taken: number; failed: number }> {
    const taken: Have[] = [];
    const own: Have[] = [];
    let failed = 0;
    for (const raw of list) {
      const entry = raw as Partial<Have>;
      if (typeof entry?.rel !== 'string' || typeof entry.sha !== 'string' || typeof entry.at !== 'number' || !this.abs(entry.rel)) continue;
      const have = entry as Have;
      try {
        const changed = await this.check(have.rel); // this PC's own state first
        const mine = this.kv.get<Entry>(NS, have.rel);
        if (mine?.sha === have.sha) this.later(have.rel, have.at);
        if (mine?.sha === have.sha || !wins({ at: have.at, h: have.sha }, mine && { at: mine.at, h: mine.sha }, joined)) {
          if (changed) own.push(changed);
          continue;
        }
        if (have.sha) {
          const got = await this.pull(from, have, mine);
          if (got === false) { failed++; continue; } // the sender's next catch-up offers it again
          if (got === undefined) continue; // an overlapping pull put it in place and passed it on
        } else {
          if (topicOfRel(have.rel)) securityTopics(this.s).acceptSynced(have.rel, null);
          await rm(this.abs(have.rel)!, { force: true });
          this.kv.set(NS, have.rel, { sha: '', size: 0, mtime: 0, at: have.at }, this.s.clock.now());
        }
        taken.push(have);
      } catch (error) {
        failed++;
        this.s.log.info('synced file not taken', { rel: have.rel, error: errorText(error) });
      }
    }
    if (taken.length) void this.toCeo({ op: 'have', entries: taken }, from);
    if (own.length) void this.toCeo({ op: 'have', entries: own }); // newer here: the sender gets it too
    return { taken: taken.length, failed };
  }

  /** The same bytes came with a later time: kept, so a later change here still counts as newer (also after a clock skew). */
  private later(rel: string, at: number): void {
    const entry = this.kv.get<Entry>(NS, rel);
    if (entry?.sha && at > entry.at) this.kv.set(NS, rel, { ...entry, at }, this.s.clock.now());
  }

  /** `mine`: this PC's entry when the pull was decided – a file changed here since stays; undefined: an overlapping pull put this version in place. */
  private async pull(from: string, have: Have, mine: Entry | undefined): Promise<boolean | undefined> {
    const file = this.abs(have.rel)!;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await pullPieces(temp, (offset) => this.s.devices.call(from, 'sync.file', { op: 'get', rel: have.rel, offset }));
      if (await hashFile(temp) !== have.sha) throw new Error('it changed on the way');
      if (this.kv.get<Entry>(NS, have.rel)?.sha === have.sha) { this.later(have.rel, have.at); await rm(temp, { force: true }); return undefined; }
      // From here on in one synchronous step: no save here can land between the last look and the file in place.
      if (this.changedHere(have.rel, file, mine)) throw new Error('it changed here meanwhile');
      const agentId = SYSTEM_MD.exec(have.rel)?.[1];
      const ahead = agentId !== undefined && this.s.agentCore?.rowAhead(agentId) === true;
      if (topicOfRel(have.rel)) securityTopics(this.s).acceptSynced(have.rel, readFileSync(temp, 'utf8')); // not put back as an edit (Secure mode)
      replaceWithSync(temp, file, this.move);
      const info = lstatSync(file);
      this.kv.set(NS, have.rel, { sha: have.sha, size: info.size, mtime: info.mtimeMs, at: have.at }, this.s.clock.now());
      if (agentId) this.arrived(agentId, ahead);
      return true;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      this.s.log.info('synced file not pulled', { rel: have.rel, error: errorText(error) });
      return false;
    }
  }

  /** Whether the file changed here since `mine` was stored (a save while its pull ran): a scan stored another state, or it is not the file `mine` describes. */
  private changedHere(rel: string, file: string, mine: Entry | undefined): boolean {
    if (this.kv.get<Entry>(NS, rel)?.sha !== mine?.sha) return true;
    let info: Stats | undefined;
    try { info = lstatSync(file); } catch { info = undefined; }
    if (!info?.isFile()) return Boolean(mine?.sha);
    return !mine?.sha || info.size !== mine.size || info.mtimeMs !== mine.mtime;
  }

  /**
   * A SYSTEM.md in place now. `ahead`: the agents row here had already brought newer instructions than the app's own
   * file – the row stands and the pulled file is the app's own. Else the agent core takes it over at once, and that
   * change of the row is the echo of the change on the PC it came from (stamps.ts).
   */
  private arrived(agentId: string, ahead: boolean): void {
    if (ahead) { this.s.agentCore?.arrived(agentId, true); return; }
    const key = `agents/${agentId}`;
    this.stamps.echo.add(key);
    try { this.s.agentCore?.arrived(agentId); } finally { this.stamps.echo.delete(key); }
  }
}
