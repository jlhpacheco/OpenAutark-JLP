// A plan's limit readings between the company's PCs (devices/sync/readings.ts, owner 22.11.2026: a greyed-out Codex
// reading on the PC the agent worked on): a reading one PC took reaches every PC that shares the plan – my own PCs and
// an employee's PC – within a moment and is shown there; the newer reading wins by its time, an older or equal one
// never replaces it and nothing echoes back; a plan kept "Only on this PC", the person's own plan on an employee's PC
// and anything that is no reading stay where they are; a link-up sends every reading, a round in rhythm only newer ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account, AccountLimits } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { ReadingSync, readingOf } from '../../../src/runtime/devices/sync/readings.ts';
import { markOrigin } from '../../../src/runtime/devices/sync/employee.ts';
import { personPlan, sharesPlan } from '../../../src/runtime/devices/sync/plan-peers.ts';
import { noteClock, noteRoundTrip } from '../../../src/runtime/devices/link-quality.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

const plan = (id: string, extra: Partial<Account> = {}): Account => ({
  id, provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0, ...extra,
});

const limits = (used: number, readAt: number): AccountLimits => ({ windows: [{ name: 'weekly', windowMinutes: 10_080, usedPercent: used, resetsAt: 1_900_000_000_000 }], readAt });

interface Pc { id: string; db: ReturnType<typeof memoryDb>; repo: DevicesRepo; accounts: Account[]; calls: string[]; readings: ReadingSync; bus: ReturnType<typeof recordingBus>['bus']; s: RuntimeServices }

function makePc(pcs: Map<string, Pc>, id: string): Pc {
  const db = memoryDb();
  const { bus } = recordingBus();
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const accounts: Account[] = [];
  const calls: string[] = [];
  const clock = new ManualClock(1_800_000_000_000);
  const s = {
    db, bus, clock, log: silentLog,
    accounts: {
      list: () => accounts, get: (accountId: string) => accounts.find((account) => account.id === accountId),
      updateLimits: (accountId: string, next: AccountLimits) => {
        const index = accounts.findIndex((account) => account.id === accountId);
        accounts[index] = { ...accounts[index], limits: next };
        bus.emit('account.upserted', accounts[index]);
      },
    },
    devices: {
      online: (peer: string) => pcs.has(peer),
      call: async (peer: string, method: string, params: unknown) => {
        const target = pcs.get(peer);
        if (!target) throw new WorkforceError('unavailable', 'offline');
        assert.equal(method, 'sync.reading');
        calls.push(`${id}->${peer}`);
        return target.readings.receive(JSON.parse(JSON.stringify(params)), id);
      },
    },
  } as unknown as RuntimeServices;
  const readings = new ReadingSync(s);
  const pc: Pc = { id, db, repo, accounts, calls, readings, bus, s };
  pcs.set(id, pc);
  return pc;
}

const settle = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));
const used = (pc: Pc, account = 'acc_cx') => pc.accounts.find((entry) => entry.id === account)?.limits?.windows[0]?.usedPercent;

/** `b` joined `a` as one of the CEO's PCs. */
function link(a: Pc, b: Pc): void {
  a.repo.upsert(record(b.id));
  b.repo.upsert(record(a.id, { joinedAs: 'ceo' }));
}

/** `b` joined `a`'s company as Lena's PC. */
function employ(a: Pc, b: Pc): void {
  a.repo.upsert(record(b.id, { personId: 'per_lena000001' }));
  b.repo.upsert(record(a.id, { joinedAs: 'employee' }));
}

test('a reading reaches my other PC and is shown there; the newer one wins, an older one never replaces it, nothing echoes', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = makePc(pcs, 'dev_a');
  const b = makePc(pcs, 'dev_b');
  const c = makePc(pcs, 'dev_c');
  link(a, b); link(b, c);
  a.accounts.push(plan('acc_cx', { limits: limits(40, 1_000) }));
  b.accounts.push(plan('acc_cx', { limits: limits(20, 500) })); // its own read failed since
  c.accounts.push(plan('acc_cx'));
  const offs = [a.readings.attach(), b.readings.attach(), c.readings.attach()];
  t.after(() => { for (const off of offs) off(); });

  assert.equal(await a.readings.catchUp('dev_b'), true);
  assert.equal(used(b), 40, 'the newer reading is the one shown');
  await settle();
  assert.equal(used(c), 40, 'and goes on to the PCs that PC links');
  assert.deepEqual(b.calls.filter((call) => call === 'dev_b->dev_a'), [], 'never back to where it came from');

  b.accounts[0] = { ...b.accounts[0], limits: limits(55, 2_000) }; // B read the plan itself
  b.bus.emit('account.upserted', b.accounts[0]);
  await settle();
  assert.equal(used(a), 55, 'a reading taken there comes here within a moment');
  assert.equal(used(c), 55);

  const before = a.calls.length;
  await a.readings.receive({ readings: [{ account: 'acc_cx', limits: limits(10, 1_500) }] }, 'dev_b');
  assert.equal(used(a), 55, 'an older reading never replaces a newer one');
  await a.readings.catchUp('dev_b', true);
  assert.equal(a.calls.length, before, 'a round in rhythm sends nothing the other PC has');
});

