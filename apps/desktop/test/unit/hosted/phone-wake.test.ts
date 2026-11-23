// W (19.11.2026): a phone wakes a PC whose app is closed by itself – no PC online – through the real meeting server
// (services/remote-relay via rendezvous/rig.ts): the PC's wake file pins my own phones (wake.ts wakeFileFor), the real
// wake helper (sleeper.ts on the `ws` socket) waits there, and the iPhone web app's code (ui/hosted relay.ts + wake.ts on
// Node's WebSocket and WebCrypto) finds it and sends the wake signed with the phone's own key – checkWake takes it, the
// app starts; a phone the PC does not pin is refused. The signed text is pinned by a vector the Android app's
// relay/Wake.java checks too (apps/android/test/relay/WakeTest.java).
// Owns: these assertions. Never: a real phone, Electron or the network beyond loopback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import WebSocket from 'ws';
import { b64url, exportPrivate, generateEd25519, rawPublic } from '../../../src/runtime/devices/keys.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { Sleeper } from '../../../src/runtime/devices/sleeper.ts';
import { checkWake, signWake, wakeFpOf } from '../../../src/runtime/devices/wake-sign.ts';
import { wakeFileFor } from '../../../src/runtime/devices/wake.ts';
import { wakeText } from '../../../src/shared/model/wake.ts';
import { fingerprint, newDeviceKey, remoteIdOf, type DeviceKey } from '../../../src/ui/hosted/crypto.ts';
import { RelayLink, type WsFactory, type WsLike } from '../../../src/ui/hosted/relay.ts';
import { signedWake, wakeThrough } from '../../../src/ui/hosted/wake.ts';
import { startRelay, until } from '../rendezvous/rig.ts';

/** RFC 8032 7.1 TEST 1's seed, the box, time and nonce of the vector (relay/WakeTest.java uses the same). */
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const VECTOR = { wakeFp: 'a'.repeat(64), box: b64url(Buffer.alloc(32, 1)), at: 1_763_500_000_000, nonce: 'wakewakewakewake0001' };
const VECTOR_SIG = 'tSWuVIlhc3dU7NWSk-9BKhQAxIivuIUmDLX-XM71H6ZAX5bKyPsPkz6xzMlm_uvLzuGOrK1OlYPKof3Sv19DAA';
const PKCS8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED, 'hex')]);

const record = (row: Partial<DeviceRecord> & Pick<DeviceRecord, 'id' | 'kind' | 'fingerprint'>): DeviceRecord => ({
  name: row.id, role: row.kind === 'pc' ? 'home' : 'client', addresses: [], caps: {}, status: 'offline', self: false, ...row,
});

async function phoneRecord(key: DeviceKey, extra: Partial<DeviceRecord> = {}): Promise<DeviceRecord> {
  return record({ id: `dev_${(await fingerprint(key.pub)).slice(0, 8)}`, kind: 'phone', fingerprint: await fingerprint(key.pub), publicKey: b64url(key.pub), ...extra });
}

test('the wake text: the PC (node), the iPhone web app (WebCrypto) and the Android app sign the same bytes', async () => {
  const { wakeFp, box, at, nonce } = VECTOR;
  assert.equal(wakeText(wakeFp, box, at, nonce), `wf-wake-v1|${'a'.repeat(64)}|AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE|1763500000000|wakewakewakewake0001`);
  const nodeKey = createPrivateKey({ key: PKCS8, format: 'der', type: 'pkcs8' });
  assert.equal(signWake((data) => nodeSign(null, data, nodeKey), wakeFp, box, at, nonce).sig, VECTOR_SIG);
  const privateKey = await crypto.subtle.importKey('pkcs8', PKCS8, { name: 'Ed25519' }, false, ['sign']);
  const body = await signedWake({ privateKey, pub: new Uint8Array(32) }, wakeFp, box, at, nonce);
  assert.deepEqual(body, { op: 'wake', at, nonce, sig: VECTOR_SIG });
});

