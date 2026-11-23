// Meaning as a ranking inside the one word search (Quests 20.11.2026; owner 01.11.: vectors are the search, 20.11.: "intelligente
// Wortsuche … so einfach wie möglich"). A search finds by its words (knowledge/words.ts); when a person chose an embedding model
// (models/embeddings.ts), rank() embeds only the query and adds each text's cosine to its word score, so words and meaning count in
// equal parts and a text the words missed comes by its meaning alone. Measured with MiniLM on the 95 catalog turns of the 13.11.
// bench (.local/unterbewusstsein-20261113/bench/b13-rerank.ts): first in 27, top 5 in 50 – words alone 26 and 39, vectors alone 7 and 34.
// A text gets its vector when a search could return it and has none of the chosen model (need): one queue, one batch at a time,
// in the background – a ranking never waits for a document, a word hit not embedded yet counts the average meaning. A failing
// model pauses the queue for RETRY_MS. Without a model nothing here runs and the words stand alone.
// Owns: the blend, the query's embedding and the one queue. Never: searches by words, reads files or decides what is searchable.

import { createHash } from 'node:crypto';
import type { MeaningDoc, RankedHit, RankInput, RankResult, StoredText } from '../contracts/vectors.ts';
import { CHUNK_CHARS } from './chunk.ts';
import type { Embedder } from './embedders.ts';
import { cosine, toInt8, type VectorStore } from './store.ts';

export const NO_MODEL = 'No embedding model is chosen (Settings › Models › Embeddings), so these hits are ranked by their words alone.';
const LOADING = 'The embedding model is still loading or downloading, so these hits are ranked by their words alone this time.';
/** How long a ranking waits for its query's vector (the first use may load the model). */
const QUERY_WAIT_MS = 5_000;
/** After a query that waited in vain: no second wait for this long. */
const QUERY_PAUSE_MS = 60_000;
const BATCH_WAIT_MS = 60_000;
const RETRY_MS = 5 * 60_000;

/** A 48-bit number from a text's sha256: the version of a text that has no file time. */
export function textStamp(text: string): number {
  return Number.parseInt(createHash('sha256').update(text).digest('hex').slice(0, 12), 16);
}

/** What stands for a note or an entry: the whole text when it is short, else its title and description (owner 06.11.2026). */
export function meaningText(entry: { title: string; description?: string; body?: string }): string {
  const whole = `${entry.title}\n${entry.description ?? ''}${entry.body ? `\n${entry.body}` : ''}`.trim();
  if (whole.length <= CHUNK_CHARS) return whole;
  return `${entry.title}\n${entry.description ?? ''}`.slice(0, CHUNK_CHARS).trim();
}

/** The doc of a text outside the store: its key, the version of its meaning text, and how it is stored when it is embedded. */
export function meaningDoc(key: string, path: string, text: string): MeaningDoc {
  const version = textStamp(text);
  return { key, version, stored: () => ({ key, path, version, text }) };
}

/**
 * Words and meaning in equal parts: a word hit's score (0..1, relative to the best) plus its cosine; a text the words missed comes
 * by its cosine alone; a word hit without a vector yet counts the average cosine of the others. Scores relative to the best.
 */
export function blend(words: RankInput['words'], meaning: ReadonlyMap<string, number>, limit: number): RankedHit[] {
  const known = words.flatMap((hit) => (meaning.has(hit.key) ? [meaning.get(hit.key) as number] : []));
  const neutral = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 0;
  const scores = new Map<string, { score: number; byMeaning?: true }>();
  for (const hit of words) if (!scores.has(hit.key)) scores.set(hit.key, { score: hit.score + (meaning.get(hit.key) ?? neutral) });
  for (const [key, value] of meaning) if (!scores.has(key)) scores.set(key, { score: value, byMeaning: true });
  const ranked = [...scores].sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(1, limit));
  const best = ranked[0]?.[1].score ?? 0;
  return ranked.map(([key, value]) => ({ key, score: best > 0 ? Number(Math.max(0, value.score / best).toFixed(3)) : 0, ...(value.byMeaning ? { byMeaning: true as const } : {}) }));
}

export interface MeaningDeps {
  store: VectorStore;
  /** The embedding model now; undefined = none chosen (or the choice cannot serve). */
  embedder: () => Embedder | undefined;
  /** Removes secrets from a stored text and from a query that leaves this PC. */
  redact?: (text: string) => string;
  log?: { warn(message: string, details?: Record<string, unknown>): void };
  now?: () => number;
  /** Ends what the embedder holds (the local model's worker) at the stop. */
  release?: () => void;
  queryWaitMs?: number;
}

export class Meaning {
  private readonly deps: MeaningDeps;
  private readonly now: () => number;
  private readonly pending = new Set<string>();
  private draining?: Promise<void>;
  private pausedUntil = 0;
  private queryPauseUntil = 0;
  private stopped = false;

