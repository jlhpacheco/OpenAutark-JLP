// The task bubble's wait line, the detail's one sentence of state and the Resume rule (ui/tasks/waiting.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { PAUSED_REASON } from '../../../src/shared/model/tasks.ts';
import { canResume, stateLine, waitingLine } from '../../../src/ui/tasks/waiting.ts';
import { time } from '../../../src/ui/lib/format.ts';

const SINCE = new Date(2026, 10, 13, 10, 14).getTime();
const NOW = new Date(2026, 10, 13, 12, 0).getTime();
/** The clock in the host's locale ("10:14", on an en-US host "10:14 AM"): the line follows the device. */
const AT = time(SINCE);
const names = (id: string) => ({ ag_ida: 'Ida', per_mara: 'Mara' } as Record<string, string>)[id] ?? id;

function task(extra: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task_1', kind: 'todo', title: 'T', notes: '', status: 'open', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'human', priority: 0,
    ledger: {}, sort: 0, rev: 0, createdAt: SINCE, updatedAt: SINCE, steps: [], progress: { done: 0, total: 0 }, conversationTitle: '', running: false, ...extra,
  };
}

test('the wait line names who or what, since when and why; a pause is the person\'s', () => {
  assert.equal(waitingLine(task(), names), null);
  assert.equal(waitingLine(task({ status: 'waiting', waitingOn: { on: 'who', who: 'human', why: '7:30 oder nachmittags?', since: SINCE } }), names, NOW), `Waiting on you since ${AT} · 7:30 oder nachmittags?`);
  assert.equal(waitingLine(task({ status: 'waiting', waitingOn: { on: 'who', who: 'per_mara', why: 'Freigabe', since: SINCE } }), names, NOW), `Waiting on Mara since ${AT} · Freigabe`);
  assert.equal(waitingLine(task({ status: 'waiting', waitingOn: { on: 'outside', why: 'Handy-Lauf', since: SINCE } }), names, NOW), `Waiting since ${AT} · Handy-Lauf`);
  const paused = task({ status: 'waiting', waitingOn: { on: 'who', who: 'human', why: PAUSED_REASON, since: SINCE } });
  assert.equal(waitingLine(paused, names, NOW), `Paused by you since ${AT}`);
  assert.equal(canResume(paused), true);
  assert.equal(canResume(task({ status: 'waiting', waitingOn: { on: 'who', who: 'human', why: 'x', since: SINCE } })), false);
});

test('state: working only while a run is live', () => {
  assert.equal(stateLine(task(), names, NOW), 'Ida has it');
  assert.equal(stateLine(task({ running: true }), names, NOW), 'Ida is on it');
  assert.equal(stateLine(task({ status: 'dropped' }), names, NOW), 'Dropped');
  assert.equal(stateLine(task({ assigneeKind: 'human', assigneeId: undefined }), names, NOW), 'Yours');
});
