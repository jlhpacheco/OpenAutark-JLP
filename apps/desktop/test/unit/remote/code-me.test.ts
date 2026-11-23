// Eine-ID 22.11.2026 (remote/code.ts): the me tree (My ID) starts on first use only, with a fresh root whose private key
// is never stored, stays the same across a restart, is found by meFor; a PC not started yet joins the tree that signed it
// without a root of its own; two me trees with several PCs meet at the smaller root; a removed PC drops out. The company
// tree of an employee's PC is only the chain its company handed it (adoptChain), signs nobody, takes no tree and is
// cleared when it leaves; chainsOf/chainCode give what the hello and the nearby list carry.
// Owns: these assertions only. Never: a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { Db } from '../../../src/runtime/db/database.ts';
import { b64url, fingerprintOf } from '../../../src/runtime/devices/keys.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { belongs, chainCode, chainIn, chainsOf, codeFor, meFor, openCodes, watchCode, type CodeKey } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { memoryDb } from '../devices/fakes.ts';

function keyOf(seed: number): CodeKey & { pub: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(der.subarray(der.length - 32));
  return { publicKey, fingerprint: fingerprintOf(publicKey), pub: b64url(publicKey), sign: (data) => sign(null, data, privateKey) };
}
const open = (key: CodeKey, db: Db = memoryDb()) => ({ db, ...openCodes(db, key, () => 1) });
const pcRow = (key: { pub: string; fingerprint: string }, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id: `dev_${key.fingerprint.slice(0, 12)}`, name: 'PC', kind: 'pc', role: 'home', fingerprint: key.fingerprint, publicKey: key.pub, addresses: [], caps: {},
  status: 'online', self: false, pairedAt: 1, ...extra,
});

test('the me tree starts on first use only: a fresh root signs me, its private key is never stored, a restart keeps the ID', () => {
  const A = keyOf(120);
  const a = open(A);
  const kv = new KvRepo(a.db);
  let fired = 0;
  const off = watchCode(A.fingerprint, () => { fired++; });
  assert.equal(kv.get('remote.me', 'tree'), undefined, 'nothing at open');
  assert.equal(meFor(A.fingerprint), a.me);
  const myId = a.me.code();
  const stored = kv.get<{ root: string; links: Array<{ pub: string; sig: string; by: string }> }>('remote.me', 'tree');
  assert.ok(stored, 'made on first use and stored at once');
  assert.deepEqual(Object.keys(stored).sort(), ['links', 'root'], 'only public keys and signatures');
  assert.equal(stored.links.length, 1);
  assert.equal(stored.links[0].pub, A.pub, 'I am its first member');
  assert.equal(stored.links[0].by, fingerprintOf(Buffer.from(stored.root, 'base64url')), 'signed by the fresh root');
  assert.notEqual(stored.root, A.pub, 'the root is not my device key');
  assert.notEqual(myId, remoteIdOf(A.fingerprint), 'My ID is not my device ID');
  assert.notEqual(myId, a.company.code(), 'nor the Company ID');
  assert.equal(belongs(myId, A.fingerprint, a.me.chain()), true, 'my chain proves it');
  assert.equal(fired, 0, 'the start itself tells nobody (the caller reads it)');
  assert.equal(open(A, a.db).me.code(), myId, 'a restart keeps it');
  assert.notEqual(open(keyOf(121)).me.code(), myId, 'another PC starts its own');
  off();
});

test('a PC signed into my me tree joins it without a root of its own; two trees with several PCs meet at the smaller root', () => {
  const [A, B, C, D] = [keyOf(122), keyOf(123), keyOf(124), keyOf(125)];
  const a = open(A);
  assert.equal(a.me.sign(B.pub), true);
  const b = open(B);
  assert.equal(b.me.take(a.me.tree(), A.pub), true);
  assert.equal(b.me.code(), a.me.code(), 'B shows my number');
  assert.deepEqual(new KvRepo(b.db).get('remote.me', 'tree'), a.me.tree(), 'and made no root of its own');

  const c = open(C);
  c.me.sign(D.pub); // a second pair of PCs with its own number
  const [small, large] = [a, c].sort((x, y) => (fingerprintOf(Buffer.from(x.me.tree().root, 'base64url')) < fingerprintOf(Buffer.from(y.me.tree().root, 'base64url')) ? -1 : 1));
  const [smallKey, largeKey] = small === a ? [A, C] : [C, A];
  assert.equal(large.me.take(small.me.tree(), smallKey.pub), false, 'the larger cannot adopt a tree without it');
  assert.equal(small.me.take(large.me.tree(), largeKey.pub), true, 'the smaller root signs the sender');
  assert.equal(large.me.take(small.me.tree(), smallKey.pub), true, 'the larger adopts');
  assert.equal(large.me.code(), small.me.code());

  const e = open(keyOf(126));
  e.me.code(); // its own tree started (alone)
  assert.equal(e.me.take(a.me.tree(), A.pub), false, 'a tree without E brings E nothing');
  assert.equal(a.me.take(e.me.tree(), keyOf(126).pub), true, 'a PC alone never outranks a tree of several: I sign it');
  assert.equal(e.me.take(a.me.tree(), A.pub), true);
  assert.equal(e.me.code(), a.me.code(), 'it takes my number, mine stays');
});

