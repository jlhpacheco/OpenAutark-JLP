// B-048 E2 (TRANSFER) – the executor's native rebuild over the real chat store, context service and run journal
// with two recording engines (caps.rebuild) and a fake context ledger: an engine switch rebuilds from the ledger and
// binds the new session (only new lines as input, the old binding superseded, ledger.rebuilt, run note); a failed
// rebuild or probe falls back to today's path with a run note; the probe is kept per CLI version; a rebuilt session
// that ends on its first turn falls back at once and blocks further rebuilds of that chat; marks land with the next rebuild
// that happens anyway, with the call naming what is marked; the view mapping (lines the delta carries stay out).
// B-080 (the part the session holds, the fit) and B-080 wave 3 (one token unit, the fallback memory) are in session-rebuild-b080.test.ts;
// the harness both use is rebuild-harness.ts.
// KI-Runde 17.11.2026: a session starts anew only where it does anyway (an engine switch, no session, a fold, past the fit, a cold
// cache) – marks ride on that rebuild and are no reason for one; the cases about marks and the revert path let the session rest
// past CACHE_COLD_MS; past the fit the engine's own count calibrates the room, and a record nothing brings under the limit
// renews the session with the record as text (the lean history is in rebuild-lean.test.ts, the fold in context-fold.test.ts).

import { PROJECTION } from '../../../src/runtime/context/projection.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../models/harness.ts';
import { SUPERSEDED_NS, type SupersededSession } from '../../../src/runtime/agents/sessions.ts';
import { PROBE_NS, PROBE_REV, probeFor, rebuildItems, withMarks } from '../../../src/runtime/agents/rebuild.ts';
import { CACHE_COLD_MS } from '../../../src/runtime/agents/compaction-policy.ts';
import { marksCall } from '../../../src/runtime/context/ledger/marks.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import type { EngineRebuildInput, RebuildProbe } from '../../../src/runtime/engines/types.ts';
import { ENDED, setup, textOf, view } from './rebuild-harness.ts';

test('switch: the turn on the other engine rebuilds its session from the ledger, binds it and sends only the new lines', async () => {
  const h = setup();
  h.send('Build the export');
  await h.turn('claude');
  const seen = h.cursor();
  h.ledgerState.view = view([
    [`m${seen}`, 'message', 'user', '[09:00] Alex: Build the export'],
    ['a1', 'assistant', 'assistant', 'Starting.'],
    ['t2', 'tool', 'tool', 'created tsk_1', { name: 'tasks.create', args: { title: 'Export' }, callId: 'toolu_1', output: 'created tsk_1' }],
  ]);
  h.send('Use CSV please');
  const outcome = await h.turn('codex');
  assert.equal(outcome.status, 'done');

  assert.equal(h.codex.rebuilds.length, 1);
  const rebuild = h.codex.rebuilds[0];
  assert.deepEqual(rebuild.items.map((item) => [item.itemId, item.kind, item.role]), [[`m${seen}`, 'm', 'user'], ['a1', 'a', 'assistant'], ['t2', 't', 'tool']]);
  assert.deepEqual(rebuild.items[2].call, { name: 'tasks.create', args: { title: 'Export' }, callId: 'toolu_1', output: 'created tsk_1' });
  assert.equal(rebuild.generation, 1);
  assert.equal(rebuild.system.stable.length > 0, true);
  assert.equal(h.codex.state.probes, 1, 'the probe ran once for this version');

  const input = h.codex.calls[0];
  // The rebuilt binding's own count goes with it. It follows the shipped prompt texts, whose PC section differs per
  // platform (584 on Windows, 501 on Linux on 23.11.2026), so the test holds the binding and a count in that range.
  const { contextTokens, ...binding } = input.session as { ref: string; generation: number; contextTokens: number };
  assert.deepEqual(binding, { ref: 'codex-r1', generation: 1 });
  assert.ok(Number.isInteger(contextTokens) && contextTokens > 300 && contextTokens < 2_000, `contextTokens ${contextTokens}`);
  assert.match(textOf(input), /Use CSV please/);
  assert.doesNotMatch(textOf(input), /Earlier messages:|Build the export/, 'no catch-up block: the history is native now');
  assert.equal(h.binding('codex')?.ref, 'codex-r1');
  assert.deepEqual(h.ledgerState.rebuilt, [3]);
  assert.deepEqual(h.notes('run_2').find((note) => note.rebuild), { rebuild: 'native', why: 'switch', engine: 'codex', items: 3, generation: 1, tokens: h.notes('run_2').find((note) => note.rebuild)!.tokens, from: 'claude' });

  // Back to Claude: its old session is superseded by a rebuilt one (generation 2), the probe is not repeated.
  h.send('Thanks');
  await h.turn('claude');
  assert.equal(h.claude.rebuilds.length, 1);
  assert.equal(h.claude.rebuilds[0].generation, 2);
  assert.equal(h.binding('claude')?.ref, 'claude-r1');
  const superseded = new KvRepo(h.db).list<SupersededSession>(SUPERSEDED_NS).map((entry) => entry.value.ref);
  assert.ok(superseded.includes('claude-s1'), 'the replaced Claude session is recorded for the sweep');
  h.send('Once more');
  await h.turn('claude');
  assert.equal(h.claude.rebuilds.length, 1, 'the same engine again resumes its session');
  assert.equal(h.claude.calls.at(-1)?.session?.ref, 'claude-r1');
});