test('the helper\'s file pins my own PCs and phones – not an employee\'s phone, not a removed one', async () => {
  const mine = await newDeviceKey();
  const employees = await newDeviceKey();
  const removed = await newDeviceKey();
  const pc = generateEd25519();
  const pcPub = b64url(rawPublic(pc.publicKey));
  const devices = [
    record({ id: 'dev_pc', kind: 'pc', fingerprint: wakeFpOf(pcPub), publicKey: pcPub }),
    await phoneRecord(mine),
    await phoneRecord(employees, { personId: 'pe_1' }),
    await phoneRecord(removed, { status: 'revoked', revokedAt: 1 }),
  ];
  const helper = generateEd25519();
  const key = { pub: b64url(rawPublic(helper.publicKey)), pkcs8: exportPrivate(helper.privateKey) };
  const file = wakeFileFor({ relay: 'wss://meet.example', key, devices });
  assert.deepEqual(file?.pins, [{ fp: wakeFpOf(pcPub), pub: pcPub }, { fp: await fingerprint(mine.pub), pub: b64url(mine.pub) }]);
  const onlyPhone = wakeFileFor({ relay: 'wss://meet.example', key, devices: [await phoneRecord(mine)] });
  assert.equal(onlyPhone?.pins.length, 1, 'a PC with only my phone linked can be woken too');
});

test('checkWake takes a phone-signed wake from a pinned phone only', async () => {
  const phone = await newDeviceKey();
  const stranger = await newDeviceKey();
  const pins = [{ fp: await fingerprint(phone.pub), pub: b64url(phone.pub) }];
  const session = { wakeFp: 'f'.repeat(64), box: b64url(Buffer.alloc(32, 7)) };
  const now = 2_000_000;
  const seen = new Set<string>();
  const fromStranger = await signedWake(stranger, session.wakeFp, session.box, now, 'strangerstranger01');
  assert.equal(checkWake(fromStranger, await fingerprint(stranger.pub), pins, session, now, seen), false, 'an unpinned key');
  assert.equal(checkWake(fromStranger, pins[0]!.fp, pins, session, now, seen), false, 'a pinned name with another key\'s signature');
  const body = await signedWake(phone, session.wakeFp, session.box, now, 'phonephonephone001');
  assert.equal(checkWake(body, pins[0]!.fp, pins, session, now, seen), true);
  assert.equal(checkWake(body, pins[0]!.fp, pins, session, now, seen), false, 'once');
});

test('no PC online: the phone wakes the closed PC itself through the real meeting server', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const phone = await newDeviceKey();
  const stranger = await newDeviceKey();
  const helperKey = generateEd25519();
  const wakePub = b64url(rawPublic(helperKey.publicKey));
  const file = wakeFileFor({ relay: relay.url, key: { pub: wakePub, pkcs8: exportPrivate(helperKey.privateKey) }, devices: [await phoneRecord(phone)] })!;
  const started: number[] = [];
  let ended = 0;
  const helper = new Sleeper({
    file, socket: (url) => new WebSocket(url, { perMessageDeflate: false }), startApp: () => started.push(Date.now()), exit: () => { ended++; },
  });
  t.after(() => helper.end());
  helper.start();
  await until(() => relay.stats().devices, (count) => count === 1, 'the helper waits at the meeting server');
  const sockets: WebSocket[] = [];
  const socket: WsFactory = (url) => { const ws = new globalThis.WebSocket(url); sockets.push(ws as unknown as WebSocket); return ws as unknown as WsLike; };
  t.after(() => { for (const ws of sockets) ws.close(); });
  const link = (key: DeviceKey) => new RelayLink({ key, pins: new Map(), events: { presence: () => undefined, down: () => undefined }, socket });
  const phoneLink = link(phone);
  await phoneLink.connect(relay.url);
  assert.equal((await phoneLink.find(await remoteIdOf(wakeFpOf(wakePub)))).length, 1, 'found under the Remote ID of its key');

  const strangerLink = link(stranger);
  await strangerLink.connect(relay.url);
  await assert.rejects(wakeThrough(strangerLink, stranger, wakePub, 'Desk'), /Desk did not take the wake from this phone/);
  assert.deepEqual(started, [], 'an unpinned phone starts nothing');
  await assert.rejects(wakeThrough(phoneLink, phone, 'nokey', 'Desk'), /cannot be woken yet/);

  await wakeThrough(phoneLink, phone, wakePub, 'Desk');
  assert.equal(started.length, 1, 'the app starts');
  await until(() => ended, (count) => count === 1, 'the helper ends after its answer');
  phoneLink.close();
  strangerLink.close();
});
