// KI-Runde 17.11.2026, after the second review (FIXES-2 C) – the seams of the context fold over the real executor, chat store,
// run journal and context ledger (rebuild-harness.ts, wired as context-fold.test.ts wires it):
//   - the fold turn's run carries the stand-in mark of the turn before it (r2-4 #1);
//   - the engine's compaction is recorded for every main-lane turn it happens in, whatever its end (r2-3 #7, r2-4 #8);
//   - a fold whose rebuild falls back (a failed probe) holds further folds back as a refusal does (r2-3 #4);
//   - lines I posted through a block in mid-turn commentary stay in view through a fold (r2-3 #3);
//   - at my first fold only the finishing tasks.update calls of the run that just ended stay (r2-3 #11);
//   - a cut fold leaves no words of mine in the record, and its session's next turn hears nothing was folded (r2-3 #10);
//   - a fold on a session from before the start record keeps the session's own key (r2-4 #9);
//   - the fold and compaction marks belong to one session ref (r2-4 #7);
//   - a call another linked PC runs in one of my chats holds the fold back (r2-4 #11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_THREAD } from '../../../src/shared/model/origin.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { journalResult } from '../../../src/runtime/tools/journal.ts';
import { FOLD_CUT_NOTE, foldWaitsFor, wantsFold } from '../../../src/runtime/agents/context-fold.ts';
import { rebuildBlocked } from '../../../src/runtime/agents/rebuild.ts';
import { SESSION_START_NS } from '../../../src/runtime/agents/session-key.ts';
import type { FoldWhy } from '../../../src/runtime/agents/compaction-policy.ts';
import type { EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { TurnOutcome, TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import { setup, textOf } from './rebuild-harness.ts';

const HAND_OVER = [
  'I am building the customer export for Alex (task tsk_export, finished and accepted).',
  'Decided: CSV with a header row, UTF-8 with BOM, one row per customer.',
  'Files: out/export.csv (500 rows), scripts/export.mjs; run with `npm run export`.',
  'Promised: I tell Alex in our chat when the import side is ready, and I keep the header row as he asked for it.',
  'Next: the import (read out/export.csv back, check the row count against 500).',
].join('\n');

function world() {
  const h = setup();
  const ledger = new ContextLedgerService({ services: () => h.s });
  h.s.ledger = ledger;
  const stop = ledger.start();
  let runs = 0;
  const fold = (why: FoldWhy, signal = new AbortController().signal): Promise<TurnOutcome> => new TurnExecutor(() => h.s).execute({
    runId: `run_fold_${++runs}`, agentId: h.agent.id, reason: 'fold', fold: why, notes: [], signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  const items = () => ledger.items(h.agent.id, MAIN_THREAD);
  return { ...h, ledger, fold, items, lastFold: () => `run_fold_${runs}`, cleanup: stop };
}

/** A turn of work: a shell call and a finished task (journaled as the registry does), at `tokens`. */
function working(h: ReturnType<typeof world>, tokens: number): (input: EngineTurnInput) => Partial<EngineTurnResult> {
  return (input) => {
    input.onEvent({ type: 'tool_start', callId: 'sh1', name: 'Bash', args: { command: 'npm run export' }, own: true });
    input.onEvent({ type: 'tool_end', callId: 'sh1', ok: true, summary: 'exit 0', output: `export written\n${'row\n'.repeat(200)}` });
    const task = h.s.tasks.create({ title: 'Export', assigneeKind: 'agent', assigneeId: h.agent.id, createdBy: 'human' });
    const args = { id: task.id, status: 'done', result: `done in ${input.runId}` };
    input.onEvent({ type: 'tool_start', callId: 'fin1', name: 'tasks.update', args, own: false });
    h.s.runs.item(input.runId, { kind: 'tool_call', name: 'tasks.update', data: { callId: 'fin1', args: JSON.stringify(args), summary: 'Finished' }, effectStatus: 'none', idemKey: `${input.runId}:fin1` });
    h.s.tasks.finish(task.id, { status: 'done', summary: `done in ${input.runId}` }, h.agent.id);
    journalResult(h.s, input.runId, 'tasks.update', 'fin1', `${input.runId}:fin1`, { content: [{ type: 'text', text: 'Task done.' }] }, []);
    input.onEvent({ type: 'tool_end', callId: 'fin1', ok: true, summary: 'Task done.' });
    return { text: 'The export is written.', contextTokens: tokens };
  };
}

test('the fold turn\'s run carries the stand-in mark of the turn before it, so the next boundary still goes back', async () => {
  const h = world();
  try {
    const router = h.s.router;
    const standIn = { modelId: 'claude:opus', engine: 'claude', accountId: 'acc_claude', effort: 'medium', category: 'chat', reason: 'stands in', by: 'rules', alternatives: [], standIn: true } as RouteDecision;
    h.s.router = { ...router, route: async () => standIn } as typeof router;
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    assert.equal((await h.turn('claude')).fold, 'step');
    assert.equal(h.s.runs.get('run_1')?.route?.standIn, true);
    h.claude.state.reply = () => ({ text: HAND_OVER });
    assert.equal((await h.fold('step')).status, 'done');
    assert.ok(h.binding('claude')?.foldedAt !== undefined, 'folded');
    assert.equal(h.s.runs.get(h.lastFold())?.route?.standIn, true, 'the newest run on the model is the fold\'s: it says the model stands in');
  } finally { h.cleanup(); }
});

test('the engine\'s compaction is kept as the fold\'s cause after a failed turn and a call\'s turn too', async () => {
  const h = world();
  try {
    h.send('Hello');
    h.claude.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'model error' }, compacted: true, contextTokens: 40_000 });
    const failed = await h.turn('claude');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.fold, undefined, 'no fold after a turn that did not end done');
    assert.ok(h.binding('claude')?.compactedAt !== undefined, 'the compaction stands on the binding');
    h.claude.state.reply = () => ({ text: 'Done.', contextTokens: 42_000 });
    h.send('Next');
    assert.equal((await h.turn('claude')).fold, 'engine', 'the next done turn folds for it');

    // a call's turn: no fold between its lines, the cause is kept
    h.store.save({ ...h.binding('claude')!, ref: 'claude-s9', generation: 1 }); // another session: no mark
    assert.equal(h.binding('claude')?.compactedAt, undefined);
    const plan = { agent: h.agent, thread: MAIN_THREAD, callId: 'call_1' } as unknown as TurnPlan;
    const compacted = { result: { text: '', stop: 'done' as const, session: { ref: 'claude-s9', generation: 1 }, compacted: true }, tools: [] };
    assert.equal(wantsFold(h.s, plan, { engine: h.claude.engine }, compacted), undefined);
    assert.ok(h.binding('claude')?.compactedAt !== undefined, 'kept for a later turn');
  } finally { h.cleanup(); }
});

