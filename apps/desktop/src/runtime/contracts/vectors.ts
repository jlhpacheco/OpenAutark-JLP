// services.vectors: meaning inside the one word search, as a member of RuntimeServices (merged by module augmentation, like the
// other late additions in this folder) – the ranking every search calls, and the files and folders vector.embed adds to it.
// Owns: the interface and the shapes of a ranking. Never: behaviour (runtime/vectors).

import type { VectorEmbedResult, VectorSearchInput, VectorSearchResult } from '../../shared/model/vectors.ts';

/** A text of the store: a piece of an added file ("<file key>#<n>") or a note or entry whose meaning was asked for. */
export interface StoredText {
  key: string;
  /** "memory/…", a catalog key, or the file's absolute path. */
  path: string;
  /** Changes with the text (a file's time, else a hash of the text). */
  version: number;
  text: string;
  lines?: [number, number];
}

/** A text a search could return: its key, its version, and – for a text that lives outside the store – how it is stored. */
export interface MeaningDoc {
  key: string;
  version: number;
  stored?: () => StoredText;
}

export interface RankInput {
  query: string;
  /** The word search's hits, best first, scores 0..1 relative to the best. */
  words: ReadonlyArray<{ key: string; score: number }>;
  /** Every text the search could return within the caller's reach: what the words missed may come by meaning. */
  docs: readonly MeaningDoc[];
  limit: number;
}

export interface RankedHit {
  key: string;
  /** 0..1, relative to the best. */
  score: number;
  /** Found by meaning alone (the words missed it). */
  byMeaning?: true;
}

export interface RankResult {
  hits: RankedHit[];
  /** Why the words stand alone: no model chosen, or it is still loading. */
  note?: string;
}

export interface VectorService {
  /** An embedding model can serve now. */
  available(): boolean;
  /** The word hits re-ranked by meaning; without a model the words as they are, with a note. */
  rank(input: RankInput): Promise<RankResult>;
  /** Adds files or folders (absolute paths) to the search: their words now, their meaning once a model embedded them. */
  embed(paths: string[], opts?: { budgetMs?: number }): Promise<VectorEmbedResult>;
  /** The added files under the places in `in`, by their words and meaning. */
  search(input: VectorSearchInput): Promise<VectorSearchResult>;
  /** The stored texts at or below `key` go (a forgotten note, a removed folder). */
  forget(key: string): void;
  /** The app stops: the queue ends, a running local model ends. */
  stop?(): void;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    vectors: VectorService;
  }
}
