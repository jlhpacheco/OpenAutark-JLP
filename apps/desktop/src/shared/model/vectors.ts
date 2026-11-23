// The shapes of vector.search and vector.embed (01.11.2026, owner: "ein System, mit dem generell alle mit Vektoren suchen können, für
// alles"; since 20.11.2026 meaning is a ranking inside the one word search): vector.embed adds files or folders to the search and
// they stay; vector.search finds in places – "memory" / "memory/<folder>", "catalog" (skills and the home project), or added
// files and folders – by words, and by meaning where a person chose an embedding model.
// Owns: the shapes both tools and services.vectors return. Never: logic.

/** One found text. `path` is absolute for a file, "memory/…" for a note, the catalog key for an entry. */
export interface VectorHit {
  path: string;
  /** The piece's number within its file, from 0 (a note or entry is one piece). */
  chunk: number;
  /** First and last line of the piece, from 1 (a PDF has none). */
  lines?: [number, number];
  snippet: string;
  /** 0..1, relative to the best hit; for a hit reached in hops, the product along its path. */
  score: number;
  /** A hit reached through another one (hops) names it here. */
  via?: string;
}

export interface VectorSearchResult {
  hits: VectorHit[];
  searched: { places: string[]; embeddedFiles: number };
  /** Said plainly when there is something to know: no embedding model, nothing added there, a place that failed. */
  note?: string;
}

export interface VectorEmbedResult {
  /** Files added for the first time. */
  embedded: number;
  /** Files added before that had changed. */
  reembedded: number;
  /** Files already added and unchanged. */
  unchanged: number;
  /** What was left out and why (exclusions, unreadable, binary) – the budget's rest too, so a model can call again. */
  skipped: Array<{ path: string; reason: string }>;
  /** Files the call's budget did not reach (also listed in `skipped`, capped); call vector.embed again for them. */
  remaining?: number;
  /** Pieces whose meaning is still being embedded in the background (their words are searchable already). */
  waiting?: number;
}

export interface VectorSearchInput {
  query: string;
  /** Places: absolute files or folders, "memory" / "memory/<folder>", "catalog". */
  in: string[];
  k?: number;
  /** 0–2: the best hits' own texts search on; a hit found so scores the product along its path. Default 0. */
  hops?: number;
}
