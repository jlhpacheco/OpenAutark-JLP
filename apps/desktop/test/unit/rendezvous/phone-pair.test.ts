// B-078 (D5): the phone pairs like a PC – remote1…remote3 with role 'phone' and its own key, the same code on both
// screens, Accept on the PC (rendezvous/phone-pair.ts). The requester here is written the way the Android app does it
// (apps/android relay/RemotePair.java): only the public sas.ts / pair-proof.ts steps, JSON round trips in between.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh } from '../../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { b64url, fingerprintOf, fromB64url } from '../../../src/runtime/devices/keys.ts';
import { mac, macOk } from '../../../src/runtime/devices/pair-proof.ts';
import { isPhoneStep, RemoteWithPhones } from '../../../src/runtime/devices/rendezvous/phone-pair.ts';
import { phoneInfo, TargetRequests } from '../../../src/runtime/remote/requests.ts';
import { openCodes } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { phonePairLink } from '../../../src/shared/api/methods-phone.ts';
import { bytes, commitment, matchCode, newEphemeral, newNonce, sessionKey, signedBytes, transcript, verifySide } from '../../../src/runtime/remote/sas.ts';
import { PwaService } from '../../../src/runtime/pwa/service.ts';
import { PeopleRepo, cleanScopes } from '../../../src/runtime/people/repo.ts';
import { PersonTokens } from '../../../src/runtime/people/tokens.ts';
import type { RemoteDeps } from '../../../src/runtime/remote/service.ts';
import type { NewPerson, RemoteState } from '../../../src/shared/model/remote.ts';
import { HandTimers } from '../remote/rig.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function pcWithPhones(deps: Partial<RemoteDeps> = {}) {
  const db = memoryDb();
  const { bus, events } = recordingBus();
  const clock = new ManualClock();
  const timers = new HandTimers();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock, name: 'Desk' });
  const mesh = new DeviceMesh({ db, identity, clock, log: silentLog, bus, timers, dial: async () => { throw new Error('no network'); } });
  const settings = { get: () => ({ pwa: { enabled: false, bind: 'localhost' } }), update: () => undefined } as never;
  const push = { subscribedDevices: () => new Set<string>(), publicKey: async () => 'key', removeDevice: () => undefined } as never;
  const pwa = new PwaService({ db, clock, bus, log: silentLog, settings, push, port: () => 1, qr: async () => '', serveStatus: async () => undefined, interfaces: () => ({}) });
  const shown: unknown[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  const admitted: string[] = [];
  const remote = new RemoteWithPhones({
    ...deps,
    identity, clock, bus, log: silentLog, mesh, timers, findable: () => true,
    post: async () => { throw new Error('unused'); },
    notify: (view) => shown.push(view), linked: (note) => notes.push(note), admitted: (personId) => admitted.push(personId),
    pair: (phone) => pwa.pairPhone(phone),
  });
  return { remote, pwa, repo: new DevicesRepo(db), identity, events, shown, notes, mesh, db, clock, admitted };
}

/** The Android app's side of the exchange; `remoteId` the ID it asks for (RemotePair.java sends it as `target`). */
async function phoneAsks(target: { handle(body: Record<string, unknown>, from: { address?: string }): Promise<unknown> }, name = 'Pixel 8', remoteId?: string) {
  const key = await DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: new ManualClock(), name: 'phone' });
  const info = { id: `dev_${randomBytes(8).toString('hex')}`, name, role: 'client', pub: b64url(key.publicKey), addresses: [] as string[] };
  const eph = newEphemeral();
  const call = async (body: Record<string, unknown>) => json(await target.handle(json(body), { address: 'relay:phone' })) as Record<string, unknown>;
  const first = await call({ kind: 'remote1', v: 1, role: 'phone', device: info, eph: b64url(eph.pub), ...(remoteId ? { target: { remoteId } } : {}) });
  assert.equal(first.ok, true, JSON.stringify(first));
  const pc = first.device as { pub: string };
  const ephA = bytes(first.eph)!;
  const t = transcript({ a: first.device as never, b: info as never, ephA, ephB: eph.pub, commit: first.commit as string, role: 'phone' as never });
  const nb = newNonce();
  const second = await call({ kind: 'remote2', session: first.session, nb: b64url(nb), sig: b64url(key.sign(signedBytes('B', t))) });
  const na = bytes(second.na, 16)!;
  assert.equal(commitment(ephA, eph.pub, na), first.commit, 'the PC committed to its nonce first');
  assert.ok(verifySide(pc.pub, 'A', t, second.sig), 'the PC signed the transcript with its own key');
  const session = sessionKey(eph.privateKey, ephA, t);
  const wait = () => call({ kind: 'remote3', session: first.session, mac: mac(session, 'remote-wait', first.session) });
  return { info, code: matchCode(t, na, nb), wait, session, t, key, sessionId: first.session as string };
}

