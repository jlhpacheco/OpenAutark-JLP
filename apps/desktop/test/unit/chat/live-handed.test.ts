// Work given away from a chat shows in that chat's live bar (runtime/chat/live.ts handedChat; owner 20.11.2026,
// FCMWNRKJ: Konrad wrote "Felix setzt jetzt um" in the person's chat and nothing there showed Felix working): a run on
// a task whose giving turn was in a chat (TaskLedger.givenIn) – and a split part of a group on such a task – shows in
// that chat as well as where it runs, until it ends; a task given in its own chat or not given shows only where it runs.
// Owns: these assertions only. Never: engines, timers or sleeps (liveGapMs 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import { SplitRepo } from '../../../src/runtime/store/splits.ts';
import { agent, harness } from './harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_konrad', 'Konrad'));
  h.org.add(agent('ag_felix', 'Felix'));
  const asked = h.chats.create({ agentIds: ['ag_konrad'], createdBy: 'human', title: 'Konrad' });
  const room = h.chats.create({ agentIds: ['ag_konrad', 'ag_felix'], createdBy: 'ag_konrad', title: 'Konrad & Felix' });
  const active = (list: AgentActivity[]) => h.bus.emit('agent.activity', { active: list });
  return { h, asked, room, active };
}

const shown = (h: ReturnType<typeof setup>['h'], chatId: string) => h.chats.summary(chatId).live?.map((run) => [run.agentId, run.runId]) ?? [];

test('a run on a task given away from a chat shows in that chat too, until it ends', () => {
  const { h, asked, room, active } = setup();
  const task = h.tasks.create({ conversationId: room.id, title: 'Release 0.3.15 signed', assigneeKind: 'agent', assigneeId: 'ag_felix', givenIn: asked.id, createdBy: 'ag_konrad' });
  active([{ agentId: 'ag_felix', runId: 'run_felix', conversationId: room.id, taskId: task.id, note: '', startedAt: 10 }]);
  assert.deepEqual(shown(h, asked.id), [['ag_felix', 'run_felix']], 'the chat it was given from shows Felix working');
  assert.deepEqual(shown(h, room.id), [['ag_felix', 'run_felix']], 'and where it runs');
  assert.ok(h.of('conversation.upserted').some((summary) => summary.id === asked.id && summary.live?.length === 1), 'the list hears it');
  active([]);
  assert.deepEqual(shown(h, asked.id), [], 'it leaves with its run');
});

test('a split part of a group on such a task shows in the chat it was given from', () => {
  const { h, asked, room, active } = setup();
  const task = h.tasks.create({ conversationId: room.id, title: 'Release 0.3.15 signed', assigneeKind: 'agent', assigneeId: 'ag_felix', givenIn: asked.id, createdBy: 'ag_konrad' });
  h.db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_felix', 'Felix', '{}', 'human', 0, 0)`); // the group's row needs its agent's
  new SplitRepo(h.db).saveGroup({ id: 'sgr_1', agentId: 'ag_felix', parentRunId: 'run_parent', conversationId: room.id, taskId: task.id, thread: 'main', goal: 'Sign', ultra: false, status: 'running', parts: 2, createdAt: 1 });
  active([{ agentId: 'ag_felix', runId: 'run_part', conversationId: room.id, note: '', startedAt: 20, split: { id: 'spl_1', groupId: 'sgr_1', idx: 1, of: 2, parentRunId: 'run_parent', title: 'Hook' } }]);
  assert.deepEqual(shown(h, asked.id), [['ag_felix', 'run_part']]);
});

test('a task given in its own chat, or not given at all, shows only where it runs', () => {
  const { h, asked, room, active } = setup();
  const own = h.tasks.create({ conversationId: room.id, title: 'Own chat', assigneeKind: 'agent', assigneeId: 'ag_felix', givenIn: room.id, createdBy: 'ag_konrad' });
  const plain = h.tasks.create({ conversationId: room.id, title: 'Not given', assigneeKind: 'agent', assigneeId: 'ag_felix', createdBy: 'ag_felix' });
  active([
    { agentId: 'ag_felix', runId: 'run_own', conversationId: room.id, taskId: own.id, note: '', startedAt: 10 },
    { agentId: 'ag_konrad', runId: 'run_plain', conversationId: room.id, taskId: plain.id, note: '', startedAt: 11 },
  ]);
  assert.deepEqual(shown(h, asked.id), []);
  assert.deepEqual(shown(h, room.id), [['ag_felix', 'run_own'], ['ag_konrad', 'run_plain']]);
});
