// Per-task threads (Quests round 20.11.2026, owner: "pro einzelnen Task einen Chat …, also einen Verlauf";
// src/runtime/tasks/thread.ts): a task's thread is the conversation whose id is the task id, made on demand with the
// people it concerns, its owner as lead and its giver, named by its task; <chat to="task_…"> makes or joins it for an
// agent that reads the task, and only then; a person's line there wakes the task's owner with the task, without a pick;
// it is in no chat list and not in an agent's "## My chats"; an event line wakes and notifies nobody and is never news;
// an agent's line is news for the person and its notification names the task; a give makes the new owner lead quietly;
// a person's own to-do without an agent has their assistant as lead (R2.1) – an "Only me" one too: "Only me" hides
// nothing (owner 20.11.2026), agents write into its thread and nobody is taken out when it turns "Only me".
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import { dropThread, threadEvent, threadNews, threadOf } from '../../../src/runtime/tasks/thread.ts';
import { chatTitleFor } from '../../../src/runtime/chat/titles.ts';
import { ChatOutbox } from '../../../src/runtime/agents/chat-out.ts';
import { chatOverview } from '../../../src/runtime/context/chat-overview.ts';
import { agent, harness, tick } from './harness.ts';

function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  for (const [id, name] of [['ag_ada', 'Ada'], ['ag_tom', 'Tom'], ['ag_lin', 'Lin']]) h.org.add(agent(id, name));
  h.services.runs = { item: () => undefined } as never;
  const s = h.services as RuntimeServices;
  /** The person's work for Tom, without a chat. */
  const mine = h.tasks.create({ title: 'Cut the launch video', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  /** Tom's work, given by Ada (no person in it). */
  const given = h.tasks.create({ title: 'Sign the Windows installer', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: 'ag_ada' });
  const members = (id: string) => h.chats.members(id).map((member) => member.memberId).sort();
  const clear = () => { h.db.run('DELETE FROM wakes'); h.notified.length = 0; };
  return { ...h, s, mine, given, members, clear };
}

const code = (error: unknown) => (error as { code?: string }).code;

test('a task\'s thread is the conversation with the task\'s id, made on demand: its people, its owner as lead, its giver', () => {
  const h = setup();
  assert.equal(h.chats.get(h.mine.id), undefined, 'nothing before it is needed');
  const thread = threadOf(h.s, h.mine.id);
  assert.equal(thread.id, h.mine.id);
  assert.deepEqual(h.members(thread.id), ['ag_tom', HUMAN_ID]);
  assert.equal(h.chats.lead(thread.id), 'ag_tom', 'its owner leads it');
  assert.equal(thread.settings.history, 'full', 'whoever joins later reads all of it');
  assert.equal(threadOf(h.s, h.mine.id).id, thread.id);
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE id = ?', [h.mine.id])?.n, 1, 'one thread per task');
  assert.deepEqual(h.members(threadOf(h.s, h.given.id).id), ['ag_ada', 'ag_tom'], 'agents\' work: its owner and its giver, no person');
  assert.throws(() => threadOf(h.s, 'task_zz9zz9zz'), (error: Error) => code(error) === 'not_found');
  const left = h.tasks.create({ title: 'Old invoice', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  h.db.run('UPDATE tasks SET created_by = ?, assigned_by = ? WHERE id = ?', ['per_gone0001', 'per_gone0001', left.id]); // made by a colleague who left since
  assert.deepEqual(h.members(threadOf(h.s, left.id).id), ['ag_tom'], 'a colleague no longer in the organisation is no member');
});

test('a task\'s thread is named by its task – a person\'s first line never renames it', () => {
  const h = setup();
  threadOf(h.s, h.mine.id);
  h.chats.send({ conversationId: h.mine.id, authorId: HUMAN_ID, body: 'Please keep it under two minutes.' });
  assert.equal(h.chats.get(h.mine.id)!.title, '');
  assert.equal(chatTitleFor(h.s, h.mine.id, 'ag_tom'), 'Cut the launch video');
});

test('<chat to="task_…">: an agent that reads the task joins its thread quietly and posts there', async () => {
  const h = setup();
  threadOf(h.s, h.given.id);
  const out = new ChatOutbox(h.s, { agentId: 'ag_lin', runId: 'run_lin' });
  out.segment(`Checking.\n<chat to="${h.given.id}">I have the certificate, Tom.</chat>`, true);
  await out.done();
  assert.deepEqual(out.notes, []);
  assert.deepEqual(h.chats.messages(h.given.id, { limit: 20 }).map((line) => [line.authorId, line.kind, line.body]),
    [['ag_lin', 'text', 'I have the certificate, Tom.']], 'no "Added Lin" line');
  assert.deepEqual(h.members(h.given.id), ['ag_ada', 'ag_lin', 'ag_tom']);
  assert.equal(h.chats.lead(h.given.id), 'ag_tom');
  // the first line makes the thread
  const fresh = h.tasks.create({ title: 'Renew the domain', assigneeKind: 'agent', assigneeId: 'ag_ada', createdBy: HUMAN_ID });
  const first = new ChatOutbox(h.s, { agentId: 'ag_ada', runId: 'run_ada' });
  first.segment(`<chat to="${fresh.id}">Renewed until 2028.</chat>`, true);
  await first.done();
  assert.equal(h.chats.messages(fresh.id, { limit: 5 })[0]?.body, 'Renewed until 2028.');
});

test('an "Only me" task hides nothing: an agent writes into its thread like any other; an unknown task is refused', async () => {
  const h = setup();
  const own = h.tasks.create({ title: 'Doctor appointment', assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  const out = new ChatOutbox(h.s, { agentId: 'ag_lin', runId: 'run_lin' });
  out.segment(`<chat to="${own.id}">I found two free slots on Friday.</chat>\n<chat to="task_zz9zz9zz">Hello?</chat>`, true);
  await out.done();
  assert.deepEqual(h.chats.messages(own.id, { limit: 5 }).map((line) => [line.authorId, line.body]), [['ag_lin', 'I found two free slots on Friday.']]);
  assert.ok(h.members(own.id).includes('ag_lin'), 'it joined');
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /not posted: Task task_zz9zz9zz not found/);
  assert.throws(() => threadOf(h.s, 'task_zz9zz9zz', 'ag_lin'), (error: Error) => code(error) === 'not_found');
});

test('a person\'s line in a task\'s thread wakes the task\'s owner with the task – no pick among the agents there', async () => {
  let picks = 0;
  const decisions: DecisionService = { available: () => true, decide: async () => { picks++; return { choice: 'Ada', confidence: 0.9, by: 'fake' }; } };
  const h = setup({ decisions });
  threadOf(h.s, h.given.id); // Ada and Tom
  h.clear();
  h.chats.send({ conversationId: h.given.id, authorId: HUMAN_ID, body: 'Use the new certificate, please.' });
  await tick();
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.reason, row.conversation_id, row.task_id]), [['ag_tom', 'message', h.given.id, h.given.id]]);
  assert.equal(picks, 0);
  // an @mention still reaches exactly the one named, with the task
  h.clear();
  h.chats.send({ conversationId: h.given.id, authorId: HUMAN_ID, body: '@Ada where is the old one?' });
  await tick();
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.task_id]), [['ag_ada', h.given.id]]);
});

