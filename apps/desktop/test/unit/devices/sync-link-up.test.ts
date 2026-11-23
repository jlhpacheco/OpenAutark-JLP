// The catch-ups between linked PCs (devices/sync/service.ts linkUps, rhythm; stamps.ts cursors): the rows, secrets and
// every plan's login go – and have arrived – before the wakes that wait for that PC, the settings and files after them;
// one run per PC at a time; an 'online' during one (a link swap) ends it before its next step and runs it again at
// once, from the same cursors (during its last step: after it, from the cursors it moved – its wakes go once more on the
// new link right away); a run whose link is gone ends before its next step, the cursors where they were. 22.11.2026:
// while a link stays up the same catch-up runs again in rhythm – without the ledger and the file rescan, quiet when
// complete, skipped while a run is on its way –; each part moves its own cursor, so a file that keeps failing never
// makes the rows go again; after either PC changed version the cursors start from zero once. Fake parts, a manual
// clock – no network.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from '../../../src/runtime/contracts.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { linkUps, rhythm, round, type LinkUpParts } from '../../../src/runtime/devices/sync/service.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';
import { record } from './sync-net.ts';

const START = 1_000_000;
const FULL = ['roster', 'tabs', 'rows', 'ledger', 'secrets', 'logins', 'share', 'wakes', 'files'];
const AGAIN = ['roster', 'tabs', 'rows', 'secrets', 'logins', 'share', 'wakes', 'files'];

function fixture() {
  const clock = new ManualClock(START);
  const steps: string[] = [];
  const sinces: Array<number | undefined> = []; // the cursor each run's rows went from
  const flags: Array<{ step: string; again?: boolean; scan?: boolean }> = [];
  const holds = new Set<string>();
  const waiting = new Map<string, () => void>();
  const fails = new Map<string, false | Error>();
  const filesUpTo = new Map<string, number>(); // a files part that arrived only up to this time
  const cursors = new Map<string, number>(); // `${peer}/${part}`
  const linked = new Set(['dev_b', 'dev_c']);
  const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const note = (message: string, data?: Record<string, unknown>) => { logs.push({ message, data }); };
  const log: Logger = { debug() {}, info: note, warn: note, error: note };
  const step = (name: string) => async (peer: string, since?: unknown): Promise<boolean> => {
    const key = `${name}:${peer}`;
    steps.push(key);
    if (name === 'rows') sinces.push(since as number | undefined);
    if (holds.has(key)) await new Promise<void>((resolve) => waiting.set(key, resolve));
    const fail = fails.get(key);
    if (fail instanceof Error) throw fail;
    return fail !== false;
  };
  const parts: LinkUpParts = {
    roster: { linkUp: async (peer, again) => { flags.push({ step: 'roster', again }); await step('roster')(peer); } },
    tabs: { catchUp: step('tabs') },
    rows: { catchUp: step('rows'), resume: (peer) => { steps.push(`wakes:${peer}`); } },
    ledger: { catchUp: step('ledger') },
    secrets: { catchUp: step('secrets') },
    logins: { catchUp: async (peer, again) => { flags.push({ step: 'logins', again }); return step('logins')(peer); } },
    share: { catchUp: async (peer, again) => { flags.push({ step: 'share', again }); await step('share')(peer); } },
    files: { catchUp: async (peer, since, options) => { flags.push({ step: 'files', scan: options?.scan }); const done = await step('files')(peer, since); return filesUpTo.get(peer) ?? done; } },
  };
  const stamps = {
    pair: () => 'v1>v1',
    cursor: (peer: string, part = 'rows') => cursors.get(`${peer}/${part}`),
    setCursor: (peer: string, at: number, part = 'rows') => { cursors.set(`${peer}/${part}`, at); },
  };
  const run = linkUps({ clock, log }, stamps as never, parts, (peer) => linked.has(peer));
  return {
    clock, steps, sinces, flags, holds, fails, filesUpTo, cursors, linked, logs, run,
    release: (key: string) => { holds.delete(key); waiting.get(key)?.(); waiting.delete(key); },
    /** The steps of `peer` (its wakes too: only its own catch-up releases them). */
    of: (peer: string) => steps.filter((entry) => entry.endsWith(`:${peer}`)).map((entry) => entry.split(':')[0]),
    said: (message: string) => logs.filter((entry) => entry.message === message).map((entry) => entry.data),
  };
}

