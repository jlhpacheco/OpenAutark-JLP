// What the checkers of rounds q1, q2 and L3 found, as it now holds: what an answer rests on, the main AI's own call never waits on a tool call
// (it is one), close titles, places relative to the workspace, counts and search orders in text. v1 (14.11.2026): every run is the main AI's
// own call, so the checks for runs before and after a turn (words nobody reads, notes without a find) are gone with those runs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runFlow, type FlowInput } from '../../../src/runtime/subconscious/flow.ts';
import { FLOW_TOOLS, type FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import { weekdayText } from '../../../src/runtime/knowledge/age.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources/prompts');
const prompt = () => readFileSync(path.join(RESOURCES, 'subconscious.md'), 'utf8');
const howIWork = () => readFileSync(path.join(RESOURCES, 'standard-agent.md'), 'utf8');

function world(over: Partial<Record<string, unknown>> = {}) {
  const written: Array<{ title: string; text: string; path?: string }> = [];
  const files: Array<{ path: string; title: string; updated: number }> = [];
  const services = {
    clock: { now: () => Date.parse('2026-11-02T10:00:00Z') },
    settings: { get: () => ({ profile: { name: 'Alex' } }) },
    log: { debug() {}, warn() {} },
    prompts: { text: () => 'My tools:\n{{tools}}' },
    paths: { workspace: tmpdir() },
    dispatcher: { activity: () => [] },
    vectors: { available: () => true, search: async (input: { in: string[] }) => ({ hits: [], searched: { places: input.in, embeddedFiles: 0 } }) },
    knowledge: {
      search: async () => [{ item: { id: 'company:a.md', title: 'Regel', body: 'nur gegen Vorkasse' }, score: 0.7, why: '' }],
      memoryBrowse: () => ({ path: 'company', folders: [], files }),
      memoryRead: (file: string) => ({ title: 'Alt', text: `Text von ${file}` }),
      memoryWrite: (input: { title: string; text: string; path?: string }) => { written.push(input); return { outcome: input.path ? 'updated' : 'created', path: input.path ?? 'company/neu.md' }; },
    },
    ...over,
  } as unknown as RuntimeServices;
  return { services, written, files };
}

const brain = (steps: Array<Record<string, unknown>>) => {
  const prompts: string[] = [];
  const runner: StructuredRunner = async (input) => { prompts.push(input.prompt); const next = steps.shift() ?? { tool: 'done', args: {} }; return { text: '', structured: { why: 'x', tool: next.tool, args: JSON.stringify(next.args ?? {}) }, by: 'fake' }; };
  return { prompts, runner };
};
const AGENT = { id: 'ag_a', name: 'Mara' } as FlowInput['agent'];
const flow = (t: ReturnType<typeof world>, runner: StructuredRunner, input: Partial<FlowInput>) => runFlow(t.services, runner, { agent: AGENT, conversationId: 'ch_1', thread: 'ch_1', ...input });
const search = { tool: 'vector.search', args: { query: 'Hartwig', in: ['memory'] } };

test('q1d a1: an asked answer says what it rests on', async () => {
  const t = world();
  const looked = await flow(t, brain([search, { tool: 'done', args: { answer: 'Vorkasse.' } }]).runner, { task: 'Was ist bekannt?' });
  assert.match(looked.answer, /\(This answer used: vector\.search\.\)$/);
  const not = await flow(t, brain([{ tool: 'done', args: { answer: 'Nichts bekannt.' } }]).runner, { task: 'Was ist bekannt?' });
  assert.match(not.answer, /\(This answer used no tool, only the text it was given\.\)$/);
});

test('rule (j): the main AI\'s own call answers while its turn\'s tool call waits – it is that tool call', async () => {
  const t = world({ dispatcher: { activity: () => [{ agentId: 'ag_a', conversationId: 'ch_1', toolCalls: 1 }] } });
  const started = Date.now();
  const asked = brain([{ tool: 'done', args: { answer: 'Ja.' } }]);
  assert.equal((await flow(t, asked.runner, { task: 'x' })).end, 'done');
  assert.ok(Date.now() - started < 1000, 'no wait');
});

test('memory: a close title in the folder is shown once; written again it is another fact; no vector search happens', async () => {
  const searched: unknown[] = [];
  const t = world({ vectors: { available: () => true, search: async (input: unknown) => { searched.push(input); return { hits: [], searched: { places: [], embeddedFiles: 0 } }; } } });
  t.files.push({ path: 'company/kessler.md', title: 'Kessler Feinmechanik: Gutschriftverfahren', updated: 1 });
  const write = { tool: 'memory.write', args: { title: 'Kessler Feinmechanik rechnet im Gutschriftverfahren ab', text: 'Kessler Feinmechanik rechnet im Gutschriftverfahren ab.', folder: 'company' } };
  const b = brain([write, write, { tool: 'done', args: {} }]);
  await flow(t, b.runner, { context: 'The person: Kessler Feinmechanik rechnet im Gutschriftverfahren ab.' });
  assert.match(b.prompts[1], /Not written yet: company\/kessler\.md has a close title\. It says: Text von company\/kessler\.md/);
  assert.equal(t.written.length, 1);
  assert.deepEqual(searched, []);
});