test('fallback: a failed rebuild or probe keeps today\'s path and notes why; the probe result is kept per CLI version', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  h.codex.state.fail = 'thread/inject_items refused chunk 1: bad item';
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.calls[0].session, undefined, 'a fresh session with my record as text (13.11.2026: never a chat history)');
  assert.match(textOf(h.codex.calls[0]), new RegExp(`^${PROJECTION.history}[\\s\\S]*Hi there\\.[\\s\\S]*${PROJECTION.fresh}[\\s\\S]*Next`));
  assert.deepEqual(h.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'switch', reason: 'thread/inject_items refused chunk 1: bad item' });

  const p = setup();
  p.send('Hello');
  await p.turn('claude');
  p.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  p.codex.state.probe = { ok: false, reason: 'inject_items unsupported' };
  p.send('Next');
  await p.turn('codex');
  assert.equal(p.codex.rebuilds.length, 0);
  assert.deepEqual(p.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'switch', reason: 'probe 1.0.0: inject_items unsupported' });
  assert.equal(new KvRepo(p.db).get<RebuildProbe>(PROBE_NS, 'codex@1.0.0')?.ok, false);
  p.send('Again');
  await p.turn('claude');
  p.send('And again');
  await p.turn('codex');
  assert.equal(p.codex.state.probes, 1, 'a failed probe is not repeated within a day');
  p.codex.state.version = '1.1.0';
  p.codex.state.probe = {};
  p.send('New version');
  await p.turn('claude');
  await p.turn('codex');
  assert.equal(p.codex.state.probes, 2, 'a new CLI version is probed again');
  assert.equal(p.codex.rebuilds.length, 1);
});

test('a rebuild the engine refuses is not tried again every turn (each try starts and deletes a session)', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  let tries = 0;
  const rebuild = h.claude.engine.rebuild!.bind(h.claude.engine);
  h.claude.engine.rebuild = async (input) => { tries++; return rebuild(input); };
  h.claude.state.fail = 'refused';
  h.ledgerState.need = { since: 1, reason: '1 hidden', saves: 50_000 };
  h.clock.set(h.clock.now() + CACHE_COLD_MS + 1); // rested past the cache: the session would start anew
  h.send('One');
  await h.turn('claude');
  assert.equal(tries, 1);
  assert.deepEqual(h.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'cold', reason: 'refused' });
  h.clock.set(h.clock.now() + CACHE_COLD_MS + 1);
  h.send('Two');
  await h.turn('claude');
  h.clock.set(h.clock.now() + CACHE_COLD_MS + 1);
  h.send('Three');
  await h.turn('claude');
  assert.equal(tries, 1, 'the refusal does not start one more session each turn');
});

test('first-turn error: a rebuilt session that ends on its first turn falls back at once to my record as text and blocks rebuilds of that thread', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  h.codex.state.reply = (input) => (input.session?.ref === 'codex-r1' ? ENDED : undefined);
  h.send('Next');
  const outcome = await h.turn('codex');
  assert.equal(outcome.status, 'done');
  assert.equal(h.codex.calls.length, 2, 'one retry');
  assert.equal(h.codex.calls[0].session?.ref, 'codex-r1');
  assert.equal(h.codex.calls[1].session, undefined, 'the retry starts a fresh session');
  assert.ok(textOf(h.codex.calls[1]).startsWith(PROJECTION.history), 'with my record as text (13.11.2026: never a chat history)');
  assert.match(textOf(h.codex.calls[1]), new RegExp(`Hi there\\.[\\s\\S]*${PROJECTION.fresh}[\\s\\S]*Next`));
  const notes = h.notes('run_2');
  assert.ok(notes.some((note) => note.rebuild === 'fallback' && note.reason === 'first_turn_error'));
  assert.equal(h.codex.rebuilds.length, 1);

  h.send('Go on');
  await h.turn('claude');
  h.send('Codex again');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'no new rebuild of this chat on codex for a while');
});