// A timer round first: a swap during the last step releases the wakes again on a 0 ms timer.
const idle = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('B-087: the rows, secrets and every plan\'s login go before the waiting wakes; the settings and files after them', async () => {
  const f = fixture();
  f.run('dev_b');
  await idle();
  assert.deepEqual(f.steps.map((entry) => entry.split(':')[0]), FULL, 'a woken turn on the other PC finds its login and key there');
  assert.equal(f.cursors.get('dev_b/rows'), START, 'a complete run moves each part\'s cursor to its start');
  assert.equal(f.cursors.get('dev_b/files'), START);
  assert.deepEqual(f.said('linked PC caught up'), [{ peer: 'dev_b', first: true, complete: true }]);
  assert.deepEqual(f.flags, [{ step: 'roster', again: false }, { step: 'logins', again: false }, { step: 'share', again: false }, { step: 'files', scan: true }], 'a link-up: everything whole, the files rescanned');
});

test('22.11.2026: a link that stays up runs the same catch-up again – without the ledger and the rescan, and quietly when complete', async () => {
  const f = fixture();
  f.run('dev_b');
  await idle();
  f.steps.length = 0;
  f.flags.length = 0;
  f.clock.advance(120_000);
  f.run('dev_b', true);
  await idle();
  assert.deepEqual(f.of('dev_b'), AGAIN, 'the ledger keeps itself in rhythm (its own tick)');
  assert.deepEqual(f.flags, [{ step: 'roster', again: true }, { step: 'logins', again: true }, { step: 'share', again: true }, { step: 'files', scan: false }]);
  assert.deepEqual(f.sinces, [undefined, START], 'from the cursor the link-up moved');
  assert.equal(f.cursors.get('dev_b/rows'), START + 120_000);
  assert.equal(f.said('linked PC caught up').length, 1, 'no log line for a repeat that completed');

  f.fails.set('files:dev_b', false);
  f.clock.advance(120_000);
  f.run('dev_b', true);
  await idle();
  assert.deepEqual(f.said('linked PC caught up').at(-1), { peer: 'dev_b', first: false, complete: false, again: true }, 'one that could not complete says so');
});

test('22.11.2026: each part moves its own cursor – a file that keeps failing never makes the rows go again', async () => {
  const f = fixture();
  f.fails.set('files:dev_b', false);
  f.run('dev_b');
  await idle();
  assert.equal(f.cursors.get('dev_b/rows'), START, 'the rows and secrets arrived');
  assert.equal(f.cursors.get('dev_b/files'), undefined, 'the files are owed from the start');
  f.clock.advance(1_000);
  f.run('dev_b', true);
  await idle();
  assert.deepEqual(f.sinces, [undefined, START], 'the next run owes only the rows since then');
  f.fails.set('rows:dev_b', false);
  f.fails.delete('files:dev_b');
  f.clock.advance(1_000);
  f.run('dev_b', true);
  await idle();
  assert.equal(f.cursors.get('dev_b/rows'), START + 1_000, 'rows that did not arrive keep their cursor');
  assert.equal(f.cursors.get('dev_b/files'), START + 2_000, 'the files caught up');
});

test('22.11.2026 review: files that did not all arrive move their cursor up to the first page that did not, and the next round looks at every root again', async () => {
  const f = fixture();
  f.run('dev_b');
  await idle();
  f.filesUpTo.set('dev_b', START + 50); // a file of a later page keeps failing
  f.clock.advance(120_000);
  f.run('dev_b', true);
  await idle();
  assert.equal(f.cursors.get('dev_b/files'), START + 50, 'up to the page that did not arrive, not back to the whole backlog');
  assert.equal(f.cursors.get('dev_b/rows'), START + 120_000);
  f.flags.length = 0;
  f.clock.advance(120_000);
  f.run('dev_b', true);
  await idle();
  assert.deepEqual(f.flags.at(-1), { step: 'files', scan: true }, 'the round after it rescans: a stale entry heals');
  f.filesUpTo.delete('dev_b');
  f.clock.advance(120_000);
  f.run('dev_b', true);
  await idle();
  assert.deepEqual(f.flags.at(-1), { step: 'files', scan: true }, 'still owed when that round began');
  assert.equal(f.cursors.get('dev_b/files'), START + 360_000);
  f.run('dev_b', true);
  await idle();
  assert.deepEqual(f.flags.at(-1), { step: 'files', scan: false }, 'complete again: the rounds are quiet');
});

