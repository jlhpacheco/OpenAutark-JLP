// The calendar's client data (src/ui/lib/day-store.ts, B-041 §6; the Tasks page 20.11.2026): local days and midnights
// in the day's zone (DST included), events applied to the calendar window (the caller's and the agents' rows that
// overlap it – never a colleague's), the next moment the day clock moves, loadDay gated by the session (no call it may
// not make), wireDay's one timeout and its calendar sync when the window comes to the front.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEvent, CalendarList } from '../../../src/shared/model/calendar.ts';
import type { EventMap, EventName } from '../../../src/shared/api/events.ts';
import type { LoadCall } from '../../../src/ui/lib/load.ts';
import { session } from '../../../src/ui/lib/session.ts';
import {
  calendarWindow, dayClock, dayRange, loadDay, localDate, nextDayChange, nextMidnight, wireDay, withEvent, withoutEvent,
} from '../../../src/ui/lib/day-store.ts';
import type { CalendarWindow, DayEvents } from '../../../src/ui/lib/day-store.ts';

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const D2410 = Date.UTC(2026, 9, 23, 22); // 2026-10-24 00:00 in Berlin (CEST, +2)

function event(id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, ownerId: 'human', kind: 'todo', taskId: `ta_${id}`, startAt: D2410 + 9 * H, endAt: D2410 + 10 * H, sourceId: 'local', setBy: 'person',
    state: 'planned', createdBy: 'human', rev: 1, createdAt: 1, updatedAt: 1, ...patch,
  };
}

const list = (events: CalendarEvent[]): CalendarList => ({ events, tasks: [], agentRuns: [], tz: TZ, staleSources: [] });

test('local days in the day zone: the date, the next midnight across the DST change, a range of days', () => {
  assert.equal(localDate(D2410, TZ), '2026-10-24');
  assert.equal(localDate(D2410 - 1, TZ), '2026-10-23');
  assert.equal(nextMidnight(D2410 + 5 * H, TZ), D2410 + 24 * H);
  // 25 Oct 2026: Berlin goes back from +2 to +1, so that day has 25 hours.
  assert.equal(nextMidnight(D2410 + 24 * H + H, TZ), D2410 + 49 * H);
  assert.deepEqual(dayRange('2026-10-24', TZ), { from: D2410, to: D2410 + 24 * H });
  assert.deepEqual(dayRange('2026-10-24', TZ, 2), { from: D2410, to: D2410 + 49 * H });
});

test('withEvent / withoutEvent: the caller\'s and the agents\' rows that overlap the window, sorted; others leave it', () => {
  const window: CalendarWindow = { ...dayRange('2026-10-24', TZ), list: list([event('a')]) };
  const added = withEvent(window, event('b', { startAt: D2410 + 8 * H, endAt: D2410 + 9 * H }));
  assert.deepEqual(added.list.events.map((entry) => entry.id), ['b', 'a']);
  assert.equal(withEvent(window, event('x', { startAt: D2410 + 30 * H, endAt: D2410 + 31 * H })), window, 'outside the window: nothing changes');
  assert.equal(withEvent(window, event('y', { ownerId: 'per_anna0001' })), window, 'a colleague\'s row never enters the owner\'s window');
  assert.deepEqual(withEvent(window, event('ai', { ownerId: 'ag_mara' })).list.events.map((entry) => entry.id), ['a', 'ai'], 'an agent\'s to-do: the AI lane');
  const moved = withEvent(added, event('b', { startAt: D2410 + 26 * H, endAt: D2410 + 27 * H }));
  assert.deepEqual(moved.list.events.map((entry) => entry.id), ['a'], 'moved out of the window');
  assert.deepEqual(withoutEvent(added, 'a').list.events.map((entry) => entry.id), ['b']);
  assert.equal(withoutEvent(window, 'nope'), window);
});

