// The Tasks page's calls (src/ui/tasks/page-actions.ts; review R2.4–R2.8, R2.13): the input line's lines – one
// tasks.quickCreate per line with the quest, whom it goes to ("Send to…"), "Only me" and the files (on the first one
// only), the lines that failed given back –, and the detail's edits as one tasks.update each: a new title (with the
// rev, so a concurrent change is never overwritten), a time or none, into a quest or out of it, Important.
// Owns: these assertions only. Never: a real runtime (rpc.call is a fake) or rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../../src/shared/model/tasks.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
let refuse = '';
(rpc as unknown as { call: unknown }).call = async (method: string, params: Record<string, unknown>) => {
  calls.push({ method, params });
  if (refuse && params.text === refuse) throw new Error('refused');
  const id = `task_${String(calls.length).padStart(8, '0')}`;
  const view = { id, kind: 'todo', title: String(params.text ?? 'T'), notes: '', status: 'open', assigneeKind: 'human', createdBy: 'human', priority: 0, ledger: {}, sort: 0, rev: 2, createdAt: 1, updatedAt: 1, steps: [], progress: { done: 0, total: 0 }, conversationTitle: '', running: false };
  return method === 'tasks.quickCreate' ? { task: view, assistantId: 'ag_paula' } : view;
};
const { addLines, moveToQuest, rename, setImportant, setTime, told } = await import('../../../src/ui/tasks/page-actions.ts');

const FILE = { fileId: 'f'.repeat(64), name: 'receipt.pdf', mime: 'application/pdf', size: 3 };
const todo = { id: 'task_edit0001', rev: 7 } as Task;

test('one quickCreate per line: the quest, whom it goes to, Only me on each, the files on the first only; the assistant told once', async () => {
  calls.length = 0;
  const failed = await addLines([{ title: 'Milch kaufen' }, { title: 'Anna anrufen', at: 5, minutes: 30 }], { quest: 'task_quest0001', target: { kind: 'agent', id: 'ag_mira' }, private: false, files: [FILE] });
  assert.deepEqual(failed, []);
  assert.deepEqual(calls.map((call) => call.method), ['tasks.quickCreate', 'tasks.quickCreate']);
  const [first, second] = calls.map((call) => call.params);
  assert.deepEqual([first.text, first.quest, first.target, first.private, first.attachments], ['Milch kaufen', 'task_quest0001', { kind: 'agent', id: 'ag_mira' }, false, [{ fileId: FILE.fileId, name: 'receipt.pdf' }]]);
  assert.deepEqual([second.text, second.at, second.minutes, second.attachments], ['Anna anrufen', 5, 30, undefined]);
  assert.notEqual(first.clientId, second.clientId, 'each line its own idempotency key');
  assert.deepEqual(told.value?.ids, ['task_00000001', 'task_00000002']);
});

test('a line that could not be added is given back; the others stood', async () => {
  calls.length = 0;
  refuse = 'Zwei';
  const failed = await addLines([{ title: 'Eins' }, { title: 'Zwei' }, { title: 'Drei' }]);
  refuse = '';
  assert.deepEqual(failed, [{ title: 'Zwei' }]);
  assert.equal(calls.length, 3);
  assert.equal('private' in calls[0].params, false, 'Only me unsaid: the runtime\'s default');
});

test('the detail\'s edits: title with its rev, a time or none, into a quest or out, Important', async () => {
  calls.length = 0;
  await rename(todo, 'Steuer 2026');
  await setTime(todo, { at: 99, minutes: null });
  await setTime(todo, { at: null, minutes: null });
  await moveToQuest(todo, 'task_quest0001');
  await moveToQuest(todo, null);
  await setImportant(todo, true);
  assert.deepEqual(calls.map((call) => call.params), [
    { id: todo.id, rev: 7, patch: { title: 'Steuer 2026' } },
    { id: todo.id, patch: { at: 99, minutes: null } },
    { id: todo.id, patch: { at: null, minutes: null } },
    { id: todo.id, patch: { parentId: 'task_quest0001' } },
    { id: todo.id, patch: { parentId: null } },
    { id: todo.id, patch: { priority: 1 } },
  ]);
  assert.ok(calls.every((call) => call.method === 'tasks.update'));
});
