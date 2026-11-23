// 07.11.2026 – regression of Befund Workforce/qa-2026-11-07-nachrichten-kapazitaet (repro.test.ts R1/R2 there, against
// the old code: 2/2 showed the bugs). One capacity rule: no RAM admission ("waiting for capacity"), no slot FIFO and
// (B-080) no global limit for any lane – every agent's own turn starts at once, its parts up to
// SPLIT_LIMITS.runningPerAgent; a person's or colleague's line runs before the agent's own follow-ups; a normal line from
// another chat is folded into the running turn (framed, with one status line in the waiting chat) or runs right after; a
// message wake handed over from another PC is delivered by the line's level (chat/delivery-route.ts).
// Owns: these assertions only. Never: real engines, processes or PCs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { groupWakes, nextGroup, taskFacts } from '../../../src/runtime/agents/dispatch-groups.ts';
import { deliverHandedOver } from '../../../src/runtime/chat/delivery-route.ts';
import { SPLIT_LIMITS } from '../../../src/shared/model/splits.ts';
import { flush, openWakes, setup } from './fakes.ts';

function team() {
  const h = setup();
  for (const [id, name] of [['ag_jonas', 'Jonas'], ['ag_lea', 'Lea'], ['ag_max', 'Max'], ['ag_nora', 'Nora']]) h.org.add(agent(id, name));
  return h;
}

const statusLines = (h: ReturnType<typeof team>, chatId: string) =>
  h.chats.messages(chatId, { limit: 100 }).filter((message) => message.kind === 'status').map((message) => message.body);

