// memory.write, the one memory write: the same title or clearly the same content in a folder updates that file (never a second note, the old version kept);
// `pinned` moves a note into or out of its place's pinned/ and an update keeps it there; into references/<person> it keeps
// the person's own words with a reference kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctxFor, setup } from './helpers.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { memoryTools } from '../../../src/runtime/tools/builtin/memory.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';

const write = memoryTools.find((t) => t.name === 'memory.write')!;
const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;
const done = (out: ToolOutput) => out.structured as { path: string; outcome: string; note?: string };

function withKnowledge() {
  const h = setup();
  const knowledge = new KnowledgeStore({ db: h.db, clock: h.clock });
  (h.services as RuntimeServices).knowledge = knowledge;
  return { h, knowledge };
}

test('memory.write with the title of a current note updates it, never a second note; the old version stays as history', async () => {
  const { h, knowledge } = withKnowledge();
  const first = await write.run({ folder: 'company', title: 'Firma von Alex Berger', text: 'Die Firma heißt Teydra Lab.' }, ctxFor(h));
  assert.equal(done(first).outcome, 'created');
  const second = await write.run({ folder: 'company', title: ' firma von alex berger ', text: 'Die Firma heißt Teydra Lab und sitzt in Salzburg.' }, ctxFor(h));
  assert.equal(done(second).outcome, 'updated');
  assert.equal(done(second).path, done(first).path, 'the same file');
  const current = await knowledge.list({ scope: 'global' });
  assert.deepEqual(current.map((item) => item.body), ['Die Firma heißt Teydra Lab und sitzt in Salzburg.'], 'one current note');
  assert.equal(knowledge.history(current[0].id).length, 2, 'the old version is kept as history');
  const again = await write.run({ folder: 'company', title: 'firma von alex berger', text: 'Die Firma heißt Teydra Lab und sitzt in Salzburg.' }, ctxFor(h));
  assert.equal(done(again).outcome, 'unchanged');
  const fixed = await write.run({ path: done(first).path, title: 'Firma von Alex Berger', text: 'Teydra Lab, Salzburg.' }, ctxFor(h));
  assert.equal(done(fixed).outcome, 'updated', 'a path names the file to correct');
});

test('memory.write: clearly the same content under another title updates; another topic or folder does not', async () => {
  const { h, knowledge } = withKnowledge();
  const base = await write.run({ title: 'Morning drink', text: 'Alex drinks only green tea in the morning.', kind: 'preference' }, ctxFor(h));
  assert.match(done(base).path, /^agents\/ag_tom\//, 'my own folder by default');
  const reworded = await write.run({ title: 'Tea in the morning', text: 'Alex drinks only green tea in the morning.' }, ctxFor(h));
  assert.equal(done(reworded).path, done(base).path, 'the same file');
  assert.match(done(reworded).note ?? '', /Updated my note "Morning drink"/);
  assert.equal(knowledge.memoryRead(done(reworded).path)!.title, 'Tea in the morning');

  const other = await write.run({ title: 'Invoices', text: 'Alex sends invoices on the last day of the month.' }, ctxFor(h));
  assert.notEqual(done(other).path, done(base).path, 'another topic is a new note');
  const elsewhere = await write.run({ folder: 'company', title: 'Tea in the morning', text: 'Different text.' }, ctxFor(h));
  assert.match(done(elsewhere).path, /^company\//, 'the same title in another folder is another note');
  assert.equal((await knowledge.list({ scope: 'agent', scopeId: 'ag_tom' })).length, 2);
});

test('memory.write pinned: into the place\'s pinned/, an update keeps the pin, false moves it out', async () => {
  const { h, knowledge } = withKnowledge();
  const pinned = await write.run({ title: 'Style', text: 'Short answers.', pinned: true }, ctxFor(h));
  assert.match(done(pinned).path, /^agents\/ag_tom\/pinned\//);
  const kept = await write.run({ title: 'Style', text: 'Short answers, no emojis.' }, ctxFor(h));
  assert.equal(done(kept).path, done(pinned).path, 'the update stays pinned');
  const unpinned = await write.run({ title: 'Style', text: 'Short answers, no emojis, German.', pinned: false }, ctxFor(h));
  assert.doesNotMatch(done(unpinned).path, /pinned/);
  assert.equal(knowledge.get(done(unpinned).path.replace(/\//g, ':'))!.pinned, false);
  assert.equal((await knowledge.list({ scope: 'agent', scopeId: 'ag_tom' })).length, 1);
});

test('memory.write into references/: the person\'s own words with a reference kind; a reference kind elsewhere is refused', async () => {
  const { h, knowledge } = withKnowledge();
  const out = await write.run({ folder: 'references/human', title: 'pricing for agencies', text: 'We never discount below 20 %.', kind: 'reason' }, ctxFor(h));
  assert.equal(out.isError, undefined, textOf(out));
  const item = (await knowledge.list({ scope: 'reference', scopeId: 'human' }))[0];
  assert.equal(item.title, 'Reason: pricing for agencies');
  assert.equal(item.kind, 'reference');
  assert.equal((await write.run({ title: 'x', text: 'y', kind: 'correction' }, ctxFor(h))).isError, true);
});