test('a fold whose rebuild falls back on a failed probe holds further folds back, as a refusal does', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    await h.turn('claude');
    h.claude.state.reply = () => ({ text: HAND_OVER, contextTokens: 151_000 });
    await h.fold('step');
    assert.ok(h.binding('claude')?.foldedAt !== undefined);
    h.claude.state.probe = { ok: false, reason: 'the CLI cannot replay' };
    h.claude.state.reply = () => ({ contextTokens: 300_000 });
    h.send('Go on');
    const kept = await h.turn('claude');
    assert.match(String(h.notes('run_2').find((note) => note.rebuild)?.reason), /^probe /);
    assert.equal(rebuildBlocked(h.s, h.agent.id, MAIN_THREAD, 'claude'), true);
    assert.equal(kept.fold, undefined, '300,000 tokens, but no fold that nothing would replay');
  } finally { h.cleanup(); }
});

test('a line I posted through a block in mid-turn commentary stays in view through the fold, like my closing words', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    const work = working(h, 150_000);
    h.claude.state.reply = (input) => {
      input.onEvent({ type: 'commentary', text: `Let me start. <chat to="${h.chat.id}">I start the export now, Alex.</chat>` });
      return work(input);
    };
    await h.turn('claude');
    assert.ok(h.chats.messages(h.chat.id, { limit: 50 }).some((message) => message.body === 'I start the export now, Alex.'), 'posted mid-turn');
    h.claude.state.reply = () => ({ text: HAND_OVER });
    await h.fold('step');
    assert.ok(h.binding('claude')?.foldedAt !== undefined, 'folded');
    assert.ok(h.items().some((item) => item.state === 'hidden' && item.markedBy === 'fold'), 'the fold hid my tool work');
    const mine = h.items().filter((item) => item.kind === 'assistant' && item.runId === 'run_1');
    assert.equal(mine.length, 2, 'the update and the closing words');
    assert.deepEqual(mine.map((item) => item.state), ['keep', 'keep']);
  } finally { h.cleanup(); }
});

