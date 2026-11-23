// What the task tools keep private (FIXRTA 20.11.2026, review R1 findings 1 and 2 – the reviewer's scratch tests made
// real): the person's line a turn started from is quoted whole into a new task's thread only when every person of that
// thread reads the chat it was written in – else its link stands there, its words stay where they were written; a person
// who joins the thread later (the to-do given to her) finds only that link too. "Only me" is no privacy (owner
// 20.11.2026): the person's "Only me" to-do inside an agent's quest is named, counted and marked "only me".
// Owns: these assertions only. Never: real engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { LINE_ELSEWHERE } from '../../../src/runtime/tasks/thread.ts';
import { myQuestsSection } from '../../../src/runtime/context/quest-text.ts';
import { peopleRig } from '../people/rig.ts';

const PRIVATE = 'Anna soll das Intro aufnehmen. PRIVAT: der Kunde will sie eigentlich loswerden.';

function rig(t: { after: (fn: () => void) => void }) {
  const r = peopleRig();
  t.after(r.cleanup);
  const services = r.services as RuntimeServices;
  services.runs = { item: () => undefined } as never;
  const ctx = (conversationId: string): ToolContext => ({
    agent: services.org.get('ag_research')!, runId: 'run_1', conversationId, mode: 'general', services,
    signal: new AbortController().signal, status: () => {},
  });
  const run = async (name: string, args: Record<string, unknown>, context: ToolContext) => {
    const out = await taskTools.find((tool) => tool.name === name)!.run(args as never, context);
    const text = String((out.content[0] as { text?: string }).text);
    assert.equal(out.isError, undefined, text);
    return text;
  };
  const kept = (taskId: string) => r.chats.messages(taskId, { limit: 20 }).filter((line) => line.meta.status?.details?.quote).map((line) => line.meta.status?.text);
  return { ...r, services, ctx, run, kept };
}

test('R1.1: the owner\'s line in his 1:1 never reaches a colleague\'s thread – its link does; a thread whose people read the chat gets it whole', async (t) => {
  const r = rig(t);
  const anna = await r.join('Anna');
  const own = r.chats.create({ agentIds: ['ag_research'], createdBy: HUMAN_ID });
  const line = r.chats.send({ conversationId: own.id, authorId: HUMAN_ID, body: PRIVATE });
  const forAnna = JSON.parse(await r.run('tasks.add', { title: 'Intro aufnehmen', for: anna.person.id }, r.ctx(own.id))).taskId as string;
  assert.ok(r.chats.members(forAnna).some((member) => member.memberId === anna.person.id && !member.leftAt), 'Anna is in the thread');
  assert.deepEqual(r.kept(forAnna), [LINE_ELSEWHERE], 'only the link – the words stay in the 1:1');
  const quote = r.chats.messages(forAnna, { limit: 20 }).find((message) => message.meta.status?.details?.quote)!.meta.status!.details!.quote as { messageId: string };
  assert.equal(quote.messageId, line.id, 'the link names the line');
  assert.ok(!r.chats.messages(forAnna, { limit: 20 }).some((message) => message.body.includes('PRIVAT')));

  const forHim = JSON.parse(await r.run('tasks.add', { title: 'Intro freigeben', for: 'person' }, r.ctx(own.id))).taskId as string;
  assert.deepEqual(r.kept(forHim), [PRIVATE], 'his own to-do: his words, whole');

  const theirs = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: anna.person.id });
  r.chats.send({ conversationId: theirs.id, authorId: anna.person.id, authorKind: 'human', body: 'Ich nehme das Intro morgen auf.' });
  const inTheirs = JSON.parse(await r.run('tasks.add', { title: 'Intro aufnehmen (Anna)', for: anna.person.id }, r.ctx(theirs.id))).taskId as string;
  assert.deepEqual(r.kept(inTheirs), ['Ich nehme das Intro morgen auf.'], 'Anna reads the chat it came from: whole');
});

test('"Only me" hides nothing (owner 20.11.2026, replaces R1.2): the person\'s "Only me" to-do in an agent\'s quest is named, counted and marked "only me"', async (t) => {
  const r = rig(t);
  const quest = r.tasks.create({ title: 'Windows signing', kind: 'quest', assigneeKind: 'agent', assigneeId: 'ag_research', createdBy: 'ag_research' });
  const own = r.tasks.create({ title: 'Arzttermin Psychiater', parentId: quest.id, assigneeKind: 'human', createdBy: HUMAN_ID, private: true, at: r.clock.now() + 3_600_000 });
  r.tasks.create({ title: 'Sign on the phone', parentId: quest.id, assigneeKind: 'human', createdBy: 'ag_research' });
  const section = myQuestsSection(r.services, 'ag_research', 'UTC');
  assert.match(section, /person: 2 open \(next: Arzttermin Psychiater, /, section);
  const chat = r.chats.create({ agentIds: ['ag_research'], createdBy: HUMAN_ID });
  const whole = await r.run('tasks.list', { id: quest.id }, r.ctx(chat.id));
  assert.ok(whole.includes(`"Arzttermin Psychiater" · ${own.id} · only me, at `), whole);
  assert.ok((await r.run('tasks.list', { id: own.id }, r.ctx(chat.id))).startsWith('## To-do'), 'it reads the to-do whole');
});

test('a colleague who joins a thread later never reads a line quoted there from a chat she does not read – it keeps only its link', async (t) => {
  const r = rig(t);
  const anna = await r.join('Anna');
  const own = r.chats.create({ agentIds: ['ag_research'], createdBy: HUMAN_ID });
  const line = r.chats.send({ conversationId: own.id, authorId: HUMAN_ID, body: PRIVATE });
  const taskId = JSON.parse(await r.run('tasks.add', { title: 'Intro aufnehmen' }, r.ctx(own.id))).taskId as string;
  assert.deepEqual(r.kept(taskId), [PRIVATE], 'the agent\'s own to-do from his 1:1: whole');
  await r.services.tasks.give(taskId, anna.person.id, HUMAN_ID);
  assert.ok(r.chats.members(taskId).some((member) => member.memberId === anna.person.id && !member.leftAt), 'Anna joined the thread');
  assert.deepEqual(r.kept(taskId), [LINE_ELSEWHERE], 'before she joined, the line gave way to its link');
  const quote = r.chats.messages(taskId, { limit: 50 }).find((message) => message.meta.status?.details?.quote)!.meta.status!.details!.quote as { messageId: string };
  assert.equal(quote.messageId, line.id, 'the link still names the line');
  const seen = await anna.client.call<unknown[]>('messages.list', { conversationId: taskId });
  assert.ok(seen.length > 0, 'she reads the thread');
  assert.ok(!JSON.stringify(seen).includes('PRIVAT'), 'her view holds none of his words');
});