test('a phone pairs by Remote ID: same code on both screens, Accept on the PC, its token in the sealed answer', async () => {
  const pc = await pcWithPhones();
  const phone = await phoneAsks(pc.remote);
  const state = pc.remote.state() as RemoteState;
  assert.equal(state.incoming.length, 1);
  const request = state.incoming[0];
  assert.equal(request.role as string, 'phone');
  assert.equal(request.name, 'Pixel 8');
  assert.equal(request.code, phone.code, 'both screens show the same code');
  assert.equal(pc.shown.length, 1, 'one notification');
  assert.ok(pc.events.some((event) => event.event === 'remote.updated'), 'the list updates');

  const waiting = phone.wait();
  pc.remote.decide(request.id, true);
  const answer = await waiting;
  assert.equal(answer.status, 'accepted');
  assert.ok(macOk(mac(phone.session, 'remote-accept', answer.device, b64url(phone.t)), answer.mac), 'the acceptance is the PC\'s');
  assert.equal(typeof answer.token, 'string');
  assert.equal(answer.deviceId, phone.info.id);
  const record = pc.repo.get(phone.info.id)!;
  assert.equal(record.kind, 'phone');
  assert.equal(record.publicKey, phone.info.pub, 'pinned by its own key');
  assert.equal(record.fingerprint, fingerprintOf(fromB64url(phone.info.pub)));
  assert.equal(pc.pwa.authenticate(answer.token as string)?.kind, 'device', 'the token works without any phone switch');
  assert.deepEqual(pc.pwa.authenticate(answer.token as string) && (pc.pwa.authenticate(answer.token as string) as { capabilities: string[] }).capabilities.includes('permissions'), true);
  assert.equal(pc.notes.length, 1);
  assert.match(pc.notes[0].title, /Pixel 8 is now linked/);
  const again = await phone.wait();
  assert.equal(again.token, answer.token, 'a repeated wait gets the same answer');
  assert.equal(pc.mesh.list().filter((device) => device.kind === 'pc' && !device.self).length, 0, 'no PC link came of it');

  await pc.pwa.revoke(phone.info.id);
  assert.equal(pc.pwa.authenticate(answer.token as string), undefined, 'Remove ends the access');
});

const ANNA = 'per_anna000000001';
function addAnna(db: ReturnType<typeof memoryDb>): void {
  new PeopleRepo(db).save({ id: ANNA, name: 'Anna', title: '', avatar: { kind: 'initials', value: 'A' }, status: 'invited', owner: false, scopes: cleanScopes({}), createdAt: 0, updatedAt: 0 });
}

