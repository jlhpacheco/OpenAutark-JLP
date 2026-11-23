// The word index (lane find, 14.11.2026): what knowledge.find, the memory search and the catalog find rank by. Measured on the live
// data (.local/unterbewusstsein-20261113/bench/RESULTS.md, fts-decomp): it put the catalog entry the main AI then loaded first in 26 of
// 95 turns, the shipped MiniLM in 7 and the two word searches before it in 9 and 2 – with no model, no download, milliseconds.
// One SQLite FTS5 table in memory per corpus: title, description and body folded (ä→ae …, normalize.ts foldText), bm25 weighted
// 10 / 4 / 1. The query: up to QUERY_WORDS salient words of the text (subconscious/text.ts queryTokens), each a prefix and a long one
// light-stemmed (the app's one stem, shared/text/normalize.ts), a long compound also by its two parts where the index holds both, and the small DE/EN
// vocabulary (query-rewrite.ts expandQuery), joined by OR. sync() makes the table hold exactly the given texts and rewrites only the
// ones whose version changed, so a caller passes what it reads anyway and the index follows without a watcher of its own.
// Owns: the table, the query and the ranking (score = bm25 relative to the best kept hit, 0..1). Never: decides which texts a caller
// may see (`keep`), reads a file itself or calls a model.

import { Db } from '../db/database.ts';
import { foldText } from './normalize.ts';
import { expandQuery } from './query-rewrite.ts';
import { stem } from '../../shared/text/normalize.ts';
import { queryTokens } from '../subconscious/text.ts';

/** Words of a query at most (the bench: 48; the catalog's long German texts need them). */
export const QUERY_WORDS = 48;
/** A body is indexed up to this many characters (the bench's 32 KB). */
export const BODY_CHARS = 32 * 1024;
/** bm25 weights of title, description and body. */
const WEIGHTS = '10.0, 4.0, 1.0';
/** A compound is split only from this length, each part at least PART letters long. */
const COMPOUND = 8;
const PART = 4;

export interface WordText { title: string; description: string; body: string }
/** One text of a corpus: its id, a version that changes with its text, and the text (read only when the version is new). */
export interface WordDoc { id: string; version: string; text: () => WordText }
export interface WordHit { id: string; score: number }

const quote = (term: string): string => `"${term.replace(/"/g, '')}"*`;

/** The OR query of `text` for an index whose words are `vocab`; undefined when nothing is searchable. */
export function wordQuery(text: string, vocab: { has(word: string): boolean }): string | undefined {
  const tokens = queryTokens(text, QUERY_WORDS);
  const terms = new Set(tokens.map((token) => (token.length > 6 ? stem(token) : token)));
  for (const token of tokens) {
    if (token.length < COMPOUND) continue;
    for (let cut = PART; cut <= token.length - PART; cut++) {
      const head = token.slice(0, cut);
      const tail = token.slice(cut);
      if (vocab.has(head) && (vocab.has(tail) || vocab.has(stem(tail)))) { terms.add(head); terms.add(stem(tail)); }
    }
  }
  for (const added of expandQuery(text, { maxTokens: QUERY_WORDS }).added) terms.add(added);
  return terms.size ? [...terms].map(quote).join(' OR ') : undefined;
}

export class WordIndex {
  private readonly db = new Db(':memory:');
  /** id → the version and row of the text the table holds. */
  private readonly rows = new Map<string, { version: string; rowid: number }>();
  /** term → how many texts hold it (fts5vocab), read again after a change. */
  private vocab?: Map<string, number>;

  constructor() {
    this.db.exec(`CREATE VIRTUAL TABLE words USING fts5(id UNINDEXED, title, description, body, tokenize = 'unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE words_vocab USING fts5vocab('words', 'row');`);
  }

  /** Texts held now. */
  get size(): number {
    return this.rows.size;
  }

  /** The table holds exactly `docs` afterwards; only a new id or version is read and written. */
  sync(docs: readonly WordDoc[]): void {
    const wanted = new Map<string, WordDoc>();
    for (const doc of docs) if (!wanted.has(doc.id)) wanted.set(doc.id, doc);
    const gone = [...this.rows.keys()].filter((id) => !wanted.has(id));
    const changed = [...wanted.values()].filter((doc) => this.rows.get(doc.id)?.version !== doc.version);
    if (!gone.length && !changed.length) return;
    this.db.tx(() => {
      for (const id of [...gone, ...changed.map((doc) => doc.id)]) {
        const row = this.rows.get(id);
        if (row) this.db.run('DELETE FROM words WHERE rowid = ?', [row.rowid]);
        this.rows.delete(id);
      }
      for (const doc of changed) {
        let text: WordText;
        try { text = doc.text(); } catch { continue; } // unreadable now: the next sync tries again
        const { lastInsertRowid } = this.db.run('INSERT INTO words (id, title, description, body) VALUES (?, ?, ?, ?)',
          [doc.id, foldText(text.title), foldText(text.description), foldText(text.body.slice(0, BODY_CHARS))]);
        this.rows.set(doc.id, { version: doc.version, rowid: Number(lastInsertRowid) });
      }
    });
    this.vocab = undefined;
  }

  /** How many texts hold the (folded) word. */
  df(word: string): number {
    return this.terms().get(word) ?? 0;
  }

  private terms(): Map<string, number> {
    this.vocab ??= new Map(this.db.all<{ term: string; doc: number }>('SELECT term, doc FROM words_vocab').map((row) => [row.term, Number(row.doc)]));
    return this.vocab;
  }

  /** The best `limit` texts for `text` among those `keep` lets through, best first. */
  search(text: string, limit: number, keep: (id: string) => boolean = () => true): WordHit[] {
    if (!this.rows.size) return [];
    const match = wordQuery(text, this.terms());
    if (!match) return [];
    let rows: Array<{ id: string; s: number }>;
    try {
      rows = this.db.all<{ id: string; s: number }>(`SELECT id, bm25(words, ${WEIGHTS}) AS s FROM words WHERE words MATCH ? ORDER BY s`, [match]);
    } catch { return []; }
    const kept = rows.filter((row) => keep(row.id)).slice(0, Math.max(1, limit));
    const best = kept.length ? -kept[0].s : 0;
    return kept.map((row) => ({ id: row.id, score: best > 0 ? Number((-row.s / best).toFixed(3)) : 1 }));
  }
}
