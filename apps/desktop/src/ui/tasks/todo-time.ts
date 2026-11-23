// The person's to-dos and time, pure (F04; Quests round 20.11.2026: one "when", the to-do's `at`): which to-dos are on
// the For-you list (the runtime's todos.list rule, shared/model/todo-later.ts), the next moment the list reads
// differently by time alone – a to-do's time passes (its row says "since …"), a timer comes within 12 h (it leaves
// "Later"), a day word changes at midnight – for the store's For-you clock, and the "Later" choices every to-do offers
// (the Timer widget's too): in 10 minutes, in 1 hour, tomorrow at the start of the working day (read across the 04:00
// day boundary).
// Owns: these rules. Never: imports the store, rpc or the DOM – callers pass data and the time in.

import type { Task } from '../../shared/model/tasks.ts';
import { DAY_BOUNDARY_HOUR, clockMinutes } from '../../shared/model/day-settings.ts';
import { LATER_MS, isRinging, onForYouList, timerAt } from '../../shared/model/todo-later.ts';
import { time } from '../lib/format.ts';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

type Listed = Pick<Task, 'assigneeKind' | 'status' | 'widget' | 'at'> & { assigneeId?: string };

function nextMidnight(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/**
 * The next moment the list reads differently by time alone: a to-do's time passes, a timer comes within 12 h, and –
 * when any to-do has a time – the day words at midnight. Undefined: nothing changes.
 */
export function nextListChange(list: readonly Listed[], now: number): number | undefined {
  let next = Number.POSITIVE_INFINITY;
  const consider = (at: number) => { if (at > now && at < next) next = at; };
  let timed = false;
  for (const task of list) {
    if (!onForYouList(task) || task.at === undefined) continue;
    timed = true;
    consider(task.at);
    if (timerAt(task) !== undefined && !isRinging(task, now)) consider(task.at - LATER_MS);
  }
  if (timed) consider(nextMidnight(now));
  return Number.isFinite(next) ? next : undefined;
}

/**
 * The start of the person's next working day after `now`: `workStart` ('HH:MM', default 08:00)
 * tomorrow – before DAY_BOUNDARY_HOUR (04:00) the night still belongs to the day before, so
 * "tomorrow" is the coming morning of the same date. Local time.
 */
export function nextMorning(now: number, workStart = '08:00'): number {
  const minutes = clockMinutes(workStart) ?? 8 * 60;
  const date = new Date(now);
  if (date.getHours() >= DAY_BOUNDARY_HOUR) date.setDate(date.getDate() + 1);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

/** The "Later" choices (the Timer widget and every to-do's menu): in 10 minutes, in 1 hour, tomorrow at the start of work. */
export function snoozeChoices(now: number, workStart = '08:00'): Array<{ label: string; until: number }> {
  const morning = nextMorning(now, workStart);
  return [
    { label: 'In 10 minutes', until: now + 10 * MINUTE_MS },
    { label: 'In 1 hour', until: now + HOUR_MS },
    { label: `Tomorrow ${time(morning)}`, until: morning },
  ];
}