test('a task\'s thread is in no chat list and not in an agent\'s "## My chats"', () => {
  const h = setup();
  const room = h.chats.create({ title: 'Launch', agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  threadOf(h.s, h.mine.id);
  const ids = (list: Array<{ id: string }>) => list.map((chat) => chat.id);
  for (const list of [h.chats.list(), h.chats.list({ includeHidden: true }), h.chats.list({ forMember: 'ag_tom', includeHidden: true })]) {
    assert.ok(ids(list).includes(room.id));
    assert.ok(!ids(list).includes(h.mine.id));
  }
  assert.ok(ids(h.chats.list({ includeHidden: true, threads: true })).includes(h.mine.id), 'asked for: there (the start-up sweep)');
  const overview = chatOverview(h.s, 'ag_tom');
  assert.match(overview, new RegExp(room.id));
  assert.doesNotMatch(overview, new RegExp(h.mine.id));
});

test('an event line is quiet: no wake, no notification, never news – an agent\'s line is news and its notice names the task', () => {
  const h = setup();
  threadOf(h.s, h.mine.id);
  h.clear();
  const line = threadEvent(h.s, h.mine.id, 'You → Tom', HUMAN_ID);
  assert.equal(line?.kind, 'status');
  assert.equal(line?.silent, true);
  assert.equal(line?.taskId, h.mine.id);
  assert.deepEqual(h.wakeRows(), []);
  assert.equal(h.notified.length, 0, 'nobody is notified');
  assert.deepEqual(threadNews(h.s, HUMAN_ID), []);
  assert.equal(threadEvent(h.s, 'task_zz9zz9zz', 'Lost'), undefined, 'an unknown task: logged, never thrown');
  const said = h.chats.send({ conversationId: h.mine.id, authorId: 'ag_tom', body: 'The first cut is up.' });
  assert.deepEqual(threadNews(h.s, HUMAN_ID), [h.mine.id], 'the dot on the task');
  assert.deepEqual(threadNews(h.s, 'ag_tom'), [], 'never one\'s own line');
  assert.equal(h.notified.at(-1)?.title, 'Tom · Cut the launch video');
  assert.equal(h.notified.at(-1)?.conversationId, h.mine.id, 'a tap opens the thread – its task (ui router chatRoute)');
  h.chats.markRead(h.mine.id, HUMAN_ID, said.seq);
  assert.deepEqual(threadNews(h.s, HUMAN_ID), []);
});

test('an event line makes the thread when there is none; a give makes the new owner lead, quietly', async () => {
  const h = setup();
  threadEvent(h.s, h.mine.id, 'Waiting on the music');
  assert.deepEqual(h.members(h.mine.id), ['ag_tom', HUMAN_ID]);
  await h.tasks.give(h.mine.id, 'ag_lin', HUMAN_ID);
  threadOf(h.s, h.mine.id);
  assert.equal(h.chats.lead(h.mine.id), 'ag_lin');
  assert.ok(h.members(h.mine.id).includes('ag_tom'), 'nobody is taken out');
  assert.equal(h.chats.messages(h.mine.id, { limit: 50 }).filter((line) => /^Added |leads this chat/.test(line.body)).length, 0);
});

test('work made inside a thread turn is handed over in that thread; a removed task takes its thread along', () => {
  const h = setup();
  threadOf(h.s, h.mine.id);
  const piece = h.tasks.create({ conversationId: h.mine.id, title: 'Pick the music', assigneeKind: 'human', createdBy: 'ag_tom' });
  assert.equal(piece.conversationId, h.mine.id);
  assert.ok(h.chats.messages(h.mine.id, { limit: 20 }).some((line) => line.kind === 'task' && line.taskId === piece.id), 'its card is in the thread');
  dropThread(h.s, h.mine.id);
  assert.equal(h.chats.get(h.mine.id), undefined);
  dropThread(h.s, h.mine.id); // nothing left: nothing happens
});

test('the start-up sweep sees a person\'s unanswered line in a task\'s thread', () => {
  const h = setup();
  threadOf(h.s, h.mine.id);
  h.chats.send({ conversationId: h.mine.id, authorId: HUMAN_ID, body: 'Is it done?', deliver: false });
  h.clear();
  assert.equal(h.delivery.recover(), 1);
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.task_id]), [['ag_tom', h.mine.id]]);
});

