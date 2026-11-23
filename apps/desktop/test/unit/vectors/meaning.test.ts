// Meaning inside the one word search (vectors/meaning.ts, store.ts): words and meaning count in equal parts, a text the words missed
// comes by its meaning, a word hit without a vector yet counts the average; without a model the words stand alone with one line;
// the one queue embeds what a search could return and pauses after a failing model; another model's vectors do not count; a
// note deleted while the app was closed loses its stored text at the first ranking.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { blend, meaningDoc, meaningText, NO_MODEL } from '../../../src/runtime/vectors/meaning.ts';
import { vectorSystem } from '../../../src/runtime/vectors/create.ts';
import { CHUNK_CHARS } from '../../../src/runtime/vectors/chunk.ts';
import { VectorStore } from '../../../src/runtime/vectors/store.ts';

/** One dimension per meaning: "invoice" and "Rechnung" mean the same, so do "soup" and "Suppe". */
const MEANINGS = [['invoice', 'rechnung'], ['server'], ['soup', 'suppe']];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  queries: string[] = [];
  fail?: string;
  /** Only documents fail; queries are answered. */
  documentsOnly = false;
  hang = false;
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    (purpose === 'query' ? this.queries : this.documents).push(...texts);
    if (this.hang) return new Promise(() => undefined);
    if (this.fail && (purpose === 'document' || !this.documentsOnly)) throw new Error(this.fail);
    return texts.map((text) => unit([...MEANINGS.map((words) => (words.some((word) => text.toLowerCase().includes(word)) ? 1 : 0)), 0.05]));
  }
}

function setup(t: { after(fn: () => void): void }, options: { redact?: (text: string) => string; queryWaitMs?: number; gone?: (key: string) => boolean } = {}) {
  const db = new Db(':memory:');
  migrate(db);
  const embedder = new FakeEmbedder();
  let current: Embedder | undefined = embedder;
  let time = 1_000_000;
  const system = vectorSystem({ db, embedder: () => current, now: () => time, ...options });
  t.after(() => { system.stop?.(); db.raw.close(); });
  return { db, embedder, system, use: (next: Embedder | undefined) => { current = next; }, advance: (ms: number) => { time += ms; } };
}

const NOTES = {
  'memory/a.md': 'Invoices go out on the 3rd',
  'memory/b.md': 'Rechnung: Versand am Monatsende',
  'memory/c.md': 'Soup recipe for Friday',
};
const docs = () => Object.entries(NOTES).map(([key, text]) => meaningDoc(key, key, text));

test('blend: words and meaning in equal parts, a near miss by meaning alone, the average for a hit without a vector, relative to the best', () => {
  const words = [{ key: 'a', score: 1 }, { key: 'b', score: 0.9 }, { key: 'c', score: 0.5 }];
  const hits = blend(words, new Map([['a', 0.1], ['b', 0.5], ['d', 0.7]]), 10); // a 1.1 · b 1.4 · c 0.5 + 0.3 · d 0.7
  assert.deepEqual(hits.map((hit) => hit.key), ['b', 'a', 'c', 'd']);
  assert.equal(hits[0].score, 1);
  assert.equal(hits[2].score, Number((0.8 / 1.4).toFixed(3)));
  assert.deepEqual(hits.map((hit) => hit.byMeaning === true), [false, false, false, true]);
  assert.deepEqual(blend(words, new Map(), 2).map((hit) => hit.key), ['a', 'b'], 'no vectors: the words as they are');
});

test('what stands for a note or an entry: a short text whole, a big one by its title and description', () => {
  assert.equal(meaningText({ title: 'T', description: 'D', body: 'short' }), 'T\nD\nshort');
  assert.equal(meaningText({ title: 'T', description: 'D', body: 'x'.repeat(CHUNK_CHARS) }), 'T\nD');
  assert.equal(meaningText({ title: 'T' }), 'T');
});

