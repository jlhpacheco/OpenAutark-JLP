// SES2 / S2 (17.11.2026) – session prompt key over the real chat store, context service (real stable prompt) and
// run journal with a recording Codex-like engine (native sessions + dynamic tools): a changed key no longer renews – the
// agent's own mode switch general → computer, a changed tool offer and an edited SYSTEM.md keep the session on the system
// text and tools it started with, the "My mode is now" note and the changed stable lines (was / now) come once in the live
// block (again after a failed turn), and a session that starts anew takes the current prompt, and a chat has no mode of its own (13.11.2026: chats.update
// After the review (18.11.2026): a session bound before the start record, whose key differs, gets every current section
// once; the record is written only where a binding is saved, so a turn that ends without a session leaves it; a note no
// engine read waits for the next turn.
// writes no settings.mode and posts no line). B-089 (11.11.2026, live 10.11.: the models line moved every agent's stable
// prompt by itself, 216 cold sessions in 26.7 h): a relist, a price and an account state keep the key; the line is volatile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { SESSION_START_NS, promptKey } from '../../../src/runtime/agents/session-key.ts';
import { saveOutputNotes } from '../../../src/runtime/media/outputs.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Conversation, Message } from '../../../src/shared/model/chat.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

const COMPUTER_MODE: ModeInfo = {
  key: 'computer', name: 'Computer', description: 'Work on the screen of a PC.', skills: [], tools: ['*'], category: 'computer-use',
  workspace: 'computer', instructions: '# Computer mode\n\nLook at the screen before every click.',
};
const MODES = new Map([[GENERAL_MODE.key, GENERAL_MODE], [COMPUTER_MODE.key, COMPUTER_MODE]]);
const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: 'object' } });

type Reply = (input: EngineTurnInput) => Partial<EngineTurnResult> | undefined;

