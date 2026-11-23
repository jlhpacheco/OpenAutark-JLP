// The one right-click menu of a to-do on the Tasks page (src/ui/tasks/todo-menu.ts): Later › (its time moves), Repeat ›
// Daily · Weekdays · Weekly (checked when it repeats so) and Stop repeating on a repeating one, Show as ›, Move to quest ›
// (the open quests but its own, then "Out of …"), Can't do… on an asked to-do, Send to team, Only me and Important
// (checked when they are) on the person's own, Rename… and Undo last change always, Done on a mini-app, Remove on one's
// own – and the search's hits (src/ui/tasks/task-search.ts): what the page knows and what the runtime found, open ones first.
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../../src/shared/model/tasks.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { todoMenu } from '../../../src/ui/tasks/todo-menu.ts';
import { searchHits } from '../../../src/ui/tasks/task-search.ts';

const NOW = Date.UTC(2026, 10, 20, 8, 40);
let seq = 0;
function task(patch: Partial<Task> = {}): Task {
  seq++;
  return {
    id: `task_${String(seq).padStart(8, '0')}`, kind: 'todo', title: `T${seq}`, notes: '', status: 'open', assigneeKind: 'human', createdBy: 'ag_mira',
    priority: 0, ledger: {}, sort: seq, rev: 1, createdAt: NOW, updatedAt: NOW, ...patch,
  };
}

let renamed = 0;
const handlers = { onDecline: () => {}, onMarkDone: () => {}, onRemove: () => {}, onRename: () => { renamed++; } };
const said = (sections: ReturnType<typeof todoMenu>) => sections.map((section) => `${section.title ?? ''}: ${section.items.map((item) => `${item.label}${item.checked ? ' ✓' : ''}`).join(', ')}`);
const labels = (target: Task, quests: Array<Pick<Task, 'id' | 'title'>> = []) => said(todoMenu(target, handlers, quests));

test('an asked to-do: Later, Show as, Can\'t do…, Only me, Important, Rename…, Undo – no Send to team, no Remove', () => {
  const menu = labels(task({ widget: { type: 'confirm', instructions: 'Check it' } }));
  assert.match(menu[0], /^Later: In 10 minutes, In 1 hour, Tomorrow /);
  assert.equal(menu[1], 'Repeat: Daily, Weekdays, Weekly', 'making it repeat');
  assert.match(menu[2], /^Show as: Confirm ✓, Checklist, Reminder,/);
  assert.equal(menu[3], ": Can't do…, Only me, Important, Rename…, Undo last change");
  assert.equal(menu.length, 4);
});

test('the person\'s own: Send to team outside a quest, Only me and Important checked when they are, Remove; a repeating one can stop', () => {
  const own = labels(task({ createdBy: HUMAN_ID, private: true, priority: 1 }));
  assert.ok(own.includes(': Send to team, Only me ✓, Important ✓, Rename…, Undo last change'), own.join(' | '));
  assert.equal(own.at(-1), ': Remove');
  const inQuest = labels(task({ createdBy: HUMAN_ID, parentId: 'task_quest0001' }));
  assert.ok(inQuest.includes(': Only me, Important, Rename…, Undo last change'), 'a to-do of a quest stays in it');
  const repeating = labels(task({ createdBy: HUMAN_ID, widget: { type: 'timer', label: 'Pills', repeat: 'daily' }, at: NOW }));
  assert.ok(repeating.includes('Repeat: Daily ✓, Weekdays, Weekly, Stop repeating'), repeating.join(' | '));
});

test('Move to quest ›: every open quest but its own, then out of its own; Rename… opens the title', () => {
  const quests = [{ id: 'task_tax000001', title: 'Tax return 2026' }, { id: 'task_sign00001', title: 'Windows-Signierung' }];
  const loose = labels(task({ createdBy: HUMAN_ID }), quests);
  assert.ok(loose.includes('Move to quest: Tax return 2026, Windows-Signierung'), loose.join(' | '));
  const inTax = labels(task({ createdBy: HUMAN_ID, parentId: 'task_tax000001' }), quests);
  assert.ok(inTax.includes('Move to quest: Windows-Signierung, Out of Tax return 2026'), inTax.join(' | '));
  const sections = todoMenu(task(), handlers, quests);
  sections.flatMap((section) => section.items).find((item) => item.label === 'Rename…')?.onSelect();
  assert.equal(renamed, 1);
});

test('a finished to-do and agent work offer only Rename… and Undo (and Remove for one\'s own)', () => {
  const quests = [{ id: 'task_tax000001', title: 'Tax return 2026' }];
  assert.deepEqual(labels(task({ status: 'done' }), quests), [': Rename…, Undo last change'], 'nothing to move');
  assert.deepEqual(labels(task({ assigneeKind: 'agent', assigneeId: 'ag_felix' }), quests), [': Rename…, Undo last change']);
  assert.deepEqual(labels(task({ createdBy: HUMAN_ID, status: 'done' })), [': Rename…, Undo last change', ': Remove']);
});

test('search: what the page knows by stem, then what the runtime found; open ones first, then the newest', () => {
  const sign = task({ title: 'Windows-Signierung', kind: 'quest', updatedAt: NOW - 10 });
  const receipts = task({ title: 'Rechnungen ablegen', status: 'done', updatedAt: NOW });
  const other = task({ title: 'Milch kaufen' });
  const old = task({ title: 'Rechnung Certum', status: 'done', updatedAt: NOW - 99 });
  assert.deepEqual(searchHits([sign, receipts, other], [], 'signieren').map((hit) => hit.id), [sign.id], 'Signierung by its stem');
  assert.deepEqual(searchHits([receipts, other], [old, receipts], 'rechnung').map((hit) => hit.id), [receipts.id, old.id], 'plural and singular, no twice');
  assert.deepEqual(searchHits([sign, receipts], [], 'rechnung signierung'), [], 'every word must match');
  assert.deepEqual(searchHits([sign], [], '  '), []);
  const open = task({ title: 'Rechnung prüfen', updatedAt: NOW - 1000 });
  assert.equal(searchHits([receipts, open], [], 'rechnung')[0].id, open.id, 'open first');
});
