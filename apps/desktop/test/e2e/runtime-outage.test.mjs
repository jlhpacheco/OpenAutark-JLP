// End-to-end (T04): an outage neither stalls nor blocks a task, and its end resumes the task at
// once – over the real headless runtime (built app/runtime-cli.mjs) with the deterministic fake
// engine and real WebSocket RPC.
// Covers: with the only (demo) account disabled, the task turn cannot start; the task stays open,
// its chat gets one quiet "Paused: … – continues by itself" line and its owner's one retry wake waits (Quests round
// 20.11.2026: no planned look on the task – tasks/watch.ts retryLater, OUTAGE_RETRY_MS or the route's retry-after), so no
// turn follows at once; enabling the account again (account.upserted / models.updated) brings that retry forward
// (tasks/watch.ts outagesEnded), and its next turn runs on the fake engine.
// Run: npm run build && node --test test/e2e/runtime-outage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

test('an outage pauses a task without blocking it; the end of the outage resumes it', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const [demo] = await client.call('accounts.list');
  assert.ok(demo, 'demo mode seeds one fake-engine account');

  await client.call('accounts.update', { id: demo.id, enabled: false });
  const chat = await client.call('chats.create', { title: 'Outage', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`, `runs:${manager.id}`] });
  const task = await client.call('tasks.create', { conversationId: chat.id, title: 'Summarize the launch notes', to: manager.id });

  const failedRun = await client.waitFor('run.upserted', (run) => run.taskId === task.id && run.status === 'failed', 90_000);
  const line = await client.waitFor('message.created', (message) => message.conversationId === chat.id && message.meta?.status?.details?.outage === true, 90_000);
  assert.match(line.body, /^Paused: .+ – continues by itself$/, 'one quiet line, no failed bubble');
  assert.equal((await client.call('tasks.get', { id: task.id })).status, 'open', 'not paused or ended by the outage');
  await sleep(5_000);
  const turnsSince = client.events.filter((frame) => frame.event === 'run.upserted' && frame.data.taskId === task.id && (frame.data.startedAt ?? 0) > (failedRun.endedAt ?? 0));
  assert.deepEqual(turnsSince, [], 'the next try waits: no turn right after the outage');

  const enabledAt = Date.now();
  await client.call('accounts.update', { id: demo.id, enabled: true });
  const resumed = await client.waitFor('run.upserted', (run) => run.taskId === task.id && run.status === 'done' && (run.startedAt ?? 0) >= enabledAt, 50_000);
  assert.ok(Date.now() - enabledAt < 50_000, 're-woken by the event, not by the backoff');
  assert.equal(resumed.agentId, manager.id);
  assert.equal((await client.call('tasks.get', { id: task.id })).status, 'open');
  // The fake engine only echoes, so the task would keep continuing (paced); stop it here.
  await client.call('tasks.finish', { id: task.id, status: 'dropped' });
});
