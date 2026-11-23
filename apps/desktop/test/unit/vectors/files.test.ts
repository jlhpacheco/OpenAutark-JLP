// The files and folders vector.embed adds to the one search (vectors/files.ts): their words are found at once, with or without a
// model; with one their meaning ranks too; unchanged files are read once, changed ones again; folders leave out what they must and
// say so; the budget stops a big folder and the next call goes on; a search filters by place, notes a changed file and drops a gone one.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { vectorSystem, type VectorDeps } from '../../../src/runtime/vectors/create.ts';
import { chunkText, CHUNK_CHARS } from '../../../src/runtime/vectors/chunk.ts';
import { excluded } from '../../../src/runtime/vectors/places.ts';

const MEANINGS = [['invoice', 'rechnung'], ['server'], ['soup', 'suppe']];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (purpose === 'document') this.documents.push(...texts);
    return texts.map((text) => unit([...MEANINGS.map((words) => (words.some((word) => text.toLowerCase().includes(word)) ? 1 : 0)), 0.05]));
  }
}

function setup(t: { after(fn: () => void): void }, over: Partial<VectorDeps> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-files-'));
  const db = new Db(path.join(dir, 'test.db'));
  migrate(db);
  const embedder = new FakeEmbedder();
  let current: Embedder | undefined = embedder;
  const system = vectorSystem({ db, embedder: () => current, ...over });
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });
  t.after(() => { system.stop?.(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, body: string) => {
    const file = path.join(work, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    return file;
  };
  return { dir, db, embedder, system, work, write, use: (next: Embedder | undefined) => { current = next; } };
}

test('without a model an added file is found by its words at once; nothing is embedded and the result says why', async (t) => {
  const w = setup(t);
  w.use(undefined);
  const file = w.write('billing.md', '# Billing\nInvoices go out on the 3rd.\n\nSoup on Fridays.');
  assert.deepEqual(await w.system.embed([file]), { embedded: 1, reembedded: 0, unchanged: 0, skipped: [] });
  const found = await w.system.search({ query: 'invoices', in: [w.work] });
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].path, file);
  assert.deepEqual(found.hits[0].lines, [1, 4]);
  assert.match(found.hits[0].snippet, /Invoices go out/);
  assert.equal(found.note, undefined, 'the one line about the model is the caller\'s, once for every place');
  assert.deepEqual(w.embedder.documents, []);
});

test('with a model vector.embed waits for the pieces\' meaning within its budget, and a text the words miss comes by it', async (t) => {
  const w = setup(t);
  const german = w.write('freitag.md', 'Die Suppe gibt es freitags.');
  w.write('server.md', 'Server maintenance window.');
  const result = await w.system.embed([w.work]);
  assert.equal(result.embedded, 2);
  assert.equal(result.waiting, undefined, 'all embedded within the budget');
  assert.equal(w.embedder.documents.length, 2);
  const found = await w.system.search({ query: 'soup', in: [w.work] });
  assert.equal(found.hits[0].path, german, 'no shared word, the same meaning');
});

test('an unchanged file is read once; a changed one again; a search notes a file changed since and drops one that is gone', async (t) => {
  const w = setup(t);
  const a = w.write('a.md', 'An invoice note.');
  const b = w.write('b.md', 'Another invoice note.');
  await w.system.embed([w.work]);
  assert.deepEqual(await w.system.embed([w.work]), { embedded: 0, reembedded: 0, unchanged: 2, skipped: [] });
  const later = new Date(Date.now() + 60_000);
  writeFileSync(a, 'An invoice note, changed.');
  utimesSync(a, later, later);
  const found = await w.system.search({ query: 'invoice', in: [w.work] });
  assert.match(found.note ?? '', /changed since vector\.embed read them/);
  rmSync(b);
  const after = await w.system.search({ query: 'invoice', in: [w.work] });
  assert.deepEqual(after.hits.map((hit) => hit.path), [a], 'the gone file left');
  assert.equal((await w.system.embed([a])).reembedded, 1);
});

test('a folder leaves out binaries, dependencies, caches and secrets and names them; a file named on purpose is added', async (t) => {
  const w = setup(t);
  w.write('notes.md', 'An invoice note.');
  w.write('node_modules/x/readme.md', 'invoice');
  w.write('.env', 'TOKEN=1');
  w.write('Chrome Passwords.csv', 'site,user,password');
  w.write('photo.png', 'png');
  const env = w.write('cache/keep.md', 'An invoice kept on purpose.');
  const result = await w.system.embed([w.work]);
  assert.equal(result.embedded, 1);
  for (const name of ['node_modules', '.env', 'Chrome Passwords.csv', 'cache']) assert.ok(result.skipped.some((entry) => entry.path.endsWith(name)), name);
  assert.ok(result.skipped.some((entry) => /1 binary files/.test(entry.reason)));
  assert.equal((await w.system.embed([env])).embedded, 1, 'named on purpose');
  assert.equal((await w.system.embed([w.work])).unchanged, 1, 'a walk of the parent leaves it');
  assert.equal((await w.system.search({ query: 'invoice', in: [w.work] })).hits.length, 2);
});

