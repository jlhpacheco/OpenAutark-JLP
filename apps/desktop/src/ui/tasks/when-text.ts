// The Tasks page's words about time, pure: a to-do's "when" on its row, in its detail and in a quest ("since Wed",
// "Today 15:00–18:00", "Tomorrow 18:00", "Mon 11 Jan 09:00"; a day without a time just "Tomorrow"), a finished one's
// "done 09:05", a coming note's time ("17:00" today, else with its day), the page's date title ("Friday, November 20"), lengths ("30 min"), date steps and dictated words after
// typed text. A day without a time (the input line's "morgen") is shared/model/day-settings.ts isDayOnly: the one
// "when" (Task.at) has no all-day flag. All wall times are read in the person's zone (shared/text/when.ts wallOf).
// Owns: these texts. Never: the store, rpc, the DOM or a clock – callers pass the time and zone.

import { isDayOnly } from '../../shared/model/day-settings.ts';
import { wallOf } from '../../shared/text/when.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The date `days` calendar days from `date` (YYYY-MM-DD; negative goes back). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The weekday of a date (0 = Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  const ms = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** "Sat 25 Oct". */
export function dateText(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(date)]} ${d} ${MONTHS[m - 1]}`;
}

/** The page's title: "Friday, November 20". */
export function headTitle(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${LONG_DAYS[weekdayOf(date)]}, ${LONG_MONTHS[m - 1]} ${d}`;
}

/** A day relative to today: "Today", "Tomorrow", "Yesterday", "Wed" within the next six days, else "Mon 11 Jan". */
export function dayWord(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 1 && days < 7 ? WEEKDAYS[weekdayOf(date)] : dateText(date);
}

/** 'HH:MM' of an instant in `zone`. */
export function clockText(at: number, zone?: string): string {
  const minutes = wallOf(at, zone).minutes;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export interface WhenText { text: string; late: boolean }

/**
 * A to-do's "when": overdue ones say since when ("since 09:00" today, "since yesterday", "since Wed", "since 11 Jan"),
 * others the day and the time with its end from 30 minutes on ("Today 15:00–18:00"); undefined without a time – and
 * for an agent's to-do: agent work starts now, a time on it is never shown (CONTRACT "agent work has no time").
 */
export function whenOf(task: { at?: number; minutes?: number; status?: string; assigneeKind?: string }, now: number, zone?: string): WhenText | undefined {
  if (task.at === undefined || task.assigneeKind === 'agent') return undefined;
  const today = wallOf(now, zone).date;
  const date = wallOf(task.at, zone).date;
  const dayOnly = isDayOnly(task, zone);
  const finished = task.status === 'done' || task.status === 'dropped';
  const late = !finished && (dayOnly ? date < today : task.at < now);
  if (late) {
    const days = daysBetween(date, today);
    const since = days === 0 ? clockText(task.at, zone) : days === 1 ? 'yesterday' : days < 7 ? WEEKDAYS[weekdayOf(date)] : dateText(date).slice(4);
    return { text: `since ${since}`, late: true };
  }
  let text = dayWord(date, today);
  if (!dayOnly) {
    text += ` ${clockText(task.at, zone)}`;
    if ((task.minutes ?? 0) >= 30) text += `–${clockText(task.at + task.minutes! * 60_000, zone)}`;
  }
  return { text, late: false };
}

/** A found time phrase as its chip says it ("Tomorrow 10:00", "Fri"), else as written. */
export function phraseText(phrase: { at: number; text: string }, now: number, zone?: string): string {
  return whenOf({ at: phrase.at }, now, zone)?.text ?? phrase.text;
}

/** A finished one's time: "done 09:05" today, "done Mon 21:23" this week, else "done 11 Jan". */
export function doneText(completedAt: number, now: number, zone?: string): string {
  return `done ${momentText(completedAt, now, zone)}`;
}

/** A moment that passed: "09:05" today, "Mon 21:23" this week, else "11 Jan". */
export function momentText(at: number, now: number, zone?: string): string {
  const date = wallOf(at, zone).date;
  const days = daysBetween(date, wallOf(now, zone).date);
  if (days === 0) return clockText(at, zone);
  return days > 0 && days < 7 ? `${WEEKDAYS[weekdayOf(date)]} ${clockText(at, zone)}` : dateText(date).slice(4);
}

/** A coming note's time: "17:00" today, else with its day ("Tomorrow 08:00", "Tue 11:00", "Fri 27 Nov 17:00"). */
export function noteWhenText(at: number, now: number, zone?: string): string {
  if (wallOf(at, zone).date === wallOf(now, zone).date) return clockText(at, zone);
  return whenOf({ at, minutes: 1 }, now, zone)?.text ?? clockText(at, zone);
}

/** "30 min", "1 h", "1 h 30 min". */
export function minutesText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Dictated words after the typed text: one space between; either may be empty. */
export function joinSaid(text: string, said: string): string {
  const head = text.trimEnd();
  const tail = said.trim();
  return head && tail ? `${head} ${tail}` : head || tail;
}