function setup() {
  const f = fixture();
  const s = f.services;
  const vic = f.vid;
  const chat = f.chats.create({ title: 'Desk', agentIds: [vic.id], createdBy: 'human' });
  const calls: EngineTurnInput[] = [];
  const state: { reply?: Reply; sessions: number; extraTool?: string; callTool?: boolean } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: false, images: false, rebase: true, structured: false, ownTools: true };
  const engine = {
    id: 'codex', caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `codex-s${++state.sessions}`, generation: 1 };
      return { text: `answer ${calls.length}`, stop: 'done', session, ...state.reply?.(input) };
    },
  } as unknown as Engine;
  const models = new Map<string, ModelInfo>([['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')]]);
  const route: RouteDecision = { modelId: 'codex:sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const acc = account('acc_codex', 'codex');
  Object.assign(s, {
    modes: { get: (key: string) => { const mode = MODES.get(key); if (!mode) throw new Error(`unknown mode ${key}`); return mode; }, list: () => [...MODES.values()] },
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: {
      get: (name: string) => (['tasks.list', 'computer.screenshot', 'computer.click', 'tools.call', state.extraTool].includes(name) ? spec(name) : undefined),
      // Device tools only in the computer workspace (as ToolRegistry.allowed does).
      specsFor: (_agent: unknown, mode: ModeInfo) => [
        spec('tasks.list'), ...(mode.workspace === 'computer' ? [spec('computer.screenshot'), spec('computer.click')] : []),
        ...(state.extraTool ? [spec(state.extraTool)] : []), ...(state.callTool ? [spec('tools.call')] : []),
      ],
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    },
  });

  let runs = 0;
  const store = new SessionStore(f.db);
  return {
    ...f, vic, chat, calls, state, store,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    setMode: (mode: string) => f.org.add({ ...f.org.require(vic.id), mode }), // the mode is the agent's own
    setInstructions: (instructions: string) => f.org.add({ ...f.org.require(vic.id), instructions }),
    turn: () => new TurnExecutor(() => s).execute({
      runId: `run_${++runs}`, agentId: vic.id, conversationId: chat.id, reason: 'message', notes: [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    }),
    binding: () => store.get(vic.id, 'main', 'codex'),
    notes: (runId: string) => s.runs.items(runId).filter((item) => item.kind === 'note' && item.name !== 'Answer').map((item) => item.data), // the final answer's item (B-047 D4) is no renewal note
  };
}

const textOf = (input: EngineTurnInput | undefined) => (input?.input[0] as { text: string } | undefined)?.text ?? '';
const toolsOf = (input: EngineTurnInput | undefined) => (input?.tools ?? []).map((tool) => tool.name).sort();
const keyOf = (input: EngineTurnInput) => promptKey(input.system.stable, input.tools.map((tool) => tool.name));

test('S2: general → computer keeps the session on the prompt and tools it started with; the note and the changed mode section come once', async () => {
  const h = setup();
  h.send('Hello');
  assert.equal((await h.turn()).status, 'done');
  assert.equal(h.calls[0].session, undefined);
  assert.deepEqual(toolsOf(h.calls[0]), ['tasks.list'], 'no device tools in general');
  const first = h.binding()!;
  assert.equal(first.ref, 'codex-s1');
  assert.equal(first.mode, 'general');
  assert.equal(first.promptKey, keyOf(h.calls[0]), 'turn-finish saves the key of the offered prompt and tools');
  assert.match(first.promptKey!, /^[0-9a-f]{64}$/);

  h.send('Next');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 'codex-s1', 'same mode, same key: the session is resumed');
  assert.deepEqual(h.notes('run_2'), []);

  h.setMode('computer');
  h.send('Take a screenshot of the desktop');
  assert.equal((await h.turn()).status, 'done');
  const switched = h.calls[2];
  assert.equal(switched.session?.ref, 'codex-s1', 'no renewal: the session resumes');
  assert.equal(switched.system.stable, h.calls[0].system.stable, 'on the system text it started with');
  assert.deepEqual(toolsOf(switched), ['tasks.list'], 'and its own tools – the computer ones are reachable through tools.call until it starts anew');
  assert.match(textOf(switched), /My mode is now Computer \(was General\)\./);
  assert.match(switched.system.volatile, /Parts of my standing text changed since this session began\.[\s\S]*## Mode: Computer\n(?:was: [^\n]*\n)*now: ## Mode: Computer[\s\S]*now: Look at the screen before every click\./, 'the mode section as changed lines in the live block');
  assert.deepEqual(h.notes('run_3'), [], 'no fresh note');
  assert.equal(h.binding()?.promptKey, first.promptKey, 'the binding keeps the key it started with');
  assert.equal(h.binding()?.mode, 'computer');

  h.send('Click OK');
  await h.turn();
  assert.equal(h.calls[3].session?.ref, 'codex-s1');
  assert.ok(!textOf(h.calls[3]).includes('My mode is now'), 'the note comes once');
  assert.ok(!h.calls[3].system.volatile.includes('standing text changed'), 'the changed lines come once');
});

test('S2: a changed tool offer keeps the session and its own tools; "More tools" names the new one as a changed line', async () => {
  const h = setup();
  h.state.callTool = true; // "More tools" lists what tools.call reaches beyond the direct tools
  h.send('Hello');
  await h.turn();
  assert.ok(!h.calls[0].system.stable.includes('media.image'));
  h.state.extraTool = 'media.image';
  h.send('Draw a logo');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 'codex-s1', 'resumed');
  assert.deepEqual(toolsOf(h.calls[1]), ['tasks.list', 'tools.call'], 'its own offer');
  assert.equal(h.calls[1].system.stable, h.calls[0].system.stable);
  assert.equal(keyOf(h.calls[1]), h.binding()?.promptKey, 'and the key it started with');
  assert.ok(!textOf(h.calls[1]).includes('My mode is now'));
  assert.deepEqual(h.notes('run_2'), []);
  assert.match(h.calls[1].system.volatile, /## More tools[\s\S]*now: [^\n]*media\.image/, 'reachable through tools.call, named once');
});

test('S2: my SYSTEM.md changes – the resumed session keeps its system text and gets the changed lines once; a failed turn sends them again; a new session takes the new text', async () => {
  const h = setup();
  h.setInstructions('# How I work\nI write tight.\n\n## My role\nDesk work.');
  h.send('Hello');
  await h.turn();
  const started = h.calls[0].system.stable;
  assert.match(started, /I write tight\./);

  h.setInstructions('# How I work\nI write tight and warm.\n\n## My role\nDesk work.');
  h.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'The engine crashed.' } });
  h.send('Next');
  await h.turn();
  assert.equal(h.calls[1].session?.ref, 'codex-s1');
  assert.equal(h.calls[1].system.stable, started, 'the system text it started with');
  assert.match(h.calls[1].system.volatile, /## My SYSTEM\.md\nwas: I write tight\.\nnow: I write tight and warm\./);

  h.state.reply = undefined;
  h.send('Again');
  await h.turn();
  assert.match(h.calls[2].system.volatile, /was: I write tight\.\nnow: I write tight and warm\./, 'the failed turn did not count: the lines come again');
  h.send('Thanks');
  await h.turn();
  assert.ok(!h.calls[3].system.volatile.includes('standing text changed'), 'then not again');
  assert.equal(h.calls[3].system.stable, started);

  h.store.remove(h.vic.id, 'main', 'codex'); // the session starts anew (S1 decides when)
  h.send('Fresh');
  await h.turn();
  assert.equal(h.calls[4].session, undefined);
  assert.match(h.calls[4].system.stable, /I write tight and warm\./, 'a new session takes the current prompt');
  assert.ok(!h.calls[4].system.volatile.includes('standing text changed'));
  h.send('On');
  await h.turn();
  assert.equal(h.calls[5].system.stable, h.calls[4].system.stable, 'and keeps it');
  assert.ok(!h.calls[5].system.volatile.includes('standing text changed'), 'the new start counts from itself');
});