test('without a model: the word hits as they are, one line saying so, and nothing stored or embedded', async (t) => {
  const w = setup(t);
  w.use(undefined);
  const ranked = await w.system.rank({ query: 'invoice', words: [{ key: 'memory/a.md', score: 1 }], docs: docs(), limit: 5 });
  assert.deepEqual(ranked.hits, [{ key: 'memory/a.md', score: 1 }]);
  assert.equal(ranked.note, NO_MODEL);
  assert.equal(w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vector_files')?.n, 0);
});

test('with a model: a ranking embeds the query; the texts it could return get their meaning in the queue, and a note the words missed comes by it', async (t) => {
  const w = setup(t);
  const words = [{ key: 'memory/a.md', score: 1 }];
  await w.system.rank({ query: 'invoice', words, docs: docs(), limit: 5 });
  await w.system.settled();
  assert.deepEqual([...w.embedder.documents].sort(), Object.values(NOTES).sort(), 'each text once');
  const ranked = await w.system.rank({ query: 'invoice', words, docs: docs(), limit: 5 });
  assert.deepEqual(ranked.hits.slice(0, 2).map((hit) => [hit.key, hit.byMeaning === true]), [['memory/a.md', false], ['memory/b.md', true]], 'the German note comes by its meaning, after the word hit');
  assert.equal(ranked.note, undefined);
  assert.equal(w.embedder.documents.length, 3, 'a second ranking embeds no text again');
  assert.deepEqual(w.embedder.queries, ['invoice', 'invoice']);
});

test('a changed text gets its meaning anew; another model\'s vectors do not count until the text has the new one', async (t) => {
  const w = setup(t);
  const first = docs();
  await w.system.rank({ query: 'soup', words: [], docs: first, limit: 5 });
  await w.system.settled();
  w.embedder.documents.length = 0;
  const changed = [meaningDoc('memory/c.md', 'memory/c.md', 'Server maintenance on Friday'), ...first.filter((doc) => doc.key !== 'memory/c.md')];
  await w.system.rank({ query: 'soup', words: [], docs: changed, limit: 5 });
  await w.system.settled();
  assert.deepEqual(w.embedder.documents, ['Server maintenance on Friday']);

  const next = new FakeEmbedder();
  next.id = 'fake:2';
  next.fail = 'not yet';
  next.documentsOnly = true;
  w.use(next);
  const during = await w.system.rank({ query: 'rechnung', words: [], docs: changed, limit: 5 });
  assert.deepEqual(during.hits, [], 'vectors of fake:1 are not compared with a fake:2 query');
  await w.system.settled();
  next.fail = undefined;
  next.documents.length = 0;
  w.advance(6 * 60_000);
  await w.system.rank({ query: 'rechnung', words: [], docs: changed, limit: 5 });
  await w.system.settled();
  assert.equal(next.documents.length, 3, 'every text gets the chosen model\'s vector');
  const after = await w.system.rank({ query: 'server', words: [], docs: changed, limit: 1 });
  assert.equal(after.hits[0].key, 'memory/c.md', 'by its new text and the new model');
});

test('a failing model pauses the queue: the words stand, and it is not asked again before the pause ends', async (t) => {
  const w = setup(t);
  w.embedder.fail = 'server down';
  const words = [{ key: 'memory/a.md', score: 1 }];
  const ranked = await w.system.rank({ query: 'invoice', words, docs: docs(), limit: 5 });
  assert.equal(ranked.hits[0].key, 'memory/a.md');
  await w.system.settled();
  const tried = w.embedder.documents.length;
  assert.ok(tried > 0);
  await w.system.rank({ query: 'invoice', words, docs: docs(), limit: 5 });
  await w.system.settled();
  assert.equal(w.embedder.documents.length, tried, 'paused');
  w.embedder.fail = undefined;
  w.advance(6 * 60_000);
  await w.system.rank({ query: 'invoice', words, docs: docs(), limit: 5 });
  await w.system.settled();
  assert.ok(w.embedder.documents.length > tried, 'after the pause the queue goes on');
});

test('a query that waited in vain: the words stand with a note, and the next ranking does not wait again', async (t) => {
  const w = setup(t, { queryWaitMs: 20 });
  w.embedder.hang = true;
  const words = [{ key: 'memory/a.md', score: 1 }];
  const first = await w.system.rank({ query: 'invoice', words, docs: [], limit: 5 });
  assert.deepEqual(first.hits, words);
  assert.match(first.note ?? '', /still loading/);
  const asked = w.embedder.queries.length;
  await w.system.rank({ query: 'invoice', words, docs: [], limit: 5 });
  assert.equal(w.embedder.queries.length, asked, 'no second wait');
});

test('a query that leaves the PC is redacted, and so is a stored text; a forgotten key leaves the store', async (t) => {
  const w = setup(t, { redact: (text) => text.replaceAll('sk-secret', 'secret://sec_1') });
  w.embedder.remote = true;
  await w.system.rank({ query: 'invoice sk-secret', words: [], docs: [meaningDoc('memory/k.md', 'memory/k.md', 'Invoice key sk-secret')], limit: 5 });
  await w.system.settled();
  assert.deepEqual(w.embedder.queries, ['invoice secret://sec_1']);
  assert.deepEqual(w.embedder.documents, ['Invoice key secret://sec_1']);
  assert.equal(w.db.get<{ snippet: string }>('SELECT snippet FROM vector_chunks')?.snippet, 'Invoice key secret://sec_1');
  w.system.forget('memory/k.md');
  assert.equal(w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vector_files')?.n, 0);
});

test('a note deleted while the app was closed: its stored text goes at the first ranking (once); the others stay', async (t) => {
  const gone = new Set(['memory/old.md']);
  const asked: string[] = [];
  const w = setup(t, { gone: (key) => { asked.push(key); return gone.has(key); } });
  new VectorStore(w.db).put([{ key: 'memory/old.md', path: 'memory/old.md', version: 1, text: 'Private: the client wants to drop Anna' }]);
  await w.system.rank({ query: 'invoice', words: [{ key: 'memory/a.md', score: 1 }], docs: docs(), limit: 5 });
  await w.system.settled();
  const keys = w.db.all<{ key: string }>('SELECT key FROM vector_files ORDER BY key').map((row) => row.key);
  assert.ok(!keys.includes('memory/old.md') && keys.includes('memory/a.md'), keys.join(', '));
  assert.equal(w.db.get(`SELECT 1 AS hit FROM vector_chunks WHERE snippet LIKE '%Anna%'`), undefined, 'its words are gone');
  const before = asked.length;
  await w.system.rank({ query: 'soup', words: [], docs: docs(), limit: 5 });
  assert.equal(asked.length, before, 'asked once');
});
