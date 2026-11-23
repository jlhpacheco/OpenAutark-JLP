// KI-Runde 17.11.2026 – the context fold from trigger to rebuilt session (agents/context-fold.ts, compaction-policy.ts,
// context/ledger/service.ts fold, agents/rebuild.ts why 'fold', agents/boundary.ts): the real executor over the real chat store,
// run journal and context ledger with a recording engine (rebuild-harness.ts).
//   1. a turn that finished a task ends at 150,000 tokens → its outcome says fold: 'step';
//   2. the fold's turn resumes the same session at effort high with the note as its whole input; its closing text becomes the
//      pinned hand-over with my quests as they stand under it (Quests round 20.11.2026), everything of my own work before it is
//      hidden by 'fold' (the chat line and the tasks.update call that finished the task stay),
//      the session is marked folded, nothing is posted;
//   3. the next turn starts the session anew from the folded record (why 'fold') and the mark is gone.
// And what must not happen: a fold that failed, was stopped or wrote no hand-over marks nothing; a part, a call's turn, a fold's
// own turn and a session folded already never trigger one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_THREAD } from '../../../src/shared/model/origin.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { journalResult } from '../../../src/runtime/tools/journal.ts';
import { boundaryOf } from '../../../src/runtime/agents/boundary.ts';
import { FOLD_NOTE, FOLD_QUESTS, foldNote, planFold, wantsFold } from '../../../src/runtime/agents/context-fold.ts';
import { resolveMode } from '../../../src/runtime/agents/turn-prepare.ts';
import { effortKeepsCache } from '../../../src/runtime/subconscious/route-turn.ts';
import { FOLD_IDLE, FOLD_MIN_CHARS, FOLD_STEP, foldWhy, type FoldWhy } from '../../../src/runtime/agents/compaction-policy.ts';
import { CACHE_COLD_MS } from '../../../src/runtime/agents/compaction-policy.ts';
import type { EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { TurnOutcome, TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import { ENDED, setup, textOf } from './rebuild-harness.ts';
import { resetRebuildMemory } from '../../../src/runtime/agents/rebuild.ts';

const HAND_OVER = [
  'I am building the customer export for Alex (task tsk_export, finished and accepted).',
  'Decided: CSV with a header row, UTF-8 with BOM, one row per customer – Alex opens it in Excel.',
  'Files: out/export.csv (500 rows), the script scripts/export.mjs; the run command is `npm run export`.',
  'Promised: I tell Alex in our chat when the import side is ready.',
  'Next: the import (read out/export.csv back, check the row count against 500).',
].join('\n');

/** The rebuild harness with the real context ledger in place of its fake, wired as compose/services.ts does. */
function world() {
  const h = setup();
  const ledger = new ContextLedgerService({ services: () => h.s });
  h.s.ledger = ledger;
  const stop = ledger.start();
  let runs = 0;
  /** The fold's turn, as the dispatcher starts it (dispatch-runs.ts fold): no chat, no task, no notes. */
  const fold = (why: FoldWhy, signal = new AbortController().signal): Promise<TurnOutcome> => new TurnExecutor(() => h.s).execute({
    runId: `run_fold_${++runs}`, agentId: h.agent.id, reason: 'fold', fold: why, notes: [], signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  const items = () => ledger.items(h.agent.id, MAIN_THREAD);
  return { ...h, ledger, fold, items, lastFold: () => `run_fold_${runs}`, cleanup: stop };
}

/** A turn of work as the engine reports it: a native read with its output, a finished task (journaled like the registry does), a size. */
function working(h: ReturnType<typeof world>, tokens: number, finish = true): (input: EngineTurnInput) => Partial<EngineTurnResult> {
  return (input) => {
    // 0.3.19: the big native output is a Read of the export – a Claude agent turn has no native Bash any more (a Bash row is legacy, withheld).
    input.onEvent({ type: 'tool_start', callId: 'sh1', name: 'Read', args: { file_path: 'out/export.csv' }, own: true });
    input.onEvent({ type: 'tool_end', callId: 'sh1', ok: true, summary: 'read 501 lines', output: `export written to out/export.csv\n${'row\n'.repeat(500)}` });
    if (finish) {
      const task = h.s.tasks.create({ title: 'Customer export', assigneeKind: 'agent', assigneeId: h.agent.id, createdBy: 'human' });
      const args = { id: task.id, status: 'done', result: 'Export written: 500 rows' };
      input.onEvent({ type: 'tool_start', callId: 'fin1', name: 'tasks.update', args, own: false });
      h.s.runs.item(input.runId, { kind: 'tool_call', name: 'tasks.update', data: { callId: 'fin1', args: JSON.stringify(args), summary: 'Finished the export' }, effectStatus: 'none', idemKey: `${input.runId}:fin1` });
      h.s.tasks.finish(task.id, { status: 'done', summary: 'Export written: 500 rows' }, h.agent.id);
      journalResult(h.s, input.runId, 'tasks.update', 'fin1', `${input.runId}:fin1`, { content: [{ type: 'text', text: 'Task done.' }] }, []);
      input.onEvent({ type: 'tool_end', callId: 'fin1', ok: true, summary: 'Task done.' });
    }
    return { text: 'The export is written.', contextTokens: tokens };
  };
}

test('the fold from trigger to rebuilt session: a finished task at 150,000 tokens → the hand-over turn → the next turn starts from it', async () => {
  const h = world();
  try {
    // 1. the turn that ends the piece of work
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    const worked = await h.turn('claude');
    assert.equal(worked.status, 'done');
    assert.equal(worked.fold, 'step', 'a task was finished in it and the engine counts 150,000 ≥ FOLD_STEP');
    assert.deepEqual(boundaryOf(h.s, h.agent.id, MAIN_THREAD), { at: false, on: { engine: 'claude', modelId: 'claude:opus', accountId: 'acc_claude' } }, 'a warm session: no boundary yet');
    const before = h.items();
    assert.deepEqual(before.map((item) => [item.kind, item.state]), [['message', 'keep'], ['tool', 'keep'], ['tool', 'keep'], ['assistant', 'keep']], 'the line, the read, the tasks.update call that finished it, my closing words');
    const open = h.s.tasks.create({ title: 'Read the export back', assigneeKind: 'agent', assigneeId: h.agent.id, createdBy: 'human' });
    const posted = h.chats.messages(h.chat.id, { limit: 50 }).length;
    h.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, 0)', ['repair_notes', `${h.agent.id}:${MAIN_THREAD}`, JSON.stringify(['A block of mine was not posted.'])]);

    // 2. the fold's turn: the same session, the same model, effort raised to high, the note as its whole input
    let asked: EngineTurnInput | undefined;
    h.claude.state.reply = (input) => { asked = input; return { text: HAND_OVER, contextTokens: 151_000 }; };
    const folded = await h.fold(worked.fold!);
    assert.equal(folded.status, 'done');
    assert.equal(folded.fold, undefined, 'a fold\'s own turn never asks for another');
    assert.deepEqual(asked!.session, { ref: 'claude-s1', generation: 1, contextTokens: 150_000 }, 'the session resumed as it stands, with its own count (a Codex repeat of its last usage is known by it)');
    assert.equal(effortKeepsCache('claude', 'claude:opus'), false);
    assert.equal(asked!.effort, 'medium', 'this model writes its whole context again at another effort, so the fold keeps the turn\'s effort');
    assert.equal(asked!.model, h.claude.calls[0].model, 'the same model');
    assert.equal(asked!.system.stable, h.claude.calls[0].system.stable, 'the system text the session started with');
    assert.equal(asked!.system.volatile, '', 'no live block');
    assert.ok(/^\[note · [^\]]+\] /.test(textOf(asked)) && textOf(asked).endsWith(`] ${foldNote(150_000)}`), 'one note under the label every note carries, nothing else – not even the repair note that waits');
    assert.match(textOf(asked), /my context holds 150,000 tokens/);
    assert.equal(h.claude.rebuilds.length, 0, 'nothing is rebuilt for the fold\'s turn');

    const run = h.s.runs.get(h.lastFold())!;
    assert.deepEqual([run.trigger, run.status, run.effort, run.model, run.route?.by, run.conversationId], ['fold', 'done', 'medium', 'claude:opus', 'request', undefined], 'a run of its own, journaled; its effort is nobody\'s to return to');
    assert.equal(h.chats.messages(h.chat.id, { limit: 50 }).length, posted, 'nothing of it reaches a chat');

    const after = h.items();
    const checkpoint = after.find((item) => item.kind === 'checkpoint')!;
    assert.ok(checkpoint.itemId.startsWith('c') && checkpoint.pinnedUntil === Number.MAX_SAFE_INTEGER, 'the hand-over: an item of its own kind, pinned for good');
    const handOver = h.ledger.original(h.agent.id, MAIN_THREAD, checkpoint.itemId)?.text ?? '';
    assert.ok(handOver.startsWith(`${HAND_OVER}\n\n${FOLD_QUESTS}\n`), handOver);
    assert.match(handOver, new RegExp(`\n- ${open.id} · open since [^\n]+ · Read the export back$`), 'an open ask stands in the hand-over as data, whatever I wrote');
    const state = (kind: string, title: RegExp) => after.find((item) => item.kind === kind && title.test(item.title))!;
    assert.deepEqual([state('tool', /^Read/).state, state('tool', /^Read/).markedBy], ['hidden', 'fold'], 'the read and its output: hidden by the fold');
    assert.equal(state('assistant', /export is written/).state, 'keep', 'the words I posted in the chat stay in view, under the chat lines\' reach');
    assert.equal(state('tool', /^tasks\.update/).state, 'keep', 'the tasks.update call that finished the task stays: its arguments are the result');
    assert.equal(after.find((item) => item.kind === 'message')!.state, 'keep', 'chat lines follow their own reach rule');
    const noted = h.notes(h.lastFold()).find((note) => note.fold)!;
    assert.deepEqual(noted, { fold: 'step', before: 150_000, hidden: 1, checkpoint: [checkpoint.itemId] });
    assert.ok(h.binding('claude')!.foldedAt !== undefined, 'the session is marked folded');
    assert.deepEqual(boundaryOf(h.s, h.agent.id, MAIN_THREAD), { at: true, why: 'fold', on: { engine: 'claude', modelId: 'claude:opus', accountId: 'acc_claude' } }, 'a boundary: the session starts anew anyway');
    // every hidden item comes back like any hidden item
    assert.match(h.ledger.original(h.agent.id, MAIN_THREAD, state('tool', /^Read/).itemId)!.text, /export written to out\/export\.csv/);

    // 3. the next turn: the session starts anew from the folded record
    h.claude.state.reply = () => ({ contextTokens: 30_000 });
    h.send('And now the import');
    const next = await h.turn('claude');
    assert.equal(next.fold, undefined);
    assert.equal(h.claude.rebuilds.length, 1, 'rebuilt once');
    const rebuilt = h.claude.rebuilds[0];
    assert.deepEqual(rebuilt.items.map((item) => item.kind), ['m', 't', 't', 'a', 'c'], 'the line, the finishing tasks.update call, the call naming what is hidden, my posted words, the hand-over');
    assert.equal(rebuilt.items[1].call?.name, 'tasks.update');
    assert.match(rebuilt.items[2].call?.output ?? '', /^My context, kept small: hidden /);
    assert.equal(rebuilt.items[3].text, 'The export is written.');
    assert.equal(rebuilt.items[4].text, handOver, 'shown in full');
    assert.equal(rebuilt.generation, 2);
    const turn = h.claude.calls.at(-1)!;
    assert.equal(turn.session?.ref, 'claude-r1', 'the turn runs on the rebuilt session');
    assert.match(textOf(turn), /And now the import/);
    assert.match(textOf(turn), /A block of mine was not posted\./, 'the repair note the fold left waiting arrives now');
    assert.equal(h.notes('run_2').find((note) => note.rebuild)?.why, 'fold');
    assert.equal(h.binding('claude')!.foldedAt, undefined, 'the new generation is not folded');
    assert.deepEqual(boundaryOf(h.s, h.agent.id, MAIN_THREAD), { at: false, on: { engine: 'claude', modelId: 'claude:opus', accountId: 'acc_claude' } });
    assert.ok(h.items().find((item) => item.kind === 'checkpoint')!.pinnedUntil !== undefined, 'the hand-over stays pinned');
  } finally { h.cleanup(); }
});

test('a fold turn that fails, is stopped or writes no hand-over marks nothing – the session stays as it is and the next trigger asks again', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 260_000, false);
    const worked = await h.turn('claude');
    assert.equal(worked.fold, 'size', 'no task finished, but 260,000 ≥ FOLD_IDLE');
    h.store.save({ ...h.binding('claude')!, contextWindow: 1_000_000 }); // the window Claude Code reports: 260,000 is far inside its fit
    const untouched = () => {
      assert.ok(h.items().every((item) => item.state === 'keep' && item.kind !== 'checkpoint'), 'nothing hidden, no hand-over');
      assert.equal(h.binding('claude')!.foldedAt, undefined);
      assert.equal(boundaryOf(h.s, h.agent.id, MAIN_THREAD).at, false);
    };

    h.claude.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'model error' } });
    assert.equal((await h.fold('size')).status, 'failed');
    untouched();
    assert.equal(h.chats.messages(h.chat.id, { limit: 50 }).some((message) => message.state === 'failed'), false, 'a failed fold leaves no bubble');

    // a usage limit or a session the engine ended: no failover onto another route and no renewal – the fold is not retried
    const asked = () => h.claude.calls.length + h.codex.calls.length;
    let before = asked();
    // (an older session of my main thread on Codex, and a router that would send a failover there)
    h.store.save({ agentId: h.agent.id, conversationId: MAIN_THREAD, engine: 'codex', accountId: 'acc_codex', ref: 'codex-old', generation: 1, cursorSeq: 0, model: 'codex:sol', updatedAt: 0 });
    const router = h.s.router;
    h.s.router = { ...router, route: async () => ({ modelId: 'codex:sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] }) } as typeof router;
    h.claude.state.reply = () => ({ text: '', stop: 'limit', error: { code: 'rate_limited', message: 'usage limit reached' } });
    assert.notEqual((await h.fold('size')).status, 'done');
    assert.equal(asked(), before + 1, 'one call, on the session it folds – no other account or engine');
    assert.equal(h.codex.calls.length, 0, 'the stale Codex session writes no hand-over');
    untouched();
    h.s.router = router;
    h.store.remove(h.agent.id, MAIN_THREAD, 'codex');
    before = asked();
    const standing = h.binding('claude')!;
    h.claude.state.reply = () => ENDED;
    assert.notEqual((await h.fold('size')).status, 'done');
    assert.equal(asked(), before + 1, 'no renewal retry: a renewed session would hold nothing to fold');
    assert.ok(!h.notes(h.lastFold()).some((note) => note.sessionRenewed), 'not renewed');
    assert.equal(h.binding('claude'), undefined, 'the engine ended that session: the next turn starts anew from the ledger');
    assert.ok(h.items().every((item) => item.state === 'keep' && item.kind !== 'checkpoint'), 'nothing hidden, no hand-over');
    h.store.save(standing); // as if it had not ended, for the rest of this story

    const stopped = new AbortController();
    h.claude.state.reply = () => { stopped.abort(); return { text: HAND_OVER.slice(0, 200), stop: 'interrupted' }; };
    assert.equal((await h.fold('size', stopped.signal)).status, 'interrupted');
    untouched();

    h.claude.state.reply = () => ({ text: 'Understood, I will write it down later.', contextTokens: 261_000 });
    assert.equal((await h.fold('size')).status, 'done');
    untouched();
    assert.deepEqual(h.notes(h.lastFold()).find((note) => note.fold), { fold: 'kept', why: 'size', reason: 'no hand-over written' });
    assert.ok('Understood, I will write it down later.'.length < FOLD_MIN_CHARS);

    // the next turn's end asks again, and a fold that then succeeds is not asked for twice
    h.claude.state.reply = () => ({ contextTokens: 262_000 });
    h.send('Anything else?');
    assert.equal((await h.turn('claude')).fold, 'size');
    h.claude.state.reply = () => ({ text: HAND_OVER, contextTokens: 263_000 });
    assert.equal((await h.fold('size')).status, 'done');
    assert.ok(h.binding('claude')!.foldedAt !== undefined);
    // the rebuild cannot run (the engine refuses): the session goes on as it is, and the mark goes with the rebuild that did
    // not run – no boundary while rebuilds are blocked, and no fold that nothing would replay
    h.claude.state.fail = 'refused';
    h.claude.state.reply = () => ({ contextTokens: 300_000 });
    h.send('Go on');
    const kept = await h.turn('claude');
    assert.equal(h.notes('run_3').find((note) => note.rebuild)?.rebuild, 'fallback');
    assert.equal(h.claude.calls.at(-1)?.session?.ref, 'claude-s1');
    assert.equal(h.binding('claude')!.foldedAt, undefined, 'the folded mark never outlives its rebuild');
    assert.deepEqual(boundaryOf(h.s, h.agent.id, MAIN_THREAD).at, false, 'blocked rebuilds: the warm session is no boundary');
    h.store.folded(h.agent.id, MAIN_THREAD, 'claude', h.s.clock.now());
    assert.equal(boundaryOf(h.s, h.agent.id, MAIN_THREAD).at, false, 'not even with a fold mark: while rebuilds are blocked nothing starts the session anew');
    h.send('Still there?');
    assert.equal((await h.turn('claude')).fold, undefined);
    assert.equal(h.binding('claude')!.foldedAt, undefined, 'a blocked rebuild takes the mark with it too');
    assert.equal(kept.fold, undefined, 'while rebuilds are blocked a fold would only cost its turn');
    // once the block is over the size asks for a fold again (the hand-over's hides ride on the next rebuild that runs)
    resetRebuildMemory();
    delete h.claude.state.fail;
    h.claude.state.reply = () => ({ contextTokens: 310_000 });
    h.send('And on');
    assert.equal((await h.turn('claude')).fold, 'size', 'a later fold can start');
  } finally { h.cleanup(); }
});

