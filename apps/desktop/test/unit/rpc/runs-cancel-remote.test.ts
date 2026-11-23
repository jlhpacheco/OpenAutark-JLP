// runs.cancel and agents.activity with the person's other PCs (src/runtime/rpc/handlers/org.ts, devices/sync/live.ts;
// feedback F10/F21 16.11.2026): a run of this PC stops here; a run only another PC's live state names goes to that PC
// (sync.live.cancel); a run nobody has stays not_found; agents.activity and the agent.activity event windows hear list
// the other PC's runs with its deviceId. 20.11.2026: a turn the dispatcher runs before its row exists stops; the bar's
// Stop (agent and chat) of a run that is over stops what that chat shows now, here or on its PC; nothing running any
// more is done and re-announced; a PC that does not stop it says so.
// Owns: these assertions only. Never: a real mesh or engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../../../src/shared/ids.ts';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import type { DeviceService } from '../../../src/runtime/contracts.ts';
import { allActivity, chatLiveOf } from '../../../src/runtime/chat/live.ts';
import { CANCEL_METHOD, LiveSync, bindLiveSync } from '../../../src/runtime/devices/sync/live.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture, settle } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const calls: Array<{ peer: string; method: string; params: unknown }> = [];
  f.services.devices = {
    online: () => true,
    call: async (peer: string, method: string, params: unknown) => { calls.push({ peer, method, params }); return { ok: true }; },
  } as unknown as DeviceService;
  const live = chatLiveOf(f.bus)!;
  bindLiveSync(f.services, new LiveSync(f.services, live, async () => undefined, 0));
  const remote: AgentActivity = { agentId: 'ag_ava', runId: 'run_there', conversationId: chat.id, note: 'editing', startedAt: 5 };
  live.setRemote('pc_server', [{ activity: remote, chats: [chat.id] }]);
  return { ...f, chat, calls, owner: new TestClient(f.server, OWNER) };
}

test('runs.cancel: this PC\'s run stops here, another PC\'s run goes to that PC, an unknown run is not found', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const run = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', conversationId: f.chat.id, trigger: 'message' });
  await f.owner.call('runs.cancel', { runId: run.id });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: f.chat.id }], 'stopped here');
  assert.deepEqual(f.calls, [], 'no other PC asked');
  await f.owner.call('runs.cancel', { runId: 'run_there' });
  assert.deepEqual(f.calls, [{ peer: 'pc_server', method: CANCEL_METHOD, params: { runId: 'run_there' } }], 'the PC that runs it stops it');
  assert.equal((await f.owner.request('runs.cancel', { runId: 'run_missing' })).error?.code, 'not_found');
  assert.equal(f.calls.length, 1);
});

test('agents.activity and the agent.activity event list the other PC\'s runs with its deviceId', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  f.dispatcher.active = [{ agentId: 'ag_ava', runId: 'run_here', note: '', startedAt: 9 }];
  const listed = await f.owner.call<AgentActivity[]>('agents.activity');
  assert.deepEqual(listed.map((entry) => [entry.runId, entry.deviceId]), [['run_here', undefined], ['run_there', 'pc_server']]);
  await f.owner.call('events.subscribe', { topics: ['org'] });
  f.bus.emit('agent.activity', { active: f.dispatcher.active });
  await settle();
  const heard = f.owner.events('agent.activity').at(-1)?.data as { active: AgentActivity[] } | undefined;
  assert.deepEqual(heard?.active.map((entry) => [entry.runId, entry.deviceId]), [['run_here', undefined], ['run_there', 'pc_server']]);
});

// 20.11.2026 (2F66178A: "Could not stop Martin · Run not found." while the bar showed him working).

test('runs.cancel stops a turn the dispatcher runs before its run row is written', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  f.dispatcher.active = [{ agentId: 'ag_ava', runId: 'run_starting', conversationId: f.chat.id, note: '', startedAt: 9 }];
  assert.equal(f.services.runs.get('run_starting'), undefined, 'no row yet (the look before the turn runs)');
  await f.owner.call('runs.cancel', { runId: 'run_starting' });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: f.chat.id }]);
  assert.deepEqual(f.calls, [], 'no other PC asked');
});

