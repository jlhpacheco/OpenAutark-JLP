// The subconscious and the transcript under attack: the person's still open instruction survives a bare "ja bitte"; a stamp never
// promises a way back that is gone; a trace stays in the history of a stateless engine, bounded, following the marks; a paid
// brain's cost reaches the spend journal, each call's on the agent it ran for.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { TraceCall } from '../../../src/shared/model/subconscious.ts';
import { traceCallId } from '../../../src/shared/model/subconscious.ts';
import { carriedCalls, marksOf, CARRIED_TOKENS } from '../../../src/runtime/context/ledger/marks.ts';
import { rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';
import { restoreItems } from '../../../src/runtime/context/ledger/restore.ts';
import { MAX_TEXT_CHARS } from '../../../src/runtime/tools/outputs.ts';
import { mid, ledgerSetup } from '../context/ledger-fixture.ts';
import { RESOURCES, fixture, model } from '../context/fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import { routable } from './routable.ts';

const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;

function runOf(t: ReturnType<typeof ledgerSetup>): FlowRun {
  return {
    services: t.services, agent: t.tom, conversationId: t.chat.id, thread: 'main', signal: new AbortController().signal,
    hits: new Map(), searches: [], show: () => {}, finish: () => {},
  } as unknown as FlowRun;
}

test('the person\'s instruction stays out of reach while only a bare "ja bitte" came after it', async () => {
  const t = ledgerSetup();
  try {
    const old = t.say('An older finished topic about the logo, long enough to be worth a look.');
    t.done(t.turn(old.seq));
    t.clock.advance(1000);
    const instruction = t.say(`Build the whole invoice export for Brightwave and send it to Lea. ${'Details follow. '.repeat(40)}`);
    t.done(t.turn(instruction.seq));
    t.clock.advance(1000);
    const yes = t.say('ja bitte');
    t.done(t.turn(yes.seq));
    for (let index = 0; index < 4; index++) {
      t.clock.advance(1000);
      const run = t.turn(yes.seq);
      t.ourCall(run, 'shell.exec', { command: `step ${index}` }, 'x'.repeat(5000), `c${index}`);
      t.done(run);
    }
    const run = runOf(t);
    const id = mid(t.db, instruction);
    assert.doesNotMatch(String(await tool('context.list').run({}, run)), new RegExp(`\\n${id} `));
    assert.match(String(await tool('context.condense').run({ id, text: 'export for Brightwave' }, run)), /stays as it is/);
    assert.match(String(await tool('context.hide').run({ ids: [id] }, run)), /left as they are/);
    assert.match(String(await tool('context.hide').run({ ids: [mid(t.db, yes)] }, run)), /left as they are/, 'the newest message too');
    assert.match(String(await tool('context.hide').run({ ids: [mid(t.db, old)] }, run)), /^hidden: /, 'what is older may go');
  } finally { t.cleanup(); }
});

test('a condensed item whose original is gone: the stamp no longer promises the way back, and the hidden one is not offered', async () => {
  const t = ledgerSetup({ budget: 1 });
  try {
    const run = t.turn(t.say('Do it.').seq);
    t.ourCall(run, 'shell.exec', { command: 'a' }, 'a'.repeat(9000), 'c1');
    t.ourCall(run, 'shell.exec', { command: 'b' }, 'b'.repeat(9000), 'c2');
    t.done(run);
    t.ledger.mark(t.tom.id, 'main', [
      { itemId: 't1', state: 'condensed', condensed: 'a log', reason: 'old', by: 'subconscious' },
      { itemId: 't2', state: 'hidden', reason: 'old', by: 'subconscious' },
    ]);
    assert.match(t.ledger.view(t.tom.id, 'main').find((item) => item.itemId === 't1')!.text, /"restore":"context\.restore"/, 'kept 14 days: the way back holds');
    assert.ok(marksOf(t.services, t.tom.id, 'main').some((item) => item.itemId === 't2'));
    t.clock.advance(15 * 24 * 3600_000);
    t.ledger.mark(t.tom.id, 'main', [{ itemId: 'm1', state: 'hidden', reason: 'a later mark runs the retention', by: 'subconscious' }]);
    assert.equal(t.ledger.original(t.tom.id, 'main', 't1')?.pruned, true, 'retention took the condensed original');
    assert.equal(t.ledger.original(t.tom.id, 'main', 't2')?.pruned, true, 'and the hidden one');
    assert.equal(marksOf(t.services, t.tom.id, 'main').some((item) => item.itemId === 't2'), false, 'nothing to get back: not named');
    const view = t.ledger.view(t.tom.id, 'main').find((item) => item.itemId === 't1')!;
    assert.doesNotMatch(view.text, /"restore"/);
    assert.match(view.text, /a log\n\{"compacted":"t1","was":"\d+ tokens","original":"gone"\}/);
    assert.equal(rebuildItems([view]).items[0].call?.output, view.text);
  } finally { t.cleanup(); }
});

test('a condensed chat line whose message is gone from retention keeps a stamp without the way back', () => {
  const t = ledgerSetup({ budget: 1 });
  try {
    const said = t.say(`A long request. ${'words '.repeat(200)}`);
    t.done(t.turn(said.seq));
    t.ledger.mark(t.tom.id, 'main', [{ itemId: mid(t.db, said), state: 'condensed', condensed: 'a request', reason: 'old', by: 'subconscious' }]);
    t.db.run(`UPDATE context_items SET pruned_at = 1 WHERE item_id = ?`, [mid(t.db, said)]);
    const line = t.ledger.view(t.tom.id, 'main').find((item) => item.itemId === mid(t.db, said))!;
    assert.match(line.text, /a request\n\{"compacted":"m\d+","was":"\d+ tokens","original":"gone"\}/);
  } finally { t.cleanup(); }
});

/** A subconscious call as runAttempt journals it. */
function journalCall(t: ReturnType<typeof ledgerSetup>, runId: string, index: number, call: TraceCall): void {
  const callId = traceCallId(runId, index);
  t.journal.item(runId, { kind: 'tool_call', name: call.tool, idemKey: `${callId}:call`, effectStatus: 'none', data: { callId, args: JSON.stringify(call.args), summary: 'x', subconscious: true } });
  t.journal.item(runId, { kind: 'tool_result', name: call.tool, idemKey: `${callId}:result`, effectStatus: 'none', data: { callId, ok: true, summary: 'x', output: { content: [{ type: 'text', text: call.output }] } } });
}

test('stateless engine: a trace stays in the next turns, follows the marks, leaves out this run and stays bounded', () => {
  const t = ledgerSetup();
  try {
    const first = t.turn(t.say('Rechnungen?').seq, 'openai', 'openai:x');
    journalCall(t, first, 0, { tool: 'vector.search', args: { query: 'invoices', in: ['memory/company'] }, output: 'memory/company/billing.md: on the 3rd' });
    journalCall(t, first, 1, { tool: 'agent.tell', args: {}, output: 'Frau Berger bekommt die Mahnungen.' });
    t.done(first);
    t.ourCall(t.turn(t.say('Weiter.').seq, 'openai', 'openai:x'), 'shell.exec', { command: 'x' }, 'own work', 'c9');

    const calls = carriedCalls(t.services, t.tom.id, 'main', 'run_other');
    assert.deepEqual(calls.map((call) => [call.tool, call.output]), [
      ['vector.search', 'memory/company/billing.md: on the 3rd'],
      ['agent.tell', 'Frau Berger bekommt die Mahnungen.'],
    ], 'only what the subconscious showed, oldest first, not the agent\'s own calls');
    assert.deepEqual(calls[0].args, { query: 'invoices', in: ['memory/company'] });
    assert.deepEqual(carriedCalls(t.services, t.tom.id, 'main', first), [], 'a retry of the same run brings its own');

    const [search, tell] = t.ledger.items(t.tom.id, 'main', { kinds: ['tool'] });
    t.ledger.mark(t.tom.id, 'main', [{ itemId: search.itemId, state: 'hidden', reason: 'old', by: 'subconscious' }, { itemId: tell.itemId, state: 'condensed', condensed: 'Berger: Mahnungen', reason: 'old', by: 'subconscious' }]);
    const marked = carriedCalls(t.services, t.tom.id, 'main', 'run_other');
    assert.equal(marked.length, 1, 'hidden is out');
    assert.match(marked[0].output, /^Berger: Mahnungen\n\{"compacted":"/, 'condensed with its stamp');

    const later = t.turn(t.say('Noch mehr.').seq, 'openai', 'openai:x');
    for (let index = 0; index < 40; index++) journalCall(t, later, index, { tool: 'agent.tell', args: {}, output: `Note ${index}: ${'long text '.repeat(100)}` });
    const big = carriedCalls(t.services, t.tom.id, 'main', 'run_other');
    const chars = big.reduce((sum, call) => sum + call.tool.length + JSON.stringify(call.args).length + call.output.length, 0);
    assert.ok(chars <= CARRIED_TOKENS * 4, String(chars));
    assert.match(big.at(-1)!.output, /^Note 39: /, 'the newest stay');
  } finally { t.cleanup(); }
});

test("the subconscious's cost on a paid account reaches the spend journal; on a plan it does not", async () => {
  for (const [auth, expected] of [['api_key', 1], ['cli', 0]] as const) {
    const booked: Array<Record<string, unknown>> = [];
    const f = fixture();
    f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const engine = {
      id: 'compatible', caps: { sessions: false, structured: true },
      async run(_input: EngineTurnInput) {
        const structured = { tool: 'done', args: '{"answer":"Nichts."}' };
        return { text: JSON.stringify(structured), structured, stop: 'done', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 } };
      },
    } as unknown as Engine;
    Object.assign(f.services, {
      spend: { record: (entry: Record<string, unknown>) => { booked.push(entry); return undefined; } },
      vectors: { available: () => false },
      engines: { get: () => engine },
      accounts: { get: () => ({ id: 'acc', provider: 'p', auth }), markLimited() {}, markUnavailable() {}, updateLimits() {} },
      catalog: { get: () => ({ id: 'p:m', model: 'm', efforts: [] }), list: () => [{ id: 'p:m', available: true }] },
      router: { route: async (_request: RouteRequest) => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: 't', by: 'rules', alternatives: [] }) },
      paths: { ...f.services.paths, temp: path.join(RESOURCES, '..', 'test-results', 'helper-temp') },
    });
    const subconscious = new SubconsciousImpl({ services: () => f.services });
    assert.equal(await subconscious.ask({ agent: f.vid, ask: 'Was weißt du?', context: 'none' }), 'Nichts.\n\n(This answer used no tool, only the text it was given.)');
    assert.equal(booked.length, expected, auth);
    if (expected) {
      assert.equal(booked[0].amount, 0.25);
      assert.equal(booked[0].kind, 'tokens');
      assert.equal(booked[0].agentId, f.vid.id, 'it counts for the agent it ran for');
    }
  }
});

