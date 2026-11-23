// The look before a turn (subconscious/service.ts lookFirst, v1: one routing call): a message with content – else, findings 14.11., the
// turn's task with content (re-review 14.11.: also while one of my parts has a tool call in that chat). Marking (context-tools.ts): context.condense puts the lean form of whole originals in their place, built by code; a
// brain's context.restore gives the main AI the originals as a real call and pins them (v1: every run is the main AI's own call). A kept
// output of an engine's own tool stays whole in a rebuild.
// Owns: these assertions only. Never: real models or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RESOURCES } from '../context/fixture.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { leanText } from '../../../src/runtime/context/ledger/window.ts';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';
import { runFlow } from '../../../src/runtime/subconscious/flow.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import type { FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { TraceCall } from '../../../src/shared/model/subconscious.ts';

const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;

/** A brain answering step by step; after its script it says done. */
function scripted(steps: Array<{ tool: string; args?: Record<string, unknown> }>) {
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const next = steps.shift() ?? { tool: 'done' };
    const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

/** Four finished turns, each with one long tool output: t1, t2 and t3 are older than the newest turn. */
function fourTurns(t: ReturnType<typeof ledgerSetup>): void {
  for (let index = 1; index <= 4; index++) {
    const run = t.turn(t.say(`Step ${index} please, with some words.`).seq);
    t.ourCall(run, 'shell.exec', { command: `build ${index}` }, `build ${index} finished in 40${index} seconds\n${'log line\n'.repeat(400)}THE END ${index}`, `c${index}`);
    t.done(run);
    t.clock.advance(1000);
  }
}

function runOf(t: ReturnType<typeof ledgerSetup>): { run: FlowRun; shown: TraceCall[] } {
  const shown: TraceCall[] = [];
  const run = {
    services: t.services, agent: t.tom, conversationId: t.chat.id, thread: 'main', signal: new AbortController().signal,
    hits: new Map(), searches: [], show: (call: TraceCall) => { shown.push(call); }, finish: () => {},
  } as unknown as FlowRun;
  return { run, shown };
}

/** The service with a routing model that answers every call with the same pick; one connected work model. */
function look(t: ReturnType<typeof ledgerSetup>, brain: StructuredRunner) {
  const plan = { id: 'acc_1', provider: 'codex', auth: 'cli', state: 'ok', enabled: true };
  Object.assign(t.services, {
    dispatcher: { activity: () => [] },
    catalog: { list: () => [{ id: 'codex:luna', provider: 'codex', engine: 'codex', model: 'luna', name: 'Luna', tier: 'small', caps: {}, efforts: ['low'], available: true, strengths: {}, accounts: [] }], get: () => undefined },
    accounts: { list: () => [plan], candidates: () => [plan] },
    settings: { get: () => ({ profile: { name: 'Alex', timezone: 'UTC' }, routing: { allowPaidFallback: false } }) },
  });
  const impl = new SubconsciousImpl({ services: () => t.services, runner: brain });
  return (said: string | undefined, taskText?: string) => impl.beforeTurn({ agent: t.tom, thread: 'main', conversationId: t.chat.id, said, ...(taskText ? { taskText } : {}) });
}

test("no call before a bare go-ahead or without anyone's words and a task; a task with content calls, also while a part's tool call runs in the chat; a call that sets nothing leaves no trace", async () => {
  const t = ledgerSetup();
  try {
    const calls: string[] = [];
    const brain: StructuredRunner = async (call) => { calls.push(call.prompt); const structured = { hardest: 'x', misread: false, decide: false, model: '', effort: '', why: 'x' }; return { text: JSON.stringify(structured), structured, by: 'fake' }; };
    const before = look(t, brain);
    assert.equal(await before('ja bitte'), undefined);
    assert.equal(await before(undefined), undefined);
    assert.equal(calls.length, 0);
    assert.equal(await before('Was denkst du über das neue Angebot?'), undefined);
    assert.equal(calls.length, 1, 'with content the model weighs the turn');
    assert.equal(await before('', 'Ok'), undefined);
    assert.equal(calls.length, 1, 'a task without content: no call');
    assert.equal(await before('', 'Monatsabschluss Oktober\nZwei Buchungen fehlen noch.'), undefined);
    assert.equal(calls.length, 2, "nobody's words, a task with content: the model weighs the task");
    Object.assign(t.services, { dispatcher: { activity: () => [{ agentId: t.tom.id, conversationId: t.chat.id, toolCalls: 1 }] } });
    assert.equal(await before('Was denkst du über das neue Angebot?'), undefined);
    assert.equal(calls.length, 3, 're-review 14.11.: a tool call in the chat is a part\'s – the main lane runs one turn at a time – and holds nothing back');
  } finally { t.cleanup(); }
});

test('context.condense: several ids in one call, the lean form of the whole original by code, the stamp stands in the view, protection holds', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    const { run } = runOf(t);
    const out = String(await tool('context.condense').run({ ids: ['t1', 't2', 't4'] }, run));
    assert.match(out, /^condensed t1: about \d+ tokens saved/m);
    assert.match(out, /^condensed t2: about \d+ tokens saved/m);
    assert.match(out, /^t4 stays as it is: in the newest turn\./m);
    const original = t.ledger.original(t.tom.id, 'main', 't1')!;
    const lean = leanText(original.args ? `${original.args}\n${original.text}` : original.text);
    const view = t.ledger.view(t.tom.id, 'main').find((entry) => entry.itemId === 't1')!;
    assert.ok((view.call?.output ?? '').startsWith(`${lean}\n{"compacted":"t1",`), view.call?.output);
    assert.match(lean, /build 1 finished in 401 seconds/, 'how it began');
    assert.match(String(await tool('context.condense').run({ ids: ['t1'] }, run)), /^t1 is condensed already\./);
  } finally { t.cleanup(); }
});

