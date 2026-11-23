// The calendar's pure rules (B-041 track A1, Quests round 20.11.2026): which rows an agent must never be placed over
// (timed events and the to-dos the person placed), the busy spans of a member (every timed row), the free gaps of a day,
// and (B-078) the gaps several members share, each inside their own working hours.
// Owns: these rules. Never: I/O, the clock (callers pass `now`), or a model call.

import type { CalendarEvent, CalendarSetBy } from '../../shared/model/calendar.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';

export interface Span { startAt: number; endAt: number }

const MIN = 60_000;

export function overlaps(a: Span, b: Span): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

/** A row nothing may be placed over by an agent: a timed event, or a to-do the person placed (not `taskId`'s own). */
export function isFixed(row: Pick<CalendarEvent, 'kind' | 'allDay' | 'setBy' | 'taskId'>, taskId?: string): boolean {
  if (row.allDay) return false;
  if (row.kind === 'event') return true;
  return row.setBy === 'person' && (taskId === undefined || row.taskId !== taskId);
}

/** The fixed rows `span` would cover. */
export function conflicts<T extends Pick<CalendarEvent, 'kind' | 'allDay' | 'setBy' | 'taskId' | 'startAt' | 'endAt'>>(rows: readonly T[], span: Span, taskId?: string): T[] {
  return rows.filter((row) => isFixed(row, taskId) && overlaps(row, span));
}

/** The busy spans of rows: every timed row – events of the shown calendars and the to-dos with a time. All-day rows are no busy time. Sorted by start. */
export function busySpans(rows: readonly Pick<CalendarEvent, 'allDay' | 'startAt' | 'endAt'>[]): Span[] {
  return rows
    .filter((row) => !row.allDay)
    .map((row) => ({ startAt: row.startAt, endAt: row.endAt }))
    .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
}

/** Free gaps of at least `minutes` inside [from, to) around `busy` (each kept `bufferMin` apart from it), by start. */
export function freeGaps(busy: readonly Span[], from: number, to: number, minutes: number, bufferMin = 0): Span[] {
  const buffer = Math.max(0, bufferMin) * MIN;
  const spans = busy.map((span) => ({ startAt: span.startAt - buffer, endAt: span.endAt + buffer })).sort((a, b) => a.startAt - b.startAt);
  const out: Span[] = [];
  let cursor = from;
  for (const span of spans) {
    if (span.endAt <= cursor) continue;
    if (span.startAt >= to) break;
    if (span.startAt - cursor >= minutes * MIN) out.push({ startAt: cursor, endAt: span.startAt });
    cursor = Math.max(cursor, span.endAt);
  }
  if (to - cursor >= minutes * MIN) out.push({ startAt: cursor, endAt: to });
  return out;
}

/** One member's side of a common slot: their busy spans and the window they are there (UTC epoch ms; B-078 D20). */
export interface MemberWindow { busy: readonly Span[]; from: number; to: number; bufferMin?: number }

/**
 * Gaps of at least `minutes` that every member has free (each within their own window, with their own buffer) –
 * the intersection of freeGaps per member, by start. No members: none.
 */
export function commonGaps(members: readonly MemberWindow[], minutes: number): Span[] {
  if (!members.length) return [];
  let common: Span[] | undefined;
  for (const member of members) {
    const gaps = freeGaps(member.busy, member.from, member.to, minutes, member.bufferMin ?? 0);
    if (!common) { common = gaps; continue; }
    const next: Span[] = [];
    for (const a of common) {
      for (const b of gaps) {
        const startAt = Math.max(a.startAt, b.startAt);
        const endAt = Math.min(a.endAt, b.endAt);
        if (endAt - startAt >= minutes * MIN) next.push({ startAt, endAt });
      }
    }
    common = next.sort((a, b) => a.startAt - b.startAt);
    if (!common.length) return [];
  }
  return common ?? [];
}

/** Who placed a row made by `by`: a person ('person', pinned) or an agent. */
export function setByOf(by: string): CalendarSetBy {
  return isHumanActor(by) ? 'person' : 'agent';
}

/** Whose calendar `by` writes: a person's own, else the owner's (agents act on the owner's day in this build). */
export function ownerOf(by: string): string {
  return isPersonId(by) ? by : HUMAN_ID;
}
