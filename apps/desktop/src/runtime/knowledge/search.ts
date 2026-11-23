// The search of memory (Quests 20.11.2026: one search): the word index (words.ts) over the tree's texts ranks, a file holding an exact
// ID the query names comes first; where a person chose an embedding model, the word hits are re-ranked by meaning and a note the
// words missed may come by its meaning (services.vectors.rank, vectors/meaning.ts – words and meaning in equal parts). Also the short
// `why` of every hit – it ends with the day the note was saved and its age ("saved 2026-10-04, 3 weeks ago", age.ts; the day in
// the person's `zone`).
// Owns: the mapping of the index's hits to notes, a note's meaning text and the `why` text. Never: decides which files a turn reads
// (acl.ts) or calls a model itself.

import { createHash } from 'node:crypto';
import type { KnowledgeHit, KnowledgeItem } from '../../shared/model/knowledge.ts';
import type { VectorService } from '../contracts/vectors.ts';
import { savedText } from './age.ts';
import { MEMORY_ENTRY } from './memory-tree.ts';
import { foldText } from './normalize.ts';
import { exactId, expandQuery } from './query-rewrite.ts';
import { meaningDoc, meaningText } from '../vectors/meaning.ts';
import type { WordDoc, WordIndex } from './words.ts';

/** What memory needs of services.vectors. */
export type MemoryVectors = Pick<VectorService, 'available' | 'rank' | 'forget'>;

/** Word hits a ranking by meaning looks at (meaning may lift one from below the first `limit`). */
const WORD_HITS = 30;

/** A note's key in the vector store: "memory/<its path>". */
export const noteKey = (item: Pick<KnowledgeItem, 'id'>): string => `${MEMORY_ENTRY}/${item.id.replace(/:/g, '/')}`;

/** A note as a text of the word index (its version: a hash of what is indexed). */
export function noteDoc(item: KnowledgeItem): WordDoc {
  const text = { title: item.title, description: item.description ?? '', body: item.body };
  return { id: item.id, version: createHash('sha1').update(`${text.title}\0${text.description}\0${text.body}`).digest('base64'), text: () => text };
}

/** The `items` that hold the query's exact IDs, and the others ranked by the index, best first. */
function byWords(index: WordIndex, corpus: readonly KnowledgeItem[], items: readonly KnowledgeItem[], text: string, limit: number) {
  index.sync(corpus.map(noteDoc));
  const byId = new Map(items.map((item) => [item.id, item]));
  const expanded = expandQuery(text);
  const exact = expanded.ids.length ? items.filter((item) => exactId(expanded.ids, `${item.title} ${item.body}`)) : [];
  const first = new Set(exact.map((item) => item.id));
  const ranked = index.search(text, limit, (id) => byId.has(id) && !first.has(id)).map(({ id, score }) => ({ item: byId.get(id)!, score }));
  return { exact, ranked, tokens: expanded.tokens };
}

/** The `items` of `corpus` that hold a word of `text`, best first; `corpus` is what the index holds (the tree's texts). */
export function wordHits(index: WordIndex, corpus: readonly KnowledgeItem[], items: readonly KnowledgeItem[], text: string, limit: number, now: number, zone: string | undefined): KnowledgeHit[] {
  const { exact, ranked, tokens } = byWords(index, corpus, items, text, limit);
  return [...exact.map((item) => ({ item, score: 1 })), ...ranked].slice(0, limit).map(({ item, score }) => ({ item, score, why: wordWhy(item, tokens, now, zone) }));
}

/** The word hits re-ranked by meaning where a person chose an embedding model (exact IDs stay first); else the word hits. */
export async function noteHits(vectors: MemoryVectors | undefined, index: WordIndex, corpus: readonly KnowledgeItem[], items: readonly KnowledgeItem[], text: string, limit: number, now: number, zone: string | undefined): Promise<KnowledgeHit[]> {
  if (!vectors?.available()) return wordHits(index, corpus, items, text, limit, now, zone);
  const { exact, ranked, tokens } = byWords(index, corpus, items, text, Math.max(limit, WORD_HITS));
  const first = new Set(exact.map((item) => item.id));
  const byKey = new Map(items.filter((item) => !first.has(item.id)).map((item) => [noteKey(item), item]));
  let found: Awaited<ReturnType<MemoryVectors['rank']>>;
  try {
    found = await vectors.rank({
      query: text, limit,
      words: ranked.map(({ item, score }) => ({ key: noteKey(item), score })),
      docs: [...byKey].map(([key, item]) => meaningDoc(key, key, meaningText({ title: item.title, description: item.description, body: item.body }))),
    });
  } catch { return wordHits(index, corpus, items, text, limit, now, zone); } // the words stand alone
  const meant = found.hits.flatMap((hit) => {
    const item = byKey.get(hit.key);
    return item ? [{ item, score: hit.score, why: hit.byMeaning ? vectorWhy(item, now, zone) : wordWhy(item, tokens, now, zone) }] : [];
  });
  return [...exact.map((item) => ({ item, score: 1, why: wordWhy(item, tokens, now, zone) })), ...meant].slice(0, limit);
}

function wordWhy(item: KnowledgeItem, tokens: readonly string[], now: number, zone: string | undefined): string {
  const haystack = foldText(`${item.title} ${item.description ?? ''} ${item.body}`);
  const matched = tokens.filter((token) => haystack.includes(token)).slice(0, 4);
  return [...(matched.length ? [`matches '${matched.join(' ')}'`] : []), savedText(item.recordedAt, now, zone)].join(' · ');
}

/** The `why` of a note found by its meaning alone. */
export function vectorWhy(item: KnowledgeItem, now: number, zone: string | undefined): string {
  return `similar meaning · ${savedText(item.recordedAt, now, zone)}`;
}