test('a drive, a secrets folder, memory or a relative path are refused in plain words', async (t) => {
  const w = setup(t);
  const drive = path.parse(w.dir).root;
  mkdirSync(path.join(w.dir, '.ssh'));
  const result = await w.system.embed([drive, path.join(w.dir, '.ssh'), 'memory/company', 'catalog', 'notes.md']);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), [
    'a whole drive – name the folders that matter', 'secrets', 'memory and the catalog are in the search already', 'memory and the catalog are in the search already', 'give an absolute path',
  ]);
});

test('the budget stops a large folder; the next call goes on where it stopped', async (t) => {
  let time = 0;
  const w = setup(t, { now: () => (time += 40) }); // every look at the clock costs 40 ms
  for (let i = 0; i < 6; i++) w.write(`n${i}.md`, `Invoice ${i}.`);
  const first = await w.system.embed([w.work], { budgetMs: 200 });
  assert.ok(first.remaining && first.remaining > 0 && first.embedded > 0, JSON.stringify(first));
  assert.ok(first.skipped.some((entry) => /call vector\.embed again/.test(entry.reason)));
  const second = await w.system.embed([w.work], { budgetMs: 100_000 });
  assert.equal(second.embedded + first.embedded, 6);
  assert.equal(second.unchanged, first.embedded);
});

test('a file that cannot be read right now keeps what is stored of it', async (t) => {
  let locked = false;
  const w = setup(t, { readFile: async () => (locked ? { skip: 'not readable' } : 'An invoice note.') });
  const file = w.write('a.md', 'x');
  await w.system.embed([file]);
  locked = true;
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
  assert.deepEqual((await w.system.embed([file])).skipped, [{ path: file, reason: 'not readable' }]);
  assert.equal((await w.system.search({ query: 'invoice', in: [file] })).hits.length, 1);
});

test('a search filters by place: a sibling with the same start is not below it; nothing added there says how to add it', async (t) => {
  const w = setup(t);
  w.write('a/x.md', 'invoice in a');
  w.write('ab/y.md', 'invoice in ab');
  await w.system.embed([w.work]);
  const found = await w.system.search({ query: 'invoice', in: [path.join(w.work, 'a')] });
  assert.deepEqual(found.hits.map((hit) => path.basename(hit.path)), ['x.md']);
  const empty = await w.system.search({ query: 'invoice', in: [path.join(w.dir, 'elsewhere')] });
  assert.deepEqual(empty.hits, []);
  assert.match(empty.note ?? '', /vector\.embed adds files and folders/);
});

test('stored pieces are redacted', async (t) => {
  const w = setup(t, { redact: (text) => text.replaceAll('sk-secret', 'secret://sec_1') });
  await w.system.embed([w.write('k.md', 'Invoice key sk-secret')]);
  assert.equal(w.db.get<{ snippet: string }>('SELECT snippet FROM vector_chunks')?.snippet, 'Invoice key secret://sec_1');
  assert.deepEqual(w.embedder.documents, ['Invoice key secret://sec_1']);
});

test('pieces: headings and blank lines cut, line ranges hold, long lines are split, all text is kept', () => {
  const head = 'intro '.repeat(100);
  const text = `${head}\n\n# One\n${'alpha '.repeat(150)}\n\n# Two\n${'beta '.repeat(150)}\n${'x'.repeat(CHUNK_CHARS * 2 + 5)}\nend`;
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks[0].from, 1);
  assert.ok(chunks.some((chunk) => chunk.text.startsWith('# One')));
  assert.ok(chunks.some((chunk) => chunk.text.includes('# Two')));
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_CHARS + 2));
  assert.ok(chunks[chunks.length - 1].text.endsWith('end'));
  assert.equal(chunks[chunks.length - 1].to, text.split('\n').length);
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('\n\n  \n'), []);
  assert.deepEqual(chunkText(text), chunks, 'deterministic');
});

test('exclusions by name', () => {
  for (const name of ['.env', '.env.production', 'id_ed25519', 'bank-passwords.csv', 'credentials.json', 'login-export.csv', 'a.kdbx', 'x.pfx']) assert.ok(excluded(name, false), name);
  for (const name of ['notes.md', 'tokenizer.json', 'report.pdf', 'main.ts', 'login.ts', 'password-policy.md']) assert.equal(excluded(name, false), undefined, name);
  for (const name of ['node_modules', '.git', '.ssh', 'AppData', 'Cache', '__pycache__']) assert.ok(excluded(name, true), name);
  assert.equal(excluded('src', true), undefined);
});
