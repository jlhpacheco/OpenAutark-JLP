// PCs on this network for Settings › Devices (remote/nearby.ts and RemoteService.nearby): the LAN hello
// answers merge into one entry per device and key (an impostor never hides the real PC), this PC and
// answers whose Remote ID is not their key's are left out, names are plain text, the marks follow
// links and this PC's own request; the last answer is reused for a minute, Refresh asks again, one
// search at a time. In the rig a PC answers hello only while it accepts requests, Connect with the
// Remote ID reaches it, and after Accept it is 'linked'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../../../src/runtime/devices/discovery.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { NEARBY_FRESH_MS, NearbyPcs, markNearby, mergeNearby } from '../../../src/runtime/remote/nearby.ts';
import type { RemoteOutgoing } from '../../../src/shared/model/remote.ts';
import { Lan, linkedIds, settle } from './rig.ts';
import { chainTo, keyOf } from './chain-keys.ts';

const hex = (digit: string) => digit.repeat(64);
const SELF = { deviceId: 'dev_ssssssssssss', fingerprint: hex('5') };
const pc = (name: string, digit: string, address: string, extra: Partial<Candidate> = {}): Candidate => ({
  deviceId: `dev_${digit.repeat(12)}`, name, fingerprint: hex(digit), addresses: [address], remoteId: remoteIdOf(hex(digit)), ...extra,
});

test('mergeNearby: one entry per device and key, this PC and wrong Remote IDs left out, plain names, sorted', () => {
  const studio = pc('Studio', 'a', 'http://192.168.1.20:47812');
  const again = pc('Studio', 'a', 'http://192.168.1.21:47812');
  const impostor = pc('Studio', 'b', 'http://192.168.1.66:47812', { deviceId: studio.deviceId });
  const liar = pc('Liar', 'c', 'http://192.168.1.7:47812', { remoteId: '000000000' });
  const self = pc('Me', '5', 'http://192.168.1.2:47812', { deviceId: SELF.deviceId });
  const tower = pc('‮Tower<b>', 'd', 'http://192.168.1.9:47812');
  const found = mergeNearby([impostor, studio, liar, self, again, tower], SELF);
  assert.deepEqual(found.map((entry) => [entry.name, entry.fingerprint[0]]), [['Studio', 'a'], ['Studio', 'b'], ['Towerb', 'd']].sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])).map((entry) => entry), 'the impostor is a second entry');
  assert.deepEqual(found.find((entry) => entry.fingerprint === hex('a'))?.addresses, ['http://192.168.1.20:47812', 'http://192.168.1.21:47812'], 'addresses merged');
});

test('markNearby: linked by device id and key, waiting only for the PC this PC asked', () => {
  const [a, b, c] = mergeNearby([pc('A', 'a', 'http://10.0.0.1:1'), pc('B', 'b', 'http://10.0.0.2:1'), pc('C', 'c', 'http://10.0.0.3:1')], SELF);
  const linked = [{ id: a.deviceId, fingerprint: a.fingerprint, status: 'online' }, { id: c.deviceId, fingerprint: hex('9'), status: 'online' }, { id: SELF.deviceId, fingerprint: SELF.fingerprint, status: 'online', self: true }];
  const out = (status: RemoteOutgoing['status'], target = b): RemoteOutgoing => ({ id: 'rr', role: 'ceo', deviceId: target.deviceId, name: target.name, remoteId: target.remoteId, fingerprint: target.fingerprint, code: '1234', status, expiresAt: 1 });
  assert.deepEqual(markNearby([a, b, c], linked, out('waiting')).map((entry) => entry.state), ['linked', 'waiting', 'new'], 'another key under a linked id stays new');
  assert.deepEqual(markNearby([a, b, c], linked, out('declined')).map((entry) => entry.state), ['linked', 'new', 'new']);
  assert.deepEqual(markNearby([a, b, c], [{ ...linked[0], status: 'revoked' }], out('accepted')).map((entry) => entry.state), ['new', 'new', 'new']);
  assert.deepEqual(markNearby([b], [], { ...out('waiting'), fingerprint: hex('e') }).map((entry) => entry.state), ['new'], 'a request to another key of that id');
});

test('NearbyPcs: the last answer for a minute, Refresh asks again, one search at a time, a failing source is empty', async () => {
  let now = 1_000;
  let asked = 0;
  let release: () => void = () => undefined;
  const near = new NearbyPcs({
    self: SELF, now: () => now, linked: () => [], outgoing: () => undefined,
    lan: async () => { asked++; await new Promise<void>((resolve) => { release = resolve; }); return [pc('Studio', 'a', 'http://10.0.0.1:1')]; },
  });
  const first = near.list();
  const second = near.list(true);
  await settle();
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(asked, 1, 'one search for both callers');
  assert.deepEqual(one.map((entry) => entry.name), ['Studio']);
  assert.deepEqual(two, one);
  await near.list();
  assert.equal(asked, 1, 'fresh: the last answer');
  now += NEARBY_FRESH_MS;
  const again = near.list();
  await settle();
  release();
  await again;
  assert.equal(asked, 2, 'older than a minute: asked again');
  const refreshed = near.list(true);
  await settle();
  release();
  await refreshed;
  assert.equal(asked, 3, 'Refresh always asks');
});

