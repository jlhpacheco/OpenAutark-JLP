// Quota refresh regression: fake provider + manual single timer, no model calls or network.
// Owns: startup freshness, updates without app activity, the working and the quiet cadence, backoff and cancellation.
// Never: accesses provider credentials or starts real CLIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountMonitor, QUIET_MS, REFRESH_MS, WORK_TAIL_MS } from '../../../src/runtime/accounts/monitor.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../fakes.ts';
import type { Account, AccountLimits, UsageSummary } from '../../../src/shared/model/providers.ts';

const T0 = Date.UTC(2026, 9, 24, 17);
const limits = (at: number, remaining = 72): AccountLimits => ({ readAt: at, windows: [
  { name: 'weekly', windowMinutes: 10080, usedPercent: 100 - remaining, resetsAt: T0 + 86_400_000 },
] });
const plan = (id: string, provider: 'codex' | 'claude', patch: Partial<Account> = {}): Account => ({
  id, provider, label: provider, auth: 'cli', state: 'ok', priority: 0,
  enabled: true, detected: false, createdAt: T0, checkedAt: T0, limits: limits(T0), ...patch,
});

function harness(initial: Account[]) {
  const clock = new ManualClock(T0);
  const bus = new Bus((error) => { throw error; });
  const accounts = new Map(initial.map((account) => [account.id, account]));
  const reads: string[] = [];
  const updates: UsageSummary[][] = [];
  const remaining = new Map(initial.map((account) => [account.id, 72]));
  let timer: { run: () => void; at: number } | undefined;
  let hold: Promise<void> | undefined;
  let failure = false;
  let active = 0, maxActive = 0;
  bus.on('usage.updated', (list) => updates.push(list));
  const monitor = new AccountMonitor({ clock, bus,
    schedule: (run, delay) => {
      assert.equal(timer, undefined, 'only one timer');
      const scheduled = { run, at: clock.now() + delay }; timer = scheduled;
      return () => { if (timer === scheduled) timer = undefined; };
    },
    accounts: { list: () => [...accounts.values()], get: (id) => accounts.get(id),
      check: async (id) => {
        reads.push(id); maxActive = Math.max(maxActive, ++active);
        try {
          if (hold) await hold;
          if (failure) throw new Error('offline');
          const next = { ...accounts.get(id)!, checkedAt: clock.now(), limits: limits(clock.now(), remaining.get(id)) };
          accounts.set(id, next); bus.emit('account.upserted', next); return next;
        } finally { active--; }
      },
    },
  });
  const advance = async (ms: number) => {
    clock.advance(ms);
    if (timer && timer.at <= clock.now()) { const next = timer; timer = undefined; next.run(); }
    await monitor.idle();
  };
  /** An agent turn is queued/running (true) or ended (false). */
  const turn = (running: boolean, id = 'run_1') => bus.emit('run.upserted', { id, status: running ? 'running' : 'done' } as never);
  return { monitor, bus, clock, accounts, reads, updates, remaining, advance, turn,
    timer: () => timer, maxActive: () => maxActive,
    hold: (promise: Promise<void> | undefined) => { hold = promise; },
    fail: (value: boolean) => { failure = value; },
  };
}

test('72 → 36 while a turn runs, without focus, hover or restart; startup ignores a recent persisted check', async () => {
  const h = harness([plan('a', 'codex')]);
  h.monitor.start(); await h.monitor.idle();
  assert.deepEqual(h.reads, ['a'], 'new process always reads despite checkedAt = now');
  h.turn(true); await h.monitor.idle();
  h.remaining.set('a', 36);
  await h.advance(REFRESH_MS.codex - 1);
  assert.equal(h.updates.at(-1)?.[0].weeklyRemainingPercent, 72);
  await h.advance(1);
  assert.equal(h.updates.at(-1)?.[0].weeklyRemainingPercent, 36);
  assert.equal(h.maxActive(), 1);
  h.monitor.stop(); assert.equal(h.timer(), undefined);
});

test('Claude updates after one minute; both providers share one queue and one timer', async () => {
  const h = harness([plan('a', 'codex'), plan('b', 'claude')]);
  h.monitor.start(); await h.monitor.idle();
  h.turn(true); await h.monitor.idle();
  h.remaining.set('b', 36);
  for (let i = 0; i < 4; i++) await h.advance(REFRESH_MS.codex);
  assert.equal(h.reads.filter((id) => id === 'a').length, 5);
  assert.equal(h.reads.filter((id) => id === 'b').length, 2);
  assert.equal(h.updates.at(-1)?.find((entry) => entry.accountId === 'b')?.weeklyRemainingPercent, 36);
  assert.equal(h.maxActive(), 1);
  h.monitor.stop();
});

test('a partial provider push reaches subscribers immediately and does not postpone the independent read', async () => {
  const h = harness([plan('a', 'codex')]);
  h.monitor.start(); await h.monitor.idle();
  h.turn(true); await h.monitor.idle();
  await h.advance(14_000);
  h.accounts.set('a', { ...h.accounts.get('a')!, limits: limits(h.clock.now(), 50) });
  h.monitor.publish();
  assert.equal(h.updates.at(-1)?.[0].weeklyRemainingPercent, 50);
  await h.advance(1_000);
  assert.equal(h.reads.length, 2, 'partial pushes cannot starve other quota windows');
  h.monitor.stop();
});