test('F1: a phone accepted for an employee gets that person\'s token and row, never my access', async () => {
  const pc = await pcWithPhones();
  addAnna(pc.db);
  const phone = await phoneAsks(pc.remote, 'Galaxy');
  const waiting = phone.wait();
  pc.remote.decide(pc.remote.state().incoming[0].id, true, ANNA);
  const answer = await waiting;
  assert.equal(answer.status, 'accepted');
  const token = answer.token as string;
  assert.equal(pc.pwa.authenticate(token), undefined, 'no device (owner phone) token');
  const tokens = new PersonTokens(pc.db, pc.clock);
  const scope = tokens.authenticate(token);
  assert.equal(scope?.personId, ANNA, 'the person token a join issues');
  assert.equal(scope?.deviceId, answer.deviceId, 'the phone gets the device id its token carries');
  const record = pc.repo.get(answer.deviceId as string)!;
  assert.equal(record.kind, 'phone');
  assert.equal(record.publicKey, phone.info.pub, 'pinned by its own key');
  assert.equal(JSON.parse((pc.db.get<{ allow: string }>('SELECT allow FROM devices WHERE id = ?', [record.id]))!.allow).personId, ANNA, 'the row carries the person');
  const anna = new PeopleRepo(pc.db).get(ANNA)!;
  assert.equal(anna.status, 'active');
  assert.equal(new PeopleRepo(pc.db).auditOf(ANNA)[0].action, 'joined');
  assert.match(pc.notes[0].title, /Galaxy is now linked as Anna's phone/);
  assert.deepEqual(pc.admitted, [ANNA], 'the personal manager hears once, as for an employee\'s PC');
  assert.deepEqual(tokens.devices(ANNA).map((entry) => entry.id), [answer.deviceId], 'Team › People lists it');

  await pc.pwa.revoke(answer.deviceId as string);
  assert.equal(tokens.authenticate(token), undefined, 'Remove in Settings › Devices ends the person token too');
});

test('F1: Me (no person) keeps the phone mine; re-pairing a key for a person ends its earlier access here', async () => {
  const pc = await pcWithPhones();
  addAnna(pc.db);
  const mine = await phoneAsks(pc.remote, 'Pixel');
  const first = mine.wait();
  pc.remote.decide(pc.remote.state().incoming[0].id, true);
  const own = await first;
  assert.equal(pc.pwa.authenticate(own.token as string)?.kind, 'device', 'my own phone as today');
  assert.match(pc.notes[0].title, /Pixel is now linked$/);
  assert.deepEqual(pc.admitted, []);

  const issued = pc.pwa.pairPhone({ id: mine.info.id, name: 'Pixel', publicKey: mine.info.pub, personId: ANNA });
  assert.equal(issued.person, 'Anna');
  assert.notEqual(issued.deviceId, mine.info.id);
  assert.equal(pc.pwa.authenticate(own.token as string), undefined, 'the earlier owner token of that key ended');
  assert.ok(pc.repo.get(mine.info.id)?.revokedAt, 'its earlier row is removed');
  assert.equal(pc.repo.byFingerprint(fingerprintOf(fromB64url(mine.info.pub)))?.id, issued.deviceId, 'one live row per key');
  assert.equal(pc.pwa.pairPhone({ id: 'dev_phonepair09', name: 'Mine', publicKey: b64url(Buffer.alloc(32, 4)), personId: 'human' }).person, undefined, 'the owner as person = my phone');
  assert.throws(() => pc.pwa.pairPhone({ id: 'dev_phonepair10', name: 'X', publicKey: b64url(Buffer.alloc(32, 5)), personId: 'per_gone000000001' }), (error: { code?: string }) => error.code === 'forbidden');
});

test('F13: a phone accepted for a new person makes that person once, and the phone gets only their token', async () => {
  const made: NewPerson[] = [];
  let db: ReturnType<typeof memoryDb> | undefined;
  const pc = await pcWithPhones({ createPerson: (input) => { made.push(input); addAnna(db!); return ANNA; } });
  db = pc.db;
  const phone = await phoneAsks(pc.remote, 'Galaxy');
  const [request] = pc.remote.state().incoming;
  const waiting = phone.wait();
  pc.remote.decide(request.id, true, undefined, { name: 'Anna' });
  assert.deepEqual(made, [], 'nobody is made before the phone collects its answer');
  const answer = await waiting;
  assert.equal(answer.status, 'accepted');
  assert.deepEqual(made, [{ name: 'Anna' }]);
  const token = answer.token as string;
  assert.equal(pc.pwa.authenticate(token), undefined, 'never my access');
  assert.equal(new PersonTokens(pc.db, pc.clock).authenticate(token)?.personId, ANNA, 'the person token');
  assert.equal(new PeopleRepo(pc.db).get(ANNA)?.status, 'active', 'she is in now');
  assert.deepEqual(pc.admitted, [ANNA]);
  await phone.wait();
  assert.equal(made.length, 1, 'a repeated wait makes nobody again');
});

test('a declined phone gets no token; a wrong session key cannot collect the answer', async () => {
  const pc = await pcWithPhones();
  const phone = await phoneAsks(pc.remote);
  const forged = await pc.remote.handle({ kind: 'remote3', session: phone.sessionId, mac: 'x'.repeat(43) }, { address: 'relay:x' });
  assert.deepEqual(forged, { ok: true, status: 'expired' });
  const waiting = phone.wait();
  pc.remote.decide(pc.remote.state().incoming[0].id, false);
  const answer = await waiting;
  assert.equal(answer.status, 'declined');
  assert.equal(answer.token, undefined);
  assert.equal(pc.repo.get(phone.info.id), undefined);
});

// Two IDs, 24.11.2026 (owner: "ein QR-Code einfach neben My ID … Das Handy kann ja auch einfach den Code nehmen"): the QR
// beside My ID carries this PC's own Remote ID (phone.pairLink, F17), the digits shown are My ID – a phone that scans and a
// phone that types both end in a request to accept here, as my phone; a number that is neither is refused.
test('two IDs: a phone asking by the QR\'s Remote ID or by the My ID typed shows here to accept; another number is refused', async () => {
  const pc = await pcWithPhones();
  const myId = openCodes(pc.db, pc.identity, () => 1).me.code();
  const qrId = remoteIdOf(pc.identity.fingerprint);
  assert.notEqual(myId, qrId, 'My ID is not the number inside the QR');
  assert.equal(phonePairLink(qrId), `https://openautark.com/pair/#${qrId}`, 'the QR the Android app reads since 0.3.x');
  for (const [asked, name] of [[qrId, 'Scanned'], [myId, 'Typed']] as const) {
    const phone = await phoneAsks(pc.remote, name, asked);
    const request = pc.remote.state().incoming.find((entry) => entry.name === name)!;
    assert.equal(request.role as string, 'phone', `${name}: a phone request, whichever ID it asked`);
    assert.equal(request.code, phone.code);
    const waiting = phone.wait();
    pc.remote.decide(request.id, true);
    const answer = await waiting;
    assert.equal(answer.status, 'accepted', name);
    assert.equal(pc.repo.get(phone.info.id)?.kind, 'phone', `${name}: linked as my phone`);
    assert.equal(pc.pwa.authenticate(answer.token as string)?.kind, 'device');
  }
  const key = await DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: new ManualClock(), name: 'stranger' });
  const stranger = { id: 'dev_stranger000001', name: 'Other', role: 'client', pub: b64url(key.publicKey), addresses: [] };
  const wrong = String((Number(myId) + 1) % 1e9).padStart(9, '0');
  const refused = await pc.remote.handle({ kind: 'remote1', v: 1, role: 'phone', device: stranger, eph: b64url(newEphemeral().pub), target: { remoteId: wrong } }, { address: 'relay:x' });
  assert.equal(refused.ok, false, 'not an ID of this PC');
  assert.equal(pc.remote.state().incoming.length, 0);
});

