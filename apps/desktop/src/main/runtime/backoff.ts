// Restart backoff for supervised processes: 1 s, 2 s, 4 s … capped at 30 s; reset after the
// process stayed up long enough. Owns: the delay sequence only. Never: timers or processes.

const INITIAL_MS = 1000;
const MAX_MS = 30_000;
/** Uptime after which the next crash starts again at INITIAL_MS. */
const STABLE_MS = 60_000;

export class Backoff {
  private attempt = 0;

  /** Delay before the next restart, given how long the process was up. */
  next(uptimeMs: number): number {
    if (uptimeMs >= STABLE_MS) this.attempt = 0;
    const delay = Math.min(MAX_MS, INITIAL_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return delay;
  }

  reset(): void { this.attempt = 0; }
}
