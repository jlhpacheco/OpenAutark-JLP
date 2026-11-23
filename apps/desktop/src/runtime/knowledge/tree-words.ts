// The memory tree's words: one word index (words.ts) over the tree's notes and the notes as the last read found them (a file read
// again only when its time changed). KnowledgeStore (service.ts) asks it for the hits of a search – by words, re-ranked by meaning
// where a person chose an embedding model (search.ts noteHits).
// Owns: the index and the notes cache. Never: writes the tree or decides who may read a note (acl.ts).

import type { KnowledgeHit, KnowledgeItem, KnowledgeQuery } from '../../shared/model/knowledge.ts';
import { inFolders, passes } from './acl.ts';
import { MemoryTree, itemOfEntry, memoryId } from './memory-tree.ts';
import { SCAN_MAX } from './memory-scan.ts';
import { noteHits, type MemoryVectors } from './search.ts';
import { WordIndex } from './words.ts';

export class TreeWords {
  private readonly index = new WordIndex();
  /** The tree's notes as the last read found them, by id with the file's time. */
  private notes = new Map<string, { mtime: number; item: KnowledgeItem }>();
  private readonly tree: MemoryTree;
  private readonly vectors: () => MemoryVectors | undefined;

  constructor(tree: MemoryTree, vectors: () => MemoryVectors | undefined = () => undefined) {
    this.tree = tree;
    this.vectors = vectors;
  }

  /** The hits of `text` among the notes in the query's `folders` that pass its filters (the index holds the whole tree, one corpus). */
  async hits(query: KnowledgeQuery, text: string, folders: readonly string[], limit: number, now: number, zone: string | undefined): Promise<KnowledgeHit[]> {
    const corpus = await this.read();
    const items = corpus.filter((item) => inFolders(item.id, folders) && passes(item, query, now));
    return noteHits(this.vectors(), this.index, corpus, items, text, limit, now, zone);
  }

  /** A file the store just wrote: read it again next time (a rewrite within the file time's resolution keeps its time). */
  changed(rel: string): void {
    this.notes.delete(memoryId(rel));
  }

  /** Every note of the tree (the newest SCAN_MAX files), a file read again only when its time changed. */
  private async read(): Promise<KnowledgeItem[]> {
    const next = new Map<string, { mtime: number; item: KnowledgeItem }>();
    for (const { rel, mtime } of await this.tree.filesAsync([''], SCAN_MAX)) {
      const known = this.notes.get(memoryId(rel));
      if (known?.mtime === mtime) { next.set(known.item.id, known); continue; }
      const entry = await this.tree.readAsync(rel);
      const item = entry && itemOfEntry(entry);
      if (item) next.set(item.id, { mtime, item });
    }
    this.notes = next;
    return [...next.values()].map((note) => note.item);
  }
}