test('PC requests never take the phone role and phone requests never become PC links', async () => {
  const plain = new TargetRequests({
    now: () => 0, timers: new HandTimers(), log: silentLog, signer: { sign: () => Buffer.alloc(64) }, findable: () => true,
    self: () => ({ id: 'dev_self000000', name: 'PC', role: 'home', pub: b64url(Buffer.alloc(32, 1)), addresses: [] }), link: () => undefined, shown: () => undefined, changed: () => undefined,
  });
  const reply = await plain.handle({ kind: 'remote1', v: 1, role: 'phone', device: {}, eph: b64url(Buffer.alloc(32, 2)) }, {});
  assert.equal(reply.ok, false);
  assert.equal(isPhoneStep({ kind: 'remote1', role: 'phone' }, { owns: () => false }), true);
  assert.equal(isPhoneStep({ kind: 'remote1', role: 'ceo' }, { owns: () => true }), false);
  assert.equal(isPhoneStep({ kind: 'remote2', session: 's' }, { owns: (session) => session === 's' }), true);
  assert.equal(phoneInfo({ id: 'dev_abcdefghij', name: ' Pixel ', role: 'client', pub: b64url(Buffer.alloc(32, 3)), addresses: ['http://x'] })?.addresses.length, 0);
  assert.equal(phoneInfo({ id: 'dev_abcdefghij', name: 'Pixel', role: 'home', pub: b64url(Buffer.alloc(32, 3)) }), undefined);
});
