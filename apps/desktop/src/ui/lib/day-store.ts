// The calendar's data in the client (B-041 §6; Quests round 20.11.2026: the Tasks page's calendar): the window the
// page shows (calendar.list for a range – connected calendars' events, the person's to-dos with a time and the ones
// done in it, the agents' to-dos on the AI lane, the agents' notes as runs, the zone the runtime does day math in) and
// the day clock. Loaded after every (re)connect by store.loadAll (today and the six days after it; the page loads its
// week itself) and kept fresh by events (wireDay from store-events.wireEvents): calendar.upserted/removed, collected
// and applied once per frame (a sync sends a burst). When the window comes to the front (focus, or the page turns
// visible) the connected calendars are synced (calendar.sync; the runtime skips a source synced in the last 30 s)
// and the window is loaded again. Every call is gated with can(): a connection that may not call a method gets an
// empty value, never a refused call. The day clock is one timeout to the next block start or end or the next local
// midnight in the day's zone, re-armed when the window changes – never an interval.
// Owns: these signals, their loader (and listEvents, a range read beside the window), the event apply, the clock and
// the sync on coming to the front.
// Never: renders, decides what the page shows (ui/tasks/calendar-model.ts), writes (the page's calls do), imports
// the store (store.ts imports this) or polls.

import { computed, effect, signal } from '@preact/signals';
import type { CalendarEvent, CalendarList } from '../../shared/model/calendar.ts';
import type { EventMap, EventName } from '../../shared/api/events.ts';
import { addDays, wallOf, wallTime } from '../../shared/text/when.ts';
import type { LoadCall } from './load.ts';
import { rpc } from './rpc.ts';
import { can } from './session.ts';
import { NEXT_FRAME, calendarBuffer, type CalendarWindow, type DayRange } from './day-window.ts';

export type { CalendarWindow, DayRange };
/** The window's pure updates (lib/day-window.ts). */
export { withChanges, withEvent, withoutEvent } from './day-window.ts';

/** The calendar range shown now and what calendar.list returned for it (null: not loaded or not allowed here). */
export const calendarWindow = signal<CalendarWindow | null>(null);
/** The time the page reads blocks at: moved at the next block start or end and at local midnight. */
export const dayClock = signal(Date.now());

/** The device's zone, until calendar.list (or the profile, via loadDay's options) names the runtime's. */
const deviceZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

