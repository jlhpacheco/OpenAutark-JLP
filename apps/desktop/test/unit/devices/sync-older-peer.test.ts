// A linked PC on an older version (0.3.16 / 0.3.17) has no 'sync.ledger' and no 'sync.reading' (they come with 0.3.18) and
// answers 'Unknown peer method …' (rpc-peer.ts). The newer PC stops sending that PC those methods until its next link-up
// instead of failing on its own rhythm forever: the record's 30 s retry, the readings' 2 min round. When that PC updates
// (a new link-up) both go again. Owns: these mixed-version cases. Never: other sync paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noMethod } from '../../../src/runtime/devices/sync/no-method.ts';
import { RETRY_MS } from '../../../src/runtime/devices/sync/ledger.ts';
import { ReadingSync } from '../../../src/runtime/devices/sync/readings.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account, AccountLimits } from '../../../src/shared/model/providers.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';
import { link, Net, record as deviceRecord } from './sync-net.ts';
import { ledgerCalls, ledgerPc, record, row } from './sync-ledger-rig.ts';

test('only a peer\'s "Unknown peer method" answer counts as an older version', () => {
  assert.equal(noMethod(new WorkforceError('not_found', 'Unknown peer method sync.ledger.')), true);
  assert.equal(noMethod(new WorkforceError('not_found', 'This device is not linked.')), false);
  assert.equal(noMethod(new WorkforceError('forbidden', 'Unknown peer method x.')), false);
  assert.equal(noMethod(new Error('Unknown peer method sync.ledger.')), false);
});

test('the record: a PC without sync.ledger is asked once per link-up, not every RETRY_MS; after its update the record goes', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  const ledger = b.handlers.get('sync.ledger')!;
  b.handlers.delete('sync.ledger'); // B is on 0.3.17
  row(a, 'message', { ref: 'msg:msg_1' });

  assert.equal(await a.ledger.catchUp('dev_b'), false, 'the link-up step says it did not go');
  const asked = ledgerCalls(net).length;
  assert.ok(asked >= 1);
  for (let i = 0; i < 2 * RETRY_MS / 5_000 + 2; i++) { // a little over two RETRY_MS, in steps the sleep check takes for time passing
    (a.h.clock as ManualClock).advance(5_000);
    a.ledger.tick();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(ledgerCalls(net).length, asked, 'no retry on its own rhythm while that link lasts');

  b.handlers.set('sync.ledger', ledger); // B updated: a new link-up
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.equal(record(b).length, 1, 'the record reaches it');
  assert.equal(record(b)[0]?.pc, 'dev_a');
});

test('the readings: a PC without sync.reading is asked once per link-up, not every round; after its update they go', async () => {
  const db = memoryDb();
  const { bus } = recordingBus();
  const repo = new DevicesRepo(db);
  repo.upsert(deviceRecord('dev_a', { self: true }));
  repo.upsert(deviceRecord('dev_b'));
  const limits: AccountLimits = { windows: [{ name: 'weekly', windowMinutes: 10_080, usedPercent: 40, resetsAt: 1_900_000_000 }], readAt: 1_000 };
  const accounts: Account[] = [{ id: 'acc_cx', provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0, limits }];
  let calls = 0;
  let older = true;
  const s = {
    db, bus, clock: new ManualClock(1_800_000_000_000), log: silentLog,
    accounts: { list: () => accounts, get: (id: string) => accounts.find((account) => account.id === id) },
    devices: {
      online: () => true,
      call: async () => { calls += 1; if (older) throw new WorkforceError('not_found', 'Unknown peer method sync.reading.'); return { ok: true, applied: 1 }; },
    },
  } as unknown as RuntimeServices;
  const readings = new ReadingSync(s);

  assert.equal(await readings.catchUp('dev_b'), false);
  assert.equal(calls, 1);
  for (let i = 0; i < 3; i++) await readings.catchUp('dev_b', true); // rounds in rhythm
  assert.equal(calls, 1, 'the rhythm does not ask again');

  older = false; // B updated: its link comes up again
  assert.equal(await readings.catchUp('dev_b'), true);
  assert.equal(calls, 2);
});