test('the trigger: a part, a call\'s turn, a fold\'s own turn, a turn that did not end done and an engine that cannot start a session anew never ask for a fold', async () => {
  const h = world();
  try {
    h.send('Hello');
    h.claude.state.reply = () => ({ contextTokens: 400_000 });
    assert.equal((await h.turn('claude')).fold, 'size');
    const plan = { agent: h.agent, thread: MAIN_THREAD } as unknown as TurnPlan;
    const turn = { engine: h.claude.engine };
    const done = { result: { text: '', stop: 'done' as const, session: { ref: 'claude-s1', generation: 1 } }, tools: [] };
    assert.equal(wantsFold(h.s, plan, turn, done), 'size');
    assert.equal(wantsFold(h.s, { ...plan, split: { splitId: 'sp_1' } } as unknown as TurnPlan, turn, done), undefined, 'a part never folds');
    assert.equal(wantsFold(h.s, { ...plan, callId: 'call_1' }, turn, done), undefined, 'not between the lines of a call');
    assert.equal(wantsFold(h.s, { ...plan, fold: { why: 'size' } } as unknown as TurnPlan, turn, done), undefined, 'not after a fold\'s own turn');
    assert.equal(wantsFold(h.s, plan, turn, { ...done, result: { ...done.result, stop: 'interrupted' } }), undefined, 'only a turn that ended done');
    assert.equal(wantsFold(h.s, plan, turn, { ...done, result: { text: '', stop: 'done' } }), undefined, 'not without a session to resume');
    const plain = { engine: { ...h.claude.engine, caps: { ...h.claude.engine.caps, rebuild: false } } } as typeof turn;
    assert.equal(wantsFold(h.s, plan, plain, done), undefined, 'an engine that cannot start a session from the ledger');

    // the sizes, in the engine's own count (the replay of 18.11.2026: 180,000 saves more than 250,000 did)
    assert.equal(FOLD_STEP, 120_000);
    assert.equal(FOLD_IDLE, 180_000);
    assert.equal(foldWhy({ tokens: 119_999, finishedTask: true, compacted: false }), undefined);
    assert.equal(foldWhy({ tokens: 120_000, finishedTask: true, compacted: false }), 'step');
    assert.equal(foldWhy({ tokens: 179_999, finishedTask: false, compacted: false }), undefined, 'without a finished task only the size counts');
    assert.equal(foldWhy({ tokens: 180_000, finishedTask: false, compacted: false }), 'size');
    assert.equal(foldWhy({ tokens: 40_000, finishedTask: false, compacted: true }), 'engine', 'the engine compacted by itself: at any size');
    assert.equal(foldWhy({ finishedTask: true, compacted: false }), undefined, 'no count, no fold');
    // a failed tasks.update call, or one that finished no task of mine in the run, is no finished task
    h.store.save({ ...h.binding('claude')!, contextTokens: 150_000 });
    assert.equal(wantsFold(h.s, plan, turn, { ...done, tools: [{ name: 'tasks.update', native: false, ok: false }] }), undefined);
    assert.equal(wantsFold(h.s, plan, turn, { ...done, tools: [{ name: 'tasks.update', native: false, ok: true }] }), undefined, 'an update that ended nothing');
    const ended = h.s.tasks.create({ title: 'Export', assigneeKind: 'agent', assigneeId: h.agent.id, createdBy: 'human' });
    h.s.tasks.finish(ended.id, { status: 'done', summary: 'Written' }, h.agent.id);
    assert.equal(wantsFold(h.s, plan, turn, { ...done, tools: [{ name: 'tasks.update', native: false, ok: true }] }), 'step');
    // the note is true for each cause – a finished step, the size alone, the engine's own compaction (which leaves a small
    // count): it says my turn is done and what my context holds, not that a piece of work ended or that it grew, and never 0 tokens
    assert.match(FOLD_NOTE, /\{\{size\}\}/, 'the note names the size');
    assert.doesNotMatch(foldNote(312_000), /\{\{/);
    assert.match(foldNote(312_000), /^My turn is done, and my context holds 312,000 tokens: I read all of it again on every step\./);
    assert.match(foldNote(52_000), /^My turn is done, and my context holds 52,000 tokens:/, 'after the engine compacted it');
    assert.match(foldNote(undefined), /^My turn is done, and my context holds all I read on the way: I read all of it again on every step\./);
    assert.doesNotMatch(FOLD_NOTE, /grown|piece of my work is done/);
    assert.doesNotMatch(foldNote(undefined), /0 tokens/);
    assert.match(FOLD_NOTE, /my chats with my own lines in them/, 'after the fold my own lines in my chats are in view again');
    assert.match(FOLD_NOTE, /an ask that is not done stays open in its quest, and my quests as they stand now are added under my hand-over/);
  } finally { h.cleanup(); }
});

test('the fold\'s effort: at least high where the model keeps its cache across one, else the last turn\'s', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    assert.equal((await h.turn('claude')).fold, 'step', 'the turn ran at medium');
    const plan = (modelId: string) => {
      h.store.save({ ...h.binding('claude')!, model: modelId });
      return planFold(h.s, { runId: 'run_x', agentId: h.agent.id, reason: 'fold', fold: 'step', notes: [], signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 } }, resolveMode);
    };
    assert.equal(effortKeepsCache('claude', 'claude:claude-opus-5-5'), true);
    assert.equal(plan('claude:claude-opus-5-5')?.fold?.route.effort, 'high', 'the raised effort is free there: a bit more thinking for the hand-over');
    assert.equal(plan('claude:opus')?.fold?.route.effort, 'medium', 'here another effort writes the whole context again – that would cost about 40 times the read');
  } finally { h.cleanup(); }
});