test('RemoteService.nearby: only PCs that accept requests answer; Connect by its Company ID (a new member, named at Accept); Accept marks it linked', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812', { deps: { createPerson: () => 'per_tower00001' } }); // Accept makes the new member
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  const hidden = await lan.add('Hidden', 'http://10.0.0.3:47812', { findable: false });
  assert.equal(hidden.hello, undefined, 'a PC that does not accept requests answers no hello');
  const hello = laptop.hello!();
  assert.deepEqual(Object.keys(hello!).sort(), ['addresses', 'deviceId', 'fingerprint', 'name', 'remoteId'], 'the public identity and the Remote ID only');
  assert.equal(hello!.remoteId, laptop.remote.remoteId());

  const found = await tower.remote.nearby();
  assert.deepEqual(found.map((entry) => [entry.name, entry.state]), [['Laptop', 'new']], 'this PC and the hidden PC are not listed');
  const [pick] = found;
  assert.equal(pick.companyId, pick.remoteId, 'a company root: its Company ID is its own Remote ID');
  const out = await tower.remote.connect({ target: pick.companyId! });
  assert.deepEqual((await tower.remote.nearby()).map((entry) => entry.state), ['waiting'], 'the cached list is marked again');
  const [incoming] = laptop.remote.state().incoming;
  assert.equal(incoming.code, out.code, 'the same code as ever');
  laptop.remote.decide(incoming.id, true, undefined, { name: 'Tower person' }); // a new member needs a name
  await settle();
  assert.deepEqual(linkedIds(tower), [laptop.identity.deviceId]);
  assert.deepEqual((await tower.remote.nearby()).map((entry) => entry.state), ['linked']);

  laptop.findable = false;
  laptop.remote.refresh();
  assert.equal(laptop.hello, undefined, 'turning requests off ends the hello answers');
  assert.deepEqual(await tower.remote.nearby(true), [], 'Refresh asks the network again');
});

test('F09: each company of a PC answers with its name and own Remote ID; names are plain text; an older answer has none', async () => {
  const lan = new Lan();
  const first = await lan.add('Server', 'http://10.0.0.1:47812', { deps: { company: () => '  Teydra Lab  ' } });
  const second = await lan.add('Server', 'http://10.0.0.1:63140', { deps: { company: () => 'Teydra <b>Lab</b> 2' } });
  await lan.add('Old', 'http://10.0.0.7:47812');
  const broken = await lan.add('Broken', 'http://10.0.0.8:47812', { deps: { company: () => { throw new Error('no settings'); } } });
  const notebook = await lan.add('Notebook', 'http://10.0.0.2:47812');
  assert.equal(first.hello!()?.company, 'Teydra Lab', 'trimmed');
  assert.equal(broken.hello!()?.company, undefined, 'a failing name leaves the answer without it');
  const found = await notebook.remote.nearby();
  const byId = new Map(found.map((entry) => [entry.remoteId, entry]));
  assert.equal(byId.get(first.remote.remoteId())?.company, 'Teydra Lab');
  assert.equal(byId.get(second.remote.remoteId())?.company, 'Teydra bLabb 2', 'plain text, as names are');
  assert.equal(found.find((entry) => entry.name === 'Old')?.company, undefined);
  assert.notEqual(first.remote.remoteId(), second.remote.remoteId(), 'each company is its own key');
  assert.deepEqual(mergeNearby([pc('Studio', 'a', 'http://10.0.0.1:1', { company: 'x'.repeat(81) })], SELF)[0].company, 'x'.repeat(80), 'never longer than a hello carries');
});

test('Eine-ID: each nearby PC names its Company ID – the one its company chain proves, else its own Remote ID', () => {
  const [company, member, lone] = [keyOf(160), keyOf(161), keyOf(162)];
  const row = (key: typeof member, name: string, extra: Partial<Candidate> = {}): Candidate => ({
    deviceId: `dev_${key.fingerprint.slice(0, 12)}`, name, fingerprint: key.fingerprint, addresses: ['http://10.0.0.9:47812'], remoteId: remoteIdOf(key.fingerprint), ...extra,
  });
  const found = mergeNearby([row(member, 'Seat', { chain: chainTo(company, member), me: chainTo(lone, member) }), row(lone, 'Alone')], SELF);
  assert.equal(found.find((entry) => entry.name === 'Seat')?.companyId, remoteIdOf(company.fingerprint), 'the company chain decides, not `me`');
  assert.equal(found.find((entry) => entry.name === 'Alone')?.companyId, remoteIdOf(lone.fingerprint), 'a company root: its own ID');
});