test('R2.1: a line under the person\'s own to-do reaches their assistant, the lead of its thread – an "Only me" one too; an agent\'s ask keeps its asker', async () => {
  const h = setup();
  h.org.add(agent('ag_sec', 'Sekretariat', { template: 'secretary' }));
  const own = h.tasks.create({ title: 'Water the plants', assigneeKind: 'human', createdBy: HUMAN_ID });
  const thread = threadOf(h.s, own.id, HUMAN_ID);
  assert.deepEqual(h.members(thread.id), ['ag_sec', HUMAN_ID]);
  assert.equal(h.chats.lead(thread.id), 'ag_sec');
  h.clear();
  h.chats.send({ conversationId: own.id, authorId: HUMAN_ID, body: 'Where is the watering can?' });
  await tick();
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.task_id]), [['ag_sec', own.id]], 'the assistant hears it, with the to-do');
  const ask = h.tasks.create({ title: 'Pick a colour', assigneeKind: 'human', createdBy: 'ag_tom' });
  assert.deepEqual(h.members(threadOf(h.s, ask.id, HUMAN_ID).id), ['ag_tom', HUMAN_ID], 'an agent\'s ask: the asker hears the answer');
  const secret = h.tasks.create({ title: 'Doctor appointment', assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  assert.deepEqual(h.members(threadOf(h.s, secret.id, HUMAN_ID).id), ['ag_sec', HUMAN_ID], '"Only me": theirs to do, the assistant helps around it');
  assert.equal(h.chats.lead(secret.id), 'ag_sec');
  const later = h.tasks.create({ title: 'Call the bank', assigneeKind: 'human', createdBy: HUMAN_ID });
  threadOf(h.s, later.id, HUMAN_ID);
  threadOf(h.s, later.id, 'ag_lin'); // an agent that joins later
  assert.equal(h.chats.lead(later.id), 'ag_sec', 'the assistant stays its lead');
  h.tasks.update(later.id, { private: true }, HUMAN_ID);
  assert.deepEqual(h.members(later.id), ['ag_lin', 'ag_sec', HUMAN_ID], 'turning "Only me" takes nobody out');
});
