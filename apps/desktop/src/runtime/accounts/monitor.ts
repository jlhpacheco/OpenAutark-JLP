// Account and quota monitor: provider pushes reach AccountService.updateLimits immediately;
// one cancellable timer also reads Codex every 15 s and Claude Code every 60 s while an agent turn
// is queued or running and for WORK_TAIL_MS after the last one ended; with no turn it reads every
// QUIET_MS (usage in other apps still shows; owner 09.11.2026: the app stays light while it does not
// work – a Claude read starts two CLI processes of ~120 MB, measured). A turn that starts, and the
// window brought to the front (usage.list), read what is older than the working cadence at once. Startup always checks
// again. All checks share one serial queue; failures back off to 5 min. Signed-out/disabled accounts
// have no timer. 0.3.19 (task_0c6aet8h): while working, a plan in reserve – neither the one its engine takes next nor
// running a turn – is read every RESERVE_MS: its limits move only through use elsewhere, and a Claude reading is a cold
// CLI start (on teydra-server three plans read each minute were most of the app's program starts). Its reading counts as
// stale only past RESERVE_MS + STALE_MS. The quota details the person opens (refreshAll) read every plan as before. A plan
// that comes to the front (the next one ran out or cools) is read at once: every account.upserted re-arms the timer,
// and the new front plan is due by the working cadence (monitor-timer.test.ts, Noah's review 24.11.2026).
// B-044: these background reads ask Codex for its banked resets' count only (excludeResetCreditDetails);
// the credit details come with the reads the person asks for – checkNow (a sign-in, a used reset) and
// refreshAll (the quota details or Settings › Models opened), which also reads a Codex plan
// whose count is known but whose details never came, even when it is not due.
// Owns: refresh timing, the serial queue, staleness and usage summaries.
// Never: reads tokens, starts model turns, overlaps checks, or erases a failed reading.

import type { Clock, Logger } from '../contracts.ts';
import type { Bus } from '../bus.ts';
import type { Account, AccountLimits, EngineId, UsageSummary } from '../../shared/model/providers.ts';
import { isPlanProvider } from '../../shared/model/plan-roles.ts';
import { engineFor, selectCandidates } from './candidates.ts';
import { weeklyWindow } from './limits.ts';
import { planNames } from '../../shared/model/plan-names.ts';
import { PROVIDER_LABELS } from './service-shape.ts';

const MINUTE = 60_000;
export const REFRESH_MS = { codex: 15_000, claude: MINUTE } as const;
/** The cadence while no agent turn is queued or running. */
export const QUIET_MS = 10 * MINUTE;
/** After the last turn ended the working cadence holds this long (a person's next message often follows). */
export const WORK_TAIL_MS = 2 * MINUTE;
/** Failed reads become visibly stale instead of looking current for half an hour (while quiet: past QUIET_MS plus this). */
export const STALE_MS = 2 * MINUTE;
/** While working, the cadence of a plan in reserve (not next in line for its engine, no turn running on it). */
export const RESERVE_MS = 5 * MINUTE;

const ENDED = new Set(['done', 'failed', 'interrupted']);

/** A queued check; `background`: a failure ('error') changes nothing; `details`: Codex reads its reset credits' details too. */
interface Check { id: string; background: boolean; details: boolean; done: Array<() => void> }

export interface MonitoredAccounts {
  list(): Account[];
  get(id: string): Account | undefined;
  /** The engine's official status check; `background`: a check that fails ('error') changes nothing; `details`: see Check. */
  check(id: string, background: boolean, details: boolean): Promise<Account>;
}