test('each call books its use on the agent it works for: a routing call in flight and another agent\'s ask stay apart', async () => {
  const booked: Array<Record<string, unknown>> = [];
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const engine = {
    id: 'compatible', caps: { sessions: false, structured: true },
    async run(_input: EngineTurnInput) {
      const call = ++calls;
      if (call === 1) await gate; // the first agent's routing call stays in flight while the other agent asks
      const structured = call === 1 ? { hardest: 'x', misread: false, decide: false, model: 'M', effort: 'low', why: 'a status' }
        : { tool: 'done', args: '{"answer":"Nichts."}' };
      return { text: JSON.stringify(structured), structured, stop: 'done', usage: { inputTokens: 100, outputTokens: 10, costUsd: call / 100 } };
    },
  } as unknown as Engine;
  const work = model('p:m', 'small', 'M');
  Object.assign(f.services, {
    spend: { record: (entry: Record<string, unknown>) => { booked.push(entry); return undefined; } },
    vectors: { available: () => false },
    engines: { get: () => engine },
    accounts: { get: () => ({ id: 'acc', provider: 'p', auth: 'api_key' }), list: () => [], markLimited() {}, markUnavailable() {}, updateLimits() {} },
    catalog: { get: () => work, list: () => [work] },
    router: { route: async (_request: RouteRequest) => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: 't', by: 'rules', alternatives: [] }) },
    paths: { ...f.services.paths, temp: path.join(RESOURCES, '..', 'test-results', 'helper-temp') },
  });
  routable(f.services, [work]);
  const subconscious = new SubconsciousImpl({ services: () => f.services });
  const routing = subconscious.beforeTurn({ agent: f.vid, thread: 'main', said: 'Bitte prüf den Vertrag für Müller, er unterschreibt morgen.' });
  // the word search reads files before the call starts (its reach reads the memory tree's top too): wait for the call, not a tick count
  for (let tick = 0; tick < 5000 && calls < 1; tick++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'the routing call is in flight');
  assert.equal(await subconscious.ask({ agent: f.manager, ask: 'Was weißt du?', context: 'none' }), 'Nichts.\n\n(This answer used no tool, only the text it was given.)');
  release();
  await routing;
  assert.deepEqual(booked.map((entry) => [entry.agentId, entry.amount]), [[f.manager.id, 0.02], [f.vid.id, 0.01]]);
});

