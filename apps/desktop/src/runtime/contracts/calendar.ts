// B-041 / Quests round 20.11.2026: the calendar and its connected sources as optional
// members of RuntimeServices (merged by module augmentation, like the other late additions in this folder).
// Implemented by runtime/calendar/service.ts, runtime/calendar/sources/index.ts; wired in
// compose/calendar.ts. Missing = not wired (fakes): the RPC handlers answer 'unavailable', other callers skip.
// Owns: these interfaces and the member declarations. Never: behaviour.

import type { CalendarAddInput, CalendarEvent, CalendarList, CalendarSource } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';

export interface CalendarService {
  /** `agentId`: only that agent's runs (no rows), capped for it alone. */
  list(ownerId: string, from: number, to: number, agentId?: string): CalendarList;
  /** A click into a free slot: an appointment, or the person's to-do at that time (the line's one intake, tasks/quick.ts). */
  add(input: CalendarAddInput, by: string): Promise<{ event: CalendarEvent; task?: TaskView }>;
  /** A move made on `rev` ('conflict' when the row changed since); an event becomes setBy 'person', a to-do row moves its `at`. */
  move(id: string, startAt: number, endAt: number, rev: number, by: string): CalendarEvent;
  /** Removes an event; a to-do row only loses its time (the to-do stays). */
  remove(id: string, by: string): void;
  /** Busy spans of a member in [from, to): timed events and the open to-dos with a time. */
  busy(ownerId: string, from: number, to: number): Array<{ startAt: number; endAt: number }>;
  /** Sources mirror hook: every local change of a row – a to-do's time too – or its removal. Returns the unsubscribe. */
  onLocalChange(listener: (event: CalendarEvent | { removed: string }) => void): () => void;
}

export interface CalendarSources {
  list(ownerId: string): CalendarSource[];
  /** The owner's calendars and every room's (owner room:…), for Settings › Calendar. */
  listWithRooms(ownerId: string): CalendarSource[];
  /** `room` (B-078, D20): a room:… id (calendar/members.ts roomId) – the calendar then belongs to that room, not to `by`. */
  addIcs(input: { url: string; label?: string; room?: string }, by: string): Promise<CalendarSource>;
  update(id: string, patch: { label?: string; visible?: boolean; color?: string }, by: string): CalendarSource;
  remove(id: string, by: string): Promise<void>;
  /** One source now, or every source; `reason` for the log ('start', 'resume', 'button' …). */
  sync(id?: string, reason?: string): Promise<CalendarSource[]>;
  /** `waiting`: a consent is open in the browser; `error`: the last connect failure (a user-safe sentence). */
  google(): { configured: boolean; connected: boolean; sourceId?: string; waiting?: boolean; error?: string };
  connectGoogle(clientId?: string): Promise<{ authUrl: string }>;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** B-041: the members' local calendar (events; to-dos with a time read from their tasks); missing = not wired (fakes). */
    calendar?: CalendarService;
    /** B-041: connected calendars (ICS, Google); missing = not wired. */
    calendarSources?: CalendarSources;
  }
}
