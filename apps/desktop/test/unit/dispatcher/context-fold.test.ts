// KI-Runde 17.11.2026 – the dispatcher's side of the context fold (agents/dispatcher.ts handOver / foldAfter / fold,
// dispatch-runs.ts fold, context-fold.ts foldWaitsFor): a main-lane turn whose outcome calls for a fold is followed by the
// fold's turn – a run of its own (reason 'fold', no chat, no notes, no wakes) that shows in the chat the work came from and is
// stopped by that chat's Stop. It runs before the agent's own background work (a task, a part's result, a schedule) and a
// colleague's line, which then read the small context; only a wake a person caused or a call the agent takes part in holds it
// back, and a fold that cannot start now is not kept. While the fold's turn runs it takes no line: a person's line cuts it at
// its next tool boundary and runs, a colleague's line waits the one turn. A crashed fold leaves no failed bubble.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import type { RunJournal } from '../../../src/runtime/contracts.ts';
import { flush, openWakes, setup } from './fakes.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { callLogOf, createCalls } from '../../../src/runtime/calls/wiring.ts';
import { fakeVoice } from '../calls/voice-fake.ts';

function world() {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_ida', 'Ida'));
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_ida'], createdBy: 'human', lead: 'ag_tom' });
  h.dispatcher.start();
  /** What turn-finish does at a turn's end: the agent has read the chat up to its newest line. */
  const seen = () => h.chats.markRead(chat.id, 'ag_tom', h.chats.messages(chat.id, { limit: 100 }).at(-1)!.seq);
  return { ...h, chat, seen };
}

test('a turn whose outcome calls for a fold is followed by the fold\'s turn: its own run on the main lane, no chat for the turn, shown in and stopped from the chat the work came from', async () => {
  const h = world();
  h.chats.send({ conversationId: h.chat.id, body: 'build the export', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1);
  h.executor.last().finish({ fold: 'step' });
  await flush();
  assert.equal(h.executor.calls.length, 2, 'nothing else is due: the fold starts');
  const fold = h.executor.last().request;
  assert.deepEqual([fold.reason, fold.fold, fold.agentId, fold.conversationId, fold.taskId, fold.notes], ['fold', 'step', 'ag_tom', undefined, undefined, []]);
  assert.notEqual(fold.runId, h.executor.calls[0].request.runId, 'a run of its own');
  const row = h.dispatcher.activity().find((entry) => entry.runId === fold.runId)!;
  assert.equal(row.conversationId, h.chat.id, 'the live bar of the chat the work came from shows it');
  assert.equal(row.fold, true, '22.11.2026: as a fold – the bar says so instead of its step');
  assert.equal(h.executor.maxRunning, 1, 'on the main lane: never beside another turn of the agent');
  assert.equal(openWakes(h.db).length, 0, 'it is no queued wake');

  await h.dispatcher.interrupt('ag_tom', h.chat.id); // the person's Stop in that chat
  await flush();
  assert.equal(fold.signal.aborted, true, 'the chat\'s Stop reaches the fold\'s turn');
  assert.equal(fold.control.stopKind, 'human');
  assert.equal(h.executor.calls.length, 2, 'a stopped fold is not started again by itself');
  assert.equal(h.dispatcher.activity().length, 0);
});

test('a person\'s line that waits runs first and the fold is not kept: the next turn\'s end asks again', async () => {
  const h = world();
  h.chats.send({ conversationId: h.chat.id, body: 'one', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: h.chat.id, body: 'two', authorId: 'human' }); // its wake waits (this engine never steers)
  await flush();
  h.executor.last().finish({ fold: 'step' });
  await flush();
  assert.equal(h.executor.calls.length, 2);
  assert.equal(h.executor.last().request.reason, 'message', 'the person\'s line runs, not the fold');
  h.executor.last().finish(); // this turn's outcome asks for nothing
  await flush();
  assert.equal(h.executor.calls.length, 2, 'no fold from the earlier turn\'s wish: it is asked for again only by a turn\'s own end');
  h.chats.send({ conversationId: h.chat.id, body: 'three', authorId: 'human' });
  await flush();
  h.executor.last().finish({ fold: 'size' });
  await flush();
  assert.deepEqual([h.executor.calls.length, h.executor.last().request.reason, h.executor.last().request.fold], [4, 'fold', 'size']);
  h.executor.last().finish(); // a fold's own outcome never asks for a fold
  await flush();
  assert.equal(h.executor.calls.length, 4);
});

test('my own background work and a colleague\'s line wait the one turn the fold takes, then read the small context', async () => {
  const h = world();
  h.chats.send({ conversationId: h.chat.id, body: 'build the export', authorId: 'human' });
  await flush();
  h.seen();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', taskId: 'task_1' });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'child', note: 'a part is back' });
  h.chats.send({ conversationId: h.chat.id, body: 'the data is in out/', authorId: 'ag_ida', authorKind: 'agent', mentions: ['ag_tom'] });
  await flush();
  assert.ok(h.wakes.dueAgents().includes('ag_tom'), 'work is due for the agent at the turn\'s end');
  h.executor.last().finish({ fold: 'step' });
  await flush();
  assert.equal(h.executor.calls.length, 2);
  assert.equal(h.executor.last().request.reason, 'fold', 'the fold goes first');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 3);
  assert.notEqual(h.executor.last().request.reason, 'fold', 'then the waiting work runs');
  assert.equal(h.executor.maxRunning, 1);
});