test('22.11.2026: a catch-up in rhythm is skipped while a run of that PC is on its way; a link swap still runs it again', async () => {
  const f = fixture();
  f.holds.add('rows:dev_b');
  f.run('dev_b');
  await idle();
  f.run('dev_b', true);
  f.release('rows:dev_b');
  await idle();
  assert.deepEqual(f.of('dev_b'), FULL, 'the run on its way brings the same');
  f.holds.add('tabs:dev_b');
  f.run('dev_b', true);
  await idle();
  f.run('dev_b'); // a swap cut the repeat
  f.release('tabs:dev_b');
  await idle();
  assert.deepEqual(f.of('dev_b'), [...FULL, 'roster', 'tabs', ...FULL], 'the rerun after a swap is a whole link-up');
});

test('B-087: one run per PC at a time; an online during it (a link swap) runs it once more after it, from the moved cursor', async () => {
  const f = fixture();
  f.holds.add('files:dev_b');
  f.run('dev_b');
  await idle();
  f.clock.advance(5_000);
  f.run('dev_b'); // the swap: the old link closed, the new one came up while the files still went
  f.run('dev_b'); // and once more
  f.run('dev_c'); // another PC runs beside it
  await idle();
  assert.deepEqual(f.of('dev_b'), [...FULL, 'wakes'], 'no second run while the first one runs – only its wakes go once more on the new link (the swap may have cut their hand-over)');
  assert.deepEqual(f.of('dev_c'), FULL, 'each PC has its own, its wakes too');

  f.release('files:dev_b');
  await idle();
  assert.deepEqual(f.of('dev_b'), [...FULL, 'wakes', ...FULL], 'exactly one more run, not one per online');
  assert.deepEqual(f.sinces, [undefined, undefined, START], 'the second run starts from the cursor the first one moved');
  assert.equal(f.cursors.get('dev_b/rows'), START + 5_000);
  assert.deepEqual(f.said('linked PC caught up').filter((data) => data?.peer === 'dev_b'), [
    { peer: 'dev_b', first: true, complete: true },
    { peer: 'dev_b', first: false, complete: true },
  ]);
});

test('B-087: a link swap during an earlier step ends that run at its next step; the rerun starts at once, from the same cursor', async () => {
  const f = fixture();
  f.holds.add('tabs:dev_b');
  f.run('dev_b');
  await idle();
  f.clock.advance(5_000);
  f.run('dev_b'); // the swap cut the side pane in flight
  f.release('tabs:dev_b');
  await idle();
  assert.deepEqual(f.of('dev_b'), ['roster', 'tabs', ...FULL], 'what the swap cut goes again now, not after the rows, wakes and file rescan');
  assert.deepEqual(f.sinces, [undefined], 'the cut run moved no cursor');
  assert.equal(f.cursors.get('dev_b/rows'), START + 5_000);
  assert.deepEqual(f.said('link-up again after a link swap'), [{ peer: 'dev_b' }]);
  assert.deepEqual(f.said('linked PC caught up'), [{ peer: 'dev_b', first: true, complete: true }]);
});

test('B-087: the wakes wait until the secrets and the logins have arrived, not just started', async () => {
  for (const held of ['secrets:dev_b', 'logins:dev_b']) {
    const f = fixture();
    f.holds.add(held);
    f.run('dev_b');
    await idle();
    assert.ok(!f.steps.includes('wakes:dev_b'), `no wake leaves while ${held} is on its way`);
    f.release(held);
    await idle();
    assert.deepEqual(f.steps.map((entry) => entry.split(':')[0]), FULL, `the wakes go once ${held} has arrived`);
  }
});

test('B-087: a run whose link is gone ends before its next step, the cursor where it was; the next link-up owes it all', async () => {
  const f = fixture();
  f.cursors.set('dev_b/rows', 100); // an earlier link-up
  f.holds.add('rows:dev_b');
  f.run('dev_b');
  await idle();
  f.run('dev_b'); // the link came up once more ...
  f.linked.delete('dev_b'); // ... and went again while the rows went
  f.fails.set('rows:dev_b', false);
  f.release('rows:dev_b');
  await idle();
  assert.deepEqual(f.steps, ['roster:dev_b', 'tabs:dev_b', 'rows:dev_b'], 'no secrets, logins, wakes or files are dialed for');
  assert.equal(f.cursors.get('dev_b/rows'), 100, 'the cursor stays');
  assert.deepEqual(f.said('link-up ended, link gone'), [{ peer: 'dev_b' }]);
  assert.deepEqual(f.said('linked PC caught up'), [], 'and no run follows while the link is gone');

  f.fails.clear();
  f.linked.add('dev_b');
  f.run('dev_b'); // the link is back
  await idle();
  assert.deepEqual(f.steps.slice(3).map((entry) => entry.split(':')[0]), FULL);
  assert.deepEqual(f.sinces, [100, 100], 'everything since the old cursor again');
  assert.equal(f.cursors.get('dev_b/rows'), START);
});

