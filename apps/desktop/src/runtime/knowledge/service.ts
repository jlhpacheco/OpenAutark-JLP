// KnowledgeService: memory is a folder tree of Markdown files (memory-tree.ts, <data>/memory) and the files are the truth.
// Writing memory makes it findable at once by its words (tree-words.ts; the caller's folders pick, acl.ts); with a chosen embedding
// model the word hits are re-ranked by meaning (search.ts, services.vectors.rank), and a removed note's stored meaning goes with it
// (memory-follow.ts). The old calls (save, correct, expire,
// pin, list, history …) are thin wrappers over the files; an item's id is its path ('/' written ':', memory-tree.ts).
// The database keeps the old versions of files (expired rows, `supersedes` = the file's id; retention removes them) and
// the map of old `kn_…` ids to their files (rows.ts movedTo). Texts are redacted before they are stored.
// Owns: these calls and the old versions. Never: a list of the tree in a prompt; embeds a file; recreates an item under an id
// without a file or row.

import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { Clock, KnowledgeService, Logger } from '../contracts.ts';
import type { RootWatcher } from '../root/watcher.ts';
import type { OwnWrites } from '../root/text-doc.ts';
import type { Db } from '../db/database.ts';
import type { KnowledgeHit, KnowledgeItem, KnowledgeListFilter, KnowledgeQuery } from '../../shared/model/knowledge.ts';
import type { MemoryFile, MemoryFolder, MemoryWriteInput, MemoryWriteResult } from '../../shared/model/memory.ts';
import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { agentReach, passes, queryFolders } from './acl.ts';
import { savedText } from './age.ts';
import './contract.ts';
import { KINDS, buildItem, type SaveInput } from './item-build.ts';
import { MemoryFollow } from './memory-follow.ts';
import {
  MEMORY_ENTRY, MemoryTree, PINNED_DIR, entryOfItem, folderOfScope, folderOfWholeScope, isFileId, itemOfEntry, memoryId, sameEntry, withPinned, type MemoryEntry,
} from './memory-tree.ts';
import { describePlace, describeTop, scratchRoot } from './memory-places.ts';
import { SCAN_MAX, scanFiles, scanFilesAsync } from './memory-scan.ts';
import { ITEM_COLUMNS, chainIds, correctRow, deleteRows, expireRow, getRow, insertItem, movedTo, pinRow, rowHistory, toItem, type KnowledgeRow } from './rows.ts';
import { normalScopeId } from './scope-id.ts';
import type { MemoryVectors } from './search.ts';
import { TreeWords } from './tree-words.ts';
import { ALWAYS_CHARS } from './always.ts';

export type { MemoryVectors };

/** The prompt's one cap of the always set (knowledge/always.ts ALWAYS_CHARS), applied to the rendered lines there. */
export const PINNED_CHAR_CAP = ALWAYS_CHARS;
/** Pinned files read for a prompt at most, over all places (more never fit the one cap, even as description lines). */
const PINNED_READ = 200;

export interface KnowledgeServiceOptions {
  db: Db;
  clock: Clock;
  log?: Logger;
  bus?: Bus;
  /** Replaces known secret values with handles before anything is stored. */
  redact?: (text: string) => string;
  /** The person's time zone (context/time.ts profileZone) the saved day of a hit is shown in; default the process zone. */
  zone?: () => string | undefined;
  /** The memory tree; default <folder of the database file>/memory (an in-memory database: a temporary folder). */
  root?: string;
  /** services.vectors (late-bound); missing or without a chosen model: memory is found by its words alone. */
  vectors?: () => MemoryVectors | undefined;
  /** Told about the store's own writes (the data folder watcher): their events are no outside edit. */
  writes?: OwnWrites;
}

export class KnowledgeStore implements KnowledgeService {
  private db: Db;
  private clock: Clock;
  private log?: Logger;
  private bus?: Bus;
  private redact: (text: string) => string;
  private zone: () => string | undefined;
  private vectors: () => MemoryVectors | undefined;
  private tree: MemoryTree;
  private rootDir?: string;
  private topDescribed = false;
  private follow: MemoryFollow;
  /** The tree's words (tree-words.ts): its word index and its notes as last read. */
  private readonly words: TreeWords;

