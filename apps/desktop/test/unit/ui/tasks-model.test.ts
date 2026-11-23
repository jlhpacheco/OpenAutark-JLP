// Pure task/to-do view helpers (src/ui/tasks/model.ts, todo-model.ts, work-model.ts): progress text, owners, "Show
// as…", widget icons and the steps of a task card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskView } from '../../../src/shared/model/tasks.ts';
import { canToggleStep, orderedSteps, progressLabel, progressPercent, withStep, withoutStep } from '../../../src/ui/tasks/model.ts';
import { askTargetOf, showAsOptions, widgetIcon } from '../../../src/ui/tasks/todo-model.ts';
import { ownerOf } from '../../../src/ui/tasks/work-model.ts';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
let seq = 0;

function task(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: patch.id ?? `task_${seq}`, kind: 'todo', conversationId: 'ch_a', title: `Task ${seq}`, notes: '', status: 'open', assigneeKind: 'team',
    createdBy: 'human', priority: 0, ledger: {}, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Alpha', running: false,
    ...patch,
  };
}

function step(patch: Partial<Task> = {}): Task {
  const { steps: _s, progress: _p, conversationTitle: _c, running: _r, ...rest } = task(patch);
  return { ...rest, parentId: patch.parentId ?? 'task_parent' };
}


test('progress helpers', () => {
  assert.equal(progressLabel({ done: 6, total: 10 }), '6 of 10');
  assert.equal(progressLabel({ done: 0, total: 0 }), '');
  assert.equal(progressPercent({ done: 1, total: 3 }), 33);
  assert.equal(progressPercent({ done: 5, total: 3 }), 100);
  assert.equal(progressPercent({ done: 0, total: 0 }), 0);
});

test('a task owner: an agent, or the team while it has none', () => {
  assert.deepEqual(ownerOf({ assigneeKind: 'agent', assigneeId: 'ag_x' }), { kind: 'agent', id: 'ag_x' });
  assert.deepEqual(ownerOf({ assigneeKind: 'agent' }), { kind: 'team' });
});

test('a to-do answer goes to the task; "Show as" is for human to-dos only', () => {
  const human = task({ assigneeKind: 'human', createdBy: 'ag_1', widget: { type: 'approve', action: 'Pay' } });
  assert.deepEqual(askTargetOf(human), { kind: 'task', taskId: human.id });
  assert.ok(showAsOptions(human).length > 0);
  assert.equal(showAsOptions(task({ assigneeKind: 'agent' })).length, 0);
});

test('widget icons follow the widget type and record mode', () => {
  assert.equal(widgetIcon({ type: 'record', mode: 'video' }), 'camera');
  assert.equal(widgetIcon({ type: 'record', mode: 'audio' }), 'microphone');
  assert.equal(widgetIcon({ type: 'timer', label: 'x' }), 'clock');
  assert.equal(widgetIcon(undefined), 'check-circle');
});

test('steps: only human steps toggle; order and progress stay consistent', () => {
  assert.equal(canToggleStep({ assigneeKind: 'human', status: 'open' }), true);
  assert.equal(canToggleStep({ assigneeKind: 'agent', status: 'open' }), false);
  assert.equal(canToggleStep({ assigneeKind: 'human', status: 'dropped' }), false);
  const first = step({ sort: 2 });
  const second = step({ sort: 1 });
  assert.deepEqual(orderedSteps([first, second]).map((s) => s.id), [second.id, first.id]);
  const parent = task({ steps: [first, second], progress: { done: 0, total: 2 } });
  const updated = withStep(parent, { ...first, status: 'done' });
  assert.deepEqual(updated.progress, { done: 1, total: 2 });
  const added = withStep(updated, step({ status: 'open' }));
  assert.deepEqual(added.progress, { done: 1, total: 3 });
  assert.deepEqual(withoutStep(added, first.id).progress, { done: 0, total: 2 });
});
