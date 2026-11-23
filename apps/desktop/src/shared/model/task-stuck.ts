// The one stuck rule of the views (team activity, the Tasks page): unfinished work on which nothing moved for two days
// is stuck – unless its time (`at`) is still ahead. Work without an owner and paused work count too.
// Owns: that rule. Never: I/O or status changes.

import { PAUSED_REASON, isFinished, isPaused, type Task } from './tasks.ts';

export const STUCK_MS = 2 * 24 * 3600_000;

export interface Stuck { why: string; since: number }

type StuckTask = Pick<Task, 'assigneeKind' | 'status' | 'waitingOn' | 'ledger' | 'at' | 'createdAt'>;

/** When the task last really moved (its ledger's movedAt, else when it was made). */
export function movedAt(task: Pick<Task, 'ledger' | 'createdAt'>): number {
  return task.ledger?.movedAt ?? task.createdAt;
}

/** Why unfinished work is stuck, and since when (null: it is not). */
export function stuckOf(task: StuckTask, now: number): Stuck | null {
  if (isFinished(task.status)) return null;
  if (task.assigneeKind === 'team') return { why: 'No owner yet', since: task.createdAt };
  if (isPaused(task)) return { why: PAUSED_REASON, since: task.waitingOn!.since };
  if (task.at !== undefined && task.at > now) return null;
  const since = Math.max(movedAt(task), task.waitingOn?.since ?? 0);
  if (now - since < STUCK_MS) return null;
  return { why: task.waitingOn?.why || 'Nothing moved', since };
}
