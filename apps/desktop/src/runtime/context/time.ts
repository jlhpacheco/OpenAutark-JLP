// Time formatting for the live part of the prompt and rendered chat lines, in the person's time zone.
// Owns: validated time zones, the one profile-zone read (`profileZone`: the prompt's Now line and every
// "saved"/"indexed" day of retrieved knowledge, knowledge/age.ts), cached Intl formatters and the few
// fixed formats agents see ("14:05", "18 Oct", "Mon 16 Nov 07:00", "Sat 18 Oct 2026, 14:05", a day-only to-do's "Mon 16 Nov,
// no time"). English month/day names.
// Never: used for the stable prompt section (times there would break prompt caching).

import { isDayOnly } from '../../shared/model/day-settings.ts';
import { wallOf } from '../../shared/text/when.ts';
import type { RuntimeServices } from '../contracts.ts';

const cache = new Map<string, Intl.DateTimeFormat>();
const known = new Map<string, boolean>(); // zone → Intl knows it (profileZone runs per retrieved hit)

/** The zone if Intl knows it, otherwise undefined (= the process' local zone). */
export function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  let valid = known.get(zone);
  if (valid === undefined) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); valid = true; } catch { valid = false; }
    if (known.size > 16) known.clear();
    known.set(zone, valid);
  }
  return valid ? zone : undefined;
}

/** The zone used for display: the profile zone when valid, else the process zone. */
export function displayZone(zone: string | undefined): string {
  return validZone(zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** The person's display zone (settings.profile.timezone, else the process zone); also without wired settings. */
export function profileZone(services: Pick<RuntimeServices, 'settings'>): string {
  try { return displayZone(services.settings.get().profile.timezone); } catch { return displayZone(undefined); }
}

function parts(ms: number, zone: string | undefined): Record<string, string> {
  const key = zone ?? '';
  let format = cache.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: validZone(zone), weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    if (cache.size > 16) cache.clear();
    cache.set(key, format);
  }
  const out: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) out[part.type] = part.value;
  return out;
}

/** "14:05" */
export function clockText(ms: number, zone: string | undefined): string {
  const p = parts(ms, zone);
  return `${p.hour}:${p.minute}`;
}

/** "2026-10-18": the calendar day in the zone (the app's one zone math, shared/text/when.ts), to compare days. */
export function dayKey(ms: number, zone: string | undefined): string {
  return wallOf(ms, zone).date;
}

/** "18 Oct" (with the year when it differs from `now`). */
export function dateText(ms: number, zone: string | undefined, now?: number): string {
  const p = parts(ms, zone);
  const sameYear = now === undefined || parts(now, zone).year === p.year;
  return sameYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

/** "Sat 18 Oct 2026, 14:05" */
export function fullDateTime(ms: number, zone: string | undefined): string {
  const p = parts(ms, zone);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** Message stamp: "14:05" today, "17 Oct 14:05" on other days. */
export function stampText(ms: number, zone: string | undefined, now: number): string {
  const time = clockText(ms, zone);
  return dayKey(ms, zone) === dayKey(now, zone) ? time : `${dateText(ms, zone, now)} ${time}`;
}

/** A day in the live part: "Thu 12 Nov" (the year only when it is not `now`'s) – absolute, never "today". */
export function dayName(ms: number, zone: string | undefined, now: number): string {
  const p = parts(ms, zone);
  return `${p.weekday} ${p.day} ${p.month}${parts(now, zone).year === p.year ? '' : ` ${p.year}`}`;
}

/** A time in the live part: "Mon 16 Nov 07:00" (the year only when it is not `now`'s) – absolute, never "today" or "overdue". */
export function dueText(ms: number, zone: string | undefined, now: number): string {
  return `${dayName(ms, zone, now)} ${clockText(ms, zone)}`;
}

/** A to-do's "when" in the live part: its time ("Mon 16 Nov 07:00"), or only its day for a day without a time
 *  ("Mon 16 Nov, no time" – shared/model/day-settings.ts isDayOnly), so midnight never reads as a time. */
export function todoWhen(task: { at: number; minutes?: number }, zone: string | undefined, now: number): string {
  return isDayOnly(task, zone) ? `${dayName(task.at, zone, now)}, no time` : dueText(task.at, zone, now);
}