test('B-089: a catalog relist, a new price and an account that cools keep the stable prompt and its key – the models line comes in the volatile delta', async () => {
  const h = setup();
  const s = h.services as unknown as Record<string, Record<string, unknown>>;
  const sol = { ...model('codex:sol', 'frontier', 'GPT Sol'), accounts: ['acc_codex'], smarts: 90, price: { inputPerM: 2, outputPerM: 8, source: 'priors' as const } };
  const extra = Array.from({ length: 12 }, (_, index) => ({ ...model(`codex:m${index}`, 'small', `Mini ${index}`), accounts: ['acc_codex'], smarts: 40 + index }));
  let catalog = [sol, ...extra];
  let state: 'ok' | 'cooling' = 'ok';
  const accounts = () => [account('acc_codex', 'codex', { state }), account('acc_key', 'openai')];
  Object.assign(s.catalog, { list: () => catalog, get: (id: string) => catalog.find((entry) => entry.id === id) });
  Object.assign(s.accounts, { list: accounts, get: (id: string) => accounts().find((entry) => entry.id === id) });
  h.send('Hello');
  await h.turn();
  const first = h.calls[0];
  assert.ok(!first.system.stable.includes('Models I can use'), 'no models line in the stable prompt');
  assert.match(first.system.volatile, /Models I can use [^\n]*GPT Sol \$2\/\$8 · 90 · plan[^\n]*\(\+5 more in models\.list\)/, 'the line in the first volatile text');

  // What moves the line by itself (live 10.11.: "+387 more" → "+385 more"): a relist drops two models, the price changes, the account cools.
  catalog = [{ ...sol, price: { inputPerM: 2.5, outputPerM: 10, source: 'priors' as const } }, ...extra.slice(2)];
  state = 'cooling';
  h.send('Next');
  await h.turn();
  const next = h.calls[1];
  assert.equal(next.system.stable, first.system.stable, 'the stable prompt is byte-identical');
  assert.equal(keyOf(next), keyOf(first), 'the same prompt key');
  assert.equal(next.session?.ref, 'codex-s1', 'the session resumes');
  assert.deepEqual(h.notes('run_2'), []);
  assert.match(next.system.volatile, /Models I can use [^\n]*GPT Sol \$2\.5\/\$10 · 90 · plan[^\n]*\(\+3 more in models\.list\)/, 'the changed line comes in the delta');

  h.send('Thanks');
  await h.turn();
  assert.ok(!h.calls[2].system.volatile.includes('Models I can use ('), 'unchanged: not sent again');
});

test('S2 fix: a session bound before the start record, whose prompt changed since, gets every current stable section once', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  const started = h.calls[0].system.stable;
  // A session of the version before this one: its binding carries the key it started with, but no start record exists.
  h.db.run('DELETE FROM kv WHERE ns = ?', [SESSION_START_NS]);
  h.setInstructions('# How I work\nI write tight.\n\n## My role\nDesk work.');

  h.send('Next');
  await h.turn();
  const after = h.calls[1];
  assert.equal(after.session?.ref, 'codex-s1', 'the session is kept');
  assert.ok(after.system.stable.includes('I write tight.'), 'without a record the turn passes the current text');
  assert.match(after.system.volatile, /Parts of my standing text changed since this session began\./);
  assert.match(after.system.volatile, /## My SYSTEM\.md\n(?:now: [^\n]*\n)*now: I write tight\./, 'every current section as "now" lines');
  assert.ok(!after.system.volatile.includes('was: '), 'nothing is known of what it held');

  h.send('Thanks');
  await h.turn();
  assert.ok(!h.calls[2].system.volatile.includes('standing text changed'), 'the record is its start now: once');
  assert.equal(h.calls[2].system.stable, after.system.stable);
  assert.notEqual(after.system.stable, started);
});