test('backstop: an ended (overflowing) session is rebuilt from my record in its retry (13.11.2026: the context is never lost)', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Hi there.']]);
  h.claude.state.reply = (input) => (input.session?.ref === 'claude-s1' ? { ...ENDED, error: { code: 'conflict', message: 'The conversation is too long for this session.', details: { rebase: true } } } : undefined);
  h.send('Next');
  await h.turn('claude');
  assert.equal(h.claude.calls.length, 3);
  assert.equal(h.claude.rebuilds.length, 1, 'the retry rebuilds from the record');
  assert.equal(h.claude.calls[2].session?.ref, h.binding('claude')?.ref, 'and runs on the rebuilt session');
  assert.ok(h.notes('run_2').some((note) => note.rebuild === 'native' && note.why === 'no_session'));
});

test('marks ride on a rebuild that happens anyway: a warm session is never rebuilt for them, whatever they save; a cold one starts anew with them and the call naming what is marked', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer'], ['t2', 'tool', 'tool', 'short {"compacted":"t2"}', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'short' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'condensed', origin: {} }];
  // KI-Runde 17.11.2026: 110 warm rebuilds for savings took 11 % off and each paid a full cache write – a saving alone is no reason.
  h.ledgerState.need = { since: 2, reason: '1 condensed', saves: 500_000 };
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 0, 'warm: the marks wait, however much they would take off');
  assert.equal(h.codex.calls[1].session?.ref, 'codex-s1');
  assert.equal(h.notes('run_2').find((note) => note.rebuild), undefined, 'and no note about a rebuild that does not pay: nothing is weighed');

  h.clock.set(h.clock.now() + CACHE_COLD_MS + 1); // the cache is gone: the next call reads everything uncached either way
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'cold: the session starts anew with the marks');
  const items = h.codex.rebuilds[0].items;
  const said = 'My context, kept small: condensed t2 – get any back with tools.call {"name":"context.restore","args":{"ids":[…]}}.';
  assert.deepEqual(items.at(-1), { itemId: 'marks2', kind: 't', role: 'tool', text: said, call: { name: 'subconscious', args: {}, callId: 'call_context_marks_2', output: said } });
  assert.equal(h.codex.calls[2].session?.ref, 'codex-r1');
  assert.equal(h.notes('run_3').find((note) => note.rebuild)?.why, 'cold');

  // A cold session that already holds the record as the ledger has it: starting it anew would change nothing.
  h.ledgerState.need = undefined;
  h.clock.set(h.clock.now() + CACHE_COLD_MS + 1);
  h.send('Later');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1, 'nothing to land: it resumes');
  assert.equal(h.codex.calls[3].session?.ref, 'codex-r1');
});

test('past the fit of the window the session starts anew under the limit, with or without marks – the renewal is only the backstop', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  h.store.save({ ...h.binding('codex')!, contextTokens: 170_000 }); // B-080: past 80 % of the assumed 200k window (the catalog names none)
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer'], ['t2', 'tool', 'tool', 'kept', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'kept' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't3', kind: 'tool', order: 3, createdAt: 0, tokens: 5000, title: 'log', state: 'hidden', origin: {} }];
  h.ledgerState.need = { since: 3, reason: '1 hidden', saves: 5_000 };
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  assert.equal(h.codex.calls[1].session?.ref, 'codex-r1', 'the rebuilt session goes on');
  const fitted = h.notes('run_2').find((note) => note.rebuild)!;
  assert.equal(fitted.why, 'fit');
  assert.equal(fitted.live, 170_000, 'the note names the engine\'s own count that was past the fit');

  h.store.save({ ...h.binding('codex')!, contextTokens: 170_000 }); // B-080: past 80 % of the assumed 200k window (the catalog names none)
  h.ledgerState.need = undefined;
  h.ledgerState.marked = [];
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 2, 'nothing marked: the rebuild replays the part the session holds');
  assert.equal(h.codex.calls[2].session?.ref, 'codex-r2', 'no renewal: the work stays');
});

