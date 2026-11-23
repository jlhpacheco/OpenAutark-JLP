// The chat list's "working" rule (runtime/chat/live.ts, Konrad 17.11.2026, after the owner saw sixteen chats "working" at
// once): a run counts in the chat it came from for as long as it runs; a chat it only posted into counts for
// POST_CHAT_MS after its last post there (each post starts it over); a run with no chat of its own – a schedule's – counts
// in the chat of its last post as long as it runs. The end of that time is announced to the list like any other change.
// Owns: these assertions only. Never: real timers (the clock is node's mock).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import { POST_CHAT_MS, SAID_HOLD_MS } from '../../../src/runtime/chat/live.ts';
import { agent, harness } from './harness.ts';

const MIN = 60_000;

function setup(t: { after(fn: () => void): void }) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const home = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', title: 'Invoices' });
  const press = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', title: 'Press' });
  const video = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', title: 'Video' });
  const active = (list: AgentActivity[]) => h.bus.emit('agent.activity', { active: list });
  const run = (extra: Partial<AgentActivity> = {}): AgentActivity => ({ agentId: 'ag_tom', runId: 'run_tom', conversationId: home.id, note: '', startedAt: 100, ...extra });
  const post = (chatId: string, runId = 'run_tom') => h.chats.postAgentMessage(chatId, 'ag_tom', runId, { body: 'done' });
  const shows = (chatId: string) => (h.chats.summary(chatId).live ?? []).map((entry) => entry.runId);
  return { h, home, press, video, active, run, post, shows };
}

test('the origin chat counts for as long as the run runs; a chat it only posted into counts for POST_CHAT_MS after its last post', (t) => {
  const { h, home, press, active, run, post, shows } = setup(t);
  assert.equal(POST_CHAT_MS, 3 * MIN);
  active([run()]);
  post(press.id);
  assert.deepEqual(shows(press.id), ['run_tom'], 'it just posted there');
  mock.timers.tick(POST_CHAT_MS - 1_000);
  assert.deepEqual(shows(press.id), ['run_tom'], 'a second before the end');
  mock.timers.tick(1_100);
  assert.deepEqual(shows(press.id), [], 'three minutes after its last post it works elsewhere');
  assert.deepEqual(h.chats.summary(press.id).working, []);
  assert.deepEqual(h.of('conversation.upserted').filter((chat) => chat.id === press.id).at(-1)!.working, [], 'the end is announced to the list');
  mock.timers.tick(60 * MIN);
  assert.deepEqual(shows(home.id), ['run_tom'], 'the origin chat stays an hour later');
});

test('each post starts the time over', (t) => {
  const { press, active, run, post, shows } = setup(t);
  active([run()]);
  post(press.id);
  mock.timers.tick(2 * MIN);
  post(press.id);
  mock.timers.tick(2 * MIN);
  assert.deepEqual(shows(press.id), ['run_tom'], 'two minutes after the second post');
  mock.timers.tick(MIN + 1_000);
  assert.deepEqual(shows(press.id), []);
});

test('a run with no chat of its own shows in the chat of its last post only, for as long as it runs', (t) => {
  const { h, home, press, video, active, run, post, shows } = setup(t);
  active([run({ conversationId: undefined })]);
  assert.deepEqual([home.id, press.id, video.id].flatMap((id) => shows(id)), [], 'no chat yet: nowhere');
  post(press.id);
  assert.deepEqual(shows(press.id), ['run_tom']);
  post(video.id);
  assert.deepEqual(shows(video.id), ['run_tom'], 'the last post');
  assert.deepEqual(shows(press.id), [], 'not the one before');
  assert.deepEqual(h.of('conversation.upserted').filter((chat) => chat.id === press.id).at(-1)!.working, [], 'the list hears it leave');
  mock.timers.tick(60 * MIN);
  assert.deepEqual(shows(video.id), ['run_tom'], 'it still works there an hour later');
  active([]);
  assert.deepEqual(shows(video.id), [], 'and leaves with its run');
});

test('the time of a run that ended announces nothing and leaves no timer behind', (t) => {
  const { h, press, active, run, post } = setup(t);
  active([run()]);
  post(press.id);
  active([]);
  const announced = h.of('conversation.upserted').length;
  mock.timers.tick(10 * MIN);
  assert.equal(h.of('conversation.upserted').length, announced);
});

// Owner 19.11.2026: with one context per agent the person's line of another chat is folded into the running turn – that
// chat shows the work for as long as the run runs, not only 3 minutes after a post there.
test('a chat whose line was folded into the running turn shows the run until it ends', (t) => {
  const { h, press, active, run, shows } = setup(t);
  active([run()]);
  assert.deepEqual(shows(press.id), []);
  h.bus.emit('run.item', { id: 'ri_s', runId: 'run_tom', seq: 2, kind: 'note', data: { steered: { lines: 1, upToSeq: 4, fromSeq: 3, conversationId: press.id } }, createdAt: 1 });
  mock.timers.tick(1_000);
  assert.deepEqual(shows(press.id), ['run_tom'], 'the person there sees it work');
  assert.ok(h.of('conversation.upserted').some((chat) => chat.id === press.id && chat.live?.length === 1), 'announced to the list');
  mock.timers.tick(30 * MIN);
  assert.deepEqual(shows(press.id), ['run_tom'], 'still, half an hour later');
  active([]);
  assert.deepEqual(shows(press.id), [], 'and leaves with its run');
});

test('the agent\'s own sentence holds its step against tool steps for SAID_HOLD_MS, then the tools show again', (t) => {
  const { h, home, active, run } = setup(t);
  active([run()]);
  const step = () => h.chats.summary(home.id).live?.[0].step;
  h.bus.emit('run.item', { id: 'ri_u', runId: 'run_tom', seq: 1, kind: 'note', name: 'Update', data: { text: 'Checking the March invoices now.' }, createdAt: 1 });
  assert.equal(step(), 'Checking the March invoices now');
  const read = (seq: number, file: string) => h.bus.emit('run.item', { id: `ri_${seq}`, runId: 'run_tom', seq, kind: 'tool_call', name: 'Read', data: { callId: `c${seq}`, args: { file_path: `C:/data/${file}` } }, createdAt: 1 });
  read(2, 'march.pdf');
  assert.equal(step(), 'Checking the March invoices now', 'its own words first');
  mock.timers.tick(SAID_HOLD_MS);
  read(3, 'april.pdf');
  assert.match(step() ?? '', /april\.pdf/, 'a minute later the tool step shows');
});