test('R1 (was: a memory dip parked waiters until another turn ended): no admission and no global cap at all – four agents start at once', async () => {
  const supervisor = new Supervisor({ os: { freemem: () => 0, cpuCount: () => 8, setPriority: () => {}, platform: 'win32' } });
  for (const gone of ['admit', 'maxHeavy', 'canAdmit', 'nudge']) assert.equal(gone in supervisor, false, `Supervisor.${gone} is gone`);
  const h = team();
  // B-080: no global place count either – the dispatcher has no maxConcurrent, its split lanes no slotFree; the one bound is the agent's own.
  assert.equal('maxConcurrent' in h.dispatcher, false, 'DispatcherImpl.maxConcurrent is gone');
  assert.equal('slotFree' in (Reflect.get(h.dispatcher, 'lanes') as { host: object }).host, false, 'LaneHost.slotFree is gone');
  assert.equal(h.dispatcher.capacity(), SPLIT_LIMITS.runningPerAgent);
  assert.equal(SPLIT_LIMITS.runningPerAgent, 4, 'Claude parts are CLIs of their own: four per agent stays');
  const chats = ['ag_jonas', 'ag_lea', 'ag_max', 'ag_nora'].map((id) => h.chats.create({ agentIds: [id], createdBy: 'human' }));
  h.dispatcher.start();
  for (const chat of chats) h.chats.send({ conversationId: chat.id, body: 'go', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 4, 'nobody waits for capacity');
  assert.equal(h.executor.calls.some((call) => call.request.onStatus === undefined), false);
  for (const call of h.executor.calls) call.finish();
  await flush();
  assert.equal(openWakes(h.db).length, 0);
});

test('R2 (was: the split result ran first): the person\'s line of 15:30 runs before the agent\'s own split results of 16:18 on a priority-2 task', () => {
  const t1530 = Date.UTC(2026, 10, 7, 14, 30), t1618 = Date.UTC(2026, 10, 7, 15, 18);
  const wakes = [
    { id: 'w1', agentId: 'jonas', conversationId: 'ch_1to1', reason: 'message' as const, dueAt: t1530, createdAt: t1530, attempts: 0 },
    { id: 'w2', agentId: 'jonas', conversationId: 'ch_team', taskId: 'task_prio2', reason: 'child' as const, dueAt: t1618, createdAt: t1618, attempts: 0 },
  ];
  const groups = groupWakes(wakes);
  taskFacts(groups, (id: string) => (id === 'task_prio2' ? { priority: 2 } : undefined), t1618);
  assert.equal(nextGroup(groups, []).group?.conversationId, 'ch_1to1');
  // A line riding along with a colleague's result in the same chat keeps the line's rank.
  const along = groupWakes([
    { id: 'w3', agentId: 'jonas', conversationId: 'ch_team', reason: 'message' as const, dueAt: t1618, createdAt: t1618, attempts: 0 },
    { id: 'w4', agentId: 'jonas', conversationId: 'ch_team', taskId: 'task_prio2', reason: 'child' as const, dueAt: t1618, createdAt: t1618, attempts: 0 },
  ]);
  assert.equal(along.length, 1);
  assert.deepEqual([along[0].reason, along[0].rank], ['message', 0]);
});

test('a normal line from another chat is folded into the running turn, framed; one status line there; that chat runs first after this turn', async () => {
  const h = team();
  const work = h.chats.create({ title: 'Kernteam', agentIds: ['ag_jonas'], createdBy: 'human' });
  const mine = h.chats.create({ agentIds: ['ag_jonas'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: work.id, body: 'build the release', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  const steered: string[] = [];
  call.request.control.engine = { steer: async (_runId: string, text: string) => { steered.push(text); return true; } } as unknown as Engine;
  h.wakes.wake({ agentId: 'ag_jonas', reason: 'schedule', note: 'weekly check' }); // own follow-up work waiting too
  const before = h.chats.members(mine.id).find((member) => member.memberId === 'ag_jonas')!.readSeq;
  h.chats.send({ conversationId: mine.id, body: 'Where are my messages?', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: mine.id, body: 'And the Play Store?', authorId: 'human' });
  await flush();
  assert.equal(steered.length, 2, 'each new line at the next step');
  assert.match(steered[0], /^New lines while I work:\n/);
  assert.ok(steered[0].includes(`[${mine.id} `), 'the line names its chat');
  assert.match(steered[0], / · Lena \(CEO\) · .*\] Where are my messages\?$/m);
  assert.doesNotMatch(steered[1], /Lena: Where are my messages/, 'a folded line is not folded twice');
  assert.equal(call.request.signal.aborted, false, 'a normal line never cuts the turn');
  assert.deepEqual(statusLines(h, mine.id), [], '13.11.2026: no waiting line – the live bar shows the work');
  assert.equal(h.chats.members(mine.id).find((member) => member.memberId === 'ag_jonas')!.readSeq, before, 'the waiting chat\'s cursor stays');
  assert.ok(h.runItems.some((item) => item.kind === 'note' && (item.data.steered as { conversationId?: string } | undefined)?.conversationId === mine.id));
  call.finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, mine.id, 'that chat first, before the own schedule');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.reason, 'schedule');
  h.executor.last().finish();
  await flush();
});

test('without a steering engine: no status line, and that chat runs right after', async () => {
  const h = team();
  const work = h.chats.create({ title: 'Secret plan', agentIds: ['ag_jonas'], createdBy: 'human' });
  const mine = h.chats.create({ agentIds: ['ag_jonas'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: work.id, body: 'go', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  h.chats.send({ conversationId: mine.id, body: 'one', authorId: 'human' });
  h.chats.send({ conversationId: mine.id, body: 'two', authorId: 'human' });
  await flush();
  assert.deepEqual(statusLines(h, mine.id), []);
  call.finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, mine.id);
  h.executor.last().finish();
  await flush();

  for (const item of h.executor.calls) item.finish();
  await flush();
});

test("B-080 wave 3: after the turn the chat where a person waits runs before a colleague's chat named earlier – with and without steering", async () => {
  for (const steering of [true, false]) {
    const h = team();
    const work = h.chats.create({ title: 'Kernteam', agentIds: ['ag_jonas'], createdBy: 'human' });
    const room = h.chats.create({ title: 'Release room', agentIds: ['ag_jonas', 'ag_nora'], humans: false, createdBy: 'ag_nora' });
    const mine = h.chats.create({ agentIds: ['ag_jonas'], createdBy: 'human' });
    h.dispatcher.start();
    h.chats.send({ conversationId: work.id, body: 'build the release', authorId: 'human' });
    await flush();
    const call = h.executor.last();
    const steered: string[] = [];
    if (steering) call.request.control.engine = { steer: async (_runId: string, text: string) => { steered.push(text); return true; } } as unknown as Engine;
    h.chats.send({ conversationId: room.id, body: 'The build server is free again.', authorId: 'ag_nora', authorKind: 'agent' }); // first: a colleague
    await flush();
    h.chats.send({ conversationId: mine.id, body: 'Where are my messages?', authorId: 'human' }); // then: the person
    await flush();
    if (steering) assert.equal(steered.length, 2, 'both lines folded at the next step');
    assert.deepEqual(statusLines(h, room.id), [], 'a room of agents gets no waiting line');
    assert.deepEqual(statusLines(h, mine.id), []);
    call.finish();
    await flush();
    assert.equal(h.executor.last().request.conversationId, mine.id, "the person's chat first");
    // Runde „Halb“ 21.11.2026: the colleague's chat rides along in that turn instead of a turn of its own.
    assert.deepEqual(h.executor.last().request.riders?.map((rider) => rider.conversationId), [room.id], "the colleague's rides along");
    h.executor.last().finish();
    await flush();
    assert.equal(h.executor.calls.length, 2, 'no third turn');
    assert.equal(openWakes(h.db).length, 0);
    await h.dispatcher.stop();
  }
});

test('a message wake handed over from another PC: important cuts (urgent), normal folds (steer), quiet only wakes', async () => {
  const h = team();
  const chat = h.chats.create({ agentIds: ['ag_jonas'], createdBy: 'human' });
  const calls: string[] = [];
  const s = {
    chats: h.chats, log: h.services.log,
    dispatcher: { urgent: async (agentId: string, id: string) => { calls.push(`urgent:${agentId}:${id}`); }, steer: async (agentId: string, id: string) => { calls.push(`steer:${agentId}:${id}`); return true; } },
  } as unknown as Pick<RuntimeServices, 'chats' | 'dispatcher' | 'log'>;
  const seen = () => h.chats.markRead(chat.id, 'ag_jonas', h.chats.messages(chat.id, { limit: 100 }).at(-1)!.seq);
  h.chats.send({ conversationId: chat.id, body: 'quiet note', authorId: 'human', silent: true });
  deliverHandedOver(s, 'ag_jonas', chat.id);
  assert.deepEqual(calls, [], 'quiet: the wake alone');
  h.chats.send({ conversationId: chat.id, body: 'normal', authorId: 'human' });
  deliverHandedOver(s, 'ag_jonas', chat.id);
  h.chats.send({ conversationId: chat.id, body: 'now!', authorId: 'human', priority: 'important' });
  deliverHandedOver(s, 'ag_jonas', chat.id);
  seen();
  deliverHandedOver(s, 'ag_jonas', chat.id);
  assert.deepEqual(calls, [`steer:ag_jonas:${chat.id}`, `urgent:ag_jonas:${chat.id}`], 'nothing unseen after the read: no call');
  deliverHandedOver(s, 'ag_lea', chat.id);
  assert.equal(calls.length, 2, 'not a member there: nothing');
  await flush();
});