  constructor(options: KnowledgeServiceOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.log = options.log;
    this.bus = options.bus;
    this.redact = options.redact ?? (text => text);
    this.zone = options.zone ?? (() => undefined);
    this.vectors = options.vectors ?? (() => undefined);
    this.rootDir = options.root;
    this.tree = new MemoryTree(() => (this.rootDir ??= this.defaultRoot()), options.writes);
    this.words = new TreeWords(this.tree, this.vectors);
    this.follow = new MemoryFollow({ db: this.db, now: () => this.clock.now(), tree: this.tree, vectors: this.vectors, log: this.log });
  }

  /** The tree's folder. */
  get memoryRoot(): string {
    return this.tree.root;
  }

  /** Starts following the tree: the watcher's reports of direct edits and the edits while the app was closed (memory-follow.ts). stopMemory ends the watching. */
  startMemory(watcher?: Pick<RootWatcher, 'register'>): Promise<void> {
    return this.follow.start(watcher);
  }

  stopMemory(): void {
    this.follow.stop();
  }

  memoryBrowse(folder = ''): MemoryFolder {
    this.describeTopOnce();
    return this.tree.browse(this.tree.rel(folder));
  }

  memoryRead(file: string): MemoryFile | undefined {
    const entry = this.tree.read(this.tree.fileRel(file));
    if (!entry) return undefined;
    const { by: _by, confidence: _confidence, untrusted: _untrusted, extra: _extra, ...shared } = entry;
    return shared;
  }

  /** Creates or updates a file: `path`, else the file of this title in `folder`. An unchanged entry stays as it is. */
  memoryWrite(input: MemoryWriteInput & { by?: string }): MemoryWriteResult {
    const title = this.redact(input.title.trim());
    const text = this.redact(input.text.trim());
    if (!title || !text) throw new WorkforceError('bad_request', 'A memory file needs a title and a text.');
    const rel = input.path ? this.tree.fileRel(input.path) : this.tree.slot(this.tree.rel(input.folder ?? 'company'), title);
    const old = this.tree.read(rel);
    const kind = input.kind && KINDS.has(input.kind) ? input.kind : old?.kind; // a brain's free text never reaches the frontmatter
    const description = input.description === undefined ? old?.description : this.redact(input.description.replace(/\s+/g, ' ').trim()) || undefined;
    const next: Omit<MemoryEntry, 'path'> = {
      ...old, title, text, description,
      ...(kind ? { kind } : {}),
      ...(input.tags ?? old?.tags ? { tags: input.tags ?? old?.tags } : {}),
      ...(input.source ?? old?.source ? { source: this.redact(input.source ?? old?.source ?? '') } : {}),
      ...(input.validFrom ?? old?.validFrom ? { validFrom: input.validFrom ?? old?.validFrom } : {}),
      ...(input.validTo ?? old?.validTo ? { validTo: input.validTo ?? old?.validTo } : {}),
      ...(input.by ?? old?.by ? { by: input.by ?? old?.by } : {}),
      ...(input.confidence ?? old?.confidence ? { confidence: input.confidence ?? old?.confidence } : {}),
      updated: this.clock.now(),
    };
    if (old && sameEntry(old, next)) return { path: rel, outcome: 'unchanged' };
    this.put(rel, next, old);
    return { path: rel, outcome: old ? 'updated' : 'created' };
  }

  memoryForget(file: string): { removed: boolean } {
    const rel = this.tree.fileRel(file);
    if (!this.tree.exists(rel)) {
      if (this.tree.exists(rel.replace(/\.md$/i, ''))) throw new WorkforceError('bad_request', 'This is a folder. Forget its files one by one, or delete the folder itself.');
      return { removed: false };
    }
    const ids = this.removeFile(rel);
    this.bus?.emit('knowledge.removed', { ids });
    return { removed: true };
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeHit[]> {
    const now = this.clock.now();
    const limit = Math.max(1, Math.min(query.limit ?? 10, 255));
    const folders = queryFolders(this.db, query);
    const text = query.text.trim();
    if (text) return this.words.hits(query, text, folders, limit, now, this.zone()); // tree-words.ts: the query's folders and filters pick the hits, meaning re-ranks them
    const items = await scanFilesAsync(this.tree, folders, (item) => passes(item, query, now), limit);
    return items
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.recordedAt - a.recordedAt || (a.id < b.id ? 1 : -1))
      .map((item) => ({ item, score: 0, why: savedText(item.recordedAt, now, this.zone()) }));
  }

