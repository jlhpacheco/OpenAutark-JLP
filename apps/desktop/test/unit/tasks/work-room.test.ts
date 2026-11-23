// B-078 D7 (T1.3), KI-Runde 17.11.2026: work for an agent out of a 1:1 or a chat the person is in that it is not in reaches it in the giver's own 1:1 with it – on
// tasks.create (tasks/create.ts) and on tasks.assign (tasks/service.ts → owners.ts routeOwner); the wake lands where
// the agent is a member, and the 1:1 stays two; work given from a chat it does not land in keeps that chat (ledger.givenIn).
// Owns: these assertions only. Never: engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { findDirect, findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { joinChat } from '../../../src/runtime/tasks/owners.ts';

const isMember = (h: ReturnType<typeof harness>, conversationId: string, id: string) =>
  h.chats.members(conversationId).some((member) => member.memberId === id && !member.leftAt);

function pair() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_bob', 'Bob'));
  const direct = findOrCreateDirect(h.services, 'human', 'ag_ava', { createdBy: 'human' });
  return { ...h, direct };
}

test('T1.3: Ava creating a task for Bob in her 1:1 with the owner hands it over in her 1:1 with Bob, and wakes him there', () => {
  const h = pair();
  const task = h.tasks.create({ conversationId: h.direct, title: 'Cut the trailer', assigneeId: 'ag_bob', createdBy: 'ag_ava' });
  const room = findDirect(h.services, 'ag_ava', 'ag_bob');
  assert.ok(room, 'Ava and Bob have their 1:1 now');
  assert.equal(task.conversationId, room);
  assert.equal(isMember(h, h.direct, 'ag_bob'), false, 'the 1:1 with the owner stays two');
  const wake = h.wakeRows().find((row) => row.agent_id === 'ag_bob' && row.task_id === task.id);
  assert.equal(wake?.conversation_id, room, 'Bob is woken where he is a member');
});

test('T1.3: a task for a member of the 1:1, or created by the system, keeps its chat', () => {
  const h = pair();
  const own = h.tasks.create({ conversationId: h.direct, title: 'Draft', assigneeId: 'ag_ava', createdBy: 'human' });
  assert.equal(own.conversationId, h.direct);
  const system = h.tasks.create({ conversationId: h.direct, title: 'Check', assigneeId: 'ag_bob', createdBy: 'system' });
  assert.equal(system.conversationId, h.direct);
});


test('KI-Runde 17.11.2026: work handed from a group the person is in to an agent who is not in it lands in the giver\'s 1:1 with the receiver; nobody joins the group', async () => {
  const h = pair();
  const group = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human', title: 'Mobile apps' });
  const task = h.tasks.create({ conversationId: group.id, title: 'Build the login screen', assigneeId: 'ag_bob', createdBy: 'ag_ava', givenIn: group.id });
  const room = findDirect(h.services, 'ag_ava', 'ag_bob');
  assert.equal(task.conversationId, room, 'the work is in Ava\'s 1:1 with Bob');
  assert.equal(task.ledger.givenIn, group.id, 'and keeps the chat it was given from (Ava hears back there)');
  assert.equal(isMember(h, group.id, 'ag_bob'), false, 'Bob is not seated in the person\'s group');
  const wake = h.wakeRows().find((row) => row.agent_id === 'ag_bob' && row.task_id === task.id);
  assert.equal(wake?.conversation_id, room, 'Bob is woken where he is a member');

  const later = h.tasks.create({ conversationId: group.id, title: 'Review', assigneeId: 'ag_ava', createdBy: 'ag_ava' });
  await h.tasks.give(later.id, 'ag_bob', 'ag_ava');
  assert.equal(h.tasks.get(later.id)!.conversationId, room, 'given on, it moves to that 1:1 too');
  assert.equal(isMember(h, group.id, 'ag_bob'), false, 'giving a task on does not seat him either');

  const room2 = h.chats.create({ agentIds: ['ag_ava'], humans: false, createdBy: 'ag_ava', title: 'Agents only' });
  const inRoom = h.tasks.create({ conversationId: room2.id, title: 'Sort the mails', assigneeId: 'ag_bob', createdBy: 'ag_ava' });
  assert.equal(inRoom.conversationId, room2.id);
  assert.equal(isMember(h, room2.id, 'ag_bob'), true, 'a room of agents only still takes the receiver in');
});

test('when no work room can be made, the task stays in the person\'s chat with nobody seated; the system still seats a successor', () => {
  const h = pair();
  const group = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human', title: 'Mobile apps' });
  const task = h.tasks.create({ conversationId: group.id, title: 'Build the login screen', assigneeId: 'ag_ava', createdBy: 'human' });
  joinChat(h.tasks as unknown as Parameters<typeof joinChat>[0], group.id, 'ag_bob', 'human');
  assert.equal(isMember(h, group.id, 'ag_bob'), false, 'the error path seats nobody in a chat the person is in');
  assert.equal(h.tasks.get(task.id)!.conversationId, group.id, 'the task stays in its chat');
  joinChat(h.tasks as unknown as Parameters<typeof joinChat>[0], group.id, 'ag_bob', 'system');
  assert.equal(isMember(h, group.id, 'ag_bob'), true, 'an archived agent\'s successor still takes its seat');
});
