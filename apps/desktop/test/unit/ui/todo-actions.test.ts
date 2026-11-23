// Which quiet actions a to-do offers in its menu on the Tasks page (src/ui/tasks/todo-actions.ts, F06, B-041):
// "Can't do…" for agents' and the host's open to-dos, "Remove" only for the person's own to-dos, "Done" for an agent's
// mini-app to-do (its app may never report back), "Later" for every open to-do, "Send to team" for the person's own
// to-do outside a quest, "Only me" and "Important" for every open to-do of the person's own, "Move to quest" for every
// open to-do of a person; and which to-dos the row's single check
// finishes, with what answer.
// Owns: these assertions only. Never: the DOM or rpc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { UiBlock } from '../../../src/shared/blocks/catalog.ts';
import type { TaskStatus } from '../../../src/shared/model/tasks.ts';
import { checkAnswer, todoActions } from '../../../src/ui/tasks/todo-actions.ts';

type Status = TaskStatus;
const item = (createdBy: string, widget?: Record<string, unknown>, status: Status = 'open') =>
  ({ assigneeKind: 'human' as const, createdBy, status, widget: widget as UiBlock | undefined });
const none = { decline: false, remove: false, markDone: false, snooze: false, sendToTeam: false, onlyMe: false, important: false, move: false };
// an open to-do of the person's own: Later, Only me, Important, Move to quest
const open = { snooze: true, onlyMe: true, important: true, move: true };

test("an agent's to-do can be declined and snoozed, not removed or sent on", () => {
  assert.deepEqual(todoActions(item('ag_ava', { type: 'record', mode: 'audio' })), { ...none, ...open, decline: true });
  assert.deepEqual(todoActions(item('ag_ava', { type: 'approve', action: 'Use the logo' })), { ...none, ...open, decline: true },
    'an approve block is an ordinary question');
});

test("the person's own to-do can be removed, snoozed and sent to the team, not declined", () => {
  assert.deepEqual(todoActions(item(HUMAN_ID, { type: 'timer', label: 'Call the bank' })), { ...none, ...open, remove: true },
    'a timer stays with the person (day.sendToTeam refuses it)');
  assert.deepEqual(todoActions(item(HUMAN_ID)), { ...none, ...open, remove: true, sendToTeam: true });
  assert.equal(todoActions({ ...item(HUMAN_ID), parentId: 'task_1' }).sendToTeam, false, 'a to-do of a quest stays with it');
  assert.equal(todoActions({ ...item(HUMAN_ID), assigneeId: 'per_mara' }).onlyMe, false, "a colleague's to-do is not mine to mark \"Only me\"");
  assert.deepEqual([todoActions({ ...item(HUMAN_ID), assigneeId: 'per_mara' }).important, todoActions({ ...item(HUMAN_ID), assigneeId: 'per_mara' }).move], [false, true], 'nor mine to mark Important – but it can move into a quest');
  assert.equal(todoActions(item(HUMAN_ID, undefined, 'waiting')).sendToTeam, false, 'a snoozed one first comes back');
  assert.equal(todoActions(item(HUMAN_ID, undefined, 'waiting')).snooze, true, 'snoozing again moves its time');
});

test('a host to-do can be declined', () => {
  assert.equal(todoActions(item(SYSTEM_ID, { type: 'confirm', instructions: 'Resume computer use' })).decline, true);
});

test('a mini-app to-do can be marked done or declined; finished to-dos offer nothing but Remove', () => {
  const app = { type: 'app', messageId: 'msg_1', index: 0, permissions: [] };
  assert.deepEqual(todoActions(item('ag_ava', app)), { ...none, ...open, decline: true, markDone: true });
  assert.deepEqual(todoActions(item('ag_ava', app, 'done')), none);
  assert.deepEqual(todoActions(item(HUMAN_ID, undefined, 'dropped')), { ...none, remove: true });
  assert.deepEqual(todoActions({ ...item('ag_ava'), assigneeKind: 'agent' }), none, 'agent work is no to-do');
});

test('the check finishes plain to-dos, confirmations, reminders and checklists – with their answer', () => {
  assert.deepEqual(checkAnswer(item(HUMAN_ID)), {}, 'a plain Done');
  assert.deepEqual(checkAnswer(item('ag_ava', { type: 'confirm', instructions: 'Water the plants' })), { answer: { done: true } });
  assert.deepEqual(checkAnswer(item(HUMAN_ID, { type: 'timer', label: 'Pills', repeat: 'daily' })), { answer: { event: 'done' } }, 'a repeating one then waits');
  assert.deepEqual(checkAnswer(item(HUMAN_ID, { type: 'checklist', items: ['Milk', { text: 'Bread' }] })), { answer: { checked: ['Milk', 'Bread'], open: [] } });
  assert.deepEqual(checkAnswer(item(HUMAN_ID, undefined, 'open')), {}, 'a to-do that rang (still open)');
});

test('no check where only the widget can answer, for approvals, mini-apps and finished to-dos', () => {
  for (const widget of [{ type: 'choice', options: ['A', 'B'] }, { type: 'form', fields: [] }, { type: 'upload' }, { type: 'record', mode: 'audio' }, { type: 'review', src: '' }]) {
    assert.equal(checkAnswer(item('ag_ava', widget)), undefined, widget.type);
  }
  assert.equal(checkAnswer(item(SYSTEM_ID, { type: 'approve', action: 'Pay 30 EUR', approvalId: 'ap_1' })), undefined);
  assert.equal(checkAnswer(item('ag_ava', { type: 'app', messageId: 'msg_1', index: 0, permissions: [] })), undefined);
  assert.equal(checkAnswer(item(HUMAN_ID, undefined, 'done')), undefined);
  assert.equal(checkAnswer({ ...item(HUMAN_ID), assigneeKind: 'agent' }), undefined);
});