test('context.condense with a text of its own: an invented value or a text about something else is refused, the item stays', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    const { run } = runOf(t);
    assert.match(String(await tool('context.condense').run({ texts: { t2: 'took 999 seconds' } }, run)), /^t2 not condensed: it names values the original lacks: 999\./);
    assert.match(String(await tool('context.condense').run({ texts: { t2: 'Objektiv denken, Probleme möglichst selbst lösen, wirklich alles probieren, danach melden.' } }, run)), /^t2 not condensed: it is about something else/);
    assert.equal(t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === 't2')!.state, 'keep');
    assert.match(String(await tool('context.condense').run({ texts: { t2: 'build 2 finished in 402 seconds' } }, run)), /^condensed t2/);
  } finally { t.cleanup(); }
});

test('a flow: a restore reaches the main AI as a real call with the answer, also when the run is cut off after it, and stays pinned for it', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
    const hide = (ids: string[]) => t.ledger.mark(t.tom.id, 'main', ids.map((itemId) => ({ itemId, state: 'hidden' as const, reason: 'old', by: 'subconscious' as const })));
    const flow = (steps: Parameters<typeof scripted>[0], maxSteps = 4) => runFlow(t.services, scripted(steps).runner, { agent: t.tom, conversationId: t.chat.id, thread: 'main', maxSteps });
    hide(['t1']);
    const cut = await flow([{ tool: 'context.restore', args: { ids: ['t1'] } }, { tool: 'context.list' }], 2);
    assert.equal(cut.end, 'steps');
    assert.deepEqual(cut.trace.calls.map((call) => call.tool), ['context.restore']);
    hide(['t1']);
    const shown = await flow([{ tool: 'context.restore', args: { ids: ['t1'] } }, { tool: 'done', args: { answer: 'Wieder da.' } }]);
    assert.deepEqual(shown.trace.calls.map((call) => [call.tool, call.args]), [['context.restore', { ids: ['t1'] }]]);
    assert.match(shown.trace.calls[0].output, /build 1 finished in 401 seconds/);
    assert.match(shown.answer, /^Wieder da\.\n\nRestored t1/);
    assert.notEqual(t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === 't1')!.pinnedUntil, undefined);
  } finally { t.cleanup(); }
});

test('asked: the restore is what the main AI wanted, its originals are the call\'s output', async () => {
  const t = ledgerSetup();
  try {
    fourTurns(t);
    t.ledger.mark(t.tom.id, 'main', [{ itemId: 't1', state: 'hidden', reason: 'old', by: 'subconscious' }]);
    const { run, shown } = runOf(t);
    assert.match(String(await tool('context.restore').run({ ids: ['t1'] }, run)), /^Restored t1/);
    assert.equal(shown[0].tool, 'context.restore');
    assert.match(shown[0].output, /build 1 finished in 401 seconds/);
  } finally { t.cleanup(); }
});

test('context.read pages through a long original', async () => {
  const t = ledgerSetup();
  try {
    const first = t.turn(t.say('Long one please, with some words.').seq);
    t.ourCall(first, 'shell.exec', { command: 'long' }, `${'a'.repeat(3600)}${'b'.repeat(100)}`, 'c1');
    t.done(first);
    const { run } = runOf(t);
    const head = String(await tool('context.read').run({ id: 't1' }, run));
    assert.match(head, /\[… 100 more characters, from 3600\]$/);
    assert.doesNotMatch(head, /b/);
    const rest = String(await tool('context.read').run({ id: 't1', from: 3600 }, run));
    assert.match(rest, /b{100}$/);
    assert.doesNotMatch(rest, /more characters/);
  } finally { t.cleanup(); }
});

test('a rebuild keeps an engine\'s own output as the model saw it; ours stays at the model\'s own cap', async () => {
  const t = ledgerSetup();
  try {
    const runId = t.turn(t.say('Read the long file, with some words.').seq);
    const own = `${'x'.repeat(39_000)}THE END`;
    t.journal.item(runId, { kind: 'tool_call', name: 'exec', data: { callId: 'c_own', own: true, args: JSON.stringify({ source: 'text(1)' }), summary: 'Ran a command' }, effectStatus: 'none' });
    t.journal.item(runId, { kind: 'tool_result', data: { callId: 'c_own', ok: true, summary: 'done', output: own }, effectStatus: 'none' });
    t.ourCall(runId, 'files.read', { path: 'big' }, 'y'.repeat(30_000), 'c_ours');
    t.done(runId);
    await t.journal.settled();
    const view = t.ledger.view(t.tom.id, 'main');
    const native = view.find((entry) => entry.call?.callId === 'c_own')!;
    assert.equal(native.call?.output, own, 'no cut and no note in an item nobody marked');
    const ours = view.find((entry) => entry.call?.callId === 'c_ours')!;
    assert.match(ours.call?.output ?? '', /output cut for context/);
  } finally { t.cleanup(); }
});
