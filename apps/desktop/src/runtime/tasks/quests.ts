// The quest rules (Quests round 20.11.2026, one level): a to-do goes into a quest – given a to-do as its place, it goes
// into that to-do's quest, and a top-level to-do that gets a to-do of its own becomes a quest (as migration 110 did with
// today's pieces). A quest never sits in a quest; a to-do never holds to-dos; a to-do moves only into an open quest. A
// closed quest ends every open to-do in it (dropped quietly, "Quest closed: <why>"); a to-do of a closed quest opens
// again only with its quest – and opening the quest again (a reopen, an undo) brings back the to-dos its close ended, as
// they were (lifecycle.ts tells their owners). When the last open to-do of a quest ends, its agent owner hears it once
// (transitions.ts).
// Owns: those checks and the closing and reopening of a quest's to-dos. Never: wakes anyone or posts a line itself.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { isFinished, type Task } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';
import { recordChange } from './changes.ts';

/** The quest a new to-do placed under `given` goes into: it, its quest, or the top-level to-do that becomes one (makeQuest). */
export function questFor(t: TaskServiceImpl, given: Task): Task {
  if (given.kind !== 'quest' && given.parentId) return t.repo.get(given.parentId) ?? given;
  return given;
}

/** A top-level to-do that holds a to-do now is a quest (after the new to-do stands). */
export function makeQuest(t: TaskServiceImpl, task: Task): void {
  if (task.kind !== 'quest') t.mutate(task.id, (draft) => { draft.kind = 'quest'; });
}

/** The checks of a move into the quest `parentId` (null: out of its quest); throws when it cannot be. */
export function checkMove(t: TaskServiceImpl, task: Task, parentId: string | null): void {
  if (parentId === null) return;
  if (task.kind === 'quest') throw new WorkforceError('bad_request', 'A quest never sits in another quest.', { details: { taskId: task.id } });
  if (parentId === task.id) throw new WorkforceError('bad_request', 'A to-do cannot go into itself.', { details: { taskId: task.id } });
  const quest = t.repo.get(parentId);
  if (!quest) throw new WorkforceError('not_found', 'Quest not found.', { details: { taskId: parentId } });
  if (quest.kind !== 'quest') throw new WorkforceError('bad_request', 'That is a to-do, not a quest.', { details: { taskId: parentId } });
  if (isFinished(quest.status)) throw new WorkforceError('conflict', 'That quest is closed; reopen it first.', { details: { taskId: parentId } });
}

/** The checks of a change of kind: a quest stays top-level, a to-do holds nothing. */
export function checkKind(t: TaskServiceImpl, task: Task, kind: Task['kind']): void {
  if (kind === task.kind) return;
  if (kind === 'quest' && task.parentId) throw new WorkforceError('bad_request', 'A quest never sits in another quest; move it out first.', { details: { taskId: task.id } });
  if (kind === 'todo' && t.repo.children(task.id).length) throw new WorkforceError('bad_request', 'This quest holds to-dos; move them out first.', { details: { taskId: task.id } });
}

/** A to-do of a closed quest opens again only with its quest. */
export function checkReopen(t: TaskServiceImpl, task: Task): void {
  const quest = task.parentId ? t.repo.get(task.parentId) : undefined;
  if (quest && isFinished(quest.status)) {
    throw new WorkforceError('conflict', `Its quest "${quest.title}" is closed; reopen the quest first.`, { details: { taskId: task.id, questId: quest.id } });
  }
}

/** The open to-dos of a quest. */
export function openTodos(t: TaskServiceImpl, questId: string): Task[] {
  return t.repo.children(questId).filter((todo) => !isFinished(todo.status));
}

/** How a to-do that ended with its quest's close begins its result. */
const CLOSED = 'Quest closed: ';

/** A closed quest: every open to-do in it ends as dropped, quietly, with "Quest closed: <why>". Returns how many. */
export function closeTodos(t: TaskServiceImpl, quest: Task): number {
  const why = quest.result?.summary?.trim() || (quest.status === 'done' ? 'done' : 'dropped');
  let ended = 0;
  for (const todo of openTodos(t, quest.id)) {
    try {
      t.finish(todo.id, { status: 'dropped', summary: `${CLOSED}${why}`, quiet: true }, SYSTEM_ID);
      ended++;
    } catch (error) {
      t.s.log?.warn('a to-do of a closed quest stayed open', { questId: quest.id, taskId: todo.id, error: String(error) });
    }
  }
  return ended;
}

/**
 * A quest open again (a reopen or an undo of its close, R1.4): the to-dos that ended with that close – dropped by it at or
 * after `closedAt` – stand as they were before it, open or waiting on what they waited on; the change is logged (undoable).
 * Returns them as they are now.
 */
export function reopenTodos(t: TaskServiceImpl, quest: Task, closedAt: number | undefined, by: string): Task[] {
  if (closedAt === undefined) return [];
  const now = t.s.clock.now();
  const back: Task[] = [];
  for (const todo of t.repo.children(quest.id)) {
    if (todo.status !== 'dropped' || (todo.completedAt ?? 0) < closedAt || !todo.result?.summary.startsWith(CLOSED)) continue;
    try {
      back.push(t.mutate(todo.id, (draft) => {
        const close = (draft.ledger.changes ?? []).filter((entry) => entry.kind === 'finish' && entry.by === SYSTEM_ID).at(-1);
        const wait = close?.before.status === 'waiting' ? close.before.waitingOn as Task['waitingOn'] : undefined;
        draft.status = wait ? 'waiting' : 'open';
        if (wait) draft.waitingOn = wait; else delete draft.waitingOn;
        delete draft.completedAt;
        delete draft.result;
        draft.ledger = { ...draft.ledger, movedAt: now };
        recordChange(draft, todo, by, 'update', now);
      }));
    } catch (error) {
      t.s.log?.warn('a to-do of a reopened quest stayed closed', { questId: quest.id, taskId: todo.id, error: String(error) });
    }
  }
  return back;
}
