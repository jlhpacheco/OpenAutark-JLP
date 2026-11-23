// B-084 person code in the roster (devices/sync/roster.ts + remote/code.ts): my two PCs that were linked before the code
// existed converge to one code; a PC that joined through my second PC shows my first PC's code and my first PC learns
// it as a member; an employee's PC never brings or takes a code. Eine-ID 22.11.2026: My ID (the me tree) travels over
// my own devices – a PC joined by My ID takes the number of the PC that signed it, even when its own tree started first;
// a seat and its laptop share My ID but never swap company trees (theirs comes from the company).
// Owns: these assertions only. Never: a real mesh or keychain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { b64url, fingerprintOf } from '../../../src/runtime/devices/keys.ts';
import type { PeerInfo } from '../../../src/runtime/devices/pair-proof.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { RosterSync, ROSTER_METHOD } from '../../../src/runtime/devices/sync/roster.ts';
import { belongs, chainIn, openCodes, type CodeTree } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { makePc, Net, settle } from './sync-net.ts';

const id = (name: string) => `dev_${name.padEnd(12, '0')}`;

function keyOf(seed: number) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(der.subarray(der.length - 32));
  return { publicKey, fingerprint: fingerprintOf(publicKey), pub: b64url(publicKey), sign: (data: Uint8Array) => sign(null, data, privateKey) };
}

function pc(net: Net, name: string, seed: number) {
  const p = makePc(net, id(name));
  const key = keyOf(seed);
  p.repo.patch(p.id, { publicKey: key.pub, fingerprint: key.fingerprint, name });
  (p.h.services as unknown as { host: object }).host = {
    ...(p.h.services.host as object),
    encrypt: async (plain: string) => new TextEncoder().encode(plain), decrypt: async (cipher: Uint8Array) => new TextDecoder().decode(cipher),
  };
  const mesh = {
    register: (method: string, handler: (params: unknown, from: string) => Promise<unknown>) => { p.handlers.set(method, handler); },
    add: (info: PeerInfo, options: { personId?: string; joinedAs?: 'ceo' | 'employee' }) => {
      p.repo.upsert(row(info.id, info.pub, { ...(options.personId ? { personId: options.personId } : {}), ...(options.joinedAs ? { joinedAs: options.joinedAs } : {}) }));
      return p.repo.get(info.id)!;
    },
    revoke: () => undefined,
    selfInfo: (): PeerInfo => ({ id: p.id, name, role: 'home', pub: key.pub, addresses: [] }),
  };
  const roster = new RosterSync(p.h.services, mesh as never, 0);
  const codes = openCodes(p.h.db, key, () => p.h.clock.now());
  const code: CodeTree = codes.company;
  const me: CodeTree = codes.me;
  return { ...p, key, roster, code, me };
}
type Box = ReturnType<typeof pc>;

function row(deviceId: string, pub: string, extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return { id: deviceId, name: deviceId.slice(4, 9), kind: 'pc', role: 'home', fingerprint: fingerprintOf(Buffer.from(pub, 'base64url')), publicKey: pub, addresses: [], caps: {}, status: 'online', self: false, pairedAt: 100, ...extra };
}

/** `b` is my own PC of `a`, both ways; `person`: b is that person's PC here instead. */
function linkUp(a: Box, b: Box, person?: string): void {
  a.repo.upsert(row(b.id, b.key.pub, person ? { personId: person } : {}));
  b.repo.upsert(row(a.id, a.key.pub, { joinedAs: person ? 'employee' : 'ceo' }));
}

test('my two PCs from before the code meet at one code; a third PC joined through the second shows it as well', async () => {
  const net = new Net();
  const one = pc(net, 'one', 61);
  const two = pc(net, 'two', 62);
  linkUp(one, two);
  await Promise.all([one.roster.linkUp(two.id), two.roster.linkUp(one.id)]);
  await settle();
  const smaller = [one, two].sort((x, y) => (x.key.fingerprint < y.key.fingerprint ? -1 : 1))[0];
  assert.equal(one.code.code(), two.code.code(), 'one code for both');
  assert.equal(one.code.code(), remoteIdOf(smaller.key.fingerprint), 'the smaller root fingerprint wins');

  // PC3 is accepted on PC2 (remote/service.ts signs it) and joins through PC2 only.
  const three = pc(net, 'three', 63);
  two.repo.upsert(row(three.id, three.key.pub));
  three.repo.upsert(row(two.id, two.key.pub, { joinedAs: 'ceo' }));
  assert.equal(two.code.sign(three.key.pub), true);
  await two.roster.linkUp(three.id);
  await settle();
  assert.equal(three.code.code(), one.code.code(), 'PC3 shows the same code');
  assert.equal(belongs(one.code.code(), three.key.fingerprint, three.code.chain()), true, 'and proves it');
  await two.roster.flush(); // PC2's device.upserted flush (attach() is not wired in this rig)
  await settle();
  assert.ok(one.repo.get(three.id), 'PC1 learned PC3 from PC2');
  assert.ok(one.code.tree().links.some((entry) => entry.pub === three.key.pub), 'and PC3 as a member of the code');
});

