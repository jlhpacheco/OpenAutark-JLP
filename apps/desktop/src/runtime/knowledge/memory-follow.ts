// What keeps the record of which stored files the memory tree names (memory-blobs.ts) and the stored meaning of its notes in step
// with the tree: every write and removal the store tells it, every direct edit the data folder watcher reports (the store's own
// writes never come here), and edits while the app was closed (scanChanged at the start). A removed note's or folder's stored
// meaning goes at once (services.vectors.forget); a changed note gets its new meaning when a search next asks for it (vectors/meaning.ts).
// Owns: when that record and the vectors hear of a file. Never: writes an entry, embeds, or stops a memory write.

import { existsSync, statSync } from 'node:fs';
import type { Logger } from '../contracts.ts';
import type { RootEvent, RootWatcher } from '../root/watcher.ts';
import type { Db } from '../db/database.ts';
import { forgetBlobsBelow, noteBlobs, scanChanged } from './memory-blobs.ts';
import { MEMORY_ENTRY, isEntryName, type MemoryTree } from './memory-tree.ts';
import type { MemoryVectors } from './search.ts';

export class MemoryFollow {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly tree: MemoryTree;
  private readonly vectors: () => MemoryVectors | undefined;
  private readonly log?: Logger;
  private unwatch?: () => void;

  constructor(deps: { db: Db; now: () => number; tree: MemoryTree; vectors: () => MemoryVectors | undefined; log?: Logger }) {
    this.db = deps.db;
    this.now = deps.now;
    this.tree = deps.tree;
    this.vectors = deps.vectors;
    this.log = deps.log;
  }

  /** Resolves when the tree's blob names are current. */
  start(watcher?: Pick<RootWatcher, 'register'>): Promise<void> {
    this.unwatch ??= watcher?.register(MEMORY_ENTRY, (event) => this.outsideChange(event));
    return scanChanged(this.db, this.tree.root, this.now());
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  changed(rel: string): void {
    this.noteBlobs(rel);
  }

  removed(rel: string): void {
    this.noteBlobs(rel);
    if (isEntryName(rel)) this.forget(rel); // a _folder.md or a hidden file never had a meaning of its own
  }

  /** Never stops a memory write. */
  private noteBlobs(rel: string): void {
    try {
      const entry = this.tree.exists(rel) ? this.tree.raw(rel) : undefined;
      noteBlobs(this.db, rel, entry, this.now());
    } catch (error) {
      this.log?.warn('memory: the stored files of a memory file were not noted', { file: rel, error: String(error) });
    }
  }

  /** The stored meaning of a note or folder goes; never stops a memory write. */
  private forget(rel: string): void {
    try { this.vectors()?.forget(`${MEMORY_ENTRY}/${rel}`); } catch (error) { this.log?.warn('memory: stored meaning not removed', { file: rel, error: String(error) }); }
  }

  /** The watcher reports a change in the tree. */
  private outsideChange(event: RootEvent): void {
    if (!event.parts || event.parts.some((part) => part.startsWith('.'))) return;
    const rel = event.parts.join('/'); // '': the tree itself
    if (/\.md$/i.test(rel)) {
      if (existsSync(this.tree.abs(rel))) this.changed(rel);
      else this.removed(rel);
      return;
    }
    if (!rel || statSync(this.tree.abs(rel), { throwIfNoEntry: false })) return;
    try { forgetBlobsBelow(this.db, rel); } catch { /* the next start looks again */ } // a folder went: everything below it
    this.forget(rel);
  }
}
