// "AI this week" in a quest's detail (src/ui/tasks/quest-runs.ts weekRunTime): the run time of the agents' turns on the
// quest or one of its to-dos since Monday – a running turn counts up to now, turns before Monday or on other work do
// not –, and "at least" when an agent's latest turns that were read do not reach back to Monday.
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNS_READ, weekRunTime } from '../../../src/ui/tasks/quest-runs.ts';

const MIN = 60_000;
const MONDAY = Date.UTC(2026, 10, 15, 23); // Mon 16 Nov 2026 00:00 in Berlin
const NOW = MONDAY + 4 * 24 * 60 * MIN + 10 * 60 * MIN;
const ids = new Set(['task_quest0001', 'task_todo00001']);

test('the turns on the quest and its to-dos this week, a running one up to now; others and older ones left out', () => {
  const lukas = [
    { taskId: 'task_quest0001', startedAt: MONDAY + 60 * MIN, endedAt: MONDAY + 90 * MIN },
    { taskId: 'task_todo00001', startedAt: NOW - 20 * MIN }, // still running
    { taskId: 'task_other0001', startedAt: MONDAY + 2 * 60 * MIN, endedAt: MONDAY + 3 * 60 * MIN },
    { taskId: 'task_quest0001', startedAt: MONDAY - 60 * MIN, endedAt: MONDAY - 30 * MIN }, // last week
    { startedAt: MONDAY + 5 * 60 * MIN, endedAt: MONDAY + 6 * 60 * MIN }, // a chat turn without a task
  ];
  const felix = [{ taskId: 'task_todo00001', startedAt: MONDAY + 10 * MIN, endedAt: MONDAY + 70 * MIN }];
  assert.deepEqual(weekRunTime([lukas, felix], ids, MONDAY, NOW), { ms: (30 + 20 + 60) * MIN, runs: 3, partial: false });
  assert.deepEqual(weekRunTime([], ids, MONDAY, NOW), { ms: 0, runs: 0, partial: false });
});

test('"at least": an agent whose latest turns read do not reach back to Monday', () => {
  const busy = Array.from({ length: RUNS_READ }, (_, index) => ({ taskId: 'task_quest0001', startedAt: NOW - (index + 1) * MIN, endedAt: NOW - index * MIN }));
  const week = weekRunTime([busy], ids, MONDAY, NOW);
  assert.equal(week.partial, true);
  assert.equal(week.ms, RUNS_READ * MIN);
  assert.equal(weekRunTime([busy.slice(0, 10)], ids, MONDAY, NOW).partial, false, 'fewer than read: all of them');
});