test('nextDayChange: the next block start or end, else local midnight', () => {
  const blocks = [event('a'), event('b', { startAt: D2410 + 11 * H, endAt: D2410 + 12 * H })];
  assert.equal(nextDayChange(blocks, D2410 + 8 * H, TZ), D2410 + 9 * H, 'the next start');
  assert.equal(nextDayChange(blocks, D2410 + 9.5 * H, TZ), D2410 + 10 * H, 'the end of the running block');
  assert.equal(nextDayChange(blocks, D2410 + 13 * H, TZ), D2410 + 24 * H, 'midnight');
});

function fakeCall(answers: Record<string, unknown>): { call: LoadCall; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const call = (async (method: string, params?: unknown) => {
    calls.push([method, params]);
    if (!(method in answers)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    return answers[method];
  }) as unknown as LoadCall;
  return { call, calls };
}

test('loadDay: nothing is asked for that the session does not allow; the owner gets the window', async () => {
  session.value = null; // a phone before session.info: allowed nothing
  calendarWindow.value = null;
  const none = fakeCall({});
  await loadDay(undefined, { call: none.call, now: D2410 + 9 * H, tz: TZ });
  assert.deepEqual(none.calls, []);
  assert.equal(calendarWindow.value, null);

  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] } as unknown as typeof session.value;
  const owner = fakeCall({ 'calendar.list': list([event('a')]) });
  await loadDay(undefined, { call: owner.call, now: D2410 + 9 * H, tz: TZ });
  assert.deepEqual(owner.calls.find(([method]) => method === 'calendar.list')?.[1], { from: D2410, to: dayRange('2026-10-24', TZ, 7).to }, 'today and the next 6 days');
  assert.deepEqual(owner.calls.map(([method]) => method), ['calendar.list'], 'only the calendar');
  assert.deepEqual(calendarWindow.peek()?.list.events.map((entry) => entry.id), ['a']);

  const failing = fakeCall({}); // no calendar service yet ('unavailable'): what is shown stays
  await loadDay(undefined, { call: failing.call, now: D2410 + 9 * H });
  assert.equal(calendarWindow.peek()?.list.events.length, 1);

  const week = dayRange('2026-10-26', TZ, 7);
  const view = fakeCall({ 'calendar.list': list([]) });
  await loadDay(week, { call: view.call, tz: 'Not/A_Zone' });
  await loadDay(undefined, { call: view.call }); // a reconnect
  assert.deepEqual(view.calls.filter(([method]) => method === 'calendar.list').map(([, params]) => params), [week, week], 'a reconnect loads the range the view showed');
  assert.deepEqual({ from: calendarWindow.peek()?.from, to: calendarWindow.peek()?.to, tz: calendarWindow.peek()?.list.tz }, { ...week, tz: TZ }, 'an unknown zone is ignored');
  session.value = null;
});

test('wireDay: events reach the window; one timeout, re-armed when the window changes', () => {
  const listeners = new Map<string, (data: unknown) => void>();
  const source: DayEvents = { on: <E extends EventName>(name: E, fn: (data: EventMap[E]) => void) => { listeners.set(name, fn as (data: unknown) => void); return () => listeners.delete(name); } };
  const armed: number[] = [];
  let cleared = 0;
  const now = D2410 + 8 * H;
  calendarWindow.value = { ...dayRange('2026-10-24', TZ), list: list([event('a')]) };
  const stop = wireDay(source, { now: () => now, flush: (apply) => apply(), timers: { set: (_fn, ms) => { armed.push(ms); return armed.length; }, clear: () => { cleared++; } } });
  try {
    assert.equal(dayClock.value, now);
    assert.deepEqual(armed, [H + 25], 'to the start of the next block');
    listeners.get('calendar.upserted')!(event('b', { startAt: D2410 + 8.5 * H, endAt: D2410 + 9 * H }));
    assert.deepEqual(calendarWindow.value?.list.events.map((entry) => entry.id), ['b', 'a']);
    assert.deepEqual(armed, [H + 25, 0.5 * H + 25], 're-armed: the new block starts sooner');
    assert.equal(cleared, 1, 'the earlier timeout is cleared – one at a time');
    listeners.get('calendar.removed')!({ id: 'b', ownerId: 'human' });
    assert.deepEqual(calendarWindow.value?.list.events.map((entry) => entry.id), ['a']);
  } finally {
    stop();
    calendarWindow.value = null;
  }
  assert.equal(listeners.size, 0, 'the disposer removes every listener');
});

