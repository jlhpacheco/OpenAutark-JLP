// B-057 turn pipeline for splits (agents/split-turn.ts and its one-line hooks in turn-prepare, turn-attempt, turn-finish,
// turn.ts; context/split-section.ts in the volatile prompt): a split's turn runs on its thread split:<id>, never moves the
// parent's chat cursor or posts, stays internal, books its cost on the parent agent, gets the
// 'split' section; a person's message that suggested Ultra carries its note into the
// agent's own turn (no standing Ultra section, owner 30.10.2026); an agent's own turn gets its
// settled splits' results block, gathered only when it ends done; a split's first turn is seeded once. Real chats, run
// journal, context and turn executor; a recording engine, router and split service. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { ULTRA_NOTE } from '../../../src/runtime/context/split-section.ts';
import { NOTHING_BACK, turnEndedEarly } from '../../../src/runtime/agents/split-turn.ts';
import { TOLD_ITEM } from '../../../src/runtime/splits/results.ts';
import { recordStart, startOf } from '../../../src/runtime/agents/session-key.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { RouteRequest, RuntimeServices, SplitService } from '../../../src/runtime/contracts.ts';
import type { SplitRunEnd } from '../../../src/runtime/contracts/splits.ts';
import type { Engine, EngineCaps, EngineForkInput, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import type { TurnControl } from '../../../src/runtime/agents/turn-types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { SplitGroupView, SplitTurn, SplitView } from '../../../src/shared/model/splits.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(caps: Partial<EngineCaps> = {}) {
  const f = fixture();
  const s = f.services;
  const agentId = f.vid.id;
  const chat = f.chats.create({ title: 'Launch video', agentIds: [agentId], createdBy: 'human' });
  const inputs: EngineTurnInput[] = [];
  const state: { stop: EngineTurnResult['stop']; text?: string; costUsd?: number; sameRef?: boolean; onRun?: (input: EngineTurnInput) => Promise<unknown> } = { stop: 'done' };
  const toolCtxs: ToolContext[] = [];
  const engineCaps: EngineCaps = { sessions: false, dynamicTools: false, mcp: false, images: false, rebase: false, structured: false, ownTools: false, ...caps } as EngineCaps;
  const forks: EngineForkInput[] = [];
  const engine = {
    id: 'claude', caps: engineCaps,
    async fork(input: EngineForkInput) { forks.push(input); return { ref: `fork_${forks.length}`, generation: 1 }; },
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      inputs.push(input);
      await state.onRun?.(input);
      return {
        text: state.text ?? 'Part done: three cuts.', stop: state.stop, usage: { inputTokens: 100, outputTokens: 20, costUsd: state.costUsd ?? 0.12 },
        ...(state.stop === 'error' ? { error: { code: 'internal', message: 'boom' } } : {}),
        ...(engineCaps.sessions ? { session: { ref: state.sameRef && input.session ? input.session.ref : `sess_${inputs.length}`, generation: 1 } } : {}),
      } as EngineTurnResult;
    },
  } as unknown as Engine;
  const opus = { ...model('claude:opus', 'frontier', 'Claude Opus'), provider: 'anthropic' as const, engine: 'claude' as const, accounts: ['acc_api'] };
  const route: RouteDecision = { modelId: opus.id, engine: 'claude', accountId: 'acc_api', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const acc = account('acc_api', 'anthropic'); // pay-per-use: its charge is spend of the agent
  const routes: RouteRequest[] = [];
  const spends: Array<{ agentId: string; ref?: string }> = [];
  Object.assign(s, {
    router: { route: async (request: RouteRequest) => { routes.push(request); return route; } },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, markUnavailable: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => (id === opus.id ? opus : undefined), list: () => [opus] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async (_name: string, _args: unknown, ctx: ToolContext) => { toolCtxs.push(ctx); return { content: [{ type: 'text', text: 'ok' }] }; } },
  });
  Object.assign(s, { spend: { record: (input: { agentId: string; ref?: string }) => { spends.push({ agentId: input.agentId, ref: input.ref }); } } });

  // The parent's run that split (its model and effort are the parts' 'same').
  s.runs.start({ id: 'run_parent', agentId, conversationId: chat.id, trigger: 'message' });
  s.runs.finish('run_parent', { status: 'done', endedAt: f.clock.now(), model: opus.id, effort: 'high', engine: 'claude' });

  const view = (idx: number, title: string): SplitView => ({
    id: `sp_${idx}`, groupId: 'sg_1', agentId, idx, of: 3, title, brief: `Brief ${idx}`, context: 'brief', after: [], worktree: false,
    status: 'running', attempts: 1, createdAt: 0, runs: 0,
  });
  const group: SplitGroupView = {
    id: 'sg_1', agentId, parentRunId: 'run_parent', conversationId: chat.id, thread: chat.id, goal: 'Cut the launch video', ultra: false,
    status: 'running', parts: 3, createdAt: 0, splits: [view(1, 'Intro'), view(2, 'Middle section'), view(3, 'Outro')],
  };
  const calls = {
    ends: [] as Array<{ splitId: string; end: SplitRunEnd }>, gathered: [] as Array<{ runId: string; splitIds: string[] }>,
    after: [] as Array<{ runId: string; status: string }>, asked: [] as string[],
    pending: undefined as { splitIds: string[]; text: string } | undefined, askedRuns: [] as Array<string | undefined>,
  };
  s.splits = {
    get: (id: string) => { const split = group.splits.find((item) => item.id === id); return split ? { split, group } : undefined; },
    pendingResults: (_agentId: string, thread: string, runId?: string) => { calls.asked.push(thread); calls.askedRuns.push(runId); return calls.pending; },
    markGathered: (runId: string, splitIds: string[]) => { calls.gathered.push({ runId, splitIds }); },
    afterParentTurn: (runId: string, status: string) => { calls.after.push({ runId, status }); },
    onSplitRunEnd: (splitId: string, end: SplitRunEnd) => { calls.ends.push({ splitId, end }); },
  } as unknown as SplitService;


  const splitTurn = (extra: Partial<SplitTurn> = {}): SplitTurn => ({
    splitId: 'sp_2', groupId: 'sg_1', idx: 2, of: 3, title: 'Middle section', parentRunId: 'run_parent', parentThread: chat.id,
    parentConversationId: chat.id, context: 'brief', firstTurn: true,
    // B-080: a fork part carries the session its parent's splitting turn ended with (recorded when the group started)
    ...(extra.context === 'fork' ? { parentSession: { engine: 'claude' as const, accountId: 'acc_api', ref: 'parent_sess', contextTokens: 1000 } } : {}),
    ...extra,
  });
  const executor = new TurnExecutor(() => s);
  const runSplit = (runId: string, split = splitTurn(), control: TurnControl = { lastSeq: 0, steeredSeq: 0 }) => executor.execute({
    runId, agentId, reason: 'split', split, notes: [{ text: 'Your part #2: cut the middle section to 40 seconds.', at: 0 }],
    signal: new AbortController().signal, control,
  });
  const runOwn = (runId: string) => {
    f.chats.send({ conversationId: chat.id, body: 'How is the video coming along?', authorId: 'human' });
    return executor.execute({ runId, agentId, conversationId: chat.id, reason: 'message', notes: [], signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 } });
  };
  const cursor = () => f.chats.members(chat.id).find((member) => member.memberId === agentId)?.readSeq ?? 0;
  return { ...f, s, agentId, chat, inputs, forks, state, toolCtxs, routes, spends, calls, group, splitTurn, runSplit, runOwn, cursor, opus };
}

