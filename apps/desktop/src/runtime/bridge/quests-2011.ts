// bridge 0.3.16 – it goes two releases later (Quests round 20.11.2026, migration 110).
// A task row a 0.3.x PC sends (devices/sync/tables.ts → tasks/repo.ts toTask) still carries due_at / estimate_min and no
// kind. Its time is the person's only, as in migration 110 (an agent's or a team row's old due date never comes back):
// `at ?? due_at`, `minutes ?? estimate_min`, and where the older PC sends none, this PC's stored ones stay (olderRow – it
// never set them). It keeps the kind stored here (a save of such a row never turns a quest into a to-do); a piece it
// brings goes into the top quest (never a quest in a quest) and makes it a quest. A routine or timer schedule it sends is
// what migration 110 makes of one (oldSchedule, the one mapping): a reminder or message row, or its to-do's ring. The one
// place of those reads.
// Owns: those reads and marks. Never: writes a row itself beyond the parent's kind and a timer's ring, or applies to rows
// of this version.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { isFinished, type Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { oldSchedule, type OldSchedule } from '../db/migrations/110-quests.ts';

type Row = Record<string, unknown>;

/** The mark on a task read from a row without a kind (an older PC's) – a symbol: never sent on, kept by a spread copy. */
const OLDER = Symbol('older-row');
type Marked = Task & { [OLDER]?: true };

const num = (value: unknown): number | undefined => (value === null || value === undefined || value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined);
const older = (row: Row): boolean => row.kind === undefined || row.kind === null;

/** `at`, `minutes` and `kind` of a row – an older PC's from its own columns, a time only for the person's work. */
export function questsRead(row: Row): Pick<Task, 'kind'> & Partial<Pick<Task, 'at' | 'minutes'>> & { older: boolean } {
  const old = older(row);
  const person = !old || row.assignee_kind === 'human';
  const at = num(row.at) ?? (person ? num(row.due_at) : undefined);
  const minutes = num(row.minutes) ?? (person ? num(row.estimate_min) : undefined);
  return { kind: row.kind === 'quest' ? 'quest' : 'todo', ...(at !== undefined ? { at } : {}), ...(minutes !== undefined ? { minutes } : {}), older: old };
}

/**
 * An older PC's incoming task row as this PC writes it (the sync write path, before toTask): the person's time from its
 * due_at, else the one stored here; none for agent or team work; its parent the top quest; a quest stored here stays at
 * the top. A row of this version comes back unchanged.
 */
export function olderRow(db: Db, row: Row): Row {
  if (!older(row)) return row;
  const { due_at: due, estimate_min: estimate, ...rest } = row;
  const stored = db.get<{ at: number | null; minutes: number | null; kind: string }>('SELECT "at", minutes, kind FROM tasks WHERE id = ?', [String(row.id)]);
  const person = row.assignee_kind === 'human';
  const out: Row = { ...rest, at: person ? num(due) ?? stored?.at ?? null : null, minutes: person ? num(estimate) ?? stored?.minutes ?? null : null };
  if (stored?.kind === 'quest') out.parent_id = null;
  else if (typeof row.parent_id === 'string') out.parent_id = topOf(db, row.parent_id, String(row.id));
  return out;
}

/** The task at the top of `id`'s parents (itself when it has none; a loop or a missing parent stops the walk). */
function topOf(db: Db, id: string, self: string): string {
  let top = id;
  const seen = new Set([self, id]);
  for (let parent = parentOf(db, top); parent && !seen.has(parent); parent = parentOf(db, top)) {
    seen.add(parent);
    top = parent;
  }
  return top;
}

const parentOf = (db: Db, id: string): string | undefined => db.get<{ parent_id: string | null }>('SELECT parent_id FROM tasks WHERE id = ?', [id])?.parent_id ?? undefined;

/** Marks a task read from an older PC's row (toTask). */
export function markOlder(task: Task): Task {
  (task as Marked)[OLDER] = true;
  return task;
}

/** Whether the task was read from an older PC's row: its save keeps the stored kind. */
export function isOlder(task: Task): boolean {
  return (task as Marked)[OLDER] === true;
}

/** An older PC's piece arrived: the task it belongs to (a top one – olderRow) holds to-dos now, so it is a quest. */
export function olderPiece(db: Db, task: Task): void {
  if (isOlder(task) && task.parentId) db.run(`UPDATE tasks SET kind = 'quest' WHERE id = ? AND kind <> 'quest' AND parent_id IS NULL`, [task.parentId]);
}

/**
 * An older PC's schedule row as this PC stores it: a routine as the reminder or message migration 110 makes of it; a
 * timer stores nothing – its pending ring (from the spec here: an older PC's due time does not travel) becomes its to-do's
 * `at` while the to-do is the person's and open; undefined: nothing is stored.
 */
export function olderSchedule(s: Pick<RuntimeServices, 'tasks' | 'clock' | 'scheduler'>, row: Row): Row | undefined {
  if (row.kind !== 'routine' && row.kind !== 'timer') return row;
  let next: number | undefined;
  try { next = row.kind === 'timer' && row.active ? s.scheduler.next(JSON.parse(String(row.spec)), s.clock.now()) : undefined; } catch { next = undefined; }
  const now = oldSchedule({ ...(row as unknown as OldSchedule), next_at: next ?? null });
  if (now.as === 'reminder' || now.as === 'message') return { ...row, kind: now.as, payload: now.payload };
  if (now.as === 'ring') {
    const task = s.tasks.get(now.taskId);
    if (task && task.assigneeKind === 'human' && !isFinished(task.status) && task.at !== now.at) s.tasks.update(task.id, { at: now.at }, SYSTEM_ID);
  }
  return undefined;
}