test('an employee\'s PC gets the company\'s plan readings and sends back those of that plan only; a plan kept on its PC stays', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = makePc(pcs, 'dev_a');
  const b = makePc(pcs, 'dev_b');
  employ(a, b);
  a.accounts.push(plan('acc_cx', { limits: limits(30, 1_000) }), plan('acc_mine', { limits: limits(70, 1_000), thisPcOnly: true }));
  b.accounts.push(plan('acc_cx'), plan('acc_mine'), plan('acc_lena', { limits: limits(5, 3_000) }));
  markOrigin(b.db, { t: 'accounts', id: 'acc_cx', row: {} }, 'dev_a', 0); // the company's plan came with its row

  await a.readings.catchUp('dev_b');
  assert.equal(used(b), 30, 'the company\'s plan, read on the company\'s PC, shows on the employee\'s PC');
  assert.equal(used(b, 'acc_mine'), undefined, 'a plan kept on that PC sends none');

  b.accounts[0] = { ...b.accounts[0], limits: limits(35, 2_000) };
  await b.readings.catchUp('dev_a');
  assert.equal(used(a), 35, 'the employee\'s PC reads the company\'s plan too, and the company sees it');
  assert.equal(a.accounts.some((account) => account.id === 'acc_lena'), false);
  await a.readings.receive({ readings: [{ account: 'acc_mine', limits: limits(1, 9_000) }] }, 'dev_b');
  assert.equal(used(a, 'acc_mine'), 70, 'nor does a plan kept on this PC take one');
});

test('only readings travel: a PC that is no link is refused, anything malformed is left out, a clock far ahead counts as now', async () => {
  const pcs = new Map<string, Pc>();
  const a = makePc(pcs, 'dev_a');
  a.accounts.push(plan('acc_cx', { limits: limits(30, 1_000) }));
  await assert.rejects(a.readings.receive({ readings: [] }, 'dev_x'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  const now = 1_800_000_000_000;
  assert.equal(readingOf({ account: 'acc_cx', limits: { windows: [{ name: 'weekly' }], readAt: 1 } }, now), undefined);
  assert.equal(readingOf({ account: 'acc_cx', limits: { windows: 'x', readAt: 1 } }, now), undefined);
  assert.equal(readingOf({ account: '', limits: limits(1, 1) }, now), undefined);
  assert.equal(readingOf({ account: 'acc_cx', limits: { ...limits(150, now * 2), token: 'x' } }, now)?.limits.readAt, now + 60_000);
  assert.deepEqual(Object.keys(readingOf({ account: 'acc_cx', limits: { ...limits(150, 5), token: 'x' } }, now)!.limits).sort(), ['readAt', 'windows'], 'nothing beside the reading is kept');
  assert.equal(readingOf({ account: 'acc_cx', limits: limits(150, 5) }, now)!.limits.windows[0].usedPercent, 100);
});

test('review 22.11.2026: every PC of the company counts on the employee\'s PC; only a CLI plan with a home of its own is a person\'s; a clock behind never loses', async () => {
  const pcs = new Map<string, Pc>();
  const a = makePc(pcs, 'dev_a');
  const c = makePc(pcs, 'dev_c'); // the company's second PC
  const b = makePc(pcs, 'dev_b');
  employ(a, b); employ(c, b);
  link(a, c);
  b.accounts.push(plan('acc_cx'));
  markOrigin(b.db, { t: 'accounts', id: 'acc_cx', row: {} }, 'dev_a', 0); // came from A last
  c.accounts.push(plan('acc_cx', { limits: limits(60, 1_000) }));
  await c.readings.catchUp('dev_b');
  assert.equal(used(b), 60, 'a reading from the company\'s other PC is taken too');

  assert.equal(personPlan({ provider: 'codex', auth: 'cli' }), true);
  assert.equal(personPlan({ provider: 'claude', auth: 'cli' }), true);
  assert.equal(personPlan({ provider: 'gemini-cli', auth: 'cli' }), false, 'one sign-in per PC: the person\'s own would pass for the company\'s');
  assert.equal(personPlan({ provider: 'openai', auth: 'api_key' as Account['auth'] }), false, 'an API key is no plan their PC runs');
  assert.equal(sharesPlan(a.db, { kind: 'employee', personId: 'per_lena000001' }, { id: 'acc_k', provider: 'openai', auth: 'api_key' as Account['auth'] }), false);
  assert.equal(sharesPlan(a.db, { kind: 'ceo' }, { id: 'acc_k', provider: 'openai', auth: 'api_key' as Account['auth'] }), true, 'my own PCs share everything as before');

  const t0 = Date.now();
  noteRoundTrip('dev_c', 20, t0);
  noteClock('dev_c', t0 - 20, t0 - 10 - 300_000, t0); // C's clock runs 5 min behind A's
  a.accounts.push(plan('acc_cy', { limits: limits(10, 1_800_000_000_000 - 60_000) }));
  c.accounts.push(plan('acc_cy', { limits: limits(20, 1_800_000_000_000 - 240_000) })); // read 4 min ago by C's clock = 1 min after A's reading
  await c.readings.catchUp('dev_a');
  assert.equal(used(a, 'acc_cy'), 20, 'C\'s newer reading wins although its clock is behind');
});
