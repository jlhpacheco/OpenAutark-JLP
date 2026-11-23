// Advanced schedule options end to end in the runtime (T11) against the real chat/task/schedule
// services and RPC table: messages.schedule with Important (posted as important, the agent is
// steered) and Post as task (a routine posting a team task with steps and High priority each
// time; refused without the 'tasks' tier), schedules.preview (next three runs, window, skips,
// maxRuns with runs made, a late one-off, never, refusals), schedules.update rewording every
// scheduled message and an agent's reminder note, and moving a message to another chat (owner
// 21.11.2026, Settings › Scheduled). Quests round 20.11.2026: the agents' schedule tools are tasks.remind now (test/unit/tools/tasks-remind.test.ts).
// Owns: these assertions only. Never: real timers, network or a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { wallOf } from '../../../src/shared/text/when.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';

const MIN = 60_000;
const H = 60 * MIN;
const CHAT_ONLY: ClientScope = { kind: 'device', deviceId: 'dev_chat', capabilities: ['todo', 'chat'] };
const TODO_ONLY: ClientScope = { kind: 'device', deviceId: 'dev_todo', capabilities: ['todo'] };

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const now = f.clock.now();
  return { ...f, chat, now, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

test('messages.schedule: Important is posted as important and steers the agent', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const schedule = await f.phone.call<Schedule>('messages.schedule', {
    conversationId: f.chat.id, body: 'Status please @Ava', spec: { at: f.now + H }, mentions: ['ag_ava'], priority: 'important',
  });
  assert.equal(schedule.kind, 'message');
  assert.deepEqual(schedule.payload, { body: 'Status please @Ava', mentions: ['ag_ava'], priority: 'important' });
  const normal = await f.phone.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Later', spec: { at: f.now + H }, priority: 'normal' });
  assert.deepEqual(normal.payload, { body: 'Later' }, "'normal' stores nothing extra");
  f.scheduler.start();
  f.clock.advance(H);
  f.timers.fire();
  const posted = f.chats.messages(f.chat.id).find((message) => message.kind === 'text' && message.body === 'Status please @Ava');
  assert.equal(posted?.priority, 'important');
  assert.equal(posted?.authorKind, 'human');
  assert.equal(posted?.meta.via, 'schedule');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(f.dispatcher.urgents.some((entry) => entry.agentId === 'ag_ava' && entry.conversationId === f.chat.id), 'the important post steers Ava');
  assert.equal((await f.phone.request('messages.schedule', { conversationId: f.chat.id, body: 'x', spec: { at: f.now + H }, priority: 'urgent' })).error?.code, 'bad_request');
});


test('schedules.preview: the next runs as the scheduler takes them', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const at = f.now + H;
  const preview = (params: unknown, client = f.phone) => client.call<{ times: number[] }>('schedules.preview', params).then((result) => result.times);
  assert.deepEqual(await preview({ spec: { everyMs: 53 * MIN, at } }), [at, at + 53 * MIN, at + 106 * MIN]);
  assert.equal((await preview({ spec: { everyMs: 53 * MIN, at }, count: 5 })).length, 5);
  assert.deepEqual(await preview({ spec: { everyMs: 53 * MIN, at, maxRuns: 4 }, runs: 3 }), [at], 'maxRuns counts the runs already made');
  assert.deepEqual(await preview({ spec: { everyMs: 53 * MIN, at, maxRuns: 2 }, runs: 2 }), []);
  const windowed = await preview({ spec: { everyMs: 53 * MIN, at, tz: 'UTC', window: { from: '10:00', to: '11:00' } }, count: 4 });
  assert.equal(windowed.length, 4);
  for (const time of windowed) assert.ok(wallOf(time, 'UTC').minutes >= 600 && wallOf(time, 'UTC').minutes < 660, new Date(time).toISOString());
  const day = wallOf(at, 'UTC').date;
  const skipped = await preview({ spec: { cron: '0 10 * * *', tz: 'UTC', except: [day] } });
  assert.ok(skipped.every((time) => wallOf(time, 'UTC').date !== day) && skipped.length === 3);
  assert.deepEqual(await preview({ spec: { at: f.now - MIN } }), [f.now - MIN], 'a missed one-off still runs once, late');
  assert.deepEqual(await preview({ spec: { at, tz: 'UTC', except: [day] } }), [], 'never runs');
  assert.equal((await f.phone.request('schedules.preview', { spec: { everyMs: 5 } })).error?.code, 'bad_request');
  assert.equal((await f.phone.request('schedules.preview', {})).error?.code, 'bad_request');
  assert.equal((await f.phone.request('schedules.preview', { spec: { at }, count: 11 })).error?.code, 'bad_request');
  assert.equal((await new TestClient(f.server, CHAT_ONLY).request('schedules.preview', { spec: { at } })).error, undefined, 'the chat tier may preview');
  assert.equal((await new TestClient(f.server, TODO_ONLY).request('schedules.preview', { spec: { at } })).error?.code, 'forbidden');
});