/** `tz` when Intl knows it (a profile may hold anything), else undefined. */
function knownZone(tz: unknown): string | undefined {
  if (typeof tz !== 'string' || !tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}
const zone = signal(deviceZone());
/** The zone of all day math (settings.profile.timezone as the runtime reports it). */
export const dayZone = computed(() => calendarWindow.value?.list.tz || zone.value);

const DAY_DAYS = 7;
/** setTimeout's longest reliable delay is ~24.8 days; the clock re-arms after a day at most. */
const MAX_CLOCK_DELAY = 86_400_000;

// ------------------------------------------------------------------ pure helpers (tested directly)

/** The local date (YYYY-MM-DD) of `at` in `tz`. */
export function localDate(at: number, tz: string): string {
  return wallOf(at, tz).date;
}

/** The first instant of the local day after the one `now` is in (DST-correct). */
export function nextMidnight(now: number, tz: string): number {
  return wallTime(addDays(localDate(now, tz), 1), 0, tz);
}

/** Local midnight of `date` up to local midnight `days` days later. */
export function dayRange(date: string, tz: string, days = 1): DayRange {
  return { from: wallTime(date, 0, tz), to: wallTime(addDays(date, days), 0, tz) };
}

/** The next moment a block starts or ends after `now`, or the next local midnight, whichever is first. */
export function nextDayChange(events: readonly CalendarEvent[], now: number, tz: string): number {
  let next = nextMidnight(now, tz);
  for (const event of events) {
    if (event.startAt > now && event.startAt < next) next = event.startAt;
    else if (event.endAt > now && event.endAt < next) next = event.endAt;
  }
  return next;
}

/** A calendar.list answer the page can read (an older runtime or a fake may answer anything). */
function readList(value: unknown, tz: string): CalendarList | null {
  const list = value as Partial<CalendarList> | null;
  if (!list || typeof list !== 'object' || !Array.isArray(list.events)) return null;
  return {
    events: list.events, tasks: Array.isArray(list.tasks) ? list.tasks : [], agentRuns: Array.isArray(list.agentRuns) ? list.agentRuns : [],
    tz: knownZone(list.tz) ?? tz, staleSources: Array.isArray(list.staleSources) ? list.staleSources : [],
  };
}

// ------------------------------------------------------------------ loading

export interface LoadDayOptions {
  /** The runtime's day zone when known before calendar.list answers (store.loadAll: settings.profile.timezone). */
  tz?: string;
  call?: LoadCall;
  now?: number;
}

let calendarRequest = 0;
/** The range the page asked for last: a reconnect (loadDay without a range) loads it again. */
let lastRange: DayRange | undefined;

/**
 * Loads the calendar for `range` (default: the range the page asked for last, else today and the six days after it in
 * the day's zone); only the newest request is applied. Never rejects; what may not be read is empty.
 */
export async function loadDay(range?: DayRange, options: LoadDayOptions = {}): Promise<void> {
  const call = options.call ?? rpc.call;
  const known = knownZone(options.tz);
  if (known) zone.value = known;
  const now = options.now ?? Date.now();
  const tz = dayZone.peek();
  if (range) lastRange = range;
  const shown = range ?? lastRange ?? dayRange(localDate(now, tz), tz, DAY_DAYS);
  const request = ++calendarRequest;
  if (!can('calendar.list')) { calendarWindow.value = null; return; }
  try {
    const list = readList(await call('calendar.list', { from: shown.from, to: shown.to }), zone.peek());
    if (request === calendarRequest) calendarWindow.value = list ? { ...shown, list } : null;
  } catch { /* keep what is shown (no calendar service yet, or the connection went away) */ }
}

/**
 * calendar.list for a range beside the window – the small month's dots on the Tasks page: its events, or none. Never
 * touches the window the page shows; never rejects.
 */
export async function listEvents(range: DayRange, call: LoadCall = rpc.call): Promise<CalendarEvent[]> {
  if (!can('calendar.list')) return [];
  try { return readList(await call('calendar.list', { from: range.from, to: range.to }), zone.peek())?.events ?? []; } catch { return []; }
}

// ------------------------------------------------------------------ events and the clock

/** What wireDay listens on (rpc in the app, a fake in unit tests). */
export interface DayEvents { on<E extends EventName>(event: E, fn: (data: EventMap[E]) => void): () => void }

/** The one timeout of the day clock (the window's timers in the app, a fake in unit tests). */
export interface DayTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

const WINDOW_TIMERS: DayTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Moves dayClock now and arms its one timeout for the next block start or end or local midnight; re-armed when the window changes. */
function wireDayClock(timers: DayTimers, now: () => number): () => void {
  let timer: unknown;
  const tick = () => {
    if (timer !== undefined) timers.clear(timer);
    const at = now();
    dayClock.value = at;
    const next = nextDayChange(calendarWindow.peek()?.list.events ?? [], at, dayZone.peek());
    timer = timers.set(tick, Math.max(0, Math.min(next - at + 25, MAX_CLOCK_DELAY)));
  };
  const stop = effect(() => {
    void calendarWindow.value; // re-armed at every change of the window
    tick();
  });
  return () => { stop(); if (timer !== undefined) timers.clear(timer); };
}

/** Where wireDay hears that the window came to the front (window focus, page visible); a fake in unit tests. */
export interface DayFront { on(fn: () => void): () => void }

const WINDOW_FRONT: DayFront = {
  on: (fn) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
    const shown = () => { if (document.visibilityState === 'visible') fn(); };
    window.addEventListener('focus', fn);
    document.addEventListener('visibilitychange', shown);
    return () => { window.removeEventListener('focus', fn); document.removeEventListener('visibilitychange', shown); };
  },
};

/** Focus and visibilitychange fire together, and the runtime ignores a calendar.sync within 30 s: one run per 30 s. */
const FRONT_GAP_MS = 30_000;

/**
 * On coming to the front: calendar.sync (where allowed), then the window again (the range the page showed last). Not
 * while the connection is down (19.11.2026, D2): the calls would only wait and fail, and the reconnect loads it anyway.
 */
function wireFront(front: DayFront, call: () => LoadCall, now: () => number, connected: () => boolean): () => void {
  let last = -Infinity;
  let running = false;
  return front.on(() => {
    const at = now();
    if (running || at - last < FRONT_GAP_MS || !connected()) return;
    last = at;
    running = true;
    const current = call();
    const synced = can('calendar.sync') ? current('calendar.sync', {}).then(() => undefined, () => undefined) : Promise.resolve();
    void synced.then(() => loadDay(undefined, { call: current })).finally(() => { running = false; });
  });
}

export interface WireDayOptions {
  /** rpc.call at the time of each load (store tests point rpc.call at a fake). */
  call?: LoadCall;
  timers?: DayTimers;
  now?: () => number;
  /** The window's focus and visibility in the app. */
  front?: DayFront;
  /** The connection is open (rpc.status in the app). */
  connected?: () => boolean;
  /** Runs the buffered calendar changes once (default: the next animation frame, or a short timeout while hidden). */
  flush?: (apply: () => void) => void;
}

/** Called once from store-events.wireEvents: applies the calendar's events and starts the clock. Returns the disposer. */
export function wireDay(source: DayEvents = rpc, options: WireDayOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const calendar = calendarBuffer(() => calendarWindow.peek(), (window) => { calendarWindow.value = window; }, options.flush ?? NEXT_FRAME);
  const offs = [
    source.on('calendar.upserted', (event) => calendar.upsert(event)),
    source.on('calendar.removed', ({ id }) => calendar.remove(id)),
    () => calendar.dispose(),
    wireDayClock(options.timers ?? WINDOW_TIMERS, now),
    wireFront(options.front ?? WINDOW_FRONT, () => options.call ?? rpc.call, now, options.connected ?? (() => rpc.status.peek() === 'open')),
  ];
  return () => { for (const off of offs) off(); };
}