test('a brain on an engine runner reports what each attempt used', async () => {
  const used: unknown[] = [];
  const engine = { async run() { return { text: 'x', stop: 'done', usage: { inputTokens: 3, outputTokens: 1 } }; } } as unknown as Engine;
  const runner = createEngineRunner({
    engines: { get: () => engine } as never,
    router: { route: async () => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: 't', by: 'rules', alternatives: [] }) } as never,
    accounts: { get: () => ({ id: 'acc', provider: 'p', auth: 'api_key' }), markLimited() {}, markUnavailable() {}, updateLimits() {} } as never,
    catalog: { get: () => ({ id: 'p:m', model: 'm', efforts: [] }) } as never,
    paths: { temp: path.join(RESOURCES, '..', 'test-results', 'helper-temp') },
    clock: { now: () => 1 } as never,
    onUsage: (entry) => { used.push(entry); },
  });
  await runner({ purpose: 'subconscious', system: 's', prompt: 'p' });
  assert.equal(used.length, 1);
  assert.deepEqual((used[0] as { usage: unknown }).usage, { inputTokens: 3, outputTokens: 1 });
});

test('what the main AI asks back is never cut by the limit of a tool output: restore and answer stay below it', async () => {
  const t = ledgerSetup();
  try {
    for (let index = 1; index <= 5; index++) {
      const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
      t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `${'log line\n'.repeat(1500)}THE END ${index}`, `c${index}`);
      t.done(run);
      t.clock.advance(1000);
    }
    await t.journal.settled();
    t.ledger.mark(t.tom.id, 'main', ['t1', 't2', 't3'].map((itemId) => ({ itemId, state: 'condensed', condensed: 'a log', reason: 'old', by: 'subconscious' })));
    assert.ok(restoreItems(t.services, t.tom.id, 'main', { ids: ['t1', 't2', 't3'] }).length < MAX_TEXT_CHARS);
    t.ledger.mark(t.tom.id, 'main', ['t1', 't2', 't3'].map((itemId) => ({ itemId, state: 'condensed', condensed: 'a log', reason: 'again', by: 'agent' })));
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const steps = [{ tool: 'context.restore', args: JSON.stringify({ ids: ['t1', 't2', 't3'] }) }, { tool: 'done', args: JSON.stringify({ answer: 'Hier. '.repeat(2000) }) }];
    const runner: StructuredRunner = async () => { const structured = steps.shift(); return { text: JSON.stringify(structured), structured, by: 'fake' }; };
    const answer = await new SubconsciousImpl({ services: () => t.services, runner }).ask({ agent: t.tom, conversationId: t.chat.id, ask: 'Hol sie zurück', context: 'none' });
    assert.ok(answer.length <= MAX_TEXT_CHARS, String(answer.length));
    assert.match(answer, /^Hier\. /);
    assert.match(answer, /THE END 1/);
  } finally { t.cleanup(); }
});