test('B-048 integration: a switch after marks were applied still names every condensed and hidden item (the new session has no other trace of them)', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  const seen = h.cursor();
  h.ledgerState.view = view([[`m${seen}`, 'message', 'user', '[09:00] Alex: Hello'], ['a3', 'assistant', 'assistant', 'Done.']]);
  h.ledgerState.marked = [
    { agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'hidden', origin: {} },
    { agentId: 'a', conversationId: 'c', itemId: 't4', kind: 'tool', order: 4, createdAt: 0, tokens: 900, title: 'build output', state: 'condensed', origin: {} },
  ];
  h.ledgerState.need = undefined; // applied by an earlier rebuild: nothing new to rebuild for
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  const items = h.codex.rebuilds[0].items;
  assert.deepEqual(items.map((item) => item.itemId), [`m${seen}`, 'marks0', 'a3'], 'the call sits in front of the closing words');
  assert.equal(items[1].call?.name, 'subconscious', 'the main AI\'s own tool: no call of a tool it lacks (q-r1b2 s15 went looking for context.hide)');
  assert.deepEqual(items[1].call?.args, {});
  assert.match(items[1].call?.output ?? '', /^My context, kept small: condensed t4; hidden t2 – get any back with tools\.call \{"name":"context\.restore"/, 'all marks, newest first');
});

test('trace: an engine that shows it natively gets the calls; one that cannot gets a tool-call-shaped block and a run note; both journal real calls', async () => {
  const h = setup();
  const trace = { calls: [{ tool: 'vector.search', args: { query: 'launch', in: ['memory'] }, output: 'memory/company/launch.md: Friday' }] };
  (h.s.subconscious as { beforeTurn?: unknown }).beforeTurn = async () => trace;
  h.send('When is the launch?');
  await h.turn('claude');
  const plain = h.claude.calls[0];
  assert.equal(plain.trace, undefined);
  assert.match((plain.input[0] as { text: string }).text, /^<tool_call name="vector\.search" args='\{"query":"launch","in":\["memory"\]\}'>\n<tool_output>\nmemory\/company\/launch\.md: Friday/);
  assert.ok(h.notes('run_1').some((note) => note.traceAsText === 'claude'));
  const items = h.s.runs.items('run_1');
  const call = items.find((item) => item.kind === 'tool_call' && item.name === 'vector.search')!;
  assert.equal(call.data.subconscious, true);
  const result = items.find((item) => item.kind === 'tool_result' && item.name === 'vector.search')!;
  assert.equal(result.data.callId, call.data.callId);

  (h.codex.engine.caps as { trace?: boolean }).trace = true;
  h.send('And the budget?');
  await h.turn('codex');
  assert.deepEqual(h.codex.calls.at(-1)!.trace, trace);
  assert.doesNotMatch(textOf(h.codex.calls.at(-1)), /tool_call/);
});

test('a fresh history from the projection carries the call naming what is marked there; a resumed session does not', async () => {
  const h = setup();
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 'm1', kind: 'message', order: 1, createdAt: 0, tokens: 90, title: 'Old line', state: 'hidden', origin: {} }];
  (h.codex.engine.caps as { trace?: boolean }).trace = true;
  h.send('Hello');
  await h.turn('codex');
  assert.deepEqual(h.codex.calls[0].trace?.calls.map((call) => call.tool), ['subconscious']);
  assert.match(h.codex.calls[0].trace?.calls[0].output ?? '', /^My context, kept small: hidden m1 – get any back with tools\.call \{"name":"context\.restore"/);
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.calls[1].trace, undefined);
});

