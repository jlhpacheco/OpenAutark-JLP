// Bridge eine-id-1122 (Eine-ID 22.11.2026): on an employee's PC the person's own code tree in 'remote.code' becomes the
// me tree (the person keeps the number, now as My ID) and 'remote.code' is cleared for the company's chain; the company's
// tree, a company's own PC and an existing me tree are left as they are, a tree rooted at this PC's own key is cleared but
// not kept (a fresh me tree starts, so My ID never equals the device ID); a second run changes
// nothing; trees opened already are read again.
// Owns: these assertions only, on an in-memory database. Never: a company's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { moveSeatCode, runEineId1122 } from '../../../src/runtime/bridge/eine-id-1122.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { b64url, fingerprintOf } from '../../../src/runtime/devices/keys.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { meFor, openCodes, type CodeKey } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { memoryDb, silentLog } from '../devices/fakes.ts';

function keyOf(seed: number): CodeKey & { pub: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(der.subarray(der.length - 32));
  return { publicKey, fingerprint: fingerprintOf(publicKey), pub: b64url(publicKey), sign: (data) => sign(null, data, privateKey) };
}
const row = (id: string, key: { pub: string; fingerprint: string }, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id.slice(4, 8), kind: 'pc', role: 'home', fingerprint: key.fingerprint, publicKey: key.pub, addresses: [], caps: {}, status: 'online', self: false, pairedAt: 1, ...extra,
});

/** A seat whose own code tree (its laptop as the root, itself signed in) was kept in 'remote.code' before 22.11.2026. */
function seat(seed: number, options: { employer?: boolean } = {}) {
  const db = memoryDb();
  const me = keyOf(seed);
  const laptop = keyOf(seed + 1);
  const company = keyOf(seed + 2);
  const repo = new DevicesRepo(db);
  repo.upsert(row('dev_self00000000', me, { self: true }));
  const codes = openCodes(db, me, () => 1);
  const laptopCodes = openCodes(memoryDb(), laptop, () => 1);
  laptopCodes.company.sign(me.pub); // the old person code: the laptop was first and signed this PC
  codes.company.take(laptopCodes.company.tree(), laptop.pub);
  const tree = codes.company.tree();
  if (options.employer !== false) repo.upsert(row('dev_comp00000000', company, { joinedAs: 'employee' }));
  new KvRepo(db).set('company.employer', 'facts', { code: remoteIdOf(company.fingerprint) }, 1);
  return { db, me, laptop, codes, tree, kv: new KvRepo(db) };
}

test('an employee\'s PC: its own code tree becomes My ID, the company tree is cleared; a second run changes nothing', () => {
  const s = seat(170);
  assert.equal(moveSeatCode(s.db, 5), true);
  assert.deepEqual(s.kv.get('remote.me', 'tree'), s.tree, 'the tree moved as it was');
  assert.equal(s.kv.get('remote.code', 'tree'), undefined);
  assert.equal(moveSeatCode(s.db, 6), false, 'idempotent');
  assert.equal(openCodes(s.db, s.me, () => 1).me.code(), remoteIdOf(s.laptop.fingerprint), 'the person keeps the number they had');
});

test('left alone: a company\'s own PC, the company\'s tree, a tree of this PC alone (cleared, not moved), an existing me tree', () => {
  const own = seat(180, { employer: false });
  assert.equal(moveSeatCode(own.db, 5), false, 'a company\'s own PC');
  assert.deepEqual(own.kv.get('remote.code', 'tree'), own.tree);

  const companys = seat(190);
  companys.kv.set('company.employer', 'facts', { code: remoteIdOf(companys.laptop.fingerprint) }, 1);
  assert.equal(moveSeatCode(companys.db, 5), false, 'its tree is the company\'s');

  const alone = seat(200);
  alone.kv.set('remote.code', 'tree', { root: alone.me.pub, links: [] }, 1);
  assert.equal(moveSeatCode(alone.db, 5), true);
  assert.equal(alone.kv.get('remote.me', 'tree'), undefined, 'just its own device ID: nothing to keep');
  assert.equal(alone.kv.get('remote.code', 'tree'), undefined);

  // This PC was the root of its old code (it signed its laptop): kept as `me`, My ID would be its device ID.
  const root = seat(230);
  const laptop = keyOf(231);
  root.kv.set('remote.code', 'tree', { root: root.me.pub, links: [{ pub: laptop.pub, by: root.me.fingerprint, sig: b64url(root.me.sign(Buffer.from(`wf-code-v1|${laptop.fingerprint}`, 'utf8'))) }] }, 1);
  assert.equal(moveSeatCode(root.db, 5), true);
  assert.equal(root.kv.get('remote.me', 'tree'), undefined, 'a tree rooted at its own key is not kept as My ID');
  assert.equal(root.kv.get('remote.code', 'tree'), undefined);
  const myId = openCodes(root.db, root.me, () => 1).me.code();
  assert.notEqual(myId, remoteIdOf(root.me.fingerprint), 'a fresh me tree: My ID never equals the device ID');

  const both = seat(210);
  both.kv.set('remote.me', 'tree', { root: 'x', links: [] }, 1);
  assert.equal(moveSeatCode(both.db, 5), true);
  assert.deepEqual(both.kv.get('remote.me', 'tree'), { root: 'x', links: [] }, 'an existing me tree stays');
});

test('runEineId1122: trees opened already are read again; a failure is logged, not thrown', () => {
  const s = seat(220);
  const before = s.codes.company.code();
  runEineId1122({ db: s.db, clock: { now: () => 7 }, log: silentLog } as unknown as RuntimeServices);
  assert.equal(meFor(s.me.fingerprint)!.code(), before, 'My ID is the old number');
  assert.equal(s.codes.company.code(), remoteIdOf(s.me.fingerprint), 'the company tree waits for the company\'s chain');
  const warned: string[] = [];
  runEineId1122({ db: { get: () => { throw new Error('closed'); }, all: () => { throw new Error('closed'); } }, clock: { now: () => 7 }, log: { ...silentLog, warn: (line: string) => warned.push(line) } } as unknown as RuntimeServices);
  assert.deepEqual(warned, ['eine-id-1122 bridge failed']);
});