test('S2 fix: a session from before the start record whose first turn fails gets every current section again – its start counts once a turn ran through', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  h.db.run('DELETE FROM kv WHERE ns = ?', [SESSION_START_NS]);
  h.setInstructions('# How I work\nI write tight.\n\n## My role\nDesk work.');

  h.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'The engine crashed.' } }); // the session stays bound
  h.send('Next');
  assert.equal((await h.turn()).status, 'failed');
  assert.equal(h.calls[1].session?.ref, 'codex-s1');
  assert.match(h.calls[1].system.volatile, /now: I write tight\./);

  h.state.reply = undefined;
  h.send('Again');
  await h.turn();
  assert.equal(h.calls[2].session?.ref, 'codex-s1');
  assert.match(h.calls[2].system.volatile, /## My SYSTEM\.md\n(?:now: [^\n]*\n)*now: I write tight\./, 'the failed turn did not count: every section again');
  h.send('Thanks');
  await h.turn();
  assert.ok(!h.calls[3].system.volatile.includes('standing text changed'), 'then not again');
});

test('S2 fix: a turn that ends without a session leaves the start record of the session that stands', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  const started = h.calls[0].system.stable;
  const first = h.binding()!.promptKey;

  // A turn on another account cannot resume this session (one account home per session), so it starts a fresh one – and ends
  // without one (a sign-in error before the thread opens). The bound session and its start stay as they were.
  h.db.run('UPDATE engine_sessions SET account_id = ? WHERE agent_id = ?', ['acc_other', h.vic.id]);
  h.setInstructions('# How I work\nI write tight.\n\n## My role\nDesk work.');
  h.state.reply = () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'This account is not signed in.' }, session: undefined });
  h.send('Next');
  assert.equal((await h.turn()).status, 'failed');
  assert.equal(h.calls[1].session, undefined, 'a fresh session was tried');

  h.state.reply = undefined;
  h.db.run('UPDATE engine_sessions SET account_id = ? WHERE agent_id = ?', ['acc_codex', h.vic.id]);
  h.send('Again');
  await h.turn();
  const back = h.calls[2];
  assert.equal(back.session?.ref, 'codex-s1', 'the old session is resumed');
  assert.equal(back.system.stable, started, 'on the text it started with');
  assert.equal(h.binding()?.promptKey, first);
  assert.match(back.system.volatile, /## My SYSTEM\.md\nwas: Prefer short cuts\.[^\n]*\n(?:now: [^\n]*\n)*now: I write tight\./, 'the lines of the change it never got');
});

test('S2 fix: a note that no engine read waits for my next turn (the standard\'s among them)', async () => {
  const h = setup();
  const note = 'The team\'s standard for my SYSTEM.md changed with this version of the app.';
  saveOutputNotes(h.db, 1, h.vic.id, [note]);
  h.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'The engine crashed.' } });
  h.send('Hello');
  assert.equal((await h.turn()).status, 'failed');
  assert.ok(textOf(h.calls[0]).includes(note), 'it went out with the failed turn');

  h.state.reply = undefined;
  h.send('Next');
  await h.turn();
  assert.ok(textOf(h.calls[1]).includes(note), 'and comes again, because nothing of mine ran on it');
  h.send('Thanks');
  await h.turn();
  assert.ok(!textOf(h.calls[2]).includes(note), 'the turn that ran on it took it');
});

test('chats.update: a chat has no mode – settings.mode is not written and posts no line', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  Object.assign(f.services, { modes: { get: (key: string) => { const mode = MODES.get(key); if (!mode) throw new Error('unknown'); return mode; } } });
  f.org.add(agent('ag_ava', 'Ava'));
  const owner = new TestClient(f.server, OWNER);
  const chat = await owner.call<Conversation>('chats.create', { agentIds: ['ag_ava'] });
  const updated = await owner.call<Conversation>('chats.update', { id: chat.id, settings: { mode: 'computer' } });
  assert.equal(updated.settings.mode, undefined, 'the mode is the agent\'s own');
  const lines = (await owner.call<Message[]>('messages.list', { conversationId: chat.id })).filter((message) => message.meta.status?.type === 'mode_switched');
  assert.equal(lines.length, 0);
  assert.equal(f.wakeRows().filter((wake) => wake.reason === 'message').length, 0);
});
