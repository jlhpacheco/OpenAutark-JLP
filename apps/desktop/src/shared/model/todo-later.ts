// Which of the person's to-dos are due now and which wait under "Later" (F04; Quests round 20.11.2026: one "when", the
// to-do's `at` – "Later" moves it, a repeating timer's Done moves it to its next time) – one rule for every surface that
// lists or counts what todos.list returns (runtime tasks/repo.ts todos): the app's For-you list and badge and the
// runtime's own readers of TaskService.todos (the wf CLI). Under "Later": a timer more than 12 h ahead that has not rung,
// and any other to-do whose time is on a later day – at or after the end of the local today (the caller's zone).
// A to-do that rang is never "Later".
// "Needs you" (one rule for the badge and the page's For-you group): what rang (an open timer to-do whose time passed),
// what is overdue, and what an agent, the host or a colleague asks of the person – never a "Later" one.
// Owns: these pure rules. Never: reads a clock, the store or the database – callers pass data and the time in.

import { HUMAN_ID } from '../ids.ts';
import type { Task } from './tasks.ts';

/** A timer further ahead than this waits under "Later". */
export const LATER_MS = 12 * 60 * 60_000;

type Listed = Pick<Task, 'assigneeKind' | 'status' | 'widget' | 'at'>;
/** A listed to-do with who wrote it (a missing author counts as someone else) and its id (for approval pairs). */
type Counted = Listed & { createdBy?: string; id?: string; assigneeId?: string; kind?: Task['kind'] };

/** The first instant of the local day after the one `now` is in (this process's zone): where "today" ends. */
export function endOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/** The ring time of a timer to-do (its `at`), else undefined. */
export function timerAt(task: Pick<Task, 'widget' | 'at'>): number | undefined {
  return task.widget?.type === 'timer' && task.at !== undefined && Number.isFinite(task.at) ? task.at : undefined;
}

/** On the list (the rule of repo.todos): the person's own unfinished to-do – never a quest (a goal, not a to-do; the badge never counts one). */
export function onForYouList(task: Pick<Task, 'assigneeKind' | 'status'> & { assigneeId?: string; kind?: Task['kind'] }): boolean {
  if (task.kind === 'quest') return false;
  // F-52: a to-do with an assignee id belongs to another person (the caller's own have none, or 'human').
  if (task.assigneeId !== undefined && task.assigneeId !== 'human') return false;
  return task.assigneeKind === 'human' && (task.status === 'open' || task.status === 'waiting');
}

/** Rings now: an open timer to-do whose time came. */
export function isRinging(task: Pick<Task, 'assigneeKind' | 'status' | 'widget' | 'at'>, now: number): boolean {
  const at = timerAt(task);
  return task.assigneeKind === 'human' && task.status === 'open' && at !== undefined && at <= now;
}

/**
 * Under "Later": a timer more than 12 h ahead that has not rung (its ring time decides, not the day); any other to-do
 * whose time is at or after `dayEnd` (default: the end of the local today). A to-do that rang needs the person now.
 */
export function isLater(task: Listed, now: number, dayEnd: number = endOfToday(now)): boolean {
  if (isRinging(task, now)) return false;
  const at = timerAt(task);
  if (at !== undefined) return at - now > LATER_MS;
  return task.at !== undefined && task.at >= dayEnd;
}

/**
 * Needs the person now (the badge, For you): what rang, what is overdue, and what someone else (an agent, the host, a
 * colleague) asks of them – never a "Later" one. The person's own to-dos wait for their time; a timer that has not rung
 * waits too.
 */
export function needsYou(task: Counted, now: number, dayEnd: number = endOfToday(now)): boolean {
  if (isRinging(task, now)) return true;
  if (task.at !== undefined && task.at < now) return true;
  if (isLater(task, now, dayEnd) || timerAt(task) !== undefined) return false;
  return task.createdBy !== HUMAN_ID;
}

/** The badge (rail, phone tab, overlay): the to-dos on the list that need the person now (needsYou). */
export function countNow(list: readonly Counted[], now: number, dayEnd: number = endOfToday(now)): number {
  let count = 0;
  for (const task of list) if (onForYouList(task) && needsYou(task, now, dayEnd)) count++;
  return count;
}