  /** New item, or – with `id` – a correction of that item (an id without a file or row is refused, never created). */
  save(input: SaveInput): KnowledgeItem {
    if (input.id) {
      if (!this.exists(input.id)) throw new WorkforceError('not_found', 'This item was forgotten or no longer exists.', { details: { id: input.id } });
      return this.correct(input.id, { title: input.title, body: input.body, validTo: input.validTo }, input.createdBy);
    }
    const item = this.build(input);
    const place = folderOfScope(item.scope, item.scopeId);
    const rel = this.tree.slot(item.pinned ? `${place}/${PINNED_DIR}` : place, item.title, { text: item.body });
    const old = this.tree.read(rel);
    if (old) return itemOfEntry(old); // the same title and text: that file
    return this.put(rel, entryOfItem(item, item.recordedAt));
  }

  correct(id: string, patch: { body?: string; title?: string; validTo?: number }, by: string): KnowledgeItem {
    const rel = this.fileOf(id);
    if (rel) {
      const old = this.tree.read(rel);
      if (!old) throw new WorkforceError('not_found', 'Knowledge item not found.');
      const title = this.redact((patch.title ?? old.title).trim());
      const text = this.redact((patch.body ?? old.text).trim());
      if (!title || !text) throw new WorkforceError('bad_request', 'Knowledge needs a title and a body.');
      const next = { ...old, title, text, by, updated: this.clock.now(), ...(patch.validTo !== undefined ? { validTo: patch.validTo } : {}) };
      return { ...this.put(rel, next, old), supersedes: memoryId(rel) };
    }
    const next = correctRow(this.db, id, this.clock.now(), (previous) => this.build({
      ...previous, id: undefined, title: patch.title ?? previous.title, body: patch.body ?? previous.body,
      validTo: patch.validTo ?? previous.validTo, createdBy: by, supersedes: previous.id, uses: 0, lastUsedAt: undefined,
    }));
    this.emit(next.old);
    this.emit(next.item);
    return next.item;
  }

  /** Ends an item: a file leaves the tree and stays as an old version until retention removes it. */
  expire(id: string, by: string, reason?: string): void {
    const rel = this.fileOf(id);
    if (rel) {
      const old = this.tree.read(rel);
      if (!old) throw new WorkforceError('not_found', 'Knowledge item not found.');
      const version = this.keepVersion(old);
      this.tree.remove(rel);
      this.follow.removed(rel);
      this.log?.info('knowledge expired', { id: memoryId(rel), by, reason });
      this.emit(version);
      return;
    }
    const ended = expireRow(this.db, id, this.clock.now());
    if (!ended) return;
    this.log?.info('knowledge expired', { id, by, reason });
    this.emit(ended);
  }

  /** Pins or unpins: a file moves into or out of its pinned/ subfolder (no new version; its id follows the path). */
  pin(id: string, pinned: boolean, by: string): KnowledgeItem {
    const rel = this.fileOf(id);
    if (!rel) {
      const { item, changed } = pinRow(this.db, id, pinned);
      if (changed) {
        this.log?.info('knowledge pinned', { id, pinned, by });
        this.emit(item);
      }
      return item;
    }
    const old = this.tree.read(rel);
    if (!old) throw new WorkforceError('not_found', 'Knowledge item not found.');
    const target = withPinned(rel, pinned);
    if (target === rel) return itemOfEntry(old);
    if (this.tree.exists(target)) throw new WorkforceError('conflict', `There already is a file ${target}.`);
    this.tree.move(rel, target);
    this.db.run('UPDATE knowledge SET supersedes = ? WHERE supersedes = ?', [memoryId(target), memoryId(rel)]);
    this.follow.removed(rel);
    this.follow.changed(target);
    const item = itemOfEntry({ ...old, path: target });
    this.log?.info('knowledge pinned', { id: item.id, pinned, by });
    this.emit(item);
    return item;
  }

