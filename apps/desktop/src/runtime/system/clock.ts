// Time source for the runtime. Everything that needs "now" receives a Clock, so tests can
// control time without fake timers.
// Owns: the system clock (a manual one for tests: test/unit/fakes.ts). Never: timers or scheduling (see schedules/).

import type { Clock } from '../contracts.ts';

/** Wall-clock time in epoch milliseconds. */
export const systemClock: Clock = { now: () => Date.now() };
