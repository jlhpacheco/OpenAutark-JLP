// memory.browse / read / write / forget: one handler for every caller, the caller's own folder by default, findable by writing;
// a file's description where the agent asked (its folder line, its read, a knowledge.find hit); memory.write in every
// core set and the rest on demand, and no memory search tool of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctxFor, setup } from './helpers.ts';
import { KnowledgeStore, type MemoryVectors } from '../../../src/runtime/knowledge/service.ts';
import { memoryTools } from '../../../src/runtime/tools/builtin/memory.ts';
import { findTools } from '../../../src/runtime/tools/builtin/find.ts';
import { BASE_CORE } from '../../../src/runtime/tools/core-sets.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';

const byName = (name: string) => memoryTools.find((t) => t.name === name)!;
const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

function world() {
  const h = setup();
  const forgotten: string[] = [];
  const vectors: MemoryVectors = { available: () => true, rank: async (input) => ({ hits: input.words.slice(0, input.limit) }), forget: (key) => { forgotten.push(key); } };
  const knowledge = new KnowledgeStore({ db: h.db, clock: h.clock, vectors: () => vectors });
  (h.services as RuntimeServices).knowledge = knowledge;
  return { h, knowledge, forgotten };
}

test('memory.write goes to the caller\'s own folder by default, is findable by that, and memory.read returns it', async () => {
  const { h, forgotten } = world();
  const out = await byName('memory.write').run({ title: 'Export-Einstellung', text: 'Immer H.264.', kind: 'experience', tags: ['video'] }, ctxFor(h));
  assert.equal(out.isError, undefined, textOf(out));
  const { path: file, outcome } = out.structured as { path: string; outcome: string };
  assert.equal(file, 'agents/ag_tom/export-einstellung.md');
  assert.equal(outcome, 'created');
  assert.deepEqual(forgotten, [], 'a write takes no stored meaning along');

  const read = await byName('memory.read').run({ path: file }, ctxFor(h));
  assert.match(textOf(read), /^Export-Einstellung \(experience · video · \d{4}-\d{2}-\d{2} · run:run_1\)\n\nImmer H\.264\.$/);
  const again = await byName('memory.write').run({ title: 'Export-Einstellung', text: 'Immer H.264.' }, ctxFor(h));
  assert.equal((again.structured as { outcome: string }).outcome, 'unchanged');
});

test('memory.write names a folder or a file; memory.browse shows it; memory.forget removes it', async () => {
  const { h } = world();
  await byName('memory.write').run({ folder: 'company/kunden', title: 'Müller', text: 'Zahlt spät.' }, ctxFor(h));
  const updated = await byName('memory.write').run({ path: 'company/kunden/mueller.md', title: 'Müller', text: 'Zahlt pünktlich.', source: 'human' }, ctxFor(h));
  assert.equal((updated.structured as { outcome: string }).outcome, 'updated');

  const top = textOf(await byName('memory.browse').run({}, ctxFor(h)));
  assert.match(top, /company\/ – What the whole company knows\.\n/);
  assert.doesNotMatch(top, /\d+ files?\)|searches this folder/, 'no count, no order to search (owner rules a, f)');
  const folder = textOf(await byName('memory.browse').run({ folder: 'company/kunden' }, ctxFor(h)));
  assert.match(folder, /company\/kunden\/mueller\.md – Müller \(\d{4}/);

  assert.equal((await byName('memory.forget').run({ path: 'company/kunden/mueller.md' }, ctxFor(h))).isError, undefined);
  const gone = await byName('memory.forget').run({ path: 'company/kunden/mueller.md' }, ctxFor(h));
  assert.equal(gone.isError, true);
  assert.equal((await byName('memory.read').run({ path: 'company/kunden/mueller.md' }, ctxFor(h))).isError, true);
  assert.equal((await byName('memory.read').run({ path: '../../etc/x.md' }, ctxFor(h))).isError, true);
});

test('a description shows where it was asked for: the folder line, the read and the find hit', async () => {
  const { h } = world();
  const out = await byName('memory.write').run({ folder: 'company/kunden', title: 'Müller', text: 'Zahlt spät.', description: 'When an invoice to Müller is due.' }, ctxFor(h));
  assert.equal(out.isError, undefined, textOf(out));
  const folder = textOf(await byName('memory.browse').run({ folder: 'company/kunden' }, ctxFor(h)));
  assert.match(folder, /^company\/kunden\/mueller\.md – Müller \(\d{4}-\d{2}-\d{2}\) – When an invoice to Müller is due\.$/m);
  const read = textOf(await byName('memory.read').run({ path: 'company/kunden/mueller.md' }, ctxFor(h)));
  assert.equal(read.split('\n')[1], 'When an invoice to Müller is due.');
  assert.match(read, /\n\nZahlt spät\.$/);
  const found = textOf(await findTools.find((t) => t.name === 'knowledge.find')!.run({ query: 'Müller', kinds: ['note'] }, ctxFor(h)));
  assert.match(found, /^- \[note:company:kunden:mueller\.md\] memory note "Müller" \(When an invoice to Müller is due\.\) – /m);
});

test('memory.write is in every core set, the rest on demand; there is no memory search tool', () => {
  for (const name of ['memory.browse', 'memory.read', 'memory.write', 'memory.forget']) assert.ok(byName(name), name);
  // KI-Runde 17.11.2026 (tools-friction 1.4: 69 calls and 14 lookups by name in 2.5 days): what I learned stays, directly.
  assert.equal('memory.write' in BASE_CORE, true);
  for (const name of ['memory.browse', 'memory.read', 'memory.forget']) assert.equal(name in BASE_CORE, false, `${name} is on demand`);
  assert.equal(memoryTools.some((t) => t.name === 'memory.search'), false);
});

test('Runde „Halb“: a note is a hint for a later me – its description is required and is the hint line; a way of working is a skill', () => {
  const write = byName('memory.write');
  const schema = write.inputSchema as { required: string[]; properties: { description: { description: string; minLength?: number } } };
  assert.deepEqual(schema.required, ['title', 'text', 'description']);
  assert.equal(schema.properties.description.minLength, 1);
  assert.equal(schema.properties.description.description, 'The hint line: when it matters and what it changes.');
  assert.match(write.description, /^Keeps one thing a later turn of mine would otherwise not think of/);
  assert.match(write.description, /Its description is the line my later self gets as a hint/);
  assert.match(write.description, /A way of working that needs more than a few lines is a skill \(skills\.save\)\./);
});