test('native compaction is journaled with the engine\'s own figures and asks for a fold at that turn\'s end, at any size', async () => {
  const h = world();
  try {
    h.send('Hello');
    h.claude.state.reply = (input) => {
      input.onEvent({ type: 'compacted', before: 971_204, after: 48_310, ms: 84_000 });
      return { text: 'Done.', contextTokens: 52_000, compacted: true };
    };
    const outcome = await h.turn('claude');
    assert.deepEqual(h.notes('run_1').find((note) => note.compacted), { compacted: 'engine', before: 971_204, after: 48_310, ms: 84_000 });
    assert.equal(outcome.fold, 'engine', '52,000 is below every size – the compaction itself is the reason');

    // the cause is kept until a fold ran: this one could not start (work was due), so the next turn's end asks again
    assert.ok(h.binding('claude')!.compactedAt !== undefined, 'the compaction stands on the binding');
    h.claude.state.reply = () => ({ text: 'And this.', contextTokens: 56_000 });
    h.send('One more thing');
    assert.equal((await h.turn('claude')).fold, 'engine', 'nothing compacted in this turn and 56,000 is small – the engine\'s compaction is still unanswered');
    h.claude.state.reply = () => ({ text: HAND_OVER, contextTokens: 57_000 });
    await h.fold('engine');
    assert.equal(h.binding('claude')!.compactedAt, undefined, 'the fold answered it');
    assert.ok(h.binding('claude')!.foldedAt !== undefined);
  } finally { h.cleanup(); }
});