  /** Deletes an item for good: its file or row with every old version. Emits `knowledge.removed`. */
  forget(id: string, by: string): { ids: string[] } {
    const version = isFileId(id) ? undefined : getRow(this.db, id)?.supersedes;
    const rel = this.fileOf(version && isFileId(version) ? version : id);
    if (rel) {
      if (!this.tree.exists(rel) && !this.versionIds(memoryId(rel)).length) throw new WorkforceError('not_found', 'Knowledge item not found.');
      const ids = this.removeFile(rel);
      this.log?.info('knowledge forgotten', { by, count: ids.length, ids });
      this.bus?.emit('knowledge.removed', { ids });
      return { ids };
    }
    const ids = this.db.tx(() => {
      const chain = chainIds(this.db, id);
      if (!chain.length) throw new WorkforceError('not_found', 'Knowledge item not found.');
      deleteRows(this.db, chain);
      return chain;
    });
    this.log?.info('knowledge forgotten', { by, count: ids.length, ids });
    this.bus?.emit('knowledge.removed', { ids });
    return { ids };
  }

  /** Retention: deletes these EXPIRED versions for good (a current row or file is never touched); the removed ids. */
  purgeVersions(ids: readonly string[]): string[] {
    const gone = this.db.tx(() => {
      const expired = ids.filter((id) => { const row = getRow(this.db, id); return row !== undefined && row.expired_at !== null; });
      deleteRows(this.db, expired);
      return expired;
    });
    if (gone.length) this.bus?.emit('knowledge.removed', { ids: gone });
    return gone;
  }

  /** The item; a file that left the tree: its newest old version until retention removes it. */
  get(id: string): KnowledgeItem | undefined {
    const rel = this.fileOf(id);
    if (rel) {
      const entry = this.tree.read(rel);
      if (entry) return itemOfEntry(entry);
      const row = this.db.get<KnowledgeRow>(`SELECT ${ITEM_COLUMNS} FROM knowledge WHERE supersedes = ? ORDER BY recorded_at DESC, id DESC LIMIT 1`, [memoryId(rel)]);
      return row ? toItem(row) : undefined;
    }
    const row = getRow(this.db, id);
    return row ? toItem(row) : undefined;
  }

  /** Current items, newest first: the files of the filter's place. */
  async list(filter: KnowledgeListFilter): Promise<KnowledgeItem[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const offset = filter.offset ?? 0;
    const scopeId = filter.scope && filter.scopeId ? normalScopeId(filter.scope, filter.scopeId) ?? filter.scopeId : filter.scopeId;
    const scope = filter.scope as KnowledgeItem['scope'] | undefined;
    const fits = (item: KnowledgeItem) => (!scope || item.scope === scope) && (!scopeId || item.scopeId === scopeId)
      && (!filter.kind || item.kind === filter.kind) && (!filter.kinds?.length || filter.kinds.includes(item.kind))
      && (filter.pinned === undefined || item.pinned === filter.pinned) && (filter.before === undefined || item.recordedAt < filter.before);
    const folder = !scope ? '' : scope === 'global' || !scopeId ? folderOfWholeScope(scope) : folderOfScope(scope, scopeId);
    const files = await scanFilesAsync(this.tree, [folder], fits, offset + limit);
    return files.sort((a, b) => b.recordedAt - a.recordedAt || (a.id < b.id ? 1 : -1)).slice(offset, offset + limit);
  }

  /** The kinds the newest items carry, in a fixed order. */
  async kinds(): Promise<KnowledgeItem['kind'][]> {
    const found = new Set<string>();
    for (const item of await scanFilesAsync(this.tree, [''], () => true, SCAN_MAX)) found.add(item.kind);
    return [...KINDS].filter((kind) => found.has(kind)) as KnowledgeItem['kind'][];
  }