test('view mapping: trailing person lines stay out – the history ends at the agent work; kinds become id letters', () => {
  const items = view([
    ['m3', 'message', 'user', 'first'], ['a1', 'assistant', 'assistant', 'answer'], ['r2', 'reasoning', 'assistant', 'thought'],
    ['m5', 'message', 'user', 'unanswered'], ['m6', 'message', 'user', 'also unanswered'], ['m9', 'message', 'user', 'not seen yet'],
  ]);
  const { items: out } = rebuildItems(items);
  assert.deepEqual(out.map((item) => `${item.itemId}:${item.kind}`), ['m3:m', 'a1:a', 'r2:r']);
  assert.equal(marksCall([{ itemId: 't9', state: 'hidden' }, { itemId: 'm240', state: 'condensed' }])?.output,
    'My context, kept small: condensed m240; hidden t9 – get any back with tools.call {"name":"context.restore","args":{"ids":[…]}}.');

  // The marks call goes in front of the agent's closing words, so the history still ends at its answer.
  const tidy = { itemId: 'marks2', kind: 't', role: 'tool' as const, text: 'x', call: { name: 'context.hide', args: {}, callId: 'c', output: 'x' } };
  const answered = rebuildItems(view([['m3', 'message', 'user', 'go'], ['t4', 'tool', 'tool', 'ok', { name: 'tasks.create', args: {}, callId: 'c4', output: 'ok' }], ['r5', 'reasoning', 'assistant', 'thought'], ['a6', 'assistant', 'assistant', 'Done.']])).items;
  assert.deepEqual(withMarks(answered, tidy).map((item) => item.itemId), ['m3', 't4', 'marks2', 'r5', 'a6']);
  assert.deepEqual(withMarks(answered.slice(0, 2), tidy).map((item) => item.itemId), ['m3', 't4', 'marks2'], 'no closing words: at the end');
  assert.equal(withMarks(answered, undefined), answered);
});

test('probe cache: per CLI version in kv, an unknown version only in memory, one probe at a time', async () => {
  const h = setup();
  const engine = h.codex.engine;
  const acc = account('acc_codex', 'codex');
  const [a, b] = await Promise.all([probeFor(h.s, engine, acc, '/ws'), probeFor(h.s, engine, acc, '/ws')]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(h.codex.state.probes, 1, 'concurrent callers share one probe');
  assert.ok(new KvRepo(h.db).get(PROBE_NS, 'codex@1.0.0'));
  (engine as unknown as { rebuildVersion: () => Promise<undefined> }).rebuildVersion = async () => undefined;
  await probeFor(h.s, engine, acc, '/ws');
  await probeFor(h.s, engine, acc, '/ws');
  assert.equal(h.codex.state.probes, 2);
  assert.equal(new KvRepo(h.db).get(PROBE_NS, 'codex@unknown'), undefined, 'an unknown version is not stored');
});

test('B-049 F6: a rebuild that keeps the session ref (a Codex revert) forgets what that session was sent – a failed first turn leaves no stale record', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  h.send('Next');
  await h.turn('codex');
  assert.ok(!h.codex.calls[1].system.volatile.includes('## My chats'), 'resumed: a delta');
  // Like CodexEngine.revert: the bound thread stays (same ref), cut before a recorded turn – the context blocks of the cut turns are gone.
  (h.codex.engine as { rebuild: (input: EngineRebuildInput) => Promise<unknown> }).rebuild = async (input) => {
    h.codex.rebuilds.push(input);
    return { ref: 'codex-s1', generation: input.generation, items: input.items.length };
  };
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer'], ['t2', 'tool', 'tool', 'short {"compacted":"t2"}', { name: 'shell', args: { command: 'npm i' }, callId: 'c1', output: 'short' }]]);
  h.ledgerState.marked = [{ agentId: 'a', conversationId: 'c', itemId: 't2', kind: 'tool', order: 2, createdAt: 0, tokens: 9000, title: 'npm install log', state: 'condensed', origin: {} }];
  h.ledgerState.need = { since: 2, reason: '1 condensed', saves: 20_000 };
  h.codex.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'model error' } });
  h.clock.set(h.clock.now() + CACHE_COLD_MS + 1); // B-089: rested past the cache – the marks rebuild runs
  h.send('More');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  const rebuiltTurn = h.codex.calls[2];
  assert.equal(rebuiltTurn.session?.ref, 'codex-s1');
  assert.ok(rebuiltTurn.system.volatile.includes('## My chats'), 'a rebuilt session gets every section');

  h.codex.state.reply = undefined;
  h.send('Again');
  await h.turn('codex');
  const next = h.codex.calls.at(-1)!;
  assert.equal(next.session?.ref, 'codex-s1', 'resumed, not rebuilt again');
  assert.equal(h.codex.rebuilds.length, 1);
  assert.ok(next.system.volatile.includes('## My chats') && next.system.volatile.includes('## Now'), next.system.volatile);
});

