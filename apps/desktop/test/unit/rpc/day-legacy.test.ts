// The four day.* methods 0.3.16/0.3.17 clients still call (handlers/day.ts, compat only): scope as in 0.3.17 – the owner and a
// device holding 'todo', nobody else –, day.add makes the person's own plain to-dos through the one intake (a line each, a
// retry with the same clientId answers the same to-dos, nothing is handed on), day.plan and day.briefing answer the shapes the old
// page reads (an empty plan, null), day.handedOff lists what the person gave others and never their own or an agent's own work.
// Owns: checks of handlers/day.ts only. Never: the planner or briefing (gone with My day, Quests round 20.11.2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { allowedScope } from '../../../src/runtime/rpc/table.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { agent } from '../task-center/fixture.ts';
import { OWNER, TODO_ONLY, TestClient, rpcFixture } from './s1-helpers.ts';

const METHODS = ['day.add', 'day.plan', 'day.briefing', 'day.handedOff'];

test('scope: the owner and a device with todo – a device without it, an agent and an external agent are refused', () => {
  const table = createHandlerTable();
  for (const method of METHODS) {
    const rule = table.get(method)?.scope;
    assert.deepEqual(rule, { capability: 'todo' }, `${method} keeps the 0.3.17 tier`);
    assert.equal(allowedScope(rule!, OWNER), true);
    assert.equal(allowedScope(rule!, TODO_ONLY), true);
    assert.equal(allowedScope(rule!, { kind: 'device', deviceId: 'dev_chat', capabilities: ['chat'] }), false);
    assert.equal(allowedScope(rule!, { kind: 'agent', agentId: 'ag_x', runId: 'run_x' }), false);
    assert.equal(allowedScope(rule!, { kind: 'external', memberId: 'ext_x', conversationId: 'ch_x', tokenId: 'tok_x' }), false);
  }
});

test('day.add: a line each as the person\'s own to-do, a retry answers the same ones, bad input is refused', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(() => f.cleanup());
  const phone = new TestClient(f.server, TODO_ONLY);
  const first = await phone.call<{ tasks: TaskView[] }>('day.add', { text: 'Wäsche waschen\n- Küche aufräumen\n\n', clientId: 'up-1', date: '2026-11-24' });
  assert.deepEqual(first.tasks.map((task) => task.title), ['Wäsche waschen', 'Küche aufräumen']);
  assert.ok(first.tasks.every((task) => task.assigneeKind === 'human' && task.createdBy === HUMAN_ID));
  const again = await phone.call<{ tasks: TaskView[] }>('day.add', { text: 'Wäsche waschen\n- Küche aufräumen', clientId: 'up-1' });
  assert.deepEqual(again.tasks.map((task) => task.id), first.tasks.map((task) => task.id));
  for (const [params, why] of [[{ text: '  \n ' }, 'blank'], [{ text: 'x', date: '24.11.' }, 'date'], [{ text: 'x', extra: 1 }, 'key']] as const) {
    assert.equal((await phone.request('day.add', params)).error?.code, 'bad_request', why);
  }
});

test('day.plan and day.briefing answer what the old page reads; day.handedOff lists only work the person gave others', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(() => f.cleanup());
  const phone = new TestClient(f.server, TODO_ONLY);
  assert.deepEqual(await phone.call('day.plan', { date: '2026-11-24', mode: 'plan' }), { date: '2026-11-24', placed: [], moved: [], unplanned: [], staleSources: [] });
  assert.equal(await phone.call('day.briefing', { date: '2026-11-24' }), null);
  assert.equal((await phone.request('day.plan', { date: '2026-11-24', mode: 'later' })).error?.code, 'bad_request');
  assert.equal((await phone.request('day.briefing', { date: 'today' })).error?.code, 'bad_request');

  f.org.add(agent('ag_mara', 'Mara', { createdAt: 1 }));
  const chat = f.services.chats.create({ agentIds: ['ag_mara'], humans: true, createdBy: HUMAN_ID }).id;
  const given = f.services.tasks.create({ conversationId: chat, title: 'Research flights', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: HUMAN_ID });
  f.services.tasks.create({ conversationId: chat, title: "Mara's own idea", assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: 'ag_mara' });
  await phone.call('day.add', { text: 'Steuern' });
  const list = await phone.call<TaskView[]>('day.handedOff', {});
  assert.deepEqual(list.map((task) => task.id), [given.id]);
});