  constructor(deps: MeaningDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  available(): boolean {
    return Boolean(this.embedder());
  }

  /** The word hits re-ranked by meaning (see blend); without a model, or while its query cannot be embedded, the words as they are. */
  async rank(input: RankInput): Promise<RankResult> {
    const words = input.words.slice(0, Math.max(1, input.limit));
    const embedder = this.embedder();
    if (!embedder) return { hits: words.map(({ key, score }) => ({ key, score })), note: NO_MODEL };
    this.need(input.docs);
    const query = await this.queryVector(input.query, embedder);
    if (!query) return { hits: words.map(({ key, score }) => ({ key, score })), note: LOADING };
    const meaning = new Map<string, number>();
    for (const doc of input.docs) {
      const held = this.deps.store.get(doc.key);
      if (held?.vector && held.model === embedder.id && held.version === doc.version) meaning.set(doc.key, cosine(query, held.vector));
    }
    return { hits: blend(input.words, meaning, input.limit) };
  }

  /** Texts without a vector of the chosen model get one in the background (the one queue). Returns how many wait. */
  need(docs: readonly MeaningDoc[]): number {
    const embedder = this.embedder();
    if (!embedder || this.stopped) return 0;
    const fresh: StoredText[] = [];
    for (const doc of docs) {
      if (this.pending.has(doc.key)) continue;
      const held = this.deps.store.get(doc.key);
      if (held?.vector && held.model === embedder.id && held.version === doc.version) continue;
      if (held?.version !== doc.version) {
        if (!doc.stored) continue; // a piece that left the store
        const text = doc.stored();
        fresh.push({ ...text, text: this.redact(text.text) });
      }
      this.pending.add(doc.key);
    }
    if (fresh.length) this.deps.store.put(fresh);
    this.drain();
    return this.pending.size;
  }

  /** Is `key` still waiting for its vector? */
  waiting(key: string): boolean {
    return this.pending.has(key);
  }

  /** Resolves when the queue is empty or paused, at the latest after `ms`. */
  async settled(ms = Number.POSITIVE_INFINITY): Promise<void> {
    const until = Date.now() + ms;
    while (this.draining) {
      const left = until - Date.now();
      if (left <= 0) return;
      await (Number.isFinite(left) ? Promise.race([this.draining, new Promise((resolve) => setTimeout(resolve, left).unref?.())]) : this.draining);
    }
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    try { this.deps.release?.(); } catch { /* it ends with the process anyway */ }
  }

  private embedder(): Embedder | undefined {
    try { return this.deps.embedder(); } catch { return undefined; }
  }

  private redact(text: string): string {
    return this.deps.redact ? this.deps.redact(text) : text;
  }

  private async queryVector(query: string, embedder: Embedder): Promise<Float32Array | undefined> {
    if (this.now() < this.queryPauseUntil) return undefined;
    const text = embedder.remote ? this.redact(query) : query;
    const vector = await inTime(embedder.embed([text], 'query'), this.deps.queryWaitMs ?? QUERY_WAIT_MS).then((vectors) => vectors[0], () => undefined);
    if (!vector) this.queryPauseUntil = this.now() + QUERY_PAUSE_MS;
    return vector;
  }

  /** One batch at a time until nothing waits; a failing model pauses the queue (the next need after RETRY_MS goes on). */
  private drain(): void {
    if (this.draining || this.stopped || !this.pending.size || this.now() < this.pausedUntil) return;
    this.draining = (async () => {
      while (this.pending.size && !this.stopped) {
        const embedder = this.embedder();
        if (!embedder) return;
        const keys = [...this.pending].slice(0, embedder.batch);
        const texts = keys.flatMap((key) => this.deps.store.text(key) ?? []);
        if (texts.length < keys.length) for (const key of keys) if (!texts.some((text) => text.key === key)) this.pending.delete(key);
        if (!texts.length) continue;
        let vectors: Float32Array[];
        try {
          vectors = await inTime(embedder.embed(texts.map((text) => text.text), 'document'), BATCH_WAIT_MS);
        } catch (error) {
          this.pausedUntil = this.now() + RETRY_MS;
          this.deps.log?.warn('embedding failed; the queue waits', { error: String(error) });
          return;
        }
        texts.forEach((text, index) => {
          if (vectors[index]) this.deps.store.setVector(text.key, text.version, embedder.id, toInt8(vectors[index]));
          this.pending.delete(text.key);
        });
      }
    })().catch((error: unknown) => {
      this.deps.log?.warn('the embedding queue stopped', { error: String(error) });
    }).finally(() => { this.draining = undefined; });
  }
}

/** The work's answer, or a rejection when it takes longer than `ms` (the work goes on; a late failure is nobody's error). */
function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The embedding model did not answer in time.')), ms); (timer as { unref?: () => void }).unref?.(); });
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer); });
}
