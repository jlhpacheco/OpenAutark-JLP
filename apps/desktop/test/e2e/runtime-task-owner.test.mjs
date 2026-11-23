// End-to-end (T02): retries follow the task's owner and the human's Cancel stops the work, over
// the real headless runtime (built app/runtime-cli.mjs) with the deterministic fake engine and
// real WebSocket RPC. The fake engine's echo counts as progress, so an agent's own task keeps
// continuing about every second – which makes a missing stop visible within seconds.
// Covers: after a reassignment the previous owner starts no more turns on the task and the
// chat notes the change (a handoff line); the new owner runs it; after the human cancels it nobody does.
// Run: npm run build && node --test test/e2e/runtime-task-owner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const QUIET_MS = 4000; // several continuation periods (1 s each)
const GRACE_MS = 1500; // a turn that was already starting when the change landed

test('retries follow the owner; the human cancel stops the work', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const rhea = await client.call('agents.create', { name: 'Rhea', managerId: manager.id });
  await client.call('events.subscribe', { topics: [`runs:${manager.id}`, `runs:${rhea.id}`] });

  /** Turns of an agent on the task that started after `since`. */
  const turnsOn = (taskId, agentId, since) => new Set(client.events
    .filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === agentId && frame.data.taskId === taskId && (frame.data.startedAt ?? 0) > since)
    .map((frame) => frame.data.id)).size;

  const chat = await client.call('chats.create', { title: 'Hosting', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  await client.call('messages.send', { conversationId: chat.id, body: 'Later [[tool:tasks.add {"title":"Compare hosting offers"}]]' });
  const task = await client.waitFor('task.upserted', (item) => item.title === 'Compare hosting offers', 90_000);
  assert.equal(task.assigneeId, manager.id);
  await client.waitFor('run.upserted', (run) => run.agentId === manager.id && run.taskId === task.id, 90_000);

  await t.test('after a reassignment the previous owner starts no more turns on the task', async () => {
    const reassigned = await client.call('tasks.give', { id: task.id, to: rhea.id });
    const at = Date.now();
    assert.equal(reassigned.assigneeId, rhea.id);
    assert.equal(reassigned.assignedBy, 'human', 'it records who gave it');
    // KI-Runde 17.11. §5.6: work handed out of a chat the person is in to an agent who is not in it moves into the
    // giver's 1:1 with the receiver – here the person's own 1:1 with Rhea; the Hosting chat keeps its members.
    const room = await client.call('chats.get', { id: reassigned.conversationId });
    assert.equal(room.settings.direct, true, 'the work moved into a 1:1');
    assert.ok(room.members.some((member) => member.memberId === rhea.id && !member.leftAt), 'Rhea\'s 1:1 with the person');
    assert.ok(!(await client.call('chats.get', { id: chat.id })).members.some((member) => member.memberId === rhea.id && !member.leftAt), 'Rhea is not seated in Hosting');
    const line = (await client.call('messages.list', { conversationId: task.id, limit: 100 })) // a task's lines are in its own thread (Quests round 20.11.2026)
      .find((message) => message.meta?.status?.type === 'handoff' && message.meta.status.details?.taskId === task.id);
    assert.equal(line?.meta.status.details.to, rhea.id, 'its thread notes the new owner');
    await client.waitFor('run.upserted', (run) => run.agentId === rhea.id && run.taskId === task.id, 90_000);
    await sleep(QUIET_MS);
    assert.equal(turnsOn(task.id, manager.id, at + GRACE_MS), 0, 'no duplicate work by the previous owner');
    assert.ok(turnsOn(task.id, rhea.id, at) >= 1, 'the new owner works on it');
  });

  await t.test('after the human cancels the task nobody starts another turn on it', async () => {
    await client.call('tasks.finish', { id: task.id, status: 'dropped' });
    const at = Date.now();
    await sleep(QUIET_MS);
    assert.equal(turnsOn(task.id, rhea.id, at + GRACE_MS), 0);
    assert.equal(turnsOn(task.id, manager.id, at), 0);
    assert.equal((await client.call('tasks.get', { id: task.id })).status, 'dropped');
  });
});