test('schedules.update rewords every scheduled message and a reminder note, and moves a message to another chat', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const message = await f.owner.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Recap @Ava', spec: { at: f.now + H }, mentions: ['ag_ava'] });
  const reworded = await f.owner.call<Schedule>('schedules.update', { id: message.id, body: 'Weekly recap', priority: 'important', mentions: [], spec: { cron: '0 9 * * 1', tz: 'UTC' } });
  assert.equal(reworded.title, 'Weekly recap');
  assert.deepEqual(f.scheduler.get(message.id)!.payload, { body: 'Weekly recap', priority: 'important' }, 'mentions dropped with the new text');
  assert.equal(reworded.spec.cron, '0 9 * * 1');
  assert.ok(reworded.nextAt! > f.now);
  await f.owner.call<Schedule>('schedules.update', { id: message.id, priority: 'normal' });
  assert.deepEqual(f.scheduler.get(message.id)!.payload, { body: 'Weekly recap' });

  assert.equal((await f.owner.request('messages.schedule', { conversationId: f.chat.id, body: 'Review drafts', spec: { at: f.now + H }, asTask: true })).error?.code, 'bad_request', 'a task post is a message now (Quests round)');

  const agents = f.scheduler.create({ ownerId: 'ag_ava', conversationId: f.chat.id, kind: 'message', title: 'Daily standup', spec: { cron: '0 9 * * *', tz: 'UTC' }, payload: { body: 'Standup!' } });
  const retimed = await f.owner.call<Schedule>('schedules.update', { id: agents.id, spec: { cron: '30 9 * * 1-5', tz: 'UTC' } });
  assert.equal(retimed.spec.cron, '30 9 * * 1-5', 'timing of an agent schedule changes');
  assert.deepEqual(retimed.payload, { body: 'Standup!' });
  const rewritten = await f.owner.call<Schedule>('schedules.update', { id: agents.id, body: 'Standup at 9:30', priority: 'important' });
  assert.equal(rewritten.title, 'Standup at 9:30');
  assert.equal(rewritten.ownerId, 'ag_ava', 'still posted under the agent\'s name');
  assert.deepEqual(f.scheduler.get(agents.id)!.payload, { body: 'Standup at 9:30', priority: 'important' });
  const reminder = f.scheduler.create({ ownerId: 'ag_ava', kind: 'reminder', title: 'Look', spec: { at: f.now + H }, payload: { note: 'Look' } });
  const noted = await f.owner.call<Schedule>('schedules.update', { id: reminder.id, body: 'Look at the drafts' });
  assert.equal(noted.title, 'Look at the drafts');
  assert.deepEqual(f.scheduler.get(reminder.id)!.payload, { note: 'Look at the drafts' });
  assert.equal((await f.owner.request('schedules.update', { id: reminder.id, priority: 'important' })).error?.code, 'bad_request', 'a reminder has only its note');

  const other = f.chats.create({ agentIds: [], createdBy: 'human' });
  const moved = await f.owner.call<Schedule>('schedules.update', { id: message.id, conversationId: other.id });
  assert.equal(moved.conversationId, other.id);
  assert.equal(f.scheduler.list({ conversationId: other.id }).length, 1, 'stored in the new chat');
  assert.equal((await f.owner.request('schedules.update', { id: agents.id, conversationId: other.id })).error?.code, 'bad_request', 'Ava is not in that chat');
  assert.equal((await f.owner.request('schedules.update', { id: reminder.id, conversationId: other.id })).error?.code, 'bad_request', 'a reminder does not move');
  assert.equal((await f.owner.request('schedules.update', { id: message.id, conversationId: 'cv_missing' })).error?.code, 'not_found');
  assert.equal((await f.phone.request('schedules.update', { id: message.id, body: 'x' })).error?.code, 'forbidden', "rewording needs 'manage'");
  assert.equal((await f.owner.request('schedules.update', { id: message.id, colour: 'red' })).error?.code, 'bad_request');
});

test('schedules.list: the person gets every schedule; an agent\'s own wf the running ones unless it asks with all', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const running = f.scheduler.create({ ownerId: 'ag_ava', kind: 'reminder', title: 'On', spec: { at: f.now + H }, payload: { note: 'On' } });
  const paused = f.scheduler.create({ ownerId: 'ag_ava', kind: 'reminder', title: 'Held', spec: { at: f.now + H }, payload: { note: 'Held' } });
  f.scheduler.update(paused.id, { active: false }, 'human');
  const ids = (list: Schedule[]) => list.map((entry) => entry.id).sort();
  assert.deepEqual(ids(await f.owner.call<Schedule[]>('schedules.list', { ownerId: 'ag_ava' })), [running.id, paused.id].sort());
  const ava = new TestClient(f.server, { kind: 'owner', agentId: 'ag_ava' });
  assert.deepEqual(ids(await ava.call<Schedule[]>('schedules.list', { ownerId: 'ag_ava' })), [running.id]);
  assert.deepEqual(ids(await ava.call<Schedule[]>('schedules.list', { ownerId: 'ag_ava', all: true })), [running.id, paused.id].sort());
});
