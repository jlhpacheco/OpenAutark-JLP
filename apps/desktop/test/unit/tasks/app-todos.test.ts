// Agent mini-app to-dos (F01): an ```app todo=true fence of a final agent message becomes exactly
// one human to-do (widget type 'app', keyed blk:<message>:<parse index>, title= and reason=),
// re-finishing is idempotent, blocks.answer – what the app's wf.complete sends – finishes it with the
// person's line "Done in mini-app" plus the app's data and wakes the author as for a typed line (B-076; a
// double complete returns the same to-do), and fences the person or a bridge wrote are none. Also: a background turn that
// leaves one is posted loudly (a plain one stays in its run journal, B-047 D4), its widget cannot be switched, a blank title= gets the default, a fence
// that cannot become a to-do never fails the turn, the list helpers, the fake engine's [[app:…]]
// rule and the prompt wording.
// Owns: these assertions only. Never: real engines, accounts, timers or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import { appFrameAttrs, appWidgetOf } from '../../../src/shared/blocks/app-todo.ts';
import { appHtmlOf, appTodosOf, parseAppInfo, uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { blockHelp, blockPrompt } from '../../../src/shared/blocks/prompt.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { WakeReason } from '../../../src/shared/model/runs.ts';
import { setup } from '../agents/fixture.ts';
import { agent, harness } from '../chat/harness.ts';
import { TODO_ONLY, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const VOICE_APP = [
  'Record the voice-over with this:',
  '```app title="Voice take" todo=true reason=physical permissions="microphone,geolocation"',
  '<button onclick="wf.complete({take:1})">Done</button>',
  '```',
].join('\n');

/** One finished agent turn of Tom with `text` as its answer to the person's line (13.11.2026: the safety net posts it); returns the final message. */
async function finish(h: ReturnType<typeof setup>, text: string, runId: string, patch: { reason?: WakeReason; taskId?: string } = {}): Promise<Message> {
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Please go on.' });
  const request = h.request({ runId, ...patch });
  const plan = await planTurn(h.services, request);
  assert.ok(plan, 'the turn is planned');
  const messageId = finishTurn(h.services, plan, h.routed(), request, h.attempt({ text, stop: 'done' })).messageId;
  const message = messageId ? h.chats.message(messageId) : undefined;
  assert.ok(message, 'the answer stays');
  return message;
}


test('blocks.answer (the app\'s wf.complete) finishes the to-do with "Done in mini-app" and wakes the author once', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Two things:\n```ui\n{"type":"confirm","important":true,"instructions":"Plug in the microphone"}\n```\n```app todo=true\n<button>Done</button>\n```';
  const message = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_1', { body, state: 'final' });
  const blocks = uiBlocksOf(body);
  const views = f.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index));
  assert.equal(views.length, 2, 'the confirm block and the mini-app');
  const app = views.find((view) => appWidgetOf(view.widget))!;
  const confirm = views.find((view) => !appWidgetOf(view.widget))!;
  assert.equal(appWidgetOf(app.widget)?.index, 1, 'the app after the ui block has parse index 1');
  assert.equal(app.title, 'Mini-app', 'no title= → the default title');
  f.db.run('DELETE FROM wakes');

  const phone = new TestClient(f.server, TODO_ONLY); // a To-do-only link may finish it too
  const params = { messageId: message.id, blockIndex: 1, answer: { take: 2 }, clientId: `app:b_${message.id}_1` };
  const result = await phone.call<{ ok: true; taskId?: string }>('blocks.answer', params);
  assert.equal(result.taskId, app.id);
  const done = f.tasks.get(app.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.result?.summary, 'Done in mini-app · take: 2');
  assert.deepEqual(done.result?.answer, { take: 2 });
  assert.equal(done.result?.verification, 'reported_by_human');
  assert.equal(f.tasks.get(confirm.id)?.status, 'open', 'the other to-do stays open');
  assert.deepEqual(f.chats.messages(chat.id).filter((item) => item.kind === 'answer').map((item) => item.body), ['Done in mini-app\ntake: 2'], 'the app\'s data in the person\'s line');
  const wakes = f.wakeRows().filter((wake) => wake.agent_id === 'ag_ava');
  assert.deepEqual(wakes.map((wake) => [wake.reason, wake.conversation_id, wake.note]), [['message', chat.id, null]]);

  // A double complete returns the same to-do: no second line, no second wake.
  f.db.run('DELETE FROM wakes');
  const twice = await phone.call<{ ok: true; taskId?: string }>('blocks.answer', params);
  assert.equal(twice.taskId, app.id);
  assert.equal(f.chats.messages(chat.id).filter((item) => item.kind === 'answer').length, 1);
  assert.equal(f.wakeRows().length, 0);
});