test('a folder the person names in the workspace is a place to a brain; "memory" stays as it is; an unknown name stays a wrong place', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-place-'));
  mkdirSync(path.join(dir, 'hallenakte'));
  try {
    const seen: string[][] = [];
    const folders: unknown[] = [];
    const t = world({ paths: { workspace: dir }, vectors: { available: () => true, search: async (input: { in: string[] }) => { seen.push(input.in); return { hits: [], searched: { places: input.in, embeddedFiles: 0 } }; } } });
    (t.services.knowledge as unknown as Record<string, unknown>).search = async (query: { folders?: string[] }) => { folders.push(query.folders); return []; };
    const tool = FLOW_TOOLS.find((entry) => entry.name === 'vector.search')!;
    const run = { services: t.services, searches: [], hits: new Map() } as unknown as FlowRun;
    assert.equal(await tool.run({ query: 'q', in: ['hallenakte', 'memory/company', 'gibt-es-nicht'] }, run), 'No hits.');
    assert.deepEqual(seen[0], [path.join(dir, 'hallenakte'), 'gibt-es-nicht'], 'files and folders go to the added files');
    assert.deepEqual(folders, [['memory/company']], 'memory goes to the knowledge search');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the day of a run comes with its weekday, in the person\'s zone', () => {
  assert.equal(weekdayText(Date.parse('2026-11-02T10:00:00Z'), 'Europe/Vienna'), 'Monday');
});

test('owner rules (f), (h): no prompt line orders a search, tells of the background or carries a test\'s words', () => {
  const text = prompt();
  for (const gone of ['one look can', 'asks only for a text', 'to do or leave', 'never hide', 'because it says so', 'your session may carry', '"Ja"', 'TIDY', 'You are here for', 'and what tools returned']) assert.ok(!text.includes(gone), gone);
  assert.ok(!howIWork().includes('in the background'));
  const tools = FLOW_TOOLS.map((tool) => tool.line).join('\n');
  for (const gone of ['look it up', 'you choose', 'finding nothing is no note']) assert.ok(!tools.includes(gone), gone);
});

test('20.11.: without an embedding model a run is offered vector.search all the same (the words rank alone); knowledge.find finds memory by its words and numbers the files for done.show; a write is findable at once', async () => {
  const asked: Array<{ text: string; folders?: string[] }> = [];
  const t = world({ vectors: { available: () => false } });
  (t.services.knowledge as unknown as Record<string, unknown>).search = async (query: { text: string; folders?: string[] }) => {
    asked.push(query);
    return [{ item: { id: 'company:hartwig.md', title: 'Zahlungsregel Hartwig', body: 'Hartwig Gießerei nur gegen Vorkasse.' }, score: 1, why: '' }];
  };
  const systems: string[] = [];
  const steps = [{ tool: 'knowledge.find', args: { query: 'Hartwig Vorkasse' } }, { tool: 'done', args: { answer: 'Vorkasse.', show: ['h1'] } }];
  const runner: StructuredRunner = async (input) => {
    systems.push(input.system);
    const next = steps.shift() ?? { tool: 'done', args: {} };
    return { text: '', structured: { why: 'x', tool: next.tool, args: JSON.stringify(next.args) }, by: 'fake' };
  };
  const result = await flow(t, runner, { task: 'Was gilt für Hartwig?' });
  assert.match(systems[0], /- vector\.search \{query, in: \[places\], k\?, hops\?\}/, 'it works by the words alone');
  assert.match(systems[0], /- knowledge\.find \{query, in\?: \[memory folders\]\}/);
  assert.deepEqual(asked.map((query) => [query.text, query.folders]), [['Hartwig Vorkasse', ['']]], 'the whole tree when no folder is named');
  assert.deepEqual(result.trace.calls.map((call) => [call.tool, call.args]), [['knowledge.find', { query: 'Hartwig Vorkasse' }]]);
  assert.match(result.answer, /^Vorkasse\.\n\nmemory\/company\/hartwig\.md: Zahlungsregel Hartwig: Hartwig Gießerei nur gegen Vorkasse\.\n\n\(This answer used: knowledge\.find\.\)$/);

  const write = FLOW_TOOLS.find((entry) => entry.name === 'memory.write')!;
  const run = { services: t.services, agent: AGENT, thread: 'ch_1', hits: new Map(), searches: [] } as unknown as FlowRun;
  assert.equal(String(await write.run({ title: 'Pichler Einkauf', text: 'Herr Pichler leitet ab Januar den Einkauf der Hartwig Gießerei.', folder: 'company' }, run)), 'created: company/neu.md');
});