test('past the fit the engine\'s own count calibrates the fit: a record the estimate alone lets through is brought under the limit; a switch rebuilds whatever the size', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('codex');
  // A 200k window: the fit is 160,000 of Codex's own tokens, which hold 3.4 characters each (the ledger counts two). The engine
  // counts 176,000 in the session; the ledger estimates the record at 229,506 of its tokens plus the turn's prompt – 135,000 of
  // Codex's, so by the estimate alone it fits, and a rebuild that hid nothing would come back just as big (15.–17.11.2026: 63
  // such rebuilds wrote 48M tokens and 43 of them were still past the fit).
  h.store.save({ ...h.binding('codex')!, contextTokens: 176_000 });
  const big = (id: string) => [id, 'tool', 'tool', 'x'.repeat(153_000), { name: 'shell', args: {}, callId: id, output: 'x'.repeat(153_000) }] as const;
  h.ledgerState.view = view([[...big('t1')], [...big('t2')], [...big('t3')], ['a4', 'assistant', 'assistant', 'Done.']]);
  h.send('Next');
  await h.turn('codex');
  assert.equal(h.codex.rebuilds.length, 1);
  const notes = h.notes('run_2');
  const fit = notes.find((note) => note.fit)!.fit as { hidden: number; before: number; after: number; room: number };
  assert.equal(fit.hidden, 1, 'the oldest tool work goes: what the engine counts above the limit is taken off');
  assert.equal(fit.before, 229_506);
  assert.ok(fit.room < fit.before && fit.room >= 160_000 * 1.7 / 1.25 - 25_000, `${fit.room}: the room – the fit in the ledger's tokens – shrinks by the engine's count over the estimate, at most 1.25 times`);
  assert.deepEqual(h.codex.rebuilds[0].items.filter((item) => item.itemId !== 'marks1').map((item) => item.itemId), ['t2', 't3', 'a4']);
  const rebuilt = notes.find((note) => note.rebuild === 'native')!;
  assert.equal(rebuilt.why, 'fit');
  assert.equal(rebuilt.live, 176_000);
  assert.ok(Number(rebuilt.tokens) <= fit.room, 'the new session starts under the calibrated limit');

  // A record that nothing brings under the limit: no rebuild that would come back past the fit – the session is renewed with my record as text.
  const r = setup();
  r.send('Hello');
  await r.turn('codex');
  r.store.save({ ...r.binding('codex')!, contextTokens: 176_000 });
  r.ledgerState.view = view([['a1', 'assistant', 'assistant', 'y'.repeat(578_000)]]); // my own words alone, 170,000 of Codex's tokens: nothing the fit may hide
  r.send('Next');
  await r.turn('codex');
  assert.equal(r.codex.rebuilds.length, 0);
  assert.deepEqual(r.notes('run_2').find((note) => note.rebuild), { rebuild: 'fallback', why: 'fit', reason: 'too_large' });
  assert.ok(r.notes('run_2').some((note) => note.sessionRenewed === 'context'), 'renewed once');
  assert.equal(r.codex.calls[1].session, undefined);
  assert.match(textOf(r.codex.calls[1]), new RegExp(`^${PROJECTION.history}`), 'with my record as text');

  const s = setup();
  s.codex.state.reply = () => ({ contextTokens: 1_000 });
  s.send('Hello');
  await s.turn('codex');
  s.ledgerState.view = view([['a1', 'assistant', 'assistant', 'x'.repeat(60_000)]]);
  s.send('Next');
  await s.turn('claude');
  assert.equal(s.claude.rebuilds.length, 1, 'an engine switch rebuilds whatever the size');
  s.send('Back');
  await s.turn('codex');
  assert.equal(s.codex.rebuilds.length, 1, 'a switch back onto a small live Codex session rebuilds too');
});

test('B-049 F9: a probe kept before PROBE_REV runs once more; the kept one of this revision holds', async () => {
  const h = setup();
  const acc = account('acc_codex', 'codex');
  new KvRepo(h.db).set(PROBE_NS, 'codex@1.0.0', { version: '1.0.0', ok: true, at: 0 }, 0);
  await probeFor(h.s, h.codex.engine, acc, '/ws');
  await probeFor(h.s, h.codex.engine, acc, '/ws');
  assert.equal(h.codex.state.probes, 1, 'the old probe knew nothing of custom items');
  assert.equal(new KvRepo(h.db).get<{ rev?: number }>(PROBE_NS, 'codex@1.0.0')?.rev, PROBE_REV);
});
