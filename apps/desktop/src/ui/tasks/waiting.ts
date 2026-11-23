// The static "waiting on … since" line of a task bubble: who or what the work waits on, since when and why – "Paused
// by you since …" for work the person stopped (shared isPaused) – the detail's one sentence of state (stateLine) and
// whether the detail offers Resume.
// Owns: that text and the Resume rule (unit-tested in test/unit/ui/task-waiting.test.ts).
// Never: imports the store, rpc or the DOM – names come in from the caller.

import { isPaused, type TaskView } from '../../shared/model/tasks.ts';
import { listTime, plainPreview, time } from '../lib/format.ts';

type Waiting = Pick<TaskView, 'status' | 'waitingOn'>;

/** "10:14" today, else the list's day with the time ("Mon 10:14", "12.10 10:14"), so an older time never reads as today's. */
function at(ms: number, now: number): string {
  const day = listTime(ms, now);
  const clock = time(ms);
  return day === clock ? clock : `${day} ${clock}`;
}

/** Who a wait names, in the person's words (their own id is "you"). */
function whoOf(task: Waiting, nameOf: (id: string) => string): string {
  const wait = task.waitingOn!;
  if (wait.on === 'who') return !wait.who || wait.who === 'human' ? 'you' : nameOf(wait.who);
  if (wait.on === 'task') return (wait.ids?.length ?? 0) > 1 ? `${wait.ids!.length} tasks` : 'a task';
  return '';
}

export function waitingLine(task: Waiting, nameOf: (id: string) => string, now = Date.now()): string | null {
  if (task.status !== 'waiting' || !task.waitingOn) return null;
  const wait = task.waitingOn;
  if (isPaused(task)) return `Paused by ${whoOf(task, nameOf)} since ${time(wait.since)}`;
  const who = whoOf(task, nameOf);
  return `${who ? `Waiting on ${who}` : 'Waiting'} since ${time(wait.since)} · ${plainPreview(wait.why, 90)}`;
}

type Stated = Waiting & Pick<TaskView, 'assigneeKind' | 'assigneeId' | 'running' | 'completedAt' | 'updatedAt'>;

/**
 * The task detail's one sentence of state – "Mara is on it" only while a turn really runs, "Waiting on you since 10:14",
 * "Done 10:14" (an earlier day: "Done Mon 10:14"), "Dropped"; an owner's open work between turns is "Mara has it".
 */
export function stateLine(task: Stated, nameOf: (id: string) => string, now = Date.now()): string {
  if (task.status === 'done') return `Done ${at(task.completedAt ?? task.updatedAt, now)}`;
  if (task.status === 'dropped') return 'Dropped';
  const waiting = waitingLine(task, nameOf, now);
  if (waiting) return waiting;
  if (task.assigneeKind === 'team') return 'Autark picks its owner';
  if (task.assigneeKind === 'human') return task.assigneeId && task.assigneeId !== 'human' ? `${nameOf(task.assigneeId)} has it` : 'Yours';
  const owner = task.assigneeId ? nameOf(task.assigneeId) : '';
  if (task.running) return `${owner || 'An agent'} is on it`;
  return owner ? `${owner} has it` : 'Open';
}

/** Resume in the task detail: only for work the person paused – tasks.update status 'open' ends the pause and its owner goes on. */
export function canResume(task: Waiting): boolean {
  return isPaused(task);
}