test('at my first fold only the finishing tasks.update calls of the run that just ended stay', async () => {
  const h = world();
  try {
    h.send('Build the export');
    h.claude.state.reply = working(h, 50_000);
    assert.equal((await h.turn('claude')).fold, undefined);
    h.send('And the import');
    h.claude.state.reply = working(h, 150_000);
    assert.equal((await h.turn('claude')).fold, 'step');
    h.claude.state.reply = () => ({ text: HAND_OVER });
    await h.fold('step');
    assert.ok(h.binding('claude')?.foldedAt !== undefined, 'folded');
    const finishes = h.items().filter((item) => item.kind === 'tool' && /^tasks\.update/.test(item.title));
    assert.deepEqual(finishes.map((item) => [item.runId, item.state]), [['run_1', 'hidden'], ['run_2', 'keep']]);
  } finally { h.cleanup(); }
});

test('a cut fold leaves no words of mine in the record, and the session\'s next turn hears that nothing was folded', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    await h.turn('claude');
    const stopped = new AbortController();
    h.claude.state.reply = (input) => { input.onEvent({ type: 'text', delta: 'I am building the customer export for Alex' }); stopped.abort(); return { text: '', stop: 'interrupted' }; };
    assert.equal((await h.fold('step', stopped.signal)).status, 'interrupted');
    assert.equal(h.items().some((item) => item.runId === h.lastFold() && item.kind === 'assistant'), false, 'the partial hand-over is no answer of mine');
    assert.deepEqual(h.notes(h.lastFold()).find((note) => note.fold), { fold: 'kept', why: 'step', reason: 'cut', text: 'I am building the customer export for Alex' });
    h.claude.state.reply = () => ({ contextTokens: 151_000 });
    h.send('Next');
    await h.turn('claude');
    assert.ok(textOf(h.claude.calls.at(-1)).includes(FOLD_CUT_NOTE));
  } finally { h.cleanup(); }
});

test('a fold on a session from before the start record keeps the session\'s own key', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    await h.turn('claude');
    h.db.run('DELETE FROM kv WHERE ns = ?', [SESSION_START_NS]);
    h.store.save({ ...h.binding('claude')!, promptKey: 'key-of-an-older-prompt' });
    h.claude.state.reply = () => ({ text: HAND_OVER });
    assert.equal((await h.fold('step')).status, 'done');
    assert.ok(h.binding('claude')?.foldedAt !== undefined, 'folded');
    assert.equal(h.binding('claude')?.promptKey, 'key-of-an-older-prompt', 'its next turn still gets every current section once');
  } finally { h.cleanup(); }
});

test('the fold and compaction marks belong to one session: another ref at the same generation starts without them', () => {
  const h = world();
  try {
    const base = { agentId: h.agent.id, conversationId: MAIN_THREAD, engine: 'claude' as const, accountId: 'acc_claude', generation: 1, cursorSeq: 0, updatedAt: 1 };
    h.store.save({ ...base, ref: 'A' });
    h.store.compacted(h.agent.id, MAIN_THREAD, 'claude', 10);
    h.store.save({ ...base, ref: 'A', updatedAt: 2 });
    assert.equal(h.binding('claude')?.compactedAt, 10, 'a save of the same session keeps it');
    h.store.save({ ...base, ref: 'B', updatedAt: 3 });
    assert.equal(h.binding('claude')?.compactedAt, undefined, 'a fresh session at generation 1 inherits nothing');
    h.store.folded(h.agent.id, MAIN_THREAD, 'claude', 20);
    h.store.save({ ...base, ref: 'C', updatedAt: 4 });
    assert.equal(h.binding('claude')?.foldedAt, undefined);
  } finally { h.cleanup(); }
});

test('a call another linked PC runs in one of my chats holds the fold back while something is said in it', () => {
  const h = world();
  try {
    const now = h.clock.now();
    const row = h.chats.send({
      conversationId: h.chat.id, body: 'Call', kind: 'status', silent: true, authorId: 'system', authorKind: 'system', mentions: [],
      meta: { status: { type: 'note', text: 'Call' }, call: { id: 'call_far', participant: 'device:phone', name: 'Phone', pc: 'dev_other_pc', startedAt: now, lines: [] } },
    } as Parameters<typeof h.chats.send>[0]);
    assert.ok(row);
    assert.equal(foldWaitsFor(h.s, h.agent.id), 'call');
    h.clock.set(now + 31 * 60 * 1000);
    assert.notEqual(foldWaitsFor(h.s, h.agent.id), 'call', 'a row nobody spoke in for half an hour holds nothing back');
  } finally { h.cleanup(); }
});