test('a session that starts anew after resting past the cache keeps no fold mark it never had, and a folded one that rests is still a fold', async () => {
  const h = world();
  try {
    h.send('Hello');
    h.claude.state.reply = working(h, 260_000);
    await h.turn('claude');
    h.claude.state.reply = () => ({ text: HAND_OVER });
    await h.fold('size');
    h.clock.set(h.clock.now() + CACHE_COLD_MS + 1);
    assert.equal(boundaryOf(h.s, h.agent.id, MAIN_THREAD).why, 'fold', 'folded and cold: the fold is the reason');
    h.claude.state.reply = undefined;
    h.send('Later');
    await h.turn('claude');
    assert.equal(h.notes('run_2').find((note) => note.rebuild)?.why, 'fold');
    h.clock.set(h.clock.now() + CACHE_COLD_MS + 1);
    assert.equal(boundaryOf(h.s, h.agent.id, MAIN_THREAD).why, 'cold');
    assert.deepEqual(boundaryOf(h.s, 'ag_nobody', MAIN_THREAD), { at: true, why: 'no_session' });
  } finally { h.cleanup(); }
});

test('the hand-over\'s notes, its hides and the mark are one transaction: a fold that fails half-way leaves no hand-over beside the whole record', async () => {
  const h = world();
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    assert.equal((await h.turn('claude')).fold, 'step');
    h.ledger.fold = () => { throw new Error('disk I/O error'); };
    h.claude.state.reply = () => ({ text: HAND_OVER, contextTokens: 151_000 });
    assert.equal((await h.fold('step')).status, 'done');
    assert.deepEqual(h.notes(h.lastFold()).find((note) => note.fold), { fold: 'kept', why: 'step', reason: 'failed' });
    assert.equal(h.s.runs.items(h.lastFold()).some((item) => item.name === 'Hand-over'), false, 'no hand-over note stands in the journal');
    assert.ok(h.items().every((item) => item.kind !== 'checkpoint' && item.state === 'keep'), 'no checkpoint item, nothing hidden');
    assert.equal(h.binding('claude')!.foldedAt, undefined);
  } finally { h.cleanup(); }
});

