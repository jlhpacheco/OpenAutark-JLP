// chats.thread with { taskId } and chats.threadNews (Quests round 20.11.2026; src/runtime/rpc/handlers/chats.ts,
// src/runtime/people/rpc-chats.ts): the owner's window and a person's device open a task's own thread as a summary –
// made when missing; a colleague joins the thread of a task they read and never gets one they do not –, read which
// tasks' threads hold lines they have not read (the dot on a task), and a colleague's device titles a pushed line with
// the task; a colleague's own PC gets the thread and its whole history (devices/sync/tables.ts employee rules). The
// B-078 form ({ messageId }) stays.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { pushPeopleMessages } from '../../../src/runtime/pwa/person-push.ts';
import { TABLE, type Wire } from '../../../src/runtime/devices/sync/tables.ts';
import { threadOf } from '../../../src/runtime/tasks/thread.ts';
import { OWNER, rpcFixture, TestClient } from '../rpc/s1-helpers.ts';
import { peopleRig } from '../people/rig.ts';
import { agent } from './harness.ts';

test('owner: chats.thread { taskId } opens the task\'s thread as a summary; chats.threadNews names the tasks with unread lines', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  f.org.add(agent('ag_tom', 'Tom'));
  const task = f.tasks.create({ title: 'Cut the launch video', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  const owner = new TestClient(f.server, OWNER);
  const thread = await owner.call<ConversationSummary>('chats.thread', { taskId: task.id });
  assert.equal(thread.id, task.id);
  assert.deepEqual(thread.members.map((member) => member.memberId).sort(), ['ag_tom', HUMAN_ID]);
  assert.deepEqual(await owner.call<string[]>('chats.threadNews'), []);
  f.chats.send({ conversationId: task.id, authorId: 'ag_tom', body: 'The first cut is up.' });
  assert.deepEqual(await owner.call<string[]>('chats.threadNews'), [task.id]);
  assert.equal((await owner.call<ConversationSummary>('chats.thread', { taskId: task.id })).unread, 1);
  assert.equal((await owner.request('chats.thread', { taskId: 'task_zz9zz9zz' })).error?.code, 'not_found');
  const room = f.chats.create({ title: 'Launch', agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  const line = f.chats.send({ conversationId: room.id, authorId: HUMAN_ID, body: 'Who picks the music?' });
  const onMessage = await owner.call<ConversationSummary>('chats.thread', { messageId: line.id });
  assert.equal(onMessage.settings.anchorId, line.id, 'a message\'s thread as before');
});

test('a colleague: their to-do\'s thread opens on their device, its news is theirs; a task they do not read stays hidden', async (t) => {
  const r = peopleRig();
  t.after(r.cleanup);
  const anna = await r.join('Anna');
  const todo = r.tasks.create({ title: 'Record the intro', assigneeKind: 'human', assigneeId: anna.person.id, createdBy: 'ag_research' });
  const thread = await anna.client.call<ConversationSummary>('chats.thread', { taskId: todo.id });
  assert.equal(thread.id, todo.id);
  assert.ok(r.chats.members(todo.id).some((member) => member.memberId === anna.person.id), 'she is in it');
  const pushed: Array<{ personId: string; title: string }> = [];
  const stop = pushPeopleMessages(r.services, { sendToPerson: async (personId, message) => { pushed.push({ personId, title: message.title }); return 1; } });
  t.after(stop);
  r.chats.send({ conversationId: todo.id, authorId: 'ag_research', body: 'Two takes are enough.' });
  assert.deepEqual(pushed, [{ personId: anna.person.id, title: 'Record the intro' }], 'the push names the task');
  assert.deepEqual(await anna.client.call<string[]>('chats.threadNews'), [todo.id]);
  const other = r.tasks.create({ title: 'Payroll', assigneeKind: 'agent', assigneeId: 'ag_secret', createdBy: HUMAN_ID });
  assert.equal((await anna.client.request('chats.thread', { taskId: other.id })).error?.code, 'not_found');
  assert.equal(r.chats.get(other.id), undefined, 'nothing made for her there');
});

test('sync to a colleague\'s own PC: the thread of her task and all its lines go there – also lines from before she joined', async (t) => {
  const r = peopleRig();
  t.after(r.cleanup);
  const anna = await r.join('Anna');
  const todo = r.tasks.create({ title: 'Record the intro', assigneeKind: 'agent', assigneeId: 'ag_research', createdBy: HUMAN_ID });
  r.chats.send({ conversationId: threadId(r, todo.id), authorId: 'ag_research', body: 'Draft script attached.' }); // before Anna is in it
  await r.tasks.give(todo.id, anna.person.id, HUMAN_ID);
  await anna.client.call<ConversationSummary>('chats.thread', { taskId: todo.id }); // she opens it: joins
  const conversations = TABLE.get('conversations')!;
  const row = r.db.get<Wire>('SELECT * FROM conversations WHERE id = ?', [todo.id])!;
  assert.equal(conversations.employee!(conversations.view?.(row, 'dev_self', r.services) ?? row, anna.person.id, r.db), true);
  const early = r.db.get<Wire>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT 1', [todo.id])!;
  assert.equal(TABLE.get('messages')!.employee!(early, anna.person.id, r.db), true, 'the whole history (settings.history full)');
});

/** The task's thread, made now (the owner opens the task). */
function threadId(r: ReturnType<typeof peopleRig>, taskId: string): string {
  return threadOf(r.services, taskId, HUMAN_ID).id;
}
