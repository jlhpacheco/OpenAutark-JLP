// The calendar across members (B-078 D20, the agent tools' `who`, tools/builtin/calendar.ts): busy times of several
// members and the free time they share on a day (each inside their own working hours, in their own zone – rules.ts
// commonGaps over UTC spans). A meeting is a to-do with a time for each person (Quests round 20.11.2026): nothing here
// writes into a calendar. And the owner's read of a person's calendar for their page (calendar.person).
// Owns: these reads. Never: shows titles of others (busy only).

import { WorkforceError } from '../../shared/errors.ts';
import type { PersonCalendar, PersonCalendarEntry } from '../../shared/model/calendar.ts';
import { wallTime } from '../../shared/text/when.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { spanText } from './agent-view.ts';
import { availability, memberWindow, type Member, type MemberServices } from './members.ts';
import { commonGaps, type MemberWindow, type Span } from './rules.ts';

const HOUR = 60 * 60_000;
/** How far another zone's working day can reach beyond this PC's day. */
const ZONE_REACH = 14 * HOUR;

export interface BusyLine { start: string; end: string; when: string }
export type MemberBusy = { who: string; name: string; tz?: string; busy?: BusyLine[]; unreachable?: string };

const lines = (spans: readonly Span[], tz: string): BusyLine[] =>
  spans.map((span) => ({ start: new Date(span.startAt).toISOString(), end: new Date(span.endAt).toISOString(), when: spanText(span.startAt, span.endAt, tz) }));
const why = (error: unknown) => (error instanceof WorkforceError ? error.message : 'not reachable right now');

/** Busy times of each member in [from, to) – shown in `tz` (this PC's zone); an unreachable member says why. */
export async function membersBusy(s: MemberServices, members: readonly Member[], from: number, to: number, tz: string, signal?: AbortSignal): Promise<MemberBusy[]> {
  return Promise.all(members.map(async (member): Promise<MemberBusy> => {
    try {
      const available = await availability(s, member, from, to, 'busy', signal);
      return { who: member.who, name: member.name, ...(available.tz !== tz ? { tz: available.tz } : {}), busy: lines(available.busy, tz) };
    } catch (error) { return { who: member.who, name: member.name, unreachable: why(error) }; }
  }));
}

/** Free time of at least `minutes` all reachable members share on `date` (from `now` on); the unreachable ones listed. */
export async function freeTogether(s: MemberServices, members: readonly Member[], date: string, minutes: number, now: number, tz: string, signal?: AbortSignal):
  Promise<{ free: Span[]; unreachable: Array<{ who: string; name: string; why: string }> }> {
  const from = wallTime(date, 0, tz) - ZONE_REACH;
  const to = wallTime(date, 24 * 60, tz) + ZONE_REACH;
  const windows: MemberWindow[] = [];
  const unreachable: Array<{ who: string; name: string; why: string }> = [];
  await Promise.all(members.map(async (member) => {
    try {
      const available = await availability(s, member, from, to, 'busy', signal);
      const window = memberWindow(available, date, tz);
      windows.push({ busy: available.busy, from: Math.max(now, window.from), to: window.to, bufferMin: available.bufferMin });
    } catch (error) { unreachable.push({ who: member.who, name: member.name, why: why(error) }); }
  }));
  return { free: windows.length ? commonGaps(windows, minutes) : [], unreachable };
}

/**
 * calendar.person (the owner opens a person's page – "the CEO sees the employees' calendars"): the entries of
 * [from, to) from the person's own PC or this PC's rows of theirs (a to-do by its title, "Only me" too);
 * busy spans as "Busy" where only those come back; unreachable: why.
 */
export async function personCalendar(s: MemberServices & Partial<Pick<RuntimeServices, 'tasks'>>, member: Member, from: number, to: number, signal?: AbortSignal): Promise<PersonCalendar> {
  if (member.where === 'none') return { reachable: false, note: `No calendar of ${member.name} is reachable from this PC – their own PC is not linked here.`, entries: [] };
  try {
    const available = await availability(s, member, from, to, 'list', signal);
    const busy = (): PersonCalendarEntry[] => available.busy.map((span) => ({ title: 'Busy', startAt: span.startAt, endAt: span.endAt, kind: 'event' }));
    let entries: PersonCalendarEntry[];
    if (available.entries) entries = available.entries;
    else if (available.rows) {
      entries = available.rows.map((row) => {
        let title = row.title ?? '';
        if (row.kind === 'todo') {
          let task;
          try { task = row.taskId ? s.tasks?.get(row.taskId) : undefined; } catch { task = undefined; }
          title = task ? task.title : 'Busy';
        }
        return { title: title || 'Busy', startAt: row.startAt, endAt: row.endAt, kind: row.kind === 'todo' ? 'to-do' : 'event', ...(row.allDay ? { allDay: true as const } : {}) };
      });
    } else entries = busy();
    return { reachable: true, tz: available.tz, entries: entries.sort((a, b) => a.startAt - b.startAt).slice(0, 200) };
  } catch (error) { return { reachable: false, note: why(error), entries: [] }; }
}
