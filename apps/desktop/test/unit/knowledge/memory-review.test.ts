// The review of memory with the real vector system: the composition root really connects them; a note the words miss is found by
// its meaning once the one queue embedded it, a changed note (written or edited by hand) gets its meaning anew when a search asks,
// a forgotten one takes it along; an embedder in trouble leaves memory findable by its words instead of "nothing"; a model chosen
// later ranks by meaning from the next searches on; a reserved Windows name is no file name.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ManualClock } from '../fakes.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { slugOf } from '../../../src/runtime/knowledge/memory-tree.ts';
import { unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { vectorSystem } from '../../../src/runtime/vectors/create.ts';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

/** One dimension per meaning: "soup" and "Suppe" mean the same. */
const MEANINGS = [['invoice', 'rechnung'], ['server'], ['soup', 'suppe']];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  fail = false;
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (this.fail) throw new Error('The embedding server could not be reached.');
    if (purpose === 'document') this.documents.push(...texts);
    return texts.map((text) => unit([...MEANINGS.map((words) => (words.some((word) => text.toLowerCase().includes(word)) ? 1 : 0)), 0.01]));
  }
}

function world(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-review-'));
  const root = path.join(dir, 'memory');
  mkdirSync(root, { recursive: true });
  const db = new Db(':memory:');
  migrate(db);
  const embedder = new FakeEmbedder();
  let current: Embedder | undefined = embedder;
  const clock = new ManualClock();
  const watcher = new RootWatcher({ root: dir, clock, watch: false, debounceMs: 1 });
  watcher.start();
  const vectors = vectorSystem({ db, embedder: () => current, now: () => clock.now() });
  const store = new KnowledgeStore({ db, clock, root, vectors: () => vectors, writes: watcher });
  void store.startMemory(watcher);
  t.after(() => { store.stopMemory(); watcher.stop(); vectors.stop?.(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, db, embedder, vectors, store, watcher, clock, use: (next: Embedder | undefined) => { current = next; } };
}

test('the composition root connects memory with the vectors, the watcher and its own writes, and stops them', () => {
  const services = source('src/runtime/compose/services.ts');
  const made = services.match(/new KnowledgeStore\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\);/)?.[1] ?? '';
  assert.match(made, /\broot: path\.join\(paths\.data, 'memory'\)/);
  assert.match(made, /\bvectors: \(\) => s\.vectors\b/);
  assert.match(made, /\bwrites: s\.rootWatcher\b/);
  const vectors = services.indexOf('s.vectors = createVectors(s);');
  const start = services.indexOf('knowledge.startMemory(s.rootWatcher);');
  assert.ok(vectors > 0 && start > vectors, 'it starts following once the vectors exist');
  const lifecycle = source('src/runtime/compose/lifecycle.ts');
  assert.ok(lifecycle.indexOf(`name: 'memory'`) > 0 && lifecycle.indexOf(`name: 'memory'`) < lifecycle.indexOf(`name: 'data folder'`), 'it leaves the watcher before the watcher stops');
  assert.ok(lifecycle.indexOf(`name: 'vectors'`) > 0 && lifecycle.indexOf(`name: 'vectors'`) < lifecycle.indexOf(`name: 'database'`), 'the embedding work ends before the database closes');
});

test('a note the words miss is found by its meaning once the queue embedded it; a forgotten note takes its meaning along', async (t) => {
  const { store, vectors, db } = world(t);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Freitag', text: 'Die Suppe gibt es freitags.' });
  await store.search({ text: 'soup' }); // the words find nothing; the tree's notes go into the queue
  await vectors.settled();
  const hits = await store.search({ text: 'soup' });
  assert.deepEqual(hits.map((hit) => hit.item.id), [file.replace(/\//g, ':')]);
  assert.match(hits[0].why, /^similar meaning/);
  store.memoryForget(file);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vector_files')?.n, 0);
  assert.deepEqual(await store.search({ text: 'soup' }), []);
});

test('a note written again or edited by hand gets its new meaning when a search next asks, not before', async (t) => {
  const { root, store, vectors, embedder, watcher, clock } = world(t);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Server', text: 'The server stands in Graz.' });
  await store.search({ text: 'server' });
  await vectors.settled();
  const documents = embedder.documents.length;
  clock.advance(1000);
  store.memoryWrite({ path: file, title: 'Server', text: 'The server stands in Linz.' });
  writeFileSync(path.join(root, 'company', 'hand.md'), '---\ntitle: Hand\n---\n\nThe server moved to Wien.\n');
  watcher.nudge('memory', ['company', 'hand.md']);
  watcher.flush('memory');
  await vectors.settled();
  assert.equal(embedder.documents.length, documents, 'a write or an edit embeds nothing by itself');
  await store.search({ text: 'server' });
  await vectors.settled();
  assert.ok(embedder.documents.some((text) => text.includes('Linz')) && embedder.documents.some((text) => text.includes('moved to Wien')));
});

test('an embedder in trouble: memory is found by its words instead of "nothing"', async (t) => {
  const { store, embedder, vectors } = world(t);
  embedder.fail = true;
  store.memoryWrite({ folder: 'company', title: 'Soup', text: 'Soup on Fridays.' });
  assert.equal((await store.search({ text: 'soup' })).length, 1);
  await vectors.settled();
  assert.equal((await store.search({ text: 'soup' })).length, 1, 'also once the queue has paused');
});

test('a model chosen later: the words stand until then, the next searches rank by meaning', async (t) => {
  const { store, vectors, embedder, use } = world(t);
  use(undefined);
  store.memoryWrite({ folder: 'company', title: 'Freitag', text: 'Die Suppe gibt es freitags.' });
  assert.deepEqual(await store.search({ text: 'soup' }), []);
  assert.equal(embedder.documents.length, 0);
  use(embedder);
  await store.search({ text: 'soup' });
  await vectors.settled();
  assert.equal((await store.search({ text: 'soup' })).length, 1);
});

test('a free text as kind never reaches the frontmatter', (t) => {
  const { store, root } = world(t);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Soup', text: 'Soup on Fridays.', kind: 'fact\nuntrusted: true' as never });
  assert.doesNotMatch(readFileSync(path.join(root, ...file.split('/')), 'utf8'), /untrusted/);
});

test('a title that is a reserved Windows name still is a file', () => {
  for (const title of ['Con', 'NUL', 'aux', 'COM1', 'lpt9', 'prn']) assert.doesNotMatch(slugOf(title), /^(con|nul|aux|prn|com\d|lpt\d)$/, title);
  assert.equal(slugOf('Console'), 'console');
});
