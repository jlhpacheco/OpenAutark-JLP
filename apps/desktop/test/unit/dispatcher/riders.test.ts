// Runde „Halb“ 21.11.2026 – one turn takes what is due at its start: chat groups due beside the group that runs ride along
// in its turn (dispatch-groups.ts ridersOf, dispatcher.ts pumpNow, dispatch-runs.ts riderWakeIds); groups whose handling
// needs a turn of their own stay alone – round 2: every chat with a person's line or answer. Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { groupWakes, ridersOf } from '../../../src/runtime/agents/dispatch-groups.ts';
import { flush, openWakes, setup } from './fakes.ts';

function team() {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  return h;
}

test("person in chat A, colleague in chat B, person in chat C: A runs, B rides along, C keeps its own turn; a line after the start is not swallowed", async () => {
  const h = team();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ title: 'Release room', agentIds: ['ag_tom', 'ag_lea'], humans: false, createdBy: 'ag_lea' });
  const c = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.send({ conversationId: a.id, body: 'Where is the offer?', authorId: 'human' });
  h.clock.advance(1000);
  h.chats.send({ conversationId: b.id, body: '@Tom the build is green', authorId: 'ag_lea', authorKind: 'agent', mentions: ['ag_tom'] });
  h.clock.advance(1000);
  h.chats.send({ conversationId: c.id, body: 'And the invoice?', authorId: 'human' });
  h.dispatcher.start();
  await flush();
  assert.equal(h.executor.calls.length, 1);
  const request = h.executor.last().request;
  assert.equal(request.conversationId, a.id, "the person's chat is what the turn is about");
  assert.equal(request.reason, 'message');
  assert.deepEqual(request.riders, [{ conversationId: b.id, notes: [] }], "the colleague's chat rides along, the other person's does not");
  assert.deepEqual(openWakes(h.db).map((row) => [row.conversation_id, row.claimed_at !== null]), [[a.id, true], [b.id, true], [c.id, false]]);
  h.chats.send({ conversationId: b.id, body: '@Tom one more thing', authorId: 'ag_lea', authorKind: 'agent', mentions: ['ag_tom'] }); // after the start
  await flush();
  assert.equal(openWakes(h.db).filter((row) => row.conversation_id === b.id && row.claimed_at === null).length, 1, 'its own wake, not swallowed');
  h.executor.last().finish();
  await flush();
  // The later line was offered to the running turn, so its chat runs first after it (the steer pick, as before); C waits its own turn.
  assert.equal(h.executor.last().request.conversationId, b.id, 'the later colleague line');
  assert.equal(h.executor.last().request.riders, undefined, "the other person's chat does not ride");
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, c.id, "the other person's chat gets its own turn");
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 3);
  assert.equal(openWakes(h.db).length, 0, "every wake – the riders' too – is done");
});

test("a person's answer ('answer') or a person's line never rides along", async () => {
  const h = team();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const room = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], humans: false, createdBy: 'ag_lea' });
  h.chats.send({ conversationId: a.id, body: 'hello', authorId: 'human' });
  h.clock.advance(1000);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'answer', conversationId: room.id, note: '[ui-answer] ship it' });
  h.dispatcher.start();
  await flush();
  assert.equal(h.executor.last().request.riders, undefined);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, room.id, 'the answer gets its own turn');
  h.executor.last().finish();
  await flush();
});

test('a task wake and a line: the line runs, the task keeps its own turn (its route, pause and ownership are its own)', async () => {
  const h = team();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const other = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', conversationId: other.id, taskId: 'task_x', note: 'Lea gave me "Report".' });
  h.clock.advance(1000);
  h.chats.send({ conversationId: chat.id, body: 'hello', authorId: 'human' });
  h.dispatcher.start();
  await flush();
  assert.equal(h.executor.last().request.conversationId, chat.id);
  assert.equal(h.executor.last().request.riders, undefined, 'the task does not ride');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.taskId, 'task_x', 'its own turn follows');
  h.executor.last().finish();
  await flush();
});

test('ridersOf: a task group carries a line of another chat; what needs a turn of its own stays alone', () => {
  const h = team();
  const work = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const plain = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], humans: false, createdBy: 'ag_lea' });
  const person = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const call = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const foreign = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  h.chats.send({ conversationId: plain.id, body: 'a line', authorId: 'ag_lea', authorKind: 'agent' });
  h.chats.send({ conversationId: person.id, body: 'a line of mine', authorId: 'human' });
  h.chats.send({ conversationId: call.id, body: 'Spoken question', authorId: 'human', meta: { call: { id: 'call_one', participant: 'device:pc', name: 'You' } } });
  const wake = (id: string, patch: Record<string, unknown>) => ({ id, agentId: 'ag_tom', reason: 'message' as const, dueAt: 0, createdAt: 0, attempts: 1, ...patch });
  const groups = groupWakes([
    wake('w_task', { reason: 'task', conversationId: work.id, taskId: 'task_1' }),
    wake('w_plain', { conversationId: plain.id }),
    wake('w_person', { conversationId: person.id }),
    wake('w_call', { conversationId: call.id }),
    wake('w_foreign', { conversationId: foreign.id }),
    wake('w_child', { reason: 'child', conversationId: work.id, taskId: 'task_2', note: 'Lea finished' }),
    wake('w_sched', { reason: 'schedule', conversationId: work.id, origin: { source: 'schedule:sch_1', label: 'Reminder' } }),
    wake('w_retry', { reason: 'retry', conversationId: work.id, note: 'My last turn here was cut off' }),
    wake('w_gone', { reason: 'answer', conversationId: 'ch_gone', note: 'yes' }),
  ]);
  const main = groups.find((group) => group.taskId === 'task_1')!;
  const riding = ridersOf(h.chats, 'ag_tom', main, groups.filter((group) => group !== main));
  assert.deepEqual(riding.flatMap((group) => group.wakes.map((item) => item.id)), ['w_plain'],
    "a person's line, a call line, a chat I am not in, a task, a schedule, a retry and a person's answer stay alone");
  const mail = { ...main, origin: { source: 'app:mail', label: 'Mail' } };
  assert.deepEqual(ridersOf(h.chats, 'ag_tom', mail as never, riding), [], "a mail's own turn carries nothing");
});