test('a split turn runs on its own thread, internal: no cursor, no post; cost and model stats on its parent agent', async () => {
  const h = setup();
  h.chats.send({ conversationId: h.chat.id, body: 'Please cut the launch video.', authorId: 'human' });
  const cursorBefore = h.cursor();
  const messagesBefore = h.chats.messages(h.chat.id, { limit: 200 }).length;
  const outcome = await h.runSplit('run_s2');
  await tick();
  await tick();
  assert.equal(outcome.status, 'done');
  const run = h.s.runs.get('run_s2');
  assert.equal(run?.splitId, 'sp_2');
  assert.equal(run?.conversationId, undefined);
  assert.equal(run?.trigger, 'split');
  assert.equal(h.cursor(), cursorBefore, 'the parent chat cursor never moves');
  assert.equal(h.chats.messages(h.chat.id, { limit: 200 }).length, messagesBefore, 'nothing posted in the chat');
  const answer = h.s.runs.items('run_s2').find((item) => item.name === 'Answer');
  assert.equal(answer?.data.visibility, 'internal');
  assert.equal(answer?.data.text, 'Part done: three cuts.');
  assert.deepEqual(h.spends, [{ agentId: h.agentId, ref: 'run_s2' }], 'cost booked on the parent agent');
  assert.deepEqual(h.calls.ends, [{ splitId: 'sp_2', end: { runId: 'run_s2', status: 'done' } }]);
  assert.deepEqual(h.calls.after, [], 'a split turn is no parent turn');
  assert.deepEqual(h.calls.asked, [], 'a split never gets split results');
  // Its input: the brief; its route, without a chat: a fresh part that names no model starts from its origin's model and effort – the
  // router keeps it there or, when the origin is above what executing needs, takes the executing default (17.11.2026).
  assert.match(String(h.inputs[0].input[0].type === 'text' ? h.inputs[0].input[0].text : ''), /cut the middle section to 40 seconds/);
  assert.equal(h.routes[0].conversationId, undefined);
  assert.deepEqual(h.routes[0].split, { splitId: 'sp_2', fresh: true });
  assert.deepEqual(h.routes[0].previous, { modelId: h.opus.id, effort: 'high' }, 'nobody asked for a model: not an explicit request');
  assert.equal(h.routes[0].boundary, true, 'no session of its own yet');
});