test('a blank title= is none: the mini-app to-do gets the default title and the turn finishes', async () => {
  assert.equal(parseAppInfo(' title=" " todo=true').title, undefined);
  assert.equal(parseAppInfo("title='  Voice take ' todo").title, 'Voice take');
  const h = setup();
  const message = await finish(h, 'Try this:\n```app title=" " todo=true\n<button>Done</button>\n```', 'run_1');
  assert.equal(message.state, 'final', 'the answer is finished, not left streaming');
  assert.ok(message.body.includes('```app'));
  const todos = h.tasks.todos();
  assert.deepEqual(todos.map((todo) => todo.title), ['Mini-app']);
  assert.equal(appWidgetOf(todos[0].widget)?.title, undefined);
});

test('a fence or block that cannot become a to-do is logged and skipped; the turn still finishes', async () => {
  const h = setup();
  const warnings: string[] = [];
  h.services.log = { debug() {}, info() {}, warn: (text: string) => { warnings.push(text); }, error() {} };
  const create = h.tasks.create.bind(h.tasks);
  h.tasks.create = ((input, options) => {
    if (input.title === 'First') throw new Error('cannot create');
    return create(input, options);
  }) as typeof h.tasks.create;
  const two = '```app title="First" todo=true\n<p>1</p>\n```\n```app title="Second" todo=true\n<p>2</p>\n```';
  const message = await finish(h, two, 'run_1');
  assert.equal(message.state, 'final');
  assert.deepEqual(h.tasks.todos().map((todo) => todo.title), ['Second'], 'the other fence still becomes a to-do');
  assert.deepEqual(warnings, ['mini-app to-do failed']);

  // Ingestion failing as a whole (e.g. an ask block) does not roll back the finished answer either.
  h.tasks.ingestBlocks = () => { throw new Error('cannot ingest'); };
  const ask = await finish(h, '```ui\n{"type":"confirm","important":true,"instructions":"Plug in the microphone"}\n```', 'run_2');
  assert.equal(ask.state, 'final');
  assert.ok(ask.body.length > 0);
  assert.deepEqual(warnings, ['mini-app to-do failed', 'chat block to-dos failed']);
});

test('fences the person or a bridge wrote, and apps without todo=true, become no to-dos', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const app = '```app title="Mixer" todo=true\n<button>Done</button>\n```';
  const human = h.chats.send({ conversationId: chat.id, body: app, authorId: HUMAN_ID, authorKind: 'human' });
  assert.deepEqual(h.tasks.ingestBlocks(human, [], []), []);
  const fromAgent = h.chats.send({ conversationId: chat.id, body: app, authorId: 'ag_ava', authorKind: 'agent' });
  assert.deepEqual(h.tasks.ingestBlocks({ ...fromAgent, authorKind: 'external' }, [], []), [], 'an external author');
  assert.deepEqual(h.tasks.ingestBlocks({ ...fromAgent, meta: { ...fromAgent.meta, via: 'bridge' } }, [], []), [], 'relayed by a bridge');
  const plain = h.chats.send({ conversationId: chat.id, body: '```app title="Calc"\n<p>1</p>\n```', authorId: 'ag_ava', authorKind: 'agent' });
  assert.deepEqual(h.tasks.ingestBlocks(plain, [], []), [], 'an app is a to-do only with todo=true');
  assert.equal(h.tasks.todos().length, 0);
  assert.equal(h.tasks.ingestBlocks(fromAgent, [], []).length, 1, 'the same fence from the agent itself is one');
});


test('a mini-app to-do keeps its widget: no "Show as…", its own icon, and todos.changeWidget refuses', async () => {
  const h = setup();
  await finish(h, VOICE_APP, 'run_1');
  const [todo] = h.tasks.todos();
  assert.throws(() => h.tasks.changeWidget(todo.id, 'confirm'), /keeps its mini-app/);
  assert.deepEqual(appFrameAttrs(appWidgetOf(todo.widget)!), { todo: true, expand: false, permissions: ['microphone'], title: 'Voice take' },
    'the list frame is always a to-do, so wf.complete works there');
});

test('appWidgetOf reads only well-formed mini-app widgets', () => {
  assert.equal(appWidgetOf(undefined), undefined);
  assert.equal(appWidgetOf({ type: 'confirm', instructions: 'x' }), undefined);
  assert.equal(appWidgetOf({ type: 'app' }), undefined);
  assert.equal(appWidgetOf({ type: 'app', messageId: 'msg_1', index: -1, permissions: [] }), undefined);
  assert.deepEqual(appWidgetOf({ type: 'app', messageId: 'msg_1', index: 2, permissions: ['camera', 'usb', 3], expand: true, approvalId: 'apr_1' }),
    { type: 'app', messageId: 'msg_1', index: 2, permissions: ['camera'], expand: true }, 'unknown permissions and extra props are dropped');
});