test('a running call in one of my chats holds the fold back; an answer of the person does too', async () => {
  const h = world();
  createCalls(h.services as unknown as RuntimeServices, { voice: fakeVoice(() => '').opener });
  h.chats.send({ conversationId: h.chat.id, body: 'build the export', authorId: 'human' });
  await flush();
  const pc = { key: 'pc', name: 'laptop' };
  const callId = callLogOf(h.services)!.start(h.chat.id, pc);
  h.executor.last().finish({ fold: 'size' });
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no fold turn while the call runs');
  callLogOf(h.services)!.end(callId, pc.key);

  h.chats.send({ conversationId: h.chat.id, body: 'and now?', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 2);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'answer', conversationId: h.chat.id, note: '[ui-answer] yes' });
  await flush();
  h.executor.last().finish({ fold: 'size' });
  await flush();
  assert.equal(h.executor.calls.length, 3);
  assert.equal(h.executor.last().request.reason, 'answer', 'the person\'s answer runs, not the fold');
});

test('a person\'s line cuts the fold\'s turn and runs; a colleague\'s line waits the one turn and loses nothing; an important one cuts it too', async () => {
  const h = world();
  const steered: string[] = [];
  const steering = { steer: async (_runId: string, text: string) => { steered.push(text); return true; } } as unknown as Engine;
  h.chats.send({ conversationId: h.chat.id, body: 'build the export', authorId: 'human' });
  await flush();
  h.seen();
  h.executor.last().request.control.engine = steering;
  h.executor.last().finish({ fold: 'step' });
  await flush();
  const fold = h.executor.last();
  fold.request.control.engine = steering; // an engine that takes lines into a running turn
  assert.equal(fold.request.reason, 'fold');

  const line = h.chats.send({ conversationId: h.chat.id, body: 'the import is next', authorId: 'ag_ida', authorKind: 'agent', mentions: ['ag_tom'] });
  await flush();
  assert.deepEqual(steered, [], 'nothing is folded into the fold\'s turn');
  assert.equal(await h.dispatcher.steer('ag_tom', h.chat.id), false);
  assert.equal(fold.request.signal.aborted, false, 'a colleague\'s line does not cut it');
  assert.equal(h.executor.calls.length, 2);
  assert.ok(openWakes(h.db).some((row) => row.conversation_id === h.chat.id && row.reason === 'message'), 'its wake waits');
  fold.finish();
  await flush();
  assert.equal(h.executor.calls.length, 3, 'the line\'s turn follows the fold');
  const answer = h.executor.last().request;
  assert.deepEqual([answer.reason, answer.conversationId], ['message', h.chat.id]);
  const member = h.chats.members(h.chat.id).find((item) => item.memberId === 'ag_tom')!;
  assert.ok(member.readSeq < line.seq, 'the line is still unseen when its own turn starts: nothing was marked read by the fold');

  // the person's normal line cuts the fold's turn at its next tool boundary (none runs here: at once); that chat runs next
  h.seen();
  h.executor.last().request.control.engine = steering;
  h.executor.last().finish({ fold: 'size' });
  await flush();
  const second = h.executor.last();
  assert.equal(second.request.reason, 'fold');
  second.request.control.engine = steering;
  h.chats.send({ conversationId: h.chat.id, body: 'and the import too', authorId: 'human' });
  await flush();
  assert.equal(second.request.signal.aborted, true, 'the person goes first');
  assert.equal(second.request.control.stopKind, 'urgent');
  await flush();
  assert.deepEqual([h.executor.last().request.reason, h.executor.last().request.conversationId], ['message', h.chat.id], 'the person\'s line runs next');

  // an important line cuts it the same way
  h.seen();
  h.executor.last().request.control.engine = steering;
  h.executor.last().finish({ fold: 'size' });
  await flush();
  const third = h.executor.last();
  assert.equal(third.request.reason, 'fold');
  third.request.control.engine = steering;
  h.chats.send({ conversationId: h.chat.id, body: 'stop everything, this first', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(third.request.signal.aborted, true, 'cut at its next tool boundary');
  await flush();
  assert.deepEqual([h.executor.last().request.reason, h.executor.last().request.conversationId], ['message', h.chat.id], 'the important line runs next');
  assert.deepEqual(steered, []);
});

/** review2 fix-turnloop/fold-cuts: Tom folds in a chat with `chatAgents`; his engine takes lines into a running turn. */
async function folding(chatAgents: string[]) {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_ida', 'Ida'));
  h.org.add(agent('ag_max', 'Max'));
  const chat = h.chats.create({ agentIds: chatAgents, createdBy: 'human', lead: 'ag_tom' });
  h.dispatcher.start();
  const steering = { steer: async () => true } as unknown as Engine;
  h.chats.send({ conversationId: chat.id, body: '@Tom build the export', authorId: 'human', mentions: ['ag_tom'] });
  await flush();
  const first = h.executor.calls.find((c) => c.request.agentId === 'ag_tom')!;
  h.chats.markRead(chat.id, 'ag_tom', h.chats.messages(chat.id, { limit: 100 }).at(-1)!.seq);
  first.request.control.engine = steering;
  first.finish({ fold: 'size' });
  await flush();
  const fold = h.executor.calls.find((c) => c.request.agentId === 'ag_tom' && c.request.reason === 'fold')!;
  assert.ok(fold, 'the fold runs');
  fold.request.control.engine = steering;
  return { h, chat, fold };
}

test('a colleague\'s push line leaves the fold running; its chat runs right after the fold', async () => {
  const { h, chat, fold } = await folding(['ag_tom', 'ag_ida']);
  h.chats.send({ conversationId: chat.id, body: 'urgent: look at the import', authorId: 'ag_ida', authorKind: 'agent', priority: 'important', mentions: ['ag_tom'] });
  await flush();
  assert.equal(fold.request.signal.aborted, false, 'a colleague\'s line waits the one turn the fold takes');
  fold.finish();
  await flush();
  const next = h.executor.calls.filter((c) => c.request.agentId === 'ag_tom').at(-1)!.request;
  assert.deepEqual([next.reason, next.conversationId], ['message', chat.id], 'the push line\'s turn follows the fold');
});

test('a colleague\'s line leaves the fold running also where an older quiet line of the person waits unseen (review 3)', async () => {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_ida', 'Ida'));
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_ida'], createdBy: 'human', lead: 'ag_tom' });
  h.dispatcher.start();
  const steering = { steer: async () => true } as unknown as Engine;
  h.chats.send({ conversationId: chat.id, body: '@Tom build the export', authorId: 'human', mentions: ['ag_tom'] });
  await flush();
  const first = h.executor.last();
  h.chats.markRead(chat.id, 'ag_tom', h.chats.messages(chat.id, { limit: 100 }).at(-1)!.seq);
  first.request.control.engine = steering;
  h.chats.send({ conversationId: chat.id, body: 'noted for later', authorId: 'human', silent: true }); // quiet: no wake, unseen
  await flush();
  h.clock.advance(1_000);
  first.finish({ fold: 'size' });
  await flush();
  const fold = h.executor.last();
  assert.equal(fold.request.reason, 'fold', 'a quiet line holds no fold back');
  fold.request.control.engine = steering;
  h.chats.send({ conversationId: chat.id, body: 'the import is next', authorId: 'ag_ida', authorKind: 'agent', mentions: ['ag_tom'] });
  await flush();
  assert.equal(fold.request.signal.aborted, false, 'the older quiet line is no new line of the person');
  h.chats.send({ conversationId: chat.id, body: 'and the import too', authorId: 'human' });
  await flush();
  assert.equal(fold.request.signal.aborted, true, 'a new line of the person still cuts it');
});

test('a person\'s group line for a colleague leaves my fold running; an urgent task does too', async () => {
  const { h, chat, fold } = await folding(['ag_tom', 'ag_ida', 'ag_max']);
  h.chats.send({ conversationId: chat.id, body: '@Ida what is the weather', authorId: 'human', mentions: ['ag_ida'] });
  await flush(); await flush();
  assert.equal(fold.request.signal.aborted, false, 'a line for someone else never cuts my fold');
  await h.dispatcher.urgent('ag_tom', chat.id, 'task_urgent');
  await flush();
  assert.equal(fold.request.signal.aborted, false, 'an urgent task waits the one turn too');
});

test('a fold\'s turn that crashes leaves no failed bubble and is not retried', async () => {
  const h = world();
  h.services.runs = { ...h.services.runs, get: (runId: string) => ({ id: runId, status: 'running' }) } as unknown as RunJournal; // every run still open when it crashes
  h.chats.send({ conversationId: h.chat.id, body: 'build the export', authorId: 'human' });
  await flush();
  h.executor.throwNext = true; // the fold's executor throws
  h.executor.last().finish({ fold: 'step' });
  await flush();
  assert.equal(h.executor.calls.length, 1, 'the fold started and crashed before its turn ran');
  assert.equal(h.chats.messages(h.chat.id, { limit: 20 }).some((message) => message.state === 'failed'), false, 'no failed bubble in the chat it only shows in');
  assert.equal(h.dispatcher.activity().length, 0, 'the lane is free');
  await flush();
  assert.equal(h.executor.calls.length, 1, 'and nothing retries it');
});