test('a removed PC drops out of the me tree, and the tree tells its watchers', () => {
  const [A, B] = [keyOf(127), keyOf(128)];
  const a = open(A);
  a.me.sign(B.pub);
  assert.equal(a.me.tree().links.length, 2);
  let fired = 0;
  const off = watchCode(A.fingerprint, () => { fired++; });
  new DevicesRepo(a.db).upsert(pcRow(B, { status: 'revoked', revokedAt: 2 }));
  a.me.refresh();
  assert.equal(a.me.tree().links.length, 1, 'B is out');
  assert.equal(fired, 1);
  a.me.refresh();
  assert.equal(fired, 1, 'no change, no call');
  off();
});

test('an employee\'s PC: its company tree is only the chain its company handed it, and it goes when the PC leaves', () => {
  const [COMPANY, SEAT, OTHER, NEW] = [keyOf(130), keyOf(131), keyOf(132), keyOf(133)];
  const company = open(COMPANY);
  assert.equal(company.company.sign(SEAT.pub), true);
  const chain = chainIn(company.company.tree(), SEAT.fingerprint);
  const seat = open(SEAT);
  new DevicesRepo(seat.db).upsert(pcRow(COMPANY, { joinedAs: 'employee' }));
  assert.equal(seat.company.code(), remoteIdOf(SEAT.fingerprint), 'before the chain: its own ID');
  assert.equal(seat.company.adoptChain(chainIn(company.company.tree(), COMPANY.fingerprint)), false, 'a chain ending at another key');
  assert.equal(seat.company.adoptChain({ root: COMPANY.pub, links: [{ pub: SEAT.pub, sig: chain!.links[0].sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }] }), false, 'a forged one');
  assert.equal(seat.me.adoptChain(chain), false, 'only the company tree adopts a chain');
  assert.equal(seat.company.adoptChain(chain), true);
  assert.equal(seat.company.adoptChain(chain), false, 'once');
  assert.equal(seat.company.code(), company.company.code(), 'the Company ID');
  assert.equal(belongs(company.company.code(), SEAT.fingerprint, seat.company.chain()), true);
  assert.equal(seat.company.sign(NEW.pub), false, 'it signs nobody into the company tree');
  assert.equal(seat.company.signMissing([NEW.pub]), false);
  assert.equal(seat.company.take(open(OTHER).company.tree(), OTHER.pub), false, 'and takes no tree from a roster');
  assert.equal(seat.me.sign(NEW.pub), true, 'its me tree is its own');
  assert.equal(open(SEAT, seat.db).company.code(), company.company.code(), 'kept across a restart');

  assert.equal(seat.company.clear(), true, 'the last employer link went');
  assert.equal(seat.company.code(), remoteIdOf(SEAT.fingerprint), 'its own company again');
  assert.equal(seat.company.clear(), false, 'nothing left to clear');
});

test('chainsOf: the company chain only off the root, the me chain once started; chainCode names the ID a chain proves', () => {
  const [ROOT, MEMBER] = [keyOf(134), keyOf(135)];
  const root = open(ROOT);
  assert.equal(codeFor(ROOT.fingerprint), root.company);
  const rootChains = chainsOf(ROOT.fingerprint);
  assert.equal(rootChains.chain, undefined, 'the company root answers with its own ID');
  assert.deepEqual(rootChains.me, root.me.chain(), 'my me chain (started here)');
  root.company.sign(MEMBER.pub);
  const member = open(MEMBER);
  member.company.take(root.company.tree(), ROOT.pub);
  const memberChains = chainsOf(MEMBER.fingerprint);
  assert.equal(chainCode(memberChains.chain, MEMBER.fingerprint), root.company.code());
  assert.equal(chainCode(memberChains.me, MEMBER.fingerprint), member.me.code());
  assert.equal(chainCode(memberChains.chain, ROOT.fingerprint), undefined, 'it ends at the member');
  assert.equal(chainCode(undefined, MEMBER.fingerprint), undefined);
  assert.deepEqual(chainsOf('0'.repeat(64)), {}, 'nothing opened');
});