test('slow checks are joined, never overlap; the next interval starts after completion', async () => {
  const h = harness([plan('a', 'codex')]);
  let release!: () => void;
  h.hold(new Promise<void>((resolve) => { release = resolve; }));
  h.monitor.start(); h.turn(true);
  h.clock.advance(90_000);
  h.monitor.activity(); const refresh = h.monitor.refreshAll();
  assert.deepEqual(h.reads, ['a']); assert.equal(h.timer(), undefined);
  release(); await refresh;
  assert.equal(h.maxActive(), 1);
  assert.equal(h.timer()?.at, h.clock.now() + REFRESH_MS.codex);
  h.monitor.stop();
});

test('failures back off, preserve 72%, become stale and recover without activity', async () => {
  const h = harness([plan('a', 'codex')]);
  h.fail(true); h.monitor.start(); h.turn(true); await h.monitor.idle();
  assert.equal(h.timer()?.at, T0 + 30_000);
  await h.advance(29_999); assert.equal(h.reads.length, 1);
  await h.advance(1); assert.equal(h.timer()?.at, T0 + 90_000);
  await h.advance(60_000); assert.equal(h.timer()?.at, T0 + 210_000);
  await h.advance(120_000);
  assert.equal(h.updates.at(-1)?.[0].weeklyRemainingPercent, 72);
  assert.equal(h.updates.at(-1)?.[0].limits?.stale, true);
  h.fail(false); h.remaining.set('a', 36);
  await h.advance(240_000);
  assert.equal(h.updates.at(-1)?.[0].weeklyRemainingPercent, 36);
  assert.equal(h.updates.at(-1)?.[0].limits?.stale, false);
  assert.equal(h.timer()?.at, h.clock.now() + REFRESH_MS.codex);
  h.monitor.stop();
});

test('disabled and signed-out accounts do not run; enabling arms the timer; removal cancels it', async () => {
  const h = harness([plan('a', 'codex', { enabled: false }), plan('b', 'claude', { state: 'needs_login' })]);
  h.monitor.start(); await h.monitor.idle();
  assert.deepEqual(h.reads, []); assert.equal(h.timer(), undefined);
  h.turn(true);
  await h.advance(60_000);
  const next = { ...h.accounts.get('a')!, enabled: true };
  h.accounts.set('a', next); h.bus.emit('account.upserted', next);
  await h.advance(1);
  assert.deepEqual(h.reads, ['a']);
  h.accounts.delete('a'); h.bus.emit('account.removed', { id: 'a' });
  assert.equal(h.timer(), undefined);
  h.monitor.stop();
});

test('resume after sleep reads once, with no catch-up burst; stopped monitors reject new checks', async () => {
  const h = harness([plan('a', 'codex')]);
  h.monitor.start(); await h.monitor.idle();
  h.clock.advance(86_400_000); h.monitor.resume(); await h.monitor.idle();
  assert.equal(h.reads.length, 2);
  h.monitor.stop();
  h.monitor.activity(); await h.monitor.checkNow('a');
  await h.advance(86_400_000);
  assert.equal(h.reads.length, 2); assert.equal(h.timer(), undefined);
});

test('no turn: one read per QUIET_MS and stale only past it; a starting turn reads at once, its end keeps the working cadence WORK_TAIL_MS', async () => {
  const h = harness([plan('a', 'codex'), plan('b', 'claude')]);
  h.monitor.start(); await h.monitor.idle();
  assert.deepEqual(h.reads, ['a', 'b']);
  assert.equal(h.timer()?.at, h.clock.now() + QUIET_MS, 'quiet: no read every 15 s or 60 s');
  await h.advance(5 * 60_000);
  assert.equal(h.reads.length, 2);
  assert.equal(h.monitor.summaries()[0].limits?.stale, false, 'a quiet reading is not stale before QUIET_MS');
  h.remaining.set('a', 36);
  h.turn(true);
  assert.equal(h.monitor.summaries()[0].limits?.stale, false, 'no stale flag while the first reads of the work are on the way');
  await h.monitor.idle();
  assert.deepEqual(h.reads.slice(2), ['a', 'b'], 'a turn that starts reads what is older than the working cadence');
  assert.equal(h.updates.at(-1)?.find((entry) => entry.accountId === 'a')?.weeklyRemainingPercent, 36);
  assert.equal(h.timer()?.at, h.clock.now() + REFRESH_MS.codex);
  h.turn(false); await h.monitor.idle();
  const ended = h.clock.now();
  for (let i = 0; i < 8; i++) await h.advance(REFRESH_MS.codex);
  assert.ok(h.reads.filter((id) => id === 'a').length >= 8, 'the working cadence holds after the turn');
  await h.advance(ended + WORK_TAIL_MS - h.clock.now());
  const settled = h.reads.length;
  const next = h.timer()!.at;
  assert.ok(next - h.clock.now() >= QUIET_MS - WORK_TAIL_MS, 'quiet again after the tail: the next read QUIET_MS after the last one of each plan');
  await h.advance(next - h.clock.now() - 1);
  assert.equal(h.reads.length, settled);
  await h.advance(1);
  assert.ok(h.reads.length > settled);
  h.monitor.stop();
});