test('the volatile split section is there; the agent\'s own turn has none', async () => {
  const h = setup();
  await h.runSplit('run_s2');
  const volatile = h.inputs[0].system.volatile;
  // B-083: design/principle.md "Ultra PART" with the name, piece and whole filled in – no bans.
  assert.match(volatile, /## My part #2 of 3\nI am Vic – this part of me takes “Middle section” all the way \(the whole: Cut the launch video\), while my origin and my other parts carry the rest\./);
  assert.match(volatile, /I tell it as soon as I see it \(agents\.split_tell – to my origin, a part, or all\); agents\.split_results \{steps\} shows what my other parts do\. When I end, my last words and what I did on the way go back to my origin on their own and merge into it; what a chat should see now, I post there myself\./);
  assert.match(volatile, /My other parts: #1 Intro; #3 Outro\./);
  assert.doesNotMatch(volatile, /I post nothing in chats|main self|Splitting again/);
  assert.match(volatile, /I keep to the files of my part/);
  assert.doesNotMatch(volatile, /## Ultra/);
  await h.runOwn('run_own');
  assert.doesNotMatch(h.inputs[1].system.volatile, /this part of me/);
});

test('Ultra suggested on a message: its note reaches the agent\'s own turn with that message only; no standing Ultra section', async () => {
  const h = setup();
  const text = (index: number) => h.inputs[index].input.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  await h.runOwn('run_plain');
  assert.equal(text(0).includes(ULTRA_NOTE), false, 'a plain message has no note');
  h.chats.send({ conversationId: h.chat.id, body: 'Review all six documents for contradictions.', authorId: 'human', meta: { ultra: true } });
  await h.runOwn('run_ultra');
  assert.ok(text(1).includes(`Review all six documents for contradictions. ${ULTRA_NOTE}`), text(1));
  assert.equal(text(1).split(ULTRA_NOTE).length, 2, 'only on the message that suggested it');
  for (const input of h.inputs) assert.doesNotMatch(input.system.volatile, /## Ultra/);
  await h.runSplit('run_s2');
  assert.equal(text(2).includes(ULTRA_NOTE), false, 'a split gets its brief, not the note');
});

test('settled splits\' results join the agent\'s own turn input; gathered only when that turn ends done', async () => {
  const h = setup();
  h.calls.pending = { splitIds: ['spl_1', 'spl_2'], text: 'Split results – Cut the launch video:\n#1 Intro: done – 12 s.\n#2 Middle section: done – three cuts.' };
  await h.runOwn('run_first');
  h.state.stop = 'error';
  await h.runOwn('run_failed');
  const failedInput = h.inputs[1].input[0];
  assert.match(failedInput.type === 'text' ? failedInput.text : '', /Split results – Cut the launch video/);
  h.state.stop = 'done';
  await h.runOwn('run_done');
  const doneInput = h.inputs[2].input[0];
  assert.match(doneInput.type === 'text' ? doneInput.text : '', /#2 Middle section: done – three cuts\./);
  assert.deepEqual(h.calls.asked, ['main', 'main', 'main'], 'asked for the turn\'s own thread');
  assert.deepEqual(h.calls.gathered, [{ runId: 'run_first', splitIds: ['spl_1', 'spl_2'] }, { runId: 'run_done', splitIds: ['spl_1', 'spl_2'] }], 'never for the failed turn');
  assert.deepEqual(h.calls.after, [
    { runId: 'run_first', status: 'done' }, { runId: 'run_failed', status: 'failed' }, { runId: 'run_done', status: 'done' },
  ]);
});

test('a failed split run is retryable while its effects are known; a split ends nothing for its parent', async () => {
  const h = setup();
  h.state.stop = 'error';
  const outcome = await h.runSplit('run_s2');
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(h.calls.ends, [{ splitId: 'sp_2', end: { runId: 'run_s2', status: 'failed', retryable: true, error: 'boom' } }]);
  assert.deepEqual(h.calls.after, []);
});

test('a split\'s calls carry ToolContext.split without a chat; it works in its group\'s folder unless it has its own', async () => {
  const h = setup();
  h.group.cwd = 'C:/work/video';
  h.state.onRun = (input) => input.callTool('files.read', { path: 'cut.md' }, 'call_1');
  await h.runSplit('run_s2');
  assert.equal(h.toolCtxs.length, 1);
  assert.equal(h.toolCtxs[0].split?.splitId, 'sp_2');
  assert.equal(h.toolCtxs[0].split?.parentConversationId, h.chat.id);
  assert.equal(h.toolCtxs[0].conversationId, undefined, 'a split never acts in the chat itself');
  assert.equal(h.inputs[0].cwd, 'C:/work/video', "the group's folder (the parent's at the split)");
  await h.runSplit('run_s2b', h.splitTurn({ cwd: 'C:/work/wt-2' }));
  assert.equal(h.inputs[1].cwd, 'C:/work/wt-2', 'its own worktree');
  await h.runOwn('run_own');
  assert.equal(h.toolCtxs[2].split, undefined, "the agent's own turn carries no split");
});

test('a split cut by a shutdown runs again (S14); the person\'s Stop ends it stopped', async () => {
  const h = setup();
  h.state.stop = 'interrupted';
  await h.runSplit('run_cut', h.splitTurn(), { lastSeq: 0, steeredSeq: 0, stopKind: 'shutdown' });
  await h.runSplit('run_stop', h.splitTurn(), { lastSeq: 0, steeredSeq: 0, stopKind: 'human' });
  assert.deepEqual(h.calls.ends, [
    { splitId: 'sp_2', end: { runId: 'run_cut', status: 'failed', retryable: true, error: 'The runtime stopped while the split ran.' } },
    { splitId: 'sp_2', end: { runId: 'run_stop', status: 'stopped' } },
  ]);
});

test('a split\'s first turn is seeded once (here: a native fork) and bound under its own thread; the next turn resumes it', async () => {
  const h = setup({ sessions: true, fork: true });
  const store = new SessionStore(h.s.db);
  // The parent's own session in its chat, on the worker's engine and account: the fork source (splits/fork.ts).
  store.save({ agentId: h.agentId, conversationId: h.chat.id, engine: 'claude', accountId: 'acc_api', ref: 'parent_sess', generation: 1, cursorSeq: 0, contextTokens: 1000, updatedAt: 0 });
  await h.runSplit('run_s2', h.splitTurn({ context: 'fork' }));
  assert.deepEqual(h.forks.map((fork) => fork.parentRef), ['parent_sess'], 'seedSplitSession ran once for the first turn');
  assert.equal(h.inputs[0].session?.ref, 'fork_1', 'the turn runs on the bound fork');
  assert.equal(store.get(h.agentId, 'split:sp_2', 'claude')?.ref, 'sess_1', 'kept under split:<id>');
  assert.equal(store.get(h.agentId, h.chat.id, 'claude')?.ref, 'parent_sess', 'the parent\'s binding is untouched');
  await h.runSplit('run_s2b', h.splitTurn({ context: 'fork' })); // firstTurn still set: a binding exists, so no second seed
  assert.equal(h.forks.length, 1);
  assert.equal(h.inputs[1].session?.ref, 'sess_1', 'resumed');
  await h.runSplit('run_s3', h.splitTurn({ splitId: 'sp_3', idx: 3, title: 'Outro', context: 'fork', firstTurn: false }));
  assert.equal(h.forks.length, 1, 'not a first turn: no seed');
  assert.equal(h.inputs[2].session, undefined);
});

test('FIXES-3 B1: a native fork carries its parent\'s running cost total (Claude Code, measured 18.11.2026) – the part\'s first turn stores only its own cost', async () => {
  const h = setup({ sessions: true, fork: true });
  const store = new SessionStore(h.s.db);
  store.save({ agentId: h.agentId, conversationId: h.chat.id, engine: 'claude', accountId: 'acc_api', ref: 'parent_sess', generation: 1, cursorSeq: 0, contextTokens: 1000, updatedAt: 0 });
  store.setCostTotal(h.agentId, h.chat.id, 'claude', { ref: 'parent_sess', usd: 0.237647 });
  Object.assign(h.state, { sameRef: true, costUsd: 0.249378 }); // the CLI's total for the fork: its parent's 0.237647 and its own request
  await h.runSplit('run_s2', h.splitTurn({ context: 'fork' }));
  assert.equal(h.inputs[0].session?.ref, 'fork_1');
  assert.equal(h.s.runs.get('run_s2')?.costUsd, 0.011731, 'its own share, not the parent\'s session');
  assert.deepEqual(store.get(h.agentId, 'split:sp_2', 'claude')?.costTotal, { ref: 'fork_1', usd: 0.249378 });
  assert.deepEqual(store.get(h.agentId, h.chat.id, 'claude')?.costTotal, { ref: 'parent_sess', usd: 0.237647 }, 'the parent\'s total is untouched');
});

test('S2 (FIXES-2 C.6): a native fork part starts from its parent session\'s start record and gets what changed since as lines', async () => {
  const h = setup({ sessions: true, fork: true });
  const store = new SessionStore(h.s.db);
  const started = '# My SYSTEM.md\nI write tight.';
  store.save({ agentId: h.agentId, conversationId: h.chat.id, engine: 'claude', accountId: 'acc_api', ref: 'parent_sess', generation: 1, cursorSeq: 0, contextTokens: 1000, updatedAt: 0, promptKey: 'parent-key' });
  recordStart(h.s.db, { agentId: h.agentId, thread: h.chat.id, engine: 'claude' }, { key: 'parent-key', native: [], hub: [], sections: [{ name: 'system-md', text: started }] }, 0);
  await h.runSplit('run_s2', h.splitTurn({ context: 'fork' }));
  const first = h.inputs[0];
  assert.equal(first.session?.ref, 'fork_1');
  assert.equal(first.system.stable, started, 'the system text the forked session holds: its parent\'s start');
  assert.match(first.system.volatile, /Parts of my standing text changed since this session began\./, 'the sections that changed since, as lines');
  assert.equal(store.get(h.agentId, 'split:sp_2', 'claude')?.promptKey, 'parent-key', 'the part runs on that start');
  assert.ok(startOf(h.s.db, { agentId: h.agentId, thread: 'split:sp_2', engine: 'claude' }, 'parent-key'), 'recorded on the part\'s thread');
});

test('a retry routed to another account than its earlier attempt\'s session starts as the parent again (seeded), never blind', async () => {
  const h = setup({ sessions: true, fork: true });
  const store = new SessionStore(h.s.db);
  store.save({ agentId: h.agentId, conversationId: h.chat.id, engine: 'claude', accountId: 'acc_api', ref: 'parent_sess', generation: 1, cursorSeq: 0, contextTokens: 1000, updatedAt: 0 });
  // Attempt 1 ran on another account (limited now) and left its session there.
  store.save({ agentId: h.agentId, conversationId: 'split:sp_2', engine: 'claude', accountId: 'acc_limited', ref: 'old_attempt', generation: 1, cursorSeq: 0, updatedAt: 0 });
  await h.runSplit('run_retry', h.splitTurn({ context: 'fork' }));
  assert.deepEqual(h.forks.map((fork) => fork.parentRef), ['parent_sess'], 'seeded from the parent on this account');
  assert.equal(h.inputs[0].session?.ref, 'fork_1');
});

test('a seeded first attempt that needs a session renewal (context full, no tool call) goes on fresh with its brief – never forked again', async () => {
  const h = setup({ sessions: true, fork: true });
  new SessionStore(h.s.db).save({ agentId: h.agentId, conversationId: h.chat.id, engine: 'claude', accountId: 'acc_api', ref: 'parent_sess', generation: 1, cursorSeq: 0, contextTokens: 1000, updatedAt: 0 });
  const engine = h.s.engines.get('claude') as Engine;
  const run = engine.run.bind(engine);
  let attempts = 0;
  engine.run = async (input: EngineTurnInput) => {
    const result = await run(input);
    attempts++;
    return attempts > 1 ? result : { ...result, stop: 'error', session: undefined, error: { code: 'internal', message: 'The context window is full.', details: { rebase: true } } };
  };
  const outcome = await h.runSplit('run_s2', h.splitTurn({ context: 'fork' }));
  assert.equal(outcome.status, 'done');
  assert.equal(h.inputs.length, 2, 'renewed once in the same run');
  assert.equal(h.forks.length, 1, 'seeded (forked) for the first attempt only');
  assert.equal(h.inputs[0].session?.ref, 'fork_1');
  assert.equal(h.inputs[1].session, undefined, 'the renewal starts a fresh session');
  const renewed = h.inputs[1].input[0];
  assert.match(renewed.type === 'text' ? renewed.text : '', /cut the middle section to 40 seconds/, 'with its brief');
  assert.deepEqual(h.calls.ends, [{ splitId: 'sp_2', end: { runId: 'run_s2', status: 'done' } }]);
});

test('a split\'s turn that planned no run ends it; a cut one is re-queued', () => {
  const ends: SplitRunEnd[] = [];
  const services = { splits: { onSplitRunEnd: (_id: string, end: SplitRunEnd) => { ends.push(end); } }, log: { warn: () => {} } } as unknown as RuntimeServices;
  const split = { splitId: 'sp_1' } as SplitTurn;
  turnEndedEarly(services, 'run_1', split, 'cut');
  turnEndedEarly(services, 'run_2', split, 'skipped');
  assert.deepEqual(ends, [
    { runId: 'run_1', status: 'failed', retryable: true, requeue: true, error: 'The runtime stopped before the split ran.' },
    { runId: 'run_2', status: 'stopped', error: 'The agent is paused or archived.' },
  ]);
});

test('B-080: a done part counts as done only when it brought something back – last words or a note to its origin', async () => {
  const h = setup();
  await h.runSplit('run_words'); // "Part done: three cuts."
  h.state.text = '';
  await h.runSplit('run_quiet');
  h.state.onRun = async () => {
    h.s.runs.item('run_told', { kind: 'note', name: TOLD_ITEM, effectStatus: 'none', data: { text: 'The cut list is in cuts.md.' } }); // agents.split_tell {to: 'origin'}
  };
  await h.runSplit('run_told'); // Mara's case: its piece went to its origin through agents.split_tell
  assert.deepEqual(h.calls.ends.map((entry) => entry.end), [
    { runId: 'run_words', status: 'done' },
    { runId: 'run_quiet', status: 'failed', retryable: true, error: NOTHING_BACK },
    { runId: 'run_told', status: 'done' },
  ]);
});

test('B-080: a first session on a model without a catalog window forks by the window its engine reported elsewhere', async () => {
  for (const reported of [undefined, 1_000_000]) {
    const h = setup({ sessions: true, fork: true });
    // claude:opus has no catalog window (caps {}): 300,000 tokens are past DEFAULT_WINDOW's fit, within a reported 1,000,000.
    if (reported) {
      new SessionStore(h.s.db).save({ agentId: h.agentId, conversationId: 'task:other', engine: 'claude', accountId: 'acc_api', ref: 'other_sess', generation: 1,
        cursorSeq: 0, model: h.opus.id, contextWindow: reported, updatedAt: 0 });
    }
    const parentSession = { engine: 'claude' as const, accountId: 'acc_api', ref: 'parent_sess', contextTokens: 300_000 };
    await h.runSplit('run_s2', h.splitTurn({ context: 'fork', parentSession }));
    assert.equal(h.forks.length, reported ? 1 : 0, reported ? 'native fork' : 'text seed');
  }
});
