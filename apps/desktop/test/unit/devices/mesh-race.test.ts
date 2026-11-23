// B-084 the link-up race (devices/mesh.ts + mesh-retry.ts): a PC dials one that has not stored it yet (the roster has
// not merged there): a 4003 within 10 s of this PC's row gets exactly one more dial after RACE_RETRY_MS; a later
// refusal still ends the retries; in a row's first minute both sides retry after a close, later only the smaller id.
// In-process socket pairs, manual clock and timers: nothing runs that a test does not fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh, type Timers } from '../../../src/runtime/devices/mesh.ts';
import { EARLY_REFUSAL_MS, FRESH_MS, RACE_RETRY_MS } from '../../../src/runtime/devices/mesh-retry.ts';
import { socketPair } from './socket-pair.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from './fakes.ts';

type HandTimers = Timers & { fire(): void; count(): number; delays: number[] };
interface Pc { id: string; fingerprint: string; address: string; mesh: DeviceMesh; db: ReturnType<typeof memoryDb>; clock: ManualClock; timers: HandTimers }

const pcs = new Map<string, Pc>();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function handTimers(): HandTimers {
  const queue = new Map<number, () => void>();
  let next = 0;
  const delays: number[] = [];
  return {
    delays,
    set: (fn, ms) => { delays.push(ms); queue.set(++next, fn); return next; },
    clear: (handle) => { queue.delete(handle as number); },
    fire: () => { const fns = [...queue.values()]; queue.clear(); fns.forEach((fn) => fn()); },
    count: () => queue.size,
  };
}

async function pc(name: string, address: string): Promise<Pc> {
  const db = memoryDb();
  const clock = new ManualClock();
  const timers = handTimers();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock, name });
  const mesh = new DeviceMesh({
    db, identity, clock, log: silentLog, bus: recordingBus().bus, timers,
    dial: async (target) => {
      const [mine, theirs] = socketPair();
      void pcs.get(target)!.mesh.accept(theirs).catch(() => {});
      return mine;
    },
  });
  mesh.updateSelf({ addresses: [address] });
  const node = { id: identity.deviceId, fingerprint: identity.fingerprint, address, mesh, db, clock, timers };
  pcs.set(address, node);
  return node;
}

/** Two PCs that know nothing of each other yet; `low`/`high` by device id. */
async function two() {
  pcs.clear();
  const x = await pc('Laptop', 'http://10.0.0.1:47811');
  const y = await pc('Tower', 'http://10.0.0.2:47811');
  return x.id < y.id ? { low: x, high: y } : { low: y, high: x };
}

/** `node` stores `other` the way the roster merge does, without dialing (that PC "merges later"). */
const store = (node: Pc, other: Pc, pairedAt: number) => new DevicesRepo(node.db).upsert({
  id: other.id, name: 'Other', kind: 'pc', role: 'home', fingerprint: other.fingerprint, publicKey: other.mesh.selfInfo().pub,
  addresses: [other.address], caps: {}, status: 'offline', self: false, pairedAt, lastSeenAt: pairedAt,
});
const linked = (x: Pc, y: Pc) => x.mesh.online(y.id) && y.mesh.online(x.id);

for (const side of ['low', 'high'] as const) {
  test(`a refusal right after linking (${side} id dials first) gets one more dial, which links once the other PC stored this one`, async () => {
    const pair = await two();
    const [dialer, other] = side === 'low' ? [pair.low, pair.high] : [pair.high, pair.low];
    dialer.mesh.add(other.mesh.selfInfo(), { side: 'joiner' }); // the other PC has not merged the roster yet
    await settle();
    assert.equal(linked(dialer, other), false);
    assert.equal(dialer.timers.count(), 1, 'one retry, not the end');
    assert.equal(dialer.timers.delays.at(-1), RACE_RETRY_MS);
    store(other, dialer, other.clock.now()); // the roster arrives there
    dialer.clock.advance(RACE_RETRY_MS);
    dialer.timers.fire();
    await settle();
    assert.ok(linked(dialer, other));
    assert.equal(dialer.timers.count() + other.timers.count(), 0, 'nothing left scheduled');
  });
}

test('exactly one race retry: a second refusal ends it; close() clears a pending one', async () => {
  const { low, high } = await two();
  high.mesh.add(low.mesh.selfInfo(), { side: 'joiner' });
  await settle();
  assert.equal(high.timers.count(), 1);
  high.timers.fire(); // the other PC still does not know this one
  await settle();
  assert.equal(high.timers.count(), 0, 'no second race retry: no polling');
  assert.equal(linked(low, high), false);

  const again = await two();
  again.low.mesh.add(again.high.mesh.selfInfo(), { side: 'joiner' });
  await settle();
  assert.equal(again.low.timers.count(), 1);
  again.low.mesh.close();
  assert.equal(again.low.timers.count(), 0, 'stop clears the race timer');

  // RG: a dial still in flight when the mesh closes – its refusal arrives after close() and arms nothing
  const late = await two();
  store(late.low, late.high, late.low.clock.now());
  const dial = late.low.mesh.connect(late.high.id);
  late.low.mesh.close();
  await dial.catch(() => undefined);
  await settle();
  assert.equal(late.low.timers.count(), 0, 'no timer survives close()');
});

test('a refusal later than EARLY_REFUSAL_MS after linking ends the retries as before', async () => {
  const { low, high } = await two();
  store(low, high, low.clock.now() - EARLY_REFUSAL_MS); // linked 10 s ago; the other PC unlinked this one
  await low.mesh.connect(high.id).catch(() => undefined);
  await settle();
  assert.equal(low.timers.count(), 0);
});

test('a row\'s first minute: both sides retry after a close; after FRESH_MS only the smaller id', async () => {
  const { low, high } = await two();
  low.mesh.add(high.mesh.selfInfo(), { side: 'inviter' });
  high.mesh.add(low.mesh.selfInfo(), { side: 'joiner' });
  await settle();
  assert.ok(linked(low, high));
  (await low.mesh.connect(high.id)).channel.close();
  await settle();
  assert.equal(low.timers.count(), 1);
  assert.equal(high.timers.count(), 1, 'the higher id retries too while the row is fresh');
  high.timers.fire();
  await settle();
  assert.ok(linked(low, high));
  assert.equal(low.timers.count() + high.timers.count(), 0, 'the new link ended both pending retries');

  for (const node of [low, high]) node.clock.advance(FRESH_MS);
  (await low.mesh.connect(high.id)).channel.close();
  await settle();
  assert.equal(low.timers.count(), 1);
  assert.equal(high.timers.count(), 0, 'an older row: the higher id waits again');
});