test('an employee\'s PC never brings or takes my code', async () => {
  const net = new Net();
  const boss = pc(net, 'boss', 71);
  const lena = pc(net, 'lena', 72);
  const ceoCode = boss.code.code();
  boss.code.sign(keyOf(73).pub); // the boss has a code with members
  linkUp(boss, lena, 'per_lena000001');
  await Promise.all([boss.roster.linkUp(lena.id), lena.roster.linkUp(boss.id)]);
  await settle();
  assert.equal(net.calls.filter((call) => call.method === ROSTER_METHOD).length, 0, 'no roster over employer/employee links');
  assert.equal(lena.code.code(), remoteIdOf(lena.key.fingerprint), 'no company tree from the boss through a roster');
  assert.equal(boss.code.code(), ceoCode);
});

test('My ID: a PC joined by My ID takes the number of the PC that signed it – also when its own me tree started first', async () => {
  for (const startFirst of [false, true]) {
    const net = new Net();
    const desk = pc(net, `desk${Number(startFirst)}`, 81 + Number(startFirst) * 10);
    const laptop = pc(net, `lapt${Number(startFirst)}`, 82 + Number(startFirst) * 10);
    const myId = desk.me.code();
    const companyId = desk.code.code();
    linkUp(desk, laptop);
    assert.equal(desk.me.sign(laptop.key.pub), true, 'the desk signs the laptop into My ID (remote/service.ts at Accept)');
    assert.equal(desk.code.sign(laptop.key.pub), true, 'and into the company – both are the company\'s own PCs');
    if (startFirst) assert.notEqual(laptop.me.code(), myId, 'the laptop made a me tree of its own before the roster came');
    await Promise.all([desk.roster.linkUp(laptop.id), laptop.roster.linkUp(desk.id)]);
    await settle();
    await Promise.all([desk.roster.flush(), laptop.roster.flush()]);
    await settle();
    assert.equal(laptop.me.code(), myId, 'the laptop shows the desk\'s My ID');
    assert.equal(desk.me.code(), myId, 'the desk keeps its number');
    assert.equal(belongs(myId, laptop.key.fingerprint, laptop.me.chain()), true, 'and proves it');
    assert.equal(laptop.code.code(), companyId, 'the Company ID came along');
    assert.notEqual(myId, companyId);
  }
});

test('a seat and its laptop share My ID; the company tree never travels between them', async () => {
  const net = new Net();
  const company = pc(net, 'comp', 101);
  const seat = pc(net, 'seat', 102);
  const laptop = pc(net, 'lapx', 103);
  seat.repo.upsert(row(company.id, company.key.pub, { joinedAs: 'employee' }));
  laptop.repo.upsert(row(company.id, company.key.pub, { joinedAs: 'employee' })); // the seat's roster brought it
  company.code.sign(seat.key.pub);
  assert.equal(seat.code.adoptChain(chainIn(company.code.tree(), seat.key.fingerprint)), true, 'the company\'s chain (company.facts)');
  assert.equal(seat.code.code(), company.code.code());
  linkUp(seat, laptop);
  seat.me.sign(laptop.key.pub);
  await Promise.all([seat.roster.linkUp(laptop.id), laptop.roster.linkUp(seat.id)]);
  await settle();
  const rosters = net.calls.filter((call) => call.method === ROSTER_METHOD).map((call) => call.params as { code?: unknown; me?: unknown });
  assert.ok(rosters.length >= 2);
  assert.ok(rosters.every((roster) => roster.code === undefined && roster.me !== undefined), 'My ID goes, the company tree stays home');
  assert.equal(laptop.me.code(), seat.me.code(), 'one My ID');
  assert.equal(laptop.code.code(), remoteIdOf(laptop.key.fingerprint), 'the laptop\'s company chain comes from the company only');
  assert.equal(laptop.code.take(seat.code.tree(), seat.key.pub), false, 'a PC with an employer takes no company tree');
  assert.equal(laptop.code.sign(keyOf(104).pub), false, 'and signs nobody into it');
});
