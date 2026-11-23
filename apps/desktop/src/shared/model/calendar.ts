// The calendar of the Tasks page (B-041, Quests round 20.11.2026): the local calendar keeps appointments (kind 'event',
// a row with its own title); connected calendars (ICS, Google) are mirrors. A to-do with a time (Task.at/minutes) shows
// as a row of kind 'todo' that is never stored – the calendar reads it from the task (id = taskId = the task's id, no
// title: the view reads the task, so task text is never copied). Rows are keyed by member (`ownerId` 'human' = the
// owner, a person's per_… id, or an agent's id for its own to-dos on the AI lane).
// Owns: these shapes and their small limits. Never: behaviour (runtime/calendar/*), task text copies, or secrets (an ICS
// address or a refresh token lives in the vault; a source keeps only its handle).

import type { Task } from './tasks.ts';

/** 'todo' = a to-do with a time, read from its task (never stored). */
export type CalendarEventKind = 'event' | 'todo';
export const CALENDAR_EVENT_KINDS: readonly CalendarEventKind[] = ['event', 'todo'];
/** Who placed it: 'person' = pinned (an agent never moves it), an agent, a source sync. */
export type CalendarSetBy = 'person' | 'agent' | 'sync';
export const CALENDAR_SET_BY: readonly CalendarSetBy[] = ['person', 'agent', 'sync'];
/** 'done' = a finished to-do, kept at the time it was done (the logbook). */
export type CalendarEventState = 'planned' | 'done';
export const CALENDAR_EVENT_STATES: readonly CalendarEventState[] = ['planned', 'done'];

export interface CalendarEvent {
  id: string;
  ownerId: string; // 'human' (owner), per_… or (a to-do row) the agent that owns the to-do
  kind: CalendarEventKind;
  taskId?: string;
  title?: string; // events only; to-do rows have NO title (read from the task)
  notes?: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  tz?: string;
  sourceId: string; // 'local' or a calendar_sources id
  externalId?: string;
  etag?: string;
  setBy: CalendarSetBy; // 'person' = pinned: an agent never moves it
  state: CalendarEventState;
  readOnly?: boolean; // from an ICS/Google read-only source
  createdBy: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

/** The id of the local calendar (CalendarEvent.sourceId of everything made in the app). */
export const LOCAL_SOURCE_ID = 'local';

/** A to-do's length on the calendar when it names no minutes. */
export const DEFAULT_MINUTES = 30;

export type CalendarSourceKind = 'ics' | 'google';
export const CALENDAR_SOURCE_KINDS: readonly CalendarSourceKind[] = ['ics', 'google'];
export type CalendarSourceStatus = 'ok' | 'error' | 'reconnect' | 'syncing';

export interface CalendarSource {
  id: string;
  ownerId: string;
  kind: CalendarSourceKind;
  label: string;
  color?: string;
  visible: boolean;
  writable: boolean;
  status: CalendarSourceStatus;
  error?: string;
  lastSyncAt?: number;
  pcDeviceId?: string; // google: the one PC that writes
}

/** A planned run of an agent's schedule inside the listed window (computed, never stored). */
export interface AgentRun {
  scheduleId: string;
  agentId: string;
  title: string;
  at: number;
}

/**
 * calendar.list: the window's rows (events, and a 'todo' row per to-do with a time – the person's, the agents' on the AI
 * lane, and finished ones at the time they were done), the tasks those rows show, the agents' runs, the zone all day math
 * uses, sources not synced for > 24 h.
 */
export interface CalendarList {
  events: CalendarEvent[];
  tasks: Task[];
  agentRuns: AgentRun[];
  tz: string;
  staleSources: string[];
}

/** calendar.add: a click into a free slot with typed or dictated text ('auto': the text decides event or to-do; default to-do). */
export type CalendarAddKind = 'auto' | 'todo' | 'event';
export const CALENDAR_ADD_KINDS: readonly CalendarAddKind[] = ['auto', 'todo', 'event'];
export interface CalendarAddInput {
  text: string;
  startAt: number;
  endAt?: number;
  kind?: CalendarAddKind;
  clientId?: string;
}

/** B-059: one sleep of the PC (suspend → resume, epoch ms; runtime/day/keep-awake.ts). */
export interface SleepSpan { from: number; to: number }

// ---------------------------------------------------------------- B-078 (D20): a person's calendar on their page

/** One entry of a person's calendar as their page shows it (titles masked where they are private there). */
export interface PersonCalendarEntry { title: string; startAt: number; endAt: number; allDay?: true; kind: 'event' | 'to-do' }

/** calendar.person: what the owner sees of a person's next days – from their PC (calendar.ask) or this one. */
export interface PersonCalendar {
  /** false: no calendar of theirs is reachable now; `note` says why (offline, none connected). */
  reachable: boolean;
  note?: string;
  /** The person's zone (their PC's). */
  tz?: string;
  entries: PersonCalendarEntry[];
}

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: a person's (per_…) calendar for [from, to) (at most 14 days) – asked on their own PC when it is linked here. */
    'calendar.person': { params: { id: string; from: number; to: number }; result: PersonCalendar };
  }
}

/** A local calendar day 'YYYY-MM-DD' that exists (2026-02-30 does not). */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
