// What the Tasks page says about a day and what comes next, pure (owner 23.11.2026: "die nächsten Termine als kurze
// Vorschau direkt auf der Seite; liegen mehrere kurz hintereinander, alle"): "Next" – the next appointment from now (a
// connected calendar's event, or a to-do of the person's at a time), with every one that follows it closely (it starts
// at most NEXT_GAP_MIN after the run before it ends), the one going on now first; a day of its own – what is on it in
// order (without a time first, then by time, an agent's notes and what it finished among them); and which days of the
// day line hold something (their dot) – and a day's heading: its name, its count only when it holds something, and
// "Read only" on a past day that does (Mika's review 23.11.2026).
// Owns: these rules. Never: the store, rpc, the DOM or a clock – callers pass calendar.list rows, the time and the zone.

import type { AgentRun, CalendarEvent } from '../../shared/model/calendar.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isDayOnly } from '../../shared/model/day-settings.ts';
import { wallOf } from '../../shared/text/when.ts';
import { dayView, spanClock, type CalItem, type Lookup } from './calendar-model.ts';
import { clockText, dayWord, headTitle, noteWhenText } from './when-text.ts';

/** Appointments closer than this (minutes from one's end to the next one's start) are one run: all of them show. */
export const NEXT_GAP_MIN = 60;
/** Never more lines in the preview. */
export const NEXT_MAX = 4;

export interface NextLine {
  id: string;
  kind: 'event' | 'todo';
  title: string;
  /** "now · until 10:30", "14:00" today, "Tomorrow 09:00", "Wed 11:00". */
  when: string;
  now: boolean;
  startAt: number;
  taskId?: string;
}

/** What comes next: the first appointment that has not ended and the ones that follow it closely (NEXT_GAP_MIN). */
export function nextUp(rows: readonly CalendarEvent[], now: number, zone: string, lookup: Lookup, hidden: ReadonlySet<string> = new Set()): NextLine[] {
  const coming: NextLine[] = [];
  const ends = new Map<string, number>();
  for (const row of rows) {
    if (row.endAt <= now || row.allDay) continue;
    let title: string;
    if (row.kind === 'event') {
      if (hidden.has(row.sourceId)) continue;
      title = row.title || 'Busy';
    } else {
      if (row.ownerId !== HUMAN_ID || row.state === 'done' || !row.taskId) continue;
      const task = lookup(row.taskId);
      if (!task || isDayOnly(task, zone)) continue;
      title = task.title;
    }
    const going = row.startAt <= now;
    coming.push({
      id: row.id, kind: row.kind === 'event' ? 'event' : 'todo', title, now: going, startAt: row.startAt,
      when: going ? `now · until ${clockText(row.endAt, zone)}` : noteWhenText(row.startAt, now, zone),
      ...(row.taskId ? { taskId: row.taskId } : {}),
    });
    ends.set(row.id, row.endAt);
  }
  coming.sort((a, b) => a.startAt - b.startAt || (ends.get(a.id) ?? 0) - (ends.get(b.id) ?? 0));
  const out: NextLine[] = [];
  let runEnd = -Infinity;
  for (const line of coming) {
    if (out.length && line.startAt > runEnd + NEXT_GAP_MIN * 60_000) break;
    out.push(line);
    runEnd = Math.max(runEnd, ends.get(line.id) ?? line.startAt);
    if (out.length === NEXT_MAX) break;
  }
  return out;
}

/** The time column of an all-day event (a to-do without a time shows none). */
export const ALL_DAY = 'All day';

export interface AgendaLine {
  id: string;
  kind: CalItem['kind'];
  /** 'HH:MM', ALL_DAY for an all-day event, or '' for a to-do without a time on that day. */
  time: string;
  title: string;
  hue: number;
  taskId?: string;
  who?: string;
  /** The quest a to-do belongs to (its name beside the quest's dot, as on a to-do's row). */
  quest?: string;
}

/**
 * One day in order: what has no time first, then by time – events, the person's to-dos (done ones ✓), the agents' notes;
 * a to-do in a quest names it.
 */
export function dayAgenda(rows: readonly CalendarEvent[], runs: readonly AgentRun[], date: string, zone: string, lookup: Lookup, hidden: ReadonlySet<string> = new Set()): AgendaLine[] {
  const view = dayView(rows, runs, date, zone, lookup, hidden);
  const questOf = (taskId: string | undefined): string | undefined => {
    const parent = taskId ? lookup(taskId)?.parentId : undefined;
    return parent ? lookup(parent)?.title || undefined : undefined;
  };
  const line = (item: CalItem, timed: boolean): AgendaLine => {
    const quest = item.kind === 'event' ? undefined : questOf(item.taskId);
    return {
      id: item.id, kind: item.kind, time: timed ? spanClock(item.span) : item.kind === 'event' ? ALL_DAY : '', title: item.title || (item.kind === 'event' ? 'Busy' : ''), hue: item.hue,
      ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.who ? { who: item.who } : {}), ...(quest ? { quest } : {}),
    };
  };
  const timed = [...view.blocks.map((entry) => entry.item), ...view.ai].sort((a, b) => a.span.start - b.span.start);
  return [...view.allDay.map((item) => line(item, false)), ...timed.map((item) => line(item, true))];
}

/** The days among `dates` that hold an event or a to-do of the person's (open or done) – their dot in the day line. */
export function busyDays(rows: readonly CalendarEvent[], dates: readonly string[], zone: string, hidden: ReadonlySet<string> = new Set()): Set<string> {
  const wanted = new Set(dates);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'event' ? hidden.has(row.sourceId) : row.ownerId !== HUMAN_ID) continue;
    const first = wallOf(row.startAt, zone).date;
    const last = wallOf(Math.max(row.startAt, row.endAt - 1), zone).date;
    for (const date of wanted) if (date >= first && date <= last) out.add(date);
  }
  return out;
}

export interface DayHead {
  /** "Tomorrow · Tuesday, November 24", "Saturday, November 21". */
  text: string;
  /** How many lines the day holds; null when none (no "0" beside an empty day). */
  count: number | null;
  /** A past day that holds something: it is only read. */
  readOnly: boolean;
}

/** A chosen day's heading over its lines. */
export function dayHead(date: string, today: string, count: number): DayHead {
  const word = dayWord(date, today);
  const title = headTitle(date);
  return {
    text: word === 'Tomorrow' || word === 'Yesterday' ? `${word} · ${title}` : title,
    count: count > 0 ? count : null,
    readOnly: date < today && count > 0,
  };
}