export interface AccountMonitorDeps {
  accounts: MonitoredAccounts;
  bus: Bus;
  clock: Clock;
  log?: Logger;
  /** Test scheduler; production uses one unref'd timeout. Returns its cancellation function. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

/** Older than `staleMs` (two minutes while working), or a window's reset has passed. */
export function isStale(limits: AccountLimits, now: number, staleMs = STALE_MS): boolean {
  return now - limits.readAt > staleMs || limits.windows.some((window) => window.resetsAt !== undefined && window.resetsAt <= now);
}

/**
 * Quota rail entries: every enabled plan with its short name (B-078, shared/model/plan-names.ts), weekly headroom, all
 * windows and the stale flag. Feedback 16.11.2026 (F24): a switched-off plan runs no turn here, so its last reading
 * (headroom it cannot give) is not shown – the rail said "plenty left" while every turn here waited.
 * `reserveStaleMs`: the stale age of a plan that is not its engine's next (read at the reserve cadence while working).
 */
export function usageSummaries(accounts: Account[], now: number, staleMs = STALE_MS, reserveStaleMs = staleMs): UsageSummary[] {
  const active = new Set<string>();
  for (const engine of ['codex', 'claude'] as EngineId[]) {
    const first = selectCandidates(accounts, engine, now)[0];
    if (first) active.add(first.id);
  }
  const plans = accounts.filter((account) => account.enabled && isPlanProvider(account.provider));
  const names = planNames(plans, PROVIDER_LABELS);
  return plans.map((account) => {
    const weekly = weeklyWindow(account.limits, now);
    const name = names.get(account.id);
    return {
      accountId: account.id, provider: account.provider, label: account.label, ...(name ? { name } : {}), active: active.has(account.id),
      weeklyRemainingPercent: weekly ? Math.max(0, 100 - weekly.usedPercent) : undefined, weeklyResetsAt: weekly?.resetsAt,
      // in reserve: read, but at the reserve cadence – a signed-out plan is not read at all, its readings age as before
      limits: account.limits && { ...account.limits, stale: isStale(account.limits, now, active.has(account.id) || account.state === 'needs_login' ? staleMs : Math.max(staleMs, reserveStaleMs)) },
    };
  });
}

const staleKey = (list: UsageSummary[]) => list.filter((entry) => entry.limits?.stale).map((entry) => entry.accountId).join(',');

export class AccountMonitor {
  private readonly deps: AccountMonitorDeps;
  private readonly queue: Check[] = [];
  private current: Check | undefined;
  /** Last check attempt per account (a failed background check stores nothing on the account). */
  private readonly attempted = new Map<string, number>();
  private busy = false;
  private draining: Promise<void> = Promise.resolve();
  private readonly failures = new Map<string, number>();
  private published = '';
  private off: (() => void) | undefined;
  private stopped = false;
  private cancelTimer: (() => void) | undefined;
  /** Agent turns queued or running now, and when the last one ended. */
  private readonly turns = new Set<string>();
  /** The account of each queued or running turn that names one (such a plan is read at the working cadence). */
  private readonly turnAccounts = new Map<string, string>();
  private lastTurnAt = 0;
  /** When the working cadence began (its first STALE_MS still judge readings by the quiet cadence: their reads are on the way). */
  private workingSince = 0;

  constructor(deps: AccountMonitorDeps) {
    this.deps = deps;
  }

  private now(): number { return this.deps.clock.now(); }

  /** Refreshes persisted readings immediately; follows runs and account membership changes. */
  start(): void {
    if (this.off) return;
    this.stopped = false;
    const runOff = this.deps.bus.on('run.upserted', (run) => {
      if (run.status === 'queued' || run.status === 'running') {
        if (!this.working()) this.workingSince = this.now();
        this.turns.add(run.id);
        if (run.accountId) this.turnAccounts.set(run.id, run.accountId);
      }
      else if (this.turns.delete(run.id) || ENDED.has(run.status)) this.lastTurnAt = this.now();
      if (run.status !== 'queued' && run.status !== 'running') this.turnAccounts.delete(run.id);
      if (run.accountId && ENDED.has(run.status)) this.afterTurn(run.accountId);
      this.activity();
    });
    const accountOff = this.deps.bus.on('account.upserted', () => this.arm());
    const removedOff = this.deps.bus.on('account.removed', ({ id }) => {
      this.attempted.delete(id); this.failures.delete(id); this.arm();
    });
    this.off = () => { runOff(); accountOff(); removedOff(); };
    for (const account of this.plans()) if (account.state !== 'needs_login') this.enqueue(account.id, true);
    this.arm();
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    this.stopped = true;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    for (const check of this.queue.splice(0)) for (const done of check.done) done();
  }

  /** One background check soon (adoption, a sign-in changed outside Workforce, a CLI that is back). */
  checkOnce(id: string): void {
    this.enqueue(id, true);
  }

  /** A check whose failure shows (after sign-in, a new connection, a used reset) – with the details; queued like the others, resolves when done. */
  checkNow(id: string): Promise<void> {
    return new Promise((resolve) => this.enqueue(id, false, resolve, true));
  }

  /** Activity and timer use the same cadence; pushes never postpone the independent read. `back`: the person is back (working cadence once). */
  activity(back = false): void {
    const now = this.now();
    const working = back || this.working();
    for (const account of this.plans()) {
      if (account.state === 'needs_login') continue; // sign-in, detection or the quota details check it
      if (now >= this.dueAt(account, working)) this.enqueue(account.id, true);
    }
    if (!this.busy && staleKey(this.summaries()) !== this.published) this.publish();
    this.arm();
  }

  /** Power resume or unlock (the person is back) or the host is online again (B-044). */
  resume(): void {
    this.activity(true);
  }

  /** A turn ended on this account. */
  afterTurn(accountId: string): void {
    const account = this.deps.accounts.get(accountId);
    if (!account || !this.watched(account)) return;
    if (this.now() >= this.dueAt(account, true)) this.enqueue(account.id, true);
  }

  /** Quota details share the provider cadence and serial queue with automatic reads (with the reset details; a Codex plan without them is read at once). */
  async refreshAll(): Promise<void> {
    const now = this.now();
    for (const account of this.plans()) {
      const resets = account.limits?.resets;
      const missing = account.provider === 'codex' && resets !== undefined && resets.available > 0 && resets.credits === undefined;
      if (now >= this.dueAt(account, true, false) || (missing && account.state !== 'needs_login')) this.enqueue(account.id, true, undefined, true);
    }
    await this.idle();
  }