test('wireDay: a burst of calendar rows (a sync, a calendar switched on) is applied once per frame, sorted once', () => {
  const listeners = new Map<string, (data: unknown) => void>();
  const source: DayEvents = { on: <E extends EventName>(name: E, fn: (data: EventMap[E]) => void) => { listeners.set(name, fn as (data: unknown) => void); return () => listeners.delete(name); } };
  const frames: Array<() => void> = [];
  calendarWindow.value = { ...dayRange('2026-10-24', TZ), list: list([event('a'), event('gone')]) };
  let sets = 0;
  const off = calendarWindow.subscribe(() => { sets++; });
  sets = 0;
  const stop = wireDay(source, { now: () => D2410 + 8 * H, flush: (apply) => frames.push(apply), timers: { set: () => 0, clear: () => {} } });
  try {
    for (let i = 0; i < 300; i++) listeners.get('calendar.upserted')!(event(`r${i}`, { startAt: D2410 + 10 * H + i * 60_000, endAt: D2410 + 10 * H + (i + 1) * 60_000 }));
    listeners.get('calendar.removed')!({ id: 'gone', ownerId: 'human' });
    listeners.get('calendar.upserted')!(event('late'));
    listeners.get('calendar.removed')!({ id: 'late', ownerId: 'human' }); // removed again in the same burst
    assert.equal(sets, 0, 'nothing applied before the frame');
    assert.equal(frames.length, 1, 'one frame for the whole burst');
    frames.shift()!();
    assert.equal(sets, 1, 'one window update');
    const ids = calendarWindow.value!.list.events.map((entry) => entry.id);
    assert.equal(ids.length, 301);
    assert.ok(!ids.includes('gone') && !ids.includes('late'));
    assert.ok(calendarWindow.value!.list.events.every((entry, index, all) => index === 0 || all[index - 1].startAt <= entry.startAt), 'by time');
  } finally {
    off();
    stop();
    calendarWindow.value = null;
  }
});

test('wireDay: coming to the front syncs the calendars, then loads the day again – once per 30 s', async () => {
  const fronts: Array<() => void> = [];
  const source: DayEvents = { on: () => () => {} };
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] } as unknown as typeof session.value;
  const owner = fakeCall({ 'calendar.sync': [], 'calendar.list': list([]) });
  let now = D2410 + 9 * H;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stop = wireDay(source, { call: owner.call, connected: () => true, now: () => now, timers: { set: () => 0, clear: () => {} }, front: { on: (fn) => { fronts.push(fn); return () => fronts.splice(0); } } });
  try {
    assert.equal(fronts.length, 1);
    fronts[0]();
    fronts[0](); // focus and visibilitychange together
    await settle(); await settle();
    assert.deepEqual(owner.calls.map(([method]) => method), ['calendar.sync', 'calendar.list'], 'sync first, then one reload');
    now += 10_000;
    fronts[0]();
    await settle();
    assert.equal(owner.calls.length, 2, 'within 30 s nothing is asked again');
    now += 30_000;
    fronts[0]();
    await settle(); await settle();
    assert.equal(owner.calls.filter(([method]) => method === 'calendar.sync').length, 2);
  } finally {
    stop();
    session.value = null;
    calendarWindow.value = null;
  }
  assert.equal(fronts.length, 0, 'the disposer stops listening');
});