  /** All versions of `id`, oldest first (a file: its old versions, then the file). */
  history(id: string): KnowledgeItem[] {
    const start = isFileId(id) ? undefined : getRow(this.db, id);
    const rel = start?.supersedes && isFileId(start.supersedes) ? this.tree.fileRel(start.supersedes) : this.fileOf(id);
    if (rel) {
      const versions = this.db.all<KnowledgeRow>(`SELECT ${ITEM_COLUMNS} FROM knowledge WHERE supersedes = ? ORDER BY recorded_at, id`, [memoryId(rel)]).map(toItem);
      const entry = this.tree.read(rel);
      return entry ? [...versions, itemOfEntry(entry)] : versions;
    }
    return start ? rowHistory(this.db, start) : [];
  }

  /** The files in the agent's pinned/ folders (company, its branch, its own, this chat), oldest first per place, PINNED_READ at
   *  most in all. No size cap here: the one cap is knowledge/always.ts, on the rendered lines (a long note stands by its description). */
  pinned(agentId: string, conversationId?: string): KnowledgeItem[] {
    const { spaceId } = agentReach(this.db, agentId);
    const now = this.clock.now();
    const out: KnowledgeItem[] = [];
    for (const place of [folderOfScope('global', undefined), ...(spaceId ? [folderOfScope('space', spaceId)] : []), folderOfScope('agent', agentId), ...(conversationId ? [folderOfScope('conversation', conversationId)] : [])]) {
      if (out.length >= PINNED_READ) break;
      const items = scanFiles(this.tree, [`${place}/${PINNED_DIR}`], (item) => passes(item, {}, now), PINNED_READ - out.length)
        .sort((a, b) => a.recordedAt - b.recordedAt || (a.id < b.id ? -1 : 1));
      out.push(...items);
    }
    return out;
  }

  private defaultRoot(): string {
    const file = this.db.get<{ file: string }>(`SELECT file FROM pragma_database_list WHERE name = 'main'`)?.file;
    return file ? path.join(path.dirname(file), MEMORY_ENTRY) : scratchRoot();
  }

  /** The normal path when `id` names a memory file (its path, or an old id that moved to one); else undefined. */
  private fileOf(id: string): string | undefined {
    if (isFileId(id)) return this.tree.fileRel(id);
    return getRow(this.db, id) ? undefined : movedTo(this.db, id);
  }

  private exists(id: string): boolean {
    const rel = this.fileOf(id);
    return rel ? this.tree.exists(rel) : getRow(this.db, id) !== undefined;
  }

  /** Writes a file (an old state becomes a version), tells the bus. */
  private put(rel: string, entry: Omit<MemoryEntry, 'path'>, old?: MemoryEntry): KnowledgeItem {
    this.describeTopOnce();
    describePlace(this.tree, this.db, rel);
    if (old) this.keepVersion(old);
    this.tree.write(rel, entry);
    this.words.changed(rel);
    this.follow.changed(rel);
    const item = itemOfEntry({ ...entry, path: rel });
    this.emit(item);
    return item;
  }

  /** The old state of a file as an expired row. */
  private keepVersion(entry: MemoryEntry): KnowledgeItem {
    const now = this.clock.now();
    const item = itemOfEntry(entry);
    const version: KnowledgeItem = { ...item, id: newId('kn', now), pinned: false, expiredAt: now, supersedes: item.id };
    insertItem(this.db, version);
    return version;
  }

  /** A file and its old versions go for good; their ids. */
  private removeFile(rel: string): string[] {
    const versions = this.versionIds(memoryId(rel));
    this.db.tx(() => deleteRows(this.db, versions));
    this.tree.remove(rel);
    this.follow.removed(rel);
    return [memoryId(rel), ...versions];
  }

  private versionIds(fileId: string): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM knowledge WHERE supersedes = ?', [fileId]).map((row) => row.id);
  }

  private build(input: SaveInput): KnowledgeItem {
    return buildItem(input, { now: this.clock.now(), redact: this.redact });
  }

  /** The top folders say what they are for, once. */
  private describeTopOnce(): void {
    if (this.topDescribed) return;
    this.topDescribed = true;
    describeTop(this.tree, this.log);
  }

  private emit(item: KnowledgeItem): void {
    this.bus?.emit('knowledge.upserted', item);
  }
}

