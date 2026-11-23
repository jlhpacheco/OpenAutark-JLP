// What the Tasks page says about a day and what comes next (src/ui/tasks/day-preview.ts): "Next" – the first
// appointment that has not ended (the one going on now says so), every one that follows it within NEXT_GAP_MIN, never
// more than NEXT_MAX, a switched-off calendar, an all-day event, an agent's to-do, a done or day-only to-do left out; a
// day's lines in order (without a time first); which days of the line hold something.
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun, CalendarEvent } from '../../../src/shared/model/calendar.ts';
import { busyDays, dayAgenda, nextUp, NEXT_MAX } from '../../../src/ui/tasks/day-preview.ts';

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const M = 60_000;
const MIDNIGHT = Date.UTC(2026, 10, 22, 23); // Mon 23 Nov 2026 00:00 in Berlin
const DATE = '2026-11-23';

function row(id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, ownerId: 'human', kind: 'event', title: id, startAt: MIDNIGHT + 10 * H, endAt: MIDNIGHT + 11 * H, sourceId: 'google1', setBy: 'person',
    state: 'planned', createdBy: 'human', rev: 1, createdAt: 1, updatedAt: 1, ...patch,
  };
}
const tasks: Record<string, { title: string; at?: number; minutes?: number; parentId?: string }> = {
  task_call: { title: 'Call Gerlinde', at: MIDNIGHT + 15 * H, minutes: 30 },
  task_day: { title: 'Belege sammeln', at: MIDNIGHT },
  task_agent: { title: 'Signed installer', at: MIDNIGHT + 12 * H, minutes: 30 },
};
const lookup = (id: string) => tasks[id];
const todo = (id: string, patch: Partial<CalendarEvent> = {}) => row(id, { kind: 'todo', title: undefined, taskId: id, sourceId: 'local', ...patch });

test('next: the first appointment and the ones close behind it, not the one after a long gap', () => {
  const rows = [
    row('late', { startAt: MIDNIGHT + 18 * H, endAt: MIDNIGHT + 19 * H }),
    row('b', { startAt: MIDNIGHT + 11 * H + 30 * M, endAt: MIDNIGHT + 12 * H }), // 30 min after a's end
    row('a'),
    row('c', { startAt: MIDNIGHT + 13 * H, endAt: MIDNIGHT + 13 * H + 30 * M }), // 60 min after b's end: still the run
  ];
  const lines = nextUp(rows, MIDNIGHT + 8 * H, TZ, lookup);
  assert.deepEqual(lines.map((line) => line.id), ['a', 'b', 'c']);
  assert.deepEqual(lines.map((line) => line.when), ['10:00', '11:30', '13:00']);
});

test('next: the one going on now says so; a past one is gone', () => {
  const rows = [row('gone', { startAt: MIDNIGHT + 7 * H, endAt: MIDNIGHT + 8 * H }), row('a'), row('b', { startAt: MIDNIGHT + 11 * H, endAt: MIDNIGHT + 11 * H + 30 * M })];
  const lines = nextUp(rows, MIDNIGHT + 10 * H + 15 * M, TZ, lookup);
  assert.deepEqual(lines.map((line) => [line.id, line.now, line.when]), [['a', true, 'now · until 11:00'], ['b', false, '11:00']]);
});

test('next: the person\'s timed to-do counts; an agent\'s, a done, a day-only one, all-day and hidden events do not', () => {
  const rows = [
    row('allday', { allDay: true, startAt: MIDNIGHT, endAt: MIDNIGHT + 24 * H }),
    row('hidden', { sourceId: 'ics2', startAt: MIDNIGHT + 9 * H, endAt: MIDNIGHT + 10 * H }),
    todo('task_agent', { ownerId: 'ag_felix', startAt: MIDNIGHT + 12 * H, endAt: MIDNIGHT + 12 * H + 30 * M }),
    todo('task_day', { startAt: MIDNIGHT, endAt: MIDNIGHT + 30 * M }),
    todo('task_done', { state: 'done', startAt: MIDNIGHT + 14 * H, endAt: MIDNIGHT + 14 * H + 30 * M }),
    todo('task_call', { startAt: MIDNIGHT + 15 * H, endAt: MIDNIGHT + 15 * H + 30 * M }),
  ];
  const lines = nextUp(rows, MIDNIGHT + 8 * H, TZ, lookup, new Set(['ics2']));
  assert.deepEqual(lines.map((line) => [line.kind, line.title, line.taskId]), [['todo', 'Call Gerlinde', 'task_call']]);
});

test('next: tomorrow names its day; a long run stops at NEXT_MAX', () => {
  const tomorrow = MIDNIGHT + 24 * H;
  const rows = Array.from({ length: 6 }, (_, index) => row(`m${index}`, { startAt: tomorrow + (9 + index) * H, endAt: tomorrow + (10 + index) * H }));
  const lines = nextUp(rows, MIDNIGHT + 20 * H, TZ, lookup);
  assert.equal(lines.length, NEXT_MAX);
  assert.equal(lines[0].when, 'Tomorrow 09:00');
  assert.deepEqual(nextUp([], MIDNIGHT, TZ, lookup), []);
});

test('a day in order: without a time first, then by time, an agent\'s note among them', () => {
  const rows = [
    todo('task_call', { startAt: MIDNIGHT + 15 * H, endAt: MIDNIGHT + 15 * H + 30 * M }),
    row('a'),
    todo('task_day', { startAt: MIDNIGHT, endAt: MIDNIGHT + 30 * M }),
  ];
  const runs: AgentRun[] = [{ scheduleId: 'sch_1', agentId: 'ag_felix', title: 'Check the release', at: MIDNIGHT + 12 * H }];
  const lines = dayAgenda(rows, runs, DATE, TZ, lookup);
  assert.deepEqual(lines.map((line) => [line.kind, line.time, line.title]), [
    ['todo', '', 'Belege sammeln'], ['event', '10:00', 'a'], ['ai', '12:00', 'Check the release'], ['todo', '15:00', 'Call Gerlinde'],
  ]);
  assert.equal(lines[3].taskId, 'task_call');
  assert.equal(lines[2].who, 'ag_felix');
  assert.deepEqual(dayAgenda(rows, runs, '2026-11-24', TZ, lookup), []);
});

test('busy days: an event or the person\'s to-do marks its days, a hidden calendar or an agent\'s to-do does not', () => {
  const days = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'];
  const rows = [
    row('trip', { startAt: MIDNIGHT + 24 * H, endAt: MIDNIGHT + 48 * H, allDay: true }), // Tue only (ends at Wed 00:00)
    row('hidden', { sourceId: 'ics2', startAt: MIDNIGHT + 72 * H + 9 * H, endAt: MIDNIGHT + 72 * H + 10 * H }),
    todo('task_agent', { ownerId: 'ag_felix', startAt: MIDNIGHT + 72 * H + 12 * H, endAt: MIDNIGHT + 72 * H + 13 * H }),
    todo('task_call', { startAt: MIDNIGHT + 15 * H, endAt: MIDNIGHT + 15 * H + 30 * M }),
  ];
  assert.deepEqual([...busyDays(rows, days, TZ, new Set(['ics2']))].sort(), ['2026-11-23', '2026-11-24']);
});
