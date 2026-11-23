// "AI this week" in a quest's detail (review R2.14, the mockup's "AI this week 1 h 50 min"): how long the agents' turns
// ran on the quest or one of its to-dos since Monday 00:00 in the person's zone. A turn carries the task it ran on
// (Run.taskId), so the sum is read from each involved agent's latest turns (agents.runs, at most RUNS_READ each) and
// kept a minute per quest. When an agent's latest turns do not reach back to Monday the sum says so ("at least").
// Owns: that sum, its read and its small cache. Never: a second runs store, a guess, or a poll.

import { useEffect, useState } from 'preact/hooks';
import type { Run } from '../../shared/model/runs.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';

/** How many of an agent's latest turns are read (the RPC's own upper bound). */
export const RUNS_READ = 200;
const KEEP_MS = 60_000;

export interface WeekTime { ms: number; runs: number; partial: boolean }

/** The run time of the turns in `lists` (one list per agent, newest first) on `ids` since `since`; `partial` when a full list starts after it. */
export function weekRunTime(lists: ReadonlyArray<ReadonlyArray<Pick<Run, 'taskId' | 'startedAt' | 'endedAt'>>>, ids: ReadonlySet<string>, since: number, now: number): WeekTime {
  let ms = 0;
  let runs = 0;
  let partial = false;
  for (const list of lists) {
    const oldest = Math.min(...list.map((run) => run.startedAt ?? Infinity));
    if (list.length >= RUNS_READ && oldest > since) partial = true;
    for (const run of list) {
      if (!run.taskId || !ids.has(run.taskId) || run.startedAt === undefined || run.startedAt < since) continue;
      ms += Math.max(0, (run.endedAt ?? now) - run.startedAt);
      runs++;
    }
  }
  return { ms, runs, partial };
}

const kept = new Map<string, { at: number; value: WeekTime }>();

/** The quest's AI time this week (`since`: Monday 00:00 in the person's zone); undefined while it is read or where runs cannot be read. */
export function useWeekTime(quest: Task, todos: readonly Task[], since: number): WeekTime | undefined {
  const agents = [...new Set([quest, ...todos].filter((task) => task.assigneeKind === 'agent' && task.assigneeId).map((task) => task.assigneeId!))].sort();
  const ids = [quest.id, ...todos.map((task) => task.id)];
  const key = `${quest.id}|${since}|${agents.join(',')}|${ids.length}`;
  const [value, setValue] = useState<WeekTime | undefined>(() => kept.get(key)?.value);
  useEffect(() => {
    const fresh = kept.get(key);
    if (fresh && Date.now() - fresh.at < KEEP_MS) { setValue(fresh.value); return; }
    if (!agents.length || !can('agents.runs')) { setValue(undefined); return; }
    let shown = true;
    void Promise.all(agents.map((id) => rpc.call('agents.runs', { id, limit: RUNS_READ }).catch(() => [] as Run[]))).then((lists) => {
      const sum = weekRunTime(lists, new Set(ids), since, Date.now());
      kept.set(key, { at: Date.now(), value: sum });
      if (shown) setValue(sum);
    });
    return () => { shown = false; };
  }, [key]);
  return value;
}