test('a bar a moment behind: the Stop of a run that is over stops the run of that agent the chat shows now', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  chatLiveOf(f.bus)!.setRemote('pc_server', []);
  const old = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', conversationId: f.chat.id, trigger: 'message' });
  f.services.runs.finish(old.id, { status: 'done', endedAt: 5 });
  const now: AgentActivity = { agentId: 'ag_ava', runId: 'run_next', conversationId: f.chat.id, note: '', startedAt: 6 };
  f.dispatcher.active = [now];
  f.bus.emit('agent.activity', { active: [now] });
  await f.owner.call('runs.cancel', { runId: old.id, agentId: 'ag_ava', chatId: f.chat.id });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: f.chat.id }], 'the run the bar shows now stopped');
});

test('a bar a moment behind with the run on another PC: that PC gets the run its state shows now, with the bar\'s agent and chat', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  await f.owner.call('runs.cancel', { runId: 'run_gone', agentId: 'ag_ava', chatId: f.chat.id });
  assert.deepEqual(f.calls, [{ peer: 'pc_server', method: CANCEL_METHOD, params: { runId: 'run_there', agentId: 'ag_ava', chatId: f.chat.id } }]);
});

test('nothing of it runs any more: the Stop is done and the chat\'s bar is announced again', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  chatLiveOf(f.bus)!.setRemote('pc_server', []);
  const heard: string[] = [];
  f.bus.on('conversation.upserted', (summary) => { heard.push(summary.id); });
  assert.deepEqual(await f.owner.call('runs.cancel', { runId: 'run_gone', agentId: 'ag_ava', chatId: f.chat.id }), { ok: true });
  await settle();
  assert.ok(heard.includes(f.chat.id), 'the bar hears it again');
  assert.equal((await f.owner.request('runs.cancel', { runId: 'run_gone' })).error?.code, 'not_found', 'without the bar\'s line an unknown run stays unknown');
});

test('the PC that runs it does not stop it: the Stop says so instead of "not found"', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  f.services.devices = { online: () => true, call: async () => ({ ok: false }) } as unknown as DeviceService;
  const answer = await f.owner.request('runs.cancel', { runId: 'run_there', agentId: 'ag_ava', chatId: f.chat.id });
  assert.equal(answer.error?.code, 'unavailable');
});

test('review 20.11.: an entry the bar still holds for a turn that is over leaves the bar with the Stop', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  chatLiveOf(f.bus)!.setRemote('pc_server', []);
  const held: AgentActivity = { agentId: 'ag_ava', runId: 'run_held', conversationId: f.chat.id, note: '', startedAt: 7 };
  f.bus.emit('agent.activity', { active: [held] }); // the bar took it; the dispatcher no longer runs it (f.dispatcher.active is empty)
  assert.deepEqual(f.chats.summary(f.chat.id).live?.map((run) => run.runId), ['run_held']);
  assert.deepEqual(await f.owner.call('runs.cancel', { runId: 'run_held', agentId: 'ag_ava', chatId: f.chat.id }), { ok: true });
  assert.equal(f.chats.summary(f.chat.id).live, undefined, 'the line goes now');
  assert.deepEqual(f.dispatcher.interrupts, [], 'nothing else was stopped');
});

test('review 20.11.: a run another PC had over or stopped leaves this PC\'s bar with the Stop, not with that PC\'s next state', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  assert.deepEqual(f.chats.summary(f.chat.id).live?.map((run) => [run.runId, run.deviceId]), [['run_there', 'pc_server']]);
  await f.owner.call('runs.cancel', { runId: 'run_there', agentId: 'ag_ava', chatId: f.chat.id });
  assert.equal(f.chats.summary(f.chat.id).live, undefined);
  assert.deepEqual(allActivity(f.bus, []), [], 'windows no longer hear it either');
});
