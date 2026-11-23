// 17.11.2026 (Konrad #88/#117, "Mein Tag" Paket 2): the change log of a task and its undo. Every write of update(), finish() or give() that changes one of
// the fields a reader sees – status, the wait, the result, its time and length, its title, priority, owner, its quest – leaves one entry in the
// task's ledger (`ledger.changes`: who, when, the values before and after, only the fields that changed). The ledger is a column of the task's own row, so the log
// travels with it between PCs and the phone, and an undo on any of them is an ordinary write the row sync carries. An entry is undoable for 24 hours, until it is
// undone, and while the task still holds what the change wrote (a later change to the same field ends it: undo that one first). At most 10 entries are kept.
// Notes, plan, facts and order are working text and are not logged: an agent that only adds a line leaves no entry.
// Owns: which fields count, the entry, the 24 hours and the undo's checks and its write (service.ts calls them). Never: sends a message or wakes anyone (the lifecycle does).

import { WorkforceError } from '../../shared/errors.ts';
import type { Task, TaskChange } from '../../shared/model/tasks.ts';

/** The fields a change entry carries (what the Tasks page shows as "Closed by …", "Moved to …"). */
export const LOGGED_FIELDS = [
  'title', 'status', 'waitingOn', 'result', 'completedAt', 'at', 'minutes', 'priority', 'doneWhen', 'assigneeKind', 'assigneeId', 'parentId', 'kind',
] as const satisfies ReadonlyArray<keyof Task>;
type Logged = (typeof LOGGED_FIELDS)[number];

/** How long an entry can be undone, and how many entries a task keeps. */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
export const KEEP_CHANGES = 10;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The entries of `task` still within their 24 hours (an undone one stays listed until it expires: the line "Undone" says what happened). */
export function liveChanges(task: Pick<Task, 'ledger'>, now: number): TaskChange[] {
  return (task.ledger.changes ?? []).filter((entry) => now - entry.at < UNDO_WINDOW_MS);
}

/** Writes the entry for what `draft` changed against `before` (inside the write's own mutate); none when no logged field changed. */
export function recordChange(draft: Task, before: Task, by: string, kind: TaskChange['kind'], now: number): void {
  const was: Record<string, unknown> = {};
  const is: Record<string, unknown> = {};
  for (const key of LOGGED_FIELDS) {
    if (same(before[key], draft[key])) continue;
    was[key] = before[key] ?? null;
    is[key] = draft[key] ?? null;
  }
  if (!Object.keys(was).length) return;
  const entry: TaskChange = { id: `chg_${now.toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`, at: now, by, kind, before: was, after: is };
  draft.ledger = { ...draft.ledger, changes: [...liveChanges(draft, now), entry].slice(-KEEP_CHANGES) };
}

/** What can be undone now: the entry `changeId` names, else the latest that is not undone. */
export function undoable(task: Pick<Task, 'ledger'>, now: number, changeId?: string): TaskChange | undefined {
  const live = liveChanges(task, now).filter((entry) => entry.undone === undefined);
  return changeId ? live.find((entry) => entry.id === changeId) : live.at(-1);
}

/**
 * Puts the entry's `before` values back (inside the undo's own mutate) and marks it undone. Throws `not_found` when there is nothing to undo and `conflict`
 * when a logged field no longer holds what the change wrote – a later change came after it. Returns nothing; the caller emits and tells.
 */
export function applyUndo(draft: Task, entry: TaskChange, by: string, name: string, now: number): void {
  for (const [key, value] of Object.entries(entry.after)) {
    if (!same((draft as unknown as Record<string, unknown>)[key], value)) {
      throw new WorkforceError('conflict', 'The task changed after that. Undo the later change first, or change it by hand.', { details: { taskId: draft.id, field: key } });
    }
  }
  const fields = draft as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(entry.before)) {
    if (value === null) delete fields[key]; else fields[key] = value;
  }
  const line = `Undone by ${name}: ${describe(entry)}.`;
  draft.ledger = {
    ...draft.ledger,
    changes: (draft.ledger.changes ?? []).map((item) => (item.id === entry.id ? { ...item, undone: now, undoneBy: by } : item)),
    facts: [...(draft.ledger.facts ?? []).filter((fact) => fact !== line), line].slice(-20),
    movedAt: now,
  };
}

/** "closed by Felix", "moved to 14:00" in a few words for the line a reader sees (the actor's name is the caller's). */
export function describe(entry: Pick<TaskChange, 'before' | 'after' | 'kind'>): string {
  const status = entry.after.status;
  if (status === 'done') return 'it was closed as done';
  if (status === 'dropped') return 'it was closed as dropped';
  if (status === 'waiting') return 'it was set to waiting';
  if (status === 'open') return 'it was opened again';
  if ('at' in entry.after || 'minutes' in entry.after) return 'its time was changed';
  if ('parentId' in entry.after) return 'it was moved to another quest';
  if ('assigneeId' in entry.after || 'assigneeKind' in entry.after) return 'it was given to someone else';
  if ('title' in entry.after) return 'its title was changed';
  return 'it was changed';
}
