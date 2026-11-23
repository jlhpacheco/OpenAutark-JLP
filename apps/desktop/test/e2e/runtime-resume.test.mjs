// End-to-end (T03): work waiting on the person continues at once, over the real headless runtime
// (built app/runtime-cli.mjs) with the deterministic fake engine and real WebSocket RPC.
// Covers: a task whose owner waits on the person (tasks.update waiting on: who) runs no turns; the
// person finishing the step it waits on (a piece given to them) opens it again ('Open again: …' line)
// and its owner runs a turn on it; a message of the person in that chat while it waits is a turn on
// that task; the person reopening finished work wakes the owner and the ledger keeps the reopen.
// Run: npm run build && node --test test/e2e/runtime-resume.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const QUIET_MS = 4000; // several continuation periods (1 s each): turns in flight end, then nothing runs
const GRACE_MS = 1500; // a turn that was already starting when the change landed

test('tasks waiting on the person continue as soon as the person acts', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  await client.call('events.subscribe', { topics: [`runs:${manager.id}`] });

  /** Turns of the manager on the task that started after `since`. */
  const turnsOn = (taskId, since) => new Set(client.events
    .filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === manager.id && frame.data.taskId === taskId && (frame.data.startedAt ?? 0) > since)
    .map((frame) => frame.data.id)).size;
  const nextTurn = (taskId, since) => client.waitFor('run.upserted', (run) => run.agentId === manager.id && run.taskId === taskId && (run.startedAt ?? 0) > since, 90_000);
  /** Its owner sets the task waiting on the person (a tool call in a turn) and no turn runs on it any more. */
  const waitOnPerson = async (taskId) => {
    const wait = { id: taskId, status: 'waiting', waiting: 'person: Log in first' }; // "<who>: why" – a wait on the person
    await client.call('messages.send', { conversationId: chat.id, body: `Wait for me [[tool:tasks.update ${JSON.stringify(wait)}]]` });
    await client.waitFor('task.upserted', (item) => item.id === taskId && item.status === 'waiting' && item.waitingOn?.who === 'human', 90_000);
    await sleep(QUIET_MS);
    const at = Date.now();
    await sleep(QUIET_MS);
    assert.equal(turnsOn(taskId, at), 0, 'a task waiting on the person runs no turns');
    return Date.now();
  };

  const chat = await client.call('chats.create', { title: 'Sign-up', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  const task = await client.call('tasks.create', { conversationId: chat.id, title: 'Finish the portal sign-up', to: manager.id });
  await nextTurn(task.id, 0);

  await t.test('the last human step done: the task works again and its owner continues', async () => {
    // Its owner asks the person (a piece of the task with a widget) and waits on them.
    // Quests round 20.11.2026: the piece is a to-do in the task's quest (tasks.add quest: the task – a lone to-do that gets one becomes a quest).
    const ask = { title: 'Log in to the portal', for: 'person', quest: task.id, ask: { type: 'confirm', instructions: 'Log in, then confirm here' } };
    await client.call('messages.send', { conversationId: chat.id, body: `Please log in [[tool:tasks.add ${JSON.stringify(ask)}]]` });
    const step = await client.waitFor('task.upserted', (item) => item.title === 'Log in to the portal' && item.parentId === task.id, 90_000);
    assert.equal(step.assigneeKind, 'human');
    const at = await waitOnPerson(task.id);
    await client.call('tasks.finish', { id: step.id, answer: { confirmed: true } });
    const resumed = await client.call('tasks.get', { id: task.id });
    assert.equal(resumed.status, 'open', 'back to work, not waiting');
    assert.equal(resumed.waitingOn, undefined);
    await nextTurn(task.id, at);
    // the task's lines are in its own thread (Quests round 20.11.2026)
    const lines = (await client.call('messages.list', { conversationId: task.id })).filter((message) => message.kind === 'status').map((message) => message.body);
    assert.ok(lines.includes('Open again: Finish the portal sign-up'), 'a quiet line in its thread says it goes on');
  });

  await t.test('a message of the person while it waits is a turn on that task', async () => {
    const at = await waitOnPerson(task.id);
    await client.call('messages.send', { conversationId: chat.id, body: 'I finished the login' });
    const run = await nextTurn(task.id, at);
    assert.equal(run.taskId, task.id);
  });

  await t.test('the person reopening finished work wakes its owner; the ledger keeps it', async () => {
    await client.call('tasks.finish', { id: task.id, status: 'done', note: 'Signed up' });
    await sleep(GRACE_MS);
    const at = Date.now();
    const reopened = await client.call('tasks.update', { id: task.id, patch: { status: 'open' } });
    assert.equal(reopened.status, 'open');
    assert.ok(reopened.ledger.facts?.some((fact) => /^Reopened by .+\.$/.test(fact)), 'the ledger keeps the reopen');
    await nextTurn(task.id, at);
    await client.call('tasks.finish', { id: task.id, status: 'dropped' });
  });
});