  /** Resolves when no check is queued or running. */
  async idle(): Promise<void> {
    while (this.busy) await this.draining;
  }

  summaries(): UsageSummary[] {
    const now = this.now();
    const working = this.working() && now - this.workingSince > STALE_MS;
    return usageSummaries(this.deps.accounts.list(), now, working ? STALE_MS : QUIET_MS + STALE_MS, working ? RESERVE_MS + STALE_MS : QUIET_MS + STALE_MS);
  }

  /** Emits usage.updated with the current summaries (also used by the account service). */
  publish(): void {
    const list = this.summaries();
    this.published = staleKey(list);
    this.deps.bus.emit('usage.updated', list);
  }

  private watched(account: Account): boolean {
    return account.enabled && isPlanProvider(account.provider);
  }

  private plans(): Account[] {
    return this.deps.accounts.list().filter((account) => this.watched(account));
  }

  private lastCheck(account: Account): number {
    return Math.max(account.checkedAt ?? 0, this.attempted.get(account.id) ?? 0);
  }

  /** A turn is queued or running, or the last one ended less than WORK_TAIL_MS ago. */
  private working(): boolean {
    return this.turns.size > 0 || this.now() - this.lastTurnAt < WORK_TAIL_MS;
  }

  /** `reserve`: a plan in reserve keeps the reserve cadence while working (not for the quota details the person opens). */
  private dueAt(account: Account, working = this.working(), reserve = true): number {
    if (!working) return this.lastCheck(account) + QUIET_MS;
    const gap = reserve && !this.inFront(account) ? RESERVE_MS : REFRESH_MS[account.provider === 'codex' ? 'codex' : 'claude'];
    return this.lastCheck(account) + Math.min(5 * MINUTE, gap * 2 ** (this.failures.get(account.id) ?? 0));
  }

  /** The plan its engine takes next, or one a queued or running turn uses. */
  private inFront(account: Account): boolean {
    for (const id of this.turnAccounts.values()) if (id === account.id) return true;
    const engine = engineFor(account.provider);
    return engine !== undefined && selectCandidates(this.deps.accounts.list(), engine, this.now())[0]?.id === account.id;
  }

  private arm(): void {
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (!this.off || this.stopped || this.busy) return;
    const working = this.working();
    const due = this.plans().filter((account) => account.state !== 'needs_login').map((account) => this.dueAt(account, working));
    if (!due.length) return;
    // The working tail ends: the timer wakes then to switch to the quiet cadence.
    if (working && !this.turns.size) due.push(Math.max(this.lastTurnAt + WORK_TAIL_MS, this.now() + 1));
    const delay = Math.max(1, Math.min(...due) - this.now());
    const run = () => { this.cancelTimer = undefined; this.activity(); };
    if (this.deps.schedule) this.cancelTimer = this.deps.schedule(run, delay);
    else {
      const timer = setTimeout(run, delay); timer.unref?.();
      this.cancelTimer = () => clearTimeout(timer);
    }
  }

  /** Joins a queued check of the same account (or the running one, when that covers this request). */
  private enqueue(id: string, background: boolean, done?: () => void, details = false): void {
    if (this.stopped) { done?.(); return; }
    const running = this.current?.id === id && (background || !this.current.background) && (!details || this.current.details) ? this.current : undefined;
    const same = this.queue.find((check) => check.id === id) ?? running;
    if (same) { same.background &&= background; same.details ||= details; if (done) same.done.push(done); return; }
    this.queue.push({ id, background, details, done: done ? [done] : [] });
    if (this.busy) return;
    this.busy = true;
    this.draining = this.drain();
  }

  /** One check at a time (CLI status commands and app-servers never pile up). */
  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const check = (this.current = this.queue.shift()!);
        const account = this.deps.accounts.get(check.id);
        if (!account || !account.enabled) { this.current = undefined; for (const done of check.done) done(); continue; }
        this.attempted.set(check.id, this.now());
        let fresh = false;
        const startedAt = this.now();
        try {
          const result = await this.deps.accounts.check(check.id, check.background, check.details);
          fresh = result.state === 'needs_login' || (result.state !== 'error' && result.limits !== undefined && result.limits.readAt >= startedAt);
        }
        catch (error) { this.deps.log?.debug('account check failed', { accountId: check.id, error: String(error) }); }
        this.failures.set(check.id, fresh ? 0 : Math.min(5, (this.failures.get(check.id) ?? 0) + 1));
        this.attempted.set(check.id, this.now()); // interval starts after completion, including slow cold starts
        this.current = undefined;
        try { if (!this.stopped) this.publish(); } // after stop() (shutdown) nothing more is emitted
        catch (error) { this.deps.log?.debug('usage summaries failed', { error: String(error) }); }
        for (const done of check.done) done();
      }
    } finally {
      this.busy = false;
      this.current = undefined;
      this.arm();
    }
  }
}
