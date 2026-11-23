// Session renewal and catch-up over the real chat store, context service and run journal with
// two recording engines (claude, codex): the renewal retry after an ended session (once per run), the catch-up of a session that missed another
// engine's turns, the dropped binding when too much was missed, and the engine-reported window. 13.11.2026: a renewed session
// never gets a chat's history – only the new lines, after the agent's own record when it has one (none in this fixture).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { EngineId, ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

type Reply = (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined;

const ENDED: Partial<EngineTurnResult> = { text: '', stop: 'error', error: { code: 'conflict', message: 'The conversation is too long for this session.', details: { rebase: true } } };

/** An engine with native sessions that answers "<id> answer <n>" unless `reply` says otherwise. */
function recordingEngine(id: EngineId) {
  const calls: EngineTurnInput[] = [];
  const state: { reply?: Reply; sessions: number } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: false, images: false, rebase: true, structured: false, ownTools: false };
  const engine = {
    id, caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `${id}-s${++state.sessions}`, generation: 1 };
      return { text: `${id} answer ${calls.length}`, stop: 'done', session, ...state.reply?.(input) };
    },
  } as unknown as Engine;
  return { engine, calls, state };
}

const textOf = (input: EngineTurnInput | undefined) => (input?.input[0] as { text: string } | undefined)?.text ?? '';

function setup() {
  const f = fixture();
  const s = f.services;
  const agent = f.vid;
  const chat = f.chats.create({ title: 'Launch', agentIds: [agent.id], createdBy: 'human' });
  const claude = recordingEngine('claude');
  const codex = recordingEngine('codex');
  const models = new Map<string, ModelInfo>([
    ['claude:opus', { ...model('claude:opus', 'frontier', 'Claude Opus'), provider: 'claude', engine: 'claude' }],
    ['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')],
  ]);
  const route = (engine: 'claude' | 'codex'): RouteDecision => ({
    modelId: engine === 'claude' ? 'claude:opus' : 'codex:sol', engine, accountId: `acc_${engine}`, effort: 'medium',
    category: 'chat', reason: 'test', by: 'rules', alternatives: [],
  });
  const current = { engine: 'claude' as 'claude' | 'codex' };
  const accounts = new Map([['acc_claude', account('acc_claude', 'claude')], ['acc_codex', account('acc_codex', 'codex')]]);
  Object.assign(s, {
    router: { route: async () => route(current.engine) },
    engines: { get: (id: string) => (id === 'codex' ? codex.engine : claude.engine) },
    accounts: { get: (id: string) => accounts.get(id), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  });

  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, s, agent, chat, claude, codex, store,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    turn: (engine: 'claude' | 'codex') => {
      current.engine = engine;
      return new TurnExecutor(() => s).execute({
        runId: `run_${++runs}`, agentId: agent.id, conversationId: chat.id, reason: 'message', notes: [],
        signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
      });
    },
    binding: (engine: EngineId) => store.get(agent.id, 'main', engine),
    cursor: () => f.chats.members(chat.id).find((member) => member.memberId === agent.id)!.readSeq,
    notes: (runId: string) => s.runs.items(runId).filter((item) => item.kind === 'note' && item.name !== 'Answer').map((item) => item.data), // the final answer's item (B-047 D4) is no renewal note
  };
}

test('an ended session is renewed once in the same run (dropped binding, no chat history); never twice', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.claude.state.reply = (input) => (input.session ? ENDED : undefined);

  h.send('Next step');
  const renewed = await h.turn('claude');
  assert.equal(renewed.status, 'done');
  assert.equal(h.claude.calls.length, 3, 'exactly one retry');
  assert.equal(h.claude.calls[1].session?.ref, 'claude-s1');
  assert.equal(h.claude.calls[2].session, undefined, 'the retry starts a fresh session');
  assert.ok(textOf(h.claude.calls[2]).includes('Next step') && !textOf(h.claude.calls[2]).includes('Hello'), textOf(h.claude.calls[2]));
  assert.ok(!textOf(h.claude.calls[2]).includes('still writing'), 'the run\'s own draft is not part of the input');
  assert.equal(h.binding('claude')?.ref, 'claude-s2');
  assert.deepEqual(h.notes('run_2'), [{ sessionRenewed: 'overflow' }]);
  const lines = h.chats.messages(h.chat.id);
  assert.ok(lines.some((line) => line.kind === 'status' && line.meta.status?.text === 'Continued in a fresh session'), 'a quiet status line');
  assert.equal(lines.filter((line) => line.authorId === h.agent.id && line.kind === 'text').at(-1)?.body, 'claude answer 3');

  // The fresh session ends too: no second retry in this run; the binding is dropped.
  h.claude.state.reply = () => ENDED;
  h.send('Again');
  const failed = await h.turn('claude');
  assert.equal(failed.status, 'failed');
  assert.equal(h.claude.calls.length, 5, 'still one retry per run');
  assert.equal(h.binding('claude'), undefined, 'the next turn starts fresh');

  // Tools already ran: no retry at all, only the binding is dropped.
  h.claude.state.reply = undefined;
  h.send('Fresh start');
  await h.turn('claude');
  assert.ok(h.binding('claude'));
  h.claude.state.reply = (input) => {
    void input.callTool('tasks.list', {}, 'call_1');
    return ENDED;
  };
  h.send('Do it');
  await h.turn('claude');
  assert.equal(h.claude.calls.length, 7, 'no retry after a tool call');
  assert.equal(h.binding('claude'), undefined);
});

test('a renewed run keeps the ended attempt\'s tokens and cost: every attempt the run made counts (each its own share)', async () => {
  const h = setup();
  const paid = account('acc_codex', 'codex', { plan: 'api' }); // a Codex login with an API key: its cost is a real charge
  Object.assign(h.s, { accounts: { ...h.s.accounts, get: (id: string) => (id === 'acc_codex' ? paid : undefined) } });
  h.send('Hello');
  await h.turn('codex');
  h.codex.state.reply = (input) => (input.session
    ? { ...ENDED, usage: { inputTokens: 700, outputTokens: 5, costUsd: 0.02 } }
    : { usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.01 } });
  h.send('Next step');
  assert.equal((await h.turn('codex')).status, 'done');
  assert.equal(h.codex.calls.length, 3, 'the ended attempt and its renewal');
  const run = h.s.runs.get('run_2')!;
  assert.deepEqual([run.inputTokens, run.outputTokens], [1_000, 45], 'both attempts\' tokens');
  assert.equal(run.costUsd, 0.03, 'both attempts\' cost');
});

test('the engine-reported context window is stored and renews the session past 80 % when the catalog has none (B-080: the fit of the window)', async () => {
  const h = setup();
  h.claude.state.reply = () => ({ contextWindow: 1000, contextTokens: 500 });
  h.send('Hello');
  await h.turn('claude');
  assert.equal(h.binding('claude')?.contextWindow, 1000);
  h.send('Still small');
  await h.turn('claude');
  assert.equal(h.claude.calls[1].session?.ref, 'claude-s1', '50 % keeps the session');

  h.claude.state.reply = () => ({ contextTokens: 850 });
  h.send('Grows');
  await h.turn('claude');
  assert.equal(h.binding('claude')?.contextWindow, 1000, 'kept while the model stays the same');
  h.claude.state.reply = undefined;
  h.send('Over the line');
  await h.turn('claude');
  assert.equal(h.claude.calls[3].session, undefined, '85 % of the reported window renews it');
  assert.deepEqual(h.notes('run_4'), [{ sessionRenewed: 'context' }]);
  assert.equal(h.binding('claude')?.ref, 'claude-s2');
});
