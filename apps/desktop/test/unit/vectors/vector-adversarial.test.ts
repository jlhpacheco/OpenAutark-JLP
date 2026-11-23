// The vector system under attack: what looks like a secret export stays out of a folder vector.embed adds; a search reads no new
// file, not even when an added file turned into a folder; paid embedding reaches the spend journal.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { HttpEmbedder, unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { vectorSystem } from '../../../src/runtime/vectors/create.ts';
import { excluded } from '../../../src/runtime/vectors/places.ts';
import { EmbedSpend } from '../../../src/runtime/vectors/spend.ts';

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (purpose === 'document') this.documents.push(...texts);
    return texts.map((text) => unit([text.toLowerCase().includes('invoice') ? 1 : 0, 0.01]));
  }
}

function world(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-vector-attack-'));
  const db = new Db(path.join(dir, 'test.db'));
  migrate(db);
  const embedder = new FakeEmbedder();
  const system = vectorSystem({ db, embedder: () => embedder });
  t.after(() => { system.stop?.(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  const write = (file: string, body: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); return file; };
  return { dir, embedder, system, write };
}

test('what browsers and password managers export stays out of a folder vector.embed adds; ordinary names stay in', async (t) => {
  for (const name of ['Chrome Passwords.csv', 'Google Passwords.csv', 'Microsoft Edge Passwords.csv', 'logins.csv', 'prod.env', 'api_keys.txt', 'api-key.json', 'bitwarden_export_20261101.json', 'lastpass export.csv', 'keepass-export.xml', '1password-export.csv', 'my passwords.txt']) {
    assert.ok(excluded(name, false), name);
  }
  for (const name of ['server.log', 'yarn.lock', 'package-lock.json', 'app.min.js', 'app.js.map']) assert.equal(excluded(name, false), 'generated', name);
  for (const name of ['env.md', 'token-notes.md', 'environment.ts', 'keyboard.txt', 'password-policy.md', 'export.csv', 'monkey.json', 'tokenizer.json', 'report.txt']) {
    assert.equal(excluded(name, false), undefined, name);
  }
  const w = world(t);
  const folder = path.join(w.dir, 'work');
  w.write(path.join(folder, 'Chrome Passwords.csv'), 'site,user,password,invoice');
  w.write(path.join(folder, 'notes.md'), 'An invoice note.');
  const result = await w.system.embed([folder]);
  assert.equal(result.embedded, 1);
  assert.ok(result.skipped.some((entry) => entry.path.endsWith('Chrome Passwords.csv')), 'skipped and reported');
  assert.equal(w.embedder.documents.some((text) => text.includes('password')), false);
});

test('a search reads no new file: an added file that became a folder leaves, the files in it stay out', async (t) => {
  const w = world(t);
  const file = w.write(path.join(w.dir, 'work', 'notes'), 'An invoice note.');
  await w.system.embed([file]);
  w.embedder.documents.length = 0;
  rmSync(file);
  w.write(path.join(file, 'new-file.md'), 'A new invoice note.');
  const found = await w.system.search({ query: 'invoice', in: [path.join(w.dir, 'work')] });
  assert.deepEqual(found.hits, []);
  assert.deepEqual(w.embedder.documents, [], 'a search never walks a folder');
  assert.equal(statSync(path.join(file, 'new-file.md')).isFile(), true);
  assert.deepEqual((await w.system.search({ query: 'invoice', in: [path.join(w.dir, 'work')] })).hits, [], 'and stays gone');
});

test('the HTTP embedder reports what a call used, with the price the provider names', async () => {
  const used: Array<{ tokens: number; costUsd?: number }> = [];
  const answer = (usage: unknown) => async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage }) });
  const make = (usage: unknown) => new HttpEmbedder({ provider: 'p', baseUrl: 'https://api.example.com/v1', model: 'm', remote: true, sendDimensions: false, apiKey: async () => 'k', fetch: answer(usage), onUsage: (entry) => { used.push(entry); } });
  await make({ prompt_tokens: 7, total_tokens: 7 }).embed(['a'], 'document');
  await make({ total_tokens: 9, cost: 0.002 }).embed(['a'], 'document');
  await make({ prompt_tokens: 3, estimated_cost: 0.001 }).embed(['a'], 'document');
  await make(undefined).embed(['a'], 'document');
  assert.deepEqual(used, [{ tokens: 7 }, { tokens: 9, costUsd: 0.002 }, { tokens: 3, costUsd: 0.001 }]);
});

function spendWorld(auth: string, plan?: string) {
  const booked: Array<Record<string, unknown>> = [];
  const services = {
    spend: { record: (entry: Record<string, unknown>) => { booked.push(entry); return undefined; } },
    accounts: { get: () => ({ id: 'acc', provider: 'openai', auth, ...(plan ? { plan } : {}) }) },
    catalog: { get: () => undefined },
    paths: { resources: path.join(import.meta.dirname, '..', '..', '..', 'resources') },
    log: { warn() {}, debug() {} },
  };
  return { booked, spend: new EmbedSpend(() => services as never) };
}

test('paid embedding goes into the spend journal: small amounts together, the rest at the stop; free ones never', () => {
  const paid = spendWorld('api_key');
  const choice = { accountId: 'acc', provider: 'openai', model: 'text-embedding-3-small' };
  paid.spend.add(choice, { tokens: 1000 });
  assert.equal(paid.booked.length, 0, 'not one row per batch');
  paid.spend.add(choice, { tokens: 1_000_000 });
  assert.equal(paid.booked.length, 1, 'priced at the curated list price');
  assert.equal(paid.booked[0].kind, 'tokens');
  assert.equal(paid.booked[0].currency, 'USD');
  assert.ok(Math.abs((paid.booked[0].amount as number) - 0.02002) < 1e-6, String(paid.booked[0].amount));
  assert.match(String(paid.booked[0].ref), /^embedding:text-embedding-3-small/);
  paid.spend.add({ ...choice, model: 'some-other-embedding' }, { tokens: 5, costUsd: 0.0003 });
  assert.equal(paid.booked.length, 1);
  paid.spend.flush();
  assert.equal(paid.booked.length, 2, 'what is left goes at the stop');
  assert.equal(paid.booked[1].amount, 0.0003);

  const local = spendWorld('local');
  local.spend.add(choice, { tokens: 10_000_000 });
  local.spend.flush();
  assert.equal(local.booked.length, 0);

  const plan = spendWorld('cli');
  plan.spend.add(choice, { tokens: 10_000_000 });
  plan.spend.flush();
  assert.equal(plan.booked.length, 0);
});
