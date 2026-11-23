// 0.3.19 (23.11.2026, owner: "ein Teil im Hintergrund, das nur hört, ob das Ding wieder angeschaltet werden muss – anhand
// von Cron-Job oder Handyweckung"): the wake helper's pure decisions about its own life, used by sleeper-main.ts.
// - appRunning: run-state.json says 'running' AND its process is alive – a Task Manager kill leaves 'running' behind, and
//   the helper (started then by the broker service, resources/broker/Waker.cs) must not take that for a running app.
// - otherHelper: sleeper.json names another live helper – a second one ends at once (one per data folder).
// - dueStartAt: when the helper starts the app for scheduled work (next-due.json): only work due after the helper
//   started (overdue work waits for the next start, as before), and never within 5 minutes of it – closing still closes.
// Owns: those three decisions. Never: reads files, starts anything or touches the clock itself.

import type { RunState, SleeperMark } from '../../shared/model/launch.ts';

/** A due start this soon after the helper began is moved to this point (main/launcher.ts QUIT_SETTLE_MS). */
export const DUE_SETTLE_MS = 5 * 60_000;
/** The longest single timer: re-checked then (a sleeping PC delays timers; setTimeout's own limit is ~24.8 days). */
export const DUE_TICK_MS = 15 * 60_000;

export type Alive = (pid: number) => boolean;

/** The app runs: state 'running' with a live pid (no pid at all – an older writer – counts as running). */
export function appRunning(state: Partial<RunState> | undefined, alive: Alive): boolean {
  if (state?.state !== 'running') return false;
  return typeof state.pid !== 'number' || alive(state.pid);
}

/** Another live helper holds this data folder. */
export function otherHelper(mark: Partial<SleeperMark> | undefined, self: number, alive: Alive): boolean {
  return typeof mark?.pid === 'number' && mark.pid !== self && alive(mark.pid);
}

/** When to start the app for scheduled work, or undefined (nothing due after the helper began). */
export function dueStartAt(at: number | null | undefined, startedAt: number): number | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= startedAt) return undefined;
  return Math.max(at, startedAt + DUE_SETTLE_MS);
}

/** The next timer for a due start: never longer than DUE_TICK_MS, never negative. */
export function dueDelay(startAt: number, now: number): number {
  return Math.max(0, Math.min(startAt - now, DUE_TICK_MS));
}
