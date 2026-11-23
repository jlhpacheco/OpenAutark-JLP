// Composition of the Tasks page's calendar (B-041, Quests round 20.11.2026): the calendar (events, to-dos with a time),
// the connected sources on RuntimeServices, plus the keep-awake hold (the person's line is tasks/quick.ts, no service). Every part
// gets the late-bound services record `s` and picks what it needs; start() subscribes listeners and arms timers,
// stopCalendar(s) undoes it in reverse order at shutdown. B-078 (D20): the peer method 'calendar.ask'
// (calendar/linked.ts) opens on the mesh's extension point to every link kind – linked PCs ask this PC for its person's
// free/busy, entries or a booking; what each link gets is decided there.
// Owns: this wiring. Never: behaviour, or a timer of its own.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { CalendarServiceImpl } from '../calendar/service.ts';
import { CalendarSourcesImpl } from '../calendar/sources/index.ts';
import { KeepAwake } from '../day/keep-awake.ts';
import { EVERY_LINK } from '../devices/mesh.ts';
import { registerCalendarAsk } from '../calendar/linked.ts';

interface Startable { start(): void; stop(): void }

const running = new WeakMap<RuntimeServices, Startable[]>();

export function createCalendar(s: RuntimeServices): void {
  const calendar = new CalendarServiceImpl(s);
  const sources = new CalendarSourcesImpl(s);
  s.calendar = calendar;
  s.calendarSources = sources;
  registerCalendarAsk(s, EVERY_LINK);
  const parts: Startable[] = [calendar, sources, new KeepAwake(s)];
  running.set(s, parts);
  for (const part of parts) {
    try { part.start(); } catch (error) { s.log.warn('calendar part did not start', { error: String(error) }); }
  }
}

/** Shutdown: listeners and timers go (reverse order); each part stops on its own. */
export function stopCalendar(s: RuntimeServices): void {
  for (const part of (running.get(s) ?? []).reverse()) {
    try { part.stop(); } catch (error) { s.log.warn('calendar part did not stop', { error: String(error) }); }
  }
  running.delete(s);
}
