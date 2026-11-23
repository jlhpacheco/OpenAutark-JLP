// B-080 (live 05.–09.11.: 53 of 392 agent tasks had notes over 3,000 characters; a delegated brief stood behind the cut
// from the second turn on): the task text shows the notes whole – they are bounded where they are written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { renderTask } from '../../../src/runtime/context/task-text.ts';
import { agent, harness } from '../chat/harness.ts';

test('the task text shows the notes whole – a long delegated brief keeps its end in every turn', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const notes = `${'Brief line with the person\'s words and the facts. '.repeat(160)}LAST LINE: what good looks like.`;
  const task = h.tasks.create({ conversationId: chat.id, title: 'Long brief', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: HUMAN_ID, notes });
  const text = renderTask(h.services as RuntimeServices, h.tasks.get(task.id)!, 'UTC', '## Current to-do');
  assert.ok(notes.length > 8000);
  assert.ok(text.includes(notes), 'the whole notes stand in the task text');
  assert.doesNotMatch(text, /\(truncated\)/);
});
