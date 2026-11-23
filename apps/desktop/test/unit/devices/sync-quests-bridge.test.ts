// Mixed fleet for one release (bridge/quests-2011.ts through the sync write path, devices/sync/tables.ts): a task row a
// 0.3.x PC sends has due_at/estimate_min and no kind – the person's time comes from it, else this PC's stored time stays;
// an agent's or a team row's old due date never becomes a time; its save keeps the stored kind; a piece of a to-do goes
// into the top quest (never a quest in a quest); a routine is stored as migration 110's reminder or message, a timer as
// its to-do's ring (no row).
// Owns: these assertions only. Never: the wire or the stamps (sync-rows tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { TABLE, type Apply, type Wire } from '../../../src/runtime/devices/sync/tables.ts';
import { TaskRepo, toTask } from '../../../src/runtime/tasks/repo.ts';
import { agent, harness } from '../chat/harness.ts';

const H = 3600_000;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida'));
  const ctx: Apply = { s: h.services, first: false };
  /** The stored row as a 0.3.x PC sends it: no kind, at, minutes – its own due_at and estimate_min. */
  const older = (id: string, extra: Wire = {}): Wire => {
    const row: Wire = { ...h.db.get<Wire>('SELECT * FROM tasks WHERE id = ?', [id])!, due_at: null, estimate_min: null, ...extra };
    for (const column of ['kind', 'at', 'minutes']) delete row[column];
    return row;
  };
  const write = (table: 'tasks' | 'schedules', row: Wire, existed = true) => TABLE.get(table)!.write!(row, ctx, existed);
  const row = (id: string) => ({ ...h.db.get<{ kind: string; at: number | null; minutes: number | null; parent_id: string | null }>('SELECT kind, "at", minutes, parent_id FROM tasks WHERE id = ?', [id])! });
  return { ...h, older, write, row };
}

test('an older PC\'s row of the person\'s to-do: its due_at is the time; without one this PC\'s time and length stay', () => {
  const h = setup();
  const now = h.clock.now();
  const todo = h.tasks.create({ title: 'Call the bank', assigneeKind: 'human', createdBy: HUMAN_ID, at: now + 2 * H, minutes: 20 });
  h.write('tasks', h.older(todo.id, { notes: 'ticked on the old PC', rev: todo.rev + 1 }));
  assert.deepEqual([h.row(todo.id).at, h.row(todo.id).minutes], [now + 2 * H, 20], 'a time set here is not wiped by an edit there');
  h.write('tasks', h.older(todo.id, { due_at: now + 5 * H, estimate_min: 45, rev: todo.rev + 2 }));
  assert.deepEqual([h.row(todo.id).at, h.row(todo.id).minutes], [now + 5 * H, 45], 'a time the old PC set');
});

test('an older PC\'s agent or team row never brings its due date as a time; its save keeps the stored kind', () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Windows signing', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.write('tasks', h.older(quest.id, { due_at: h.clock.now() + 41 * H, estimate_min: 30, title: 'Windows signing (older PC)', rev: quest.rev + 1 }));
  assert.deepEqual(h.row(quest.id), { kind: 'quest', at: null, minutes: null, parent_id: null });
  const read = toTask(h.older(quest.id, { assignee_kind: 'team', due_at: 1_000 }));
  assert.deepEqual([read.kind, read.at, read.minutes], ['todo', undefined, undefined], 'read as a to-do until its kind is known, without a time');
});

test('an older PC\'s piece goes into the top quest – of a to-do in a quest as of a loose to-do, which becomes the quest', () => {
  const h = setup();
  const repo = new TaskRepo(h.db);
  const quest = h.tasks.create({ kind: 'quest', title: 'Tax return', assigneeKind: 'human', createdBy: HUMAN_ID });
  const step = h.tasks.create({ title: 'Collect receipts', parentId: quest.id, assigneeKind: 'human', createdBy: HUMAN_ID });
  const piece = { ...h.older(step.id), id: 'task_old_piece', title: 'Scan the train tickets', parent_id: step.id };
  h.write('tasks', piece, false);
  assert.equal(repo.get('task_old_piece')!.parentId, quest.id, 'one level: in the quest, not under the to-do');
  assert.equal(h.row(step.id).kind, 'todo', 'the to-do stays a to-do');
  const loose = h.tasks.create({ title: 'Loose', assigneeKind: 'human', createdBy: HUMAN_ID });
  h.write('tasks', { ...h.older(loose.id), id: 'task_old_piece_2', title: 'Part of it', parent_id: loose.id }, false);
  assert.deepEqual([h.row('task_old_piece_2').parent_id, h.row(loose.id).kind], [loose.id, 'quest']);
});

test('an older PC\'s routine is stored as the reminder migration 110 makes of it; its timer rings the person\'s to-do and stores no row', () => {
  const h = setup();
  const now = h.clock.now();
  const base = { title: 'x', runs: 0, active: 1, created_at: now, conversation_id: null, payload: '{}' };
  h.write('schedules', { ...base, id: 'sch_routine', owner_id: 'ag_ida', kind: 'routine', spec: JSON.stringify({ cron: '0 18 * * *' }),
    payload: JSON.stringify({ taskTemplate: { title: 'Answer YouTube comments' } }) }, false);
  const stored = h.db.get<{ kind: string; payload: string }>(`SELECT kind, payload FROM schedules WHERE id = 'sch_routine'`)!;
  assert.deepEqual([stored.kind, JSON.parse(stored.payload)], ['reminder', { note: 'Every day at 18:00: Answer YouTube comments' }]);
  const todo = h.tasks.create({ title: 'Take the bread out', assigneeKind: 'human', createdBy: HUMAN_ID });
  h.write('schedules', { ...base, id: 'sch_timer', owner_id: HUMAN_ID, kind: 'timer', task_id: todo.id, spec: JSON.stringify({ at: now + 30 * 60_000 }) }, false);
  assert.equal(h.tasks.get(todo.id)!.at, now + 30 * 60_000, 'the ring is the to-do\'s own time');
  assert.equal(h.db.get(`SELECT 1 AS hit FROM schedules WHERE id = 'sch_timer'`), undefined);
});