// 0.3.19 (the masked engine shell): a fold resumes its session as it stands, so it asks the engine first whether that
// native session may still resume under the managed shell (foldNow → Engine.managedResume). One that may not – after a
// restart with no matching mark, say – drops the fold: no run that fails with "not there to resume", no turn on the session.
test('0.3.19: a fold whose native session may no longer resume is dropped before its turn; one that may runs as before', async () => {
  const h = world();
  const engine = h.claude.engine as { managedResume?: (account: unknown, ref: string) => Promise<boolean> };
  try {
    h.send('Please build the export');
    h.claude.state.reply = working(h, 150_000);
    const worked = await h.turn('claude');
    assert.equal(worked.fold, 'step');
    const asked: string[] = [];
    engine.managedResume = async (_account, ref) => { asked.push(ref); return false; };
    const calls = h.claude.calls.length;
    const dropped = await h.fold(worked.fold!);
    assert.equal(dropped.status, 'skipped', 'dropped, not failed');
    assert.deepEqual(asked, ['claude-s1'], 'the bound session was asked about');
    assert.equal(h.claude.calls.length, calls, 'no turn on the session');
    assert.equal(h.s.runs.get(h.lastFold())?.status === 'failed', false, 'no failed run');
    assert.ok(h.items().every((item) => item.kind !== 'checkpoint'), 'nothing folded');

    engine.managedResume = async () => true;
    h.claude.state.reply = () => ({ text: HAND_OVER, contextTokens: 151_000 });
    assert.equal((await h.fold(worked.fold!)).status, 'done', 'a session that may resume folds as before');
    assert.equal(h.claude.calls.length, calls + 1);
  } finally { delete engine.managedResume; h.cleanup(); }
});
