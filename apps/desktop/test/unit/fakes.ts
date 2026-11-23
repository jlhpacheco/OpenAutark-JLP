// Test stand-ins the runtime takes as services (Quests round 20.11.2026: moved here from src/runtime/system/clock.ts and
// log.ts – no app code uses them): a clock that moves only when told to, a logger that keeps its entries, one that
// drops them.
// Owns: these fakes. Never: imported by src/.

import type { Clock, Logger } from '../../src/runtime/contracts.ts';

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  private value: number;

  constructor(start = Date.UTC(2026, 9, 17, 9, 0, 0)) {
    this.value = start;
  }

  now(): number {
    return this.value;
  }

  set(ms: number): void {
    this.value = ms;
  }

  advance(ms: number): number {
    this.value += ms;
    return this.value;
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Logger that discards everything (tests that do not inspect logs). */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Logger that records entries in memory (tests that inspect logs). */
export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: Level; message: string; data?: Record<string, unknown> }> = [];
  debug(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'debug', message, data }); }
  info(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'info', message, data }); }
  warn(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'warn', message, data }); }
  error(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'error', message, data }); }
}