test('a link-up that fails is logged, and that PC\'s next link-up runs', async () => {
  const f = fixture();
  f.fails.set('secrets:dev_b', new Error('disk full'));
  f.run('dev_b');
  await idle();
  assert.deepEqual(f.said('linked PC not caught up'), [{ peer: 'dev_b', error: 'disk full' }]);
  assert.equal(f.cursors.get('dev_b/rows'), undefined);
  f.fails.clear();
  f.run('dev_b');
  await idle();
  assert.deepEqual(f.said('linked PC caught up'), [{ peer: 'dev_b', first: true, complete: true }]);
});

test('22.11.2026: the rhythm runs every PC while one is linked, and no timer is armed while none is', async () => {
  const peers: string[] = [];
  const ran: string[] = [];
  const beat = rhythm(() => peers, (peer) => ran.push(peer), 15);
  beat.check(); // none linked: nothing armed
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ran.length, 0);
  peers.push('dev_b', 'dev_c');
  beat.check();
  beat.check(); // one timer, not two
  await new Promise((resolve) => setTimeout(resolve, 40));
  const seen = ran.length;
  assert.ok(seen >= 2 && seen % 2 === 0 && ran.includes('dev_b') && ran.includes('dev_c'), `each PC each round (${ran.join(',')})`);
  peers.length = 0;
  beat.check();
  const stopped = ran.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ran.length, stopped, 'the last link went: the timer went with it');
  beat.stop();
});

test('22.11.2026: each round of the rhythm runs that PC\'s catch-up again and says so on the bus (sync.round), for modules that follow the rhythm', () => {
  const { bus, events } = recordingBus();
  const runs: Array<[string, boolean | undefined]> = [];
  round({ bus, log: silentLog }, (peer, again) => { runs.push([peer, again]); })('dev_b');
  assert.deepEqual(runs, [['dev_b', true]]);
  assert.deepEqual(events.filter((entry) => entry.event === 'sync.round').map((entry) => entry.data), [{ peer: 'dev_b' }]);
});

test('22.11.2026: a cursor holds both PCs\' versions – another version on either side starts from zero once', () => {
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  repo.upsert(record('dev_b', { caps: { version: '0.3.16' } }));
  const clock = new ManualClock(START);
  const stamps = new Stamps(db, clock, '0.3.17');
  assert.equal(stamps.pair('dev_b'), '0.3.17>0.3.16');
  new KvRepo(db).set('sync.sent', 'dev_b', 500, START); // the cursor of an older version: a number
  assert.equal(stamps.cursor('dev_b'), undefined, 'an older cursor: from zero');
  stamps.setCursor('dev_b', 900);
  stamps.setCursor('dev_b', 950, 'files');
  assert.equal(stamps.cursor('dev_b'), 900);
  assert.equal(stamps.cursor('dev_b', 'files'), 950, 'each part its own');

  const atStart = stamps.pair('dev_b'); // a run read the pair at its start ...
  repo.patch('dev_b', { caps: { version: '0.3.17' } }); // ... then the other PC's new version arrived
  assert.equal(stamps.cursor('dev_b'), undefined, 'the other PC updated: from zero');
  stamps.setCursor('dev_b', 1_000, 'rows', atStart); // the run completes under the pair it started with
  assert.equal(stamps.cursor('dev_b'), undefined, 'the next run still starts from zero');
  stamps.setCursor('dev_b', 1_100);
  assert.equal(stamps.cursor('dev_b'), 1_100);
  assert.equal(stamps.cursor('dev_b', 'files'), undefined, 'the files of the old pair are owed from zero too');
  assert.equal(new Stamps(db, clock, '0.3.18').cursor('dev_b'), undefined, 'this PC updated: from zero');
  stamps.dropCursor('dev_b');
  assert.equal(stamps.cursor('dev_b'), undefined);
});
