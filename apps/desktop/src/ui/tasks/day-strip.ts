// The Tasks page's day line and month view, pure (owner 23.11.2026: "‹ 14 15 16 17 ›" under the title, a tap shows that
// day, a button opens a small month with its own ‹ ›): which days the line shows – as many as fit, paged by its arrows,
// otherwise placed around the chosen day (a whole week Monday first when seven fit, else from the day before) – the month's
// grid (six weeks, Monday first), the span of days the calendar window must hold for the line, the chosen day's week and
// the preview, and what the page remembers of itself across a switch to the chats and back (the view, and the chosen day
// only on the day it was chosen).
// Owns: these rules. Never: the DOM, rpc, signals or a clock – callers pass dates (YYYY-MM-DD) and widths.

import { weekOf } from './calendar-model.ts';
import { headTitle, shiftDate, weekdayOf } from './when-text.ts';

/** One day of the line: its slot is at least this wide (px) – the circle and the gap; larger letters widen it. */
export const DAY_SLOT_PX = 36;
/** Never fewer, never more days in the line. */
export const MIN_DAYS = 3;
export const MAX_DAYS = 7;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * How many days fit into `widthPx` (MIN_DAYS … MAX_DAYS; nothing measured yet: five). `slotPx` is one day's measured
 * width – larger text (the labels size, the system's font scale) widens a day, so fewer fit; never under DAY_SLOT_PX.
 */
export function dayCount(widthPx: number, slotPx = DAY_SLOT_PX): number {
  if (!(widthPx > 0)) return 5;
  const slot = Math.max(DAY_SLOT_PX, Number.isFinite(slotPx) ? slotPx : DAY_SLOT_PX);
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(widthPx / slot)));
}

/** The line's first day when the person did not page it: the chosen day's week (seven days), else the day before it. */
export function autoStart(chosen: string, count: number): string {
  return count >= 7 ? weekOf(chosen)[0] : shiftDate(chosen, -1);
}

/** A day said in words (its button's name; the dot under it too): "Tuesday, November 24 (today), has entries". */
export function dayLabel(date: string, today: string, busy = false): string {
  return `${headTitle(date)}${date === today ? ' (today)' : ''}${busy ? ', has entries' : ''}`;
}

/** The days the line shows: from `paged` (where its arrows left it) or around the chosen day. */
export function lineDays(chosen: string, count: number, paged: string | null): string[] {
  const start = paged ?? autoStart(chosen, count);
  return Array.from({ length: count }, (_, index) => shiftDate(start, index));
}

/** Where an arrow leaves the line: a whole line further (`direction` -1 or 1). */
export function pageLine(days: readonly string[], direction: -1 | 1): string {
  return shiftDate(days[0], direction * days.length);
}

/** 'YYYY-MM' of a date. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** The month `months` from `month` ('YYYY-MM'; negative goes back). */
export function shiftMonth(month: string, months: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** "November 2026". */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "Nov" – the month button's word. */
export const monthShort = (month: string): string => MONTHS[Number(month.slice(5, 7)) - 1].slice(0, 3);

export interface MonthDay { date: string; inMonth: boolean }

/** The month as six weeks of seven days, Monday first (the days before and after it from the months around it). */
export function monthGrid(month: string): MonthDay[][] {
  const first = `${month}-01`;
  const start = shiftDate(first, -((weekdayOf(first) + 6) % 7));
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const date = shiftDate(start, week * 7 + day);
    return { date, inMonth: monthOf(date) === month };
  }));
}

/**
 * The days the calendar window must hold: the chosen day's week (the calendar reads it), the line's days (their dots),
 * and on today the next two days (the preview of what comes next). `first` and `days` for day-store's dayRange.
 */
export function windowSpan(chosen: string, today: string, line: readonly string[]): { first: string; days: number } {
  const dates = [...weekOf(chosen), ...line, ...(chosen === today ? [today, shiftDate(today, 1), shiftDate(today, 2)] : [])].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  let days = 1;
  while (shiftDate(first, days) <= last) days++;
  return { first, days };
}

/** What the page keeps of itself (in memory and in the app's storage). */
export interface KeptView { view: 'list' | 'calendar'; date: string | null; on: string }

/**
 * The kept view read back on `today`: the view always; the chosen day only when it was chosen today (tomorrow the page
 * opens on its own day again). Anything unreadable: null.
 */
export function restoreView(raw: unknown, today: string): { view: 'list' | 'calendar'; date: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const kept = raw as Partial<KeptView>;
  const view = kept.view === 'calendar' ? 'calendar' : kept.view === 'list' ? 'list' : null;
  if (!view) return null;
  const date = typeof kept.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(kept.date) && kept.on === today ? kept.date : null;
  return { view, date };
}
