// F29 stage 1 (16.11.2026): the phone app's direct socket to the peer listener (`/peer/phone`, http/peer.ts → rendezvous/
// phone.ts acceptDirect). Only the key of an accepted phone record gets a channel: an unknown key, a PC's key, a removed
// phone's key and binary data before the handshake end the socket with 0 TCP connections to the runtime port; the right
// phone gets its streams. The bytes per phone and path are counted (direct vs. through the meeting server), the meeting
// state names them, a removed phone's channels end after the drain, a phone removed between its hello and its auth is
// refused when the auth arrives (review 16.11.2026: prune saw no channel yet), the daily log line, my PCs' addresses for the phone
// (phone-use.ts myPcs) and the Settings row's words (connect-text.ts phoneLinkHint). Real sockets on 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { SecureChannel, connectSecure, wrapWs } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from '../devices/socket-pair.ts';
import { clientFinish, clientHello, type WelcomeMessage } from '../../../src/runtime/devices/handshake.ts';
import { b64url } from '../../../src/runtime/devices/keys.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { PhoneBridge, hasRelayPhone } from '../../../src/runtime/devices/rendezvous/phone.ts';
import { PhoneTraffic } from '../../../src/runtime/devices/rendezvous/phone-traffic.ts';
import { Meeting } from '../../../src/runtime/devices/rendezvous/service.ts';
import type { DeviceMesh } from '../../../src/runtime/devices/mesh.ts';
import { PeerServer } from '../../../src/runtime/http/peer-server.ts';
import { myPcs } from '../../../src/runtime/rpc/handlers/phone-use.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import type { Logger } from '../../../src/runtime/contracts.ts';
import type { RelayState } from '../../../src/shared/model/relay.ts';
import { IPHONE_LINK, phoneLinkHint } from '../../../src/ui/settings/connect-text.ts';
import { fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';
import { closeCode, openSocket, request } from '../http/fixture.ts';

const identity = (name: string) => DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name });
const record = (id: string, kind: 'phone' | 'pc', who: DeviceIdentity, extra: Partial<DeviceRecord> = {}): DeviceRecord =>
  ({ id, name: id, kind, role: kind === 'pc' ? 'home' : 'client', fingerprint: who.fingerprint, publicKey: b64url(who.publicKey), addresses: [], caps: {}, status: 'online', self: false, ...extra });

/** The PC: a runtime port that counts its TCP connections, the phone bridge and the peer listener on 127.0.0.1. */
async function desk(t: { after(fn: () => unknown): void }) {
  const pc = await identity('Desk');
  let connections = 0;
  const runtime = http.createServer((_req, res) => res.end('hello phone'));
  runtime.on('connection', () => { connections++; });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const runtimePort = (runtime.address() as { port: number }).port;
  const records = new Map<string, DeviceRecord>();
  const bridge = new PhoneBridge({ identity: pc, log: silentLog, port: () => runtimePort, phone: (fp) => records.get(fp) });
  const listener = new PeerServer({
    pairing: { wellKnown: () => ({ app: 'workforce', protocol: 1, deviceId: pc.deviceId, name: 'Desk', fingerprint: pc.fingerprint }), handle: async () => ({ ok: true }) },
    mesh: { accept: async () => { throw new Error('no PC links here'); } },
    phones: bridge,
    log: () => silentLog,
    config: () => ({ mode: 'lan', port: 0 }),
    linked: () => true,
    hosts: () => ['127.0.0.1'],
  });
  await listener.start();
  t.after(async () => { bridge.closeAll(); await listener.close(); runtime.closeAllConnections(); runtime.close(); });
  const url = `ws://127.0.0.1:${listener.port()}/peer/phone`;
  return { pc, bridge, records, listener, url, connections: () => connections };
}

/** One stream: GET / through the channel; resolves with the bytes the runtime answered. */
function get(channel: SecureChannel, s: number): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    channel.onMessage((value) => {
      const message = value as { t: string; s: number; b?: string };
      if (message.s !== s) return;
      if (message.t === 'd') { parts.push(Buffer.from(message.b!, 'base64')); channel.send({ t: 'a', s, n: Buffer.from(message.b!, 'base64').length }); }
      if (message.t === 'e') resolve(Buffer.concat(parts).toString('latin1'));
    });
    channel.send({ t: 'o', s });
    channel.send({ t: 'd', s, b: Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n').toString('base64') });
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('/peer/phone: unknown key, a PC key, a removed phone and binary before the handshake are refused before any stream', async (t) => {
  const { pc, records, url, connections } = await desk(t);
  const stranger = await identity('Stranger');
  const otherPc = await identity('Tower');
  const removed = await identity('Old phone');
  records.set(otherPc.fingerprint, record('dev_tower0000001', 'pc', otherPc));
  records.set(removed.fingerprint, record('dev_oldphone0001', 'phone', removed, { revokedAt: 1, status: 'revoked' }));

  for (const [who, what] of [[stranger, 'an unknown key'], [otherPc, 'a linked PC\'s key'], [removed, 'a removed phone\'s key']] as const) {
    const ws = await openSocket(url);
    const code = closeCode(ws);
    await assert.rejects(connectSecure(wrapWs(ws), who, pc.fingerprint), `${what} gets no channel`);
    assert.equal(await code, 4003, `${what} is refused with 4003`);
  }

  const early = await openSocket(url);
  const ended = closeCode(early);
  early.send(Buffer.from([1, 2, 3, 4])); // binary before the hello
  assert.ok((await ended) >= 1000, 'binary data before the handshake closes the socket');

  await settle();
  assert.equal(connections(), 0, '0 TCP connections reached the runtime port');
  assert.equal((await request(Number(new URL(url).port), { path: '/peer/phone' })).status, 426, 'a plain GET is told to upgrade');
});

test('/peer/phone: the accepted phone gets its streams; bytes count as direct, a tunnel as relay; Remove ends it after the drain', async (t) => {
  const { pc, bridge, records, url, connections } = await desk(t);
  const handset = await identity('Pixel');
  records.set(handset.fingerprint, record('dev_pixel0000001', 'phone', handset));
  const changes: number[] = [];
  bridge.onChange(() => changes.push(Date.now()));

  const ws = await openSocket(url);
  const channel = await connectSecure(wrapWs(ws), handset, pc.fingerprint);
  const reply = await get(channel, 1);
  assert.match(reply, /^HTTP\/1\.1 200/);
  assert.match(reply, /hello phone$/);
  assert.equal(connections(), 1, 'exactly the one stream reached the runtime port');
  let [count] = bridge.counts();
  assert.equal(count.deviceId, 'dev_pixel0000001');
  assert.equal(count.via, 'direct');
  assert.ok(count.direct > 200 && count.relay === 0, `the direct bytes are counted (${count.direct})`);
  assert.ok(changes.length >= 1, 'an opened channel is a change');

  // the same phone through the meeting server: the tunnel's bytes count as relay
  const [mine, theirs] = socketPair();
  const accepted = bridge.accept(theirs, records.get(handset.fingerprint)!);
  const tunneled = await connectSecure(mine, handset, pc.fingerprint);
  await accepted;
  await get(tunneled, 2);
  [count] = bridge.counts();
  assert.ok(count.relay > 200, `the tunnel's bytes count as relay (${count.relay})`);
  assert.equal(count.via, 'direct', 'an open direct channel names the way');
  channel.close();
  await settle();
  assert.equal(bridge.counts()[0].via, 'relay', 'with only the tunnel left the way is the meeting server');

  // Remove: after the drain the remaining channel of the phone ends
  const again = await connectSecure(wrapWs(await openSocket(url)), handset, pc.fingerprint);
  await settle(); // the PC has read the phone's auth
  records.set(handset.fingerprint, { ...records.get(handset.fingerprint)!, revokedAt: Date.now(), status: 'revoked' });
  bridge.prune();
  await settle();
  assert.equal(again.closed, true, 'the removed phone\'s direct channel ended');
  assert.equal(tunneled.closed, true, 'and its tunnel channel');
  assert.equal(bridge.counts()[0].via, undefined, 'not connected any more');
});

test('/peer/phone: a phone removed between its hello and its auth is refused when the auth arrives – no channel, no stream', async (t) => {
  const { pc, bridge, records, url, connections } = await desk(t);
  const handset = await identity('Pixel');
  records.set(handset.fingerprint, record('dev_pixel0000001', 'phone', handset));
  const ws = await openSocket(url);
  const code = closeCode(ws);
  const socket = wrapWs(ws);
  const hello = clientHello(handset);
  const welcome = new Promise<WelcomeMessage>((resolve) => socket.onMessage((data, isText) => { if (isText) resolve(JSON.parse(data.toString('utf8'))); }));
  socket.send(JSON.stringify(hello.message));
  const answer = await welcome; // the PC trusted the hello
  records.set(handset.fingerprint, { ...records.get(handset.fingerprint)!, revokedAt: Date.now(), status: 'revoked' });
  bridge.prune(); // Remove's drain: no open channel of the phone yet
  const done = clientFinish(handset, hello.state, answer);
  const channel = new SecureChannel(socket, done.keys, done.peerId, done.peerPub);
  socket.send(JSON.stringify(done.message));
  channel.send({ t: 'o', s: 1 });
  channel.send({ t: 'd', s: 1, b: Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n').toString('base64') });
  assert.equal(await Promise.race([code, delay(1_000, -1)]), 4003, 'the auth of a removed phone is refused');
  await settle();
  assert.equal(connections(), 0, 'no stream reached the runtime port');
  assert.deepEqual(bridge.counts(), [], 'no channel was opened or counted');
});

test('phone traffic: one line per day (at the first count of the next day and at shutdown), counters start at midnight', () => {
  const lines: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const log: Logger = { ...silentLog, info: (message, data) => { lines.push({ message, data }); } };
  let now = new Date(2026, 10, 16, 20, 0).getTime();
  const traffic = new PhoneTraffic(log, () => now);
  traffic.add('dev_a', 'direct', 1_000);
  traffic.add('dev_a', 'relay', 10);
  const close = traffic.opened('dev_a', 'direct');
  assert.deepEqual(traffic.list(), [{ deviceId: 'dev_a', via: 'direct', direct: 1_000, rtc: 0, relay: 10, since: now }]);
  close();
  close();
  assert.equal(traffic.list()[0].via, undefined, 'a close counts once');
  now = new Date(2026, 10, 17, 0, 5).getTime();
  traffic.add('dev_a', 'relay', 5);
  assert.equal(lines.length, 1, 'the day before gets its one line at the first count of the new day');
  assert.equal(lines[0].message, 'phone traffic');
  assert.deepEqual(lines[0].data?.phones, [{ deviceId: 'dev_a', direct: 1_000, rtc: 0, relay: 10 }]);
  assert.equal(lines[0].data?.day, '2026-11-16');
  assert.deepEqual(traffic.list(), [{ deviceId: 'dev_a', direct: 0, rtc: 0, relay: 5, since: new Date(2026, 10, 17).getTime() }]);
  traffic.flush();
  assert.equal(lines.length, 2, 'shutdown writes the running day');
  assert.equal(lines[1].data?.day, '2026-11-17');
});

test('meeting state names each phone\'s way and bytes; the drain after Remove prunes the bridge; the listener stays open for a phone', async () => {
  const db = memoryDb();
  const { bus, events } = recordingBus();
  const pc = await DeviceIdentity.load({ db, host: fakeHost(), clock: systemClock, name: 'Desk' });
  const handset = await identity('Pixel');
  const repo = new DevicesRepo(db);
  repo.upsert(record('dev_pixel0000001', 'phone', handset, { name: 'Pixel 8' }));
  assert.equal(hasRelayPhone(repo.list({ kinds: ['phone'] })), true, 'a linked phone app keeps the peer listener open');
  const listeners: Array<() => void> = [];
  let pruned = 0;
  const timers: Array<() => void> = [];
  const phones = {
    accept: async () => undefined, closeAll: () => undefined,
    counts: () => [{ deviceId: 'dev_pixel0000001', via: 'direct' as const, direct: 4_096, rtc: 0, relay: 12, since: 1 }, { deviceId: 'dev_unknown00001', direct: 1, rtc: 0, relay: 1, since: 1 }],
    onChange: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    prune: () => { pruned++; },
  };
  const mesh = { setMeeting: () => undefined, accept: async () => undefined, online: () => false, connect: async () => undefined } as unknown as Pick<DeviceMesh, 'setMeeting' | 'accept' | 'online' | 'connect'>;
  const meeting = new Meeting({
    db, bus, log: silentLog, clock: systemClock, identity: pc, mesh, phones,
    timers: { set: (fn) => { timers.push(fn); return 0; }, clear: () => undefined },
    remote: { handle: async () => ({ ok: true }), wellKnown: () => ({ deviceId: pc.deviceId, name: 'Desk', fingerprint: pc.fingerprint }), kinds: new Set() },
    relayUrl: () => '', findable: () => true, port: () => undefined,
  });
  meeting.start();
  try {
    assert.deepEqual(meeting.state().phones, [{ deviceId: 'dev_pixel0000001', name: 'Pixel 8', via: 'direct', direct: 4_096, rtc: 0, relay: 12, since: 1 }], 'only accepted phones, by name');
    const before = events.filter((event) => event.event === 'relay.updated').length;
    phones.counts = () => [{ deviceId: 'dev_pixel0000001', via: 'relay', direct: 4_096, rtc: 0, relay: 99, since: 1 }] as never;
    for (const listener of listeners) listener();
    const updates = events.filter((event) => event.event === 'relay.updated');
    assert.equal(updates.length, before + 1, 'a phone channel change sends relay.updated');
    assert.equal((updates.at(-1)!.data as RelayState).phones?.[0].via, 'relay');

    repo.patch('dev_pixel0000001', { revokedAt: Date.now(), status: 'revoked' });
    bus.emit('device.upserted', repo.get('dev_pixel0000001')! as never);
    assert.equal(pruned, 0, 'the removed phone\'s channels wait out the drain');
    for (const fn of timers.splice(0)) fn();
    assert.equal(pruned, 1, 'after the drain the bridge drops the removed phone\'s channels');
    assert.equal(hasRelayPhone(repo.list({ kinds: ['phone'] })), false);
  } finally {
    meeting.stop();
  }
});

test('my PCs for the phone carry their peer addresses (http(s) only, at most 8); the Settings row\'s words', () => {
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  const base = { kind: 'pc' as const, role: 'home' as const, caps: {}, status: 'online' as const, publicKey: 'A'.repeat(43) };
  repo.upsert({ ...base, id: 'dev_self0000001', name: 'Desk', fingerprint: 'fself', self: true, addresses: ['http://203.0.113.7:47812', 'http://192.168.1.20:47812', 'relay:abc', 'http://[2001:db8::7]:47812'] });
  repo.upsert({ ...base, id: 'dev_tower000001', name: 'Tower', fingerprint: 'ftower', self: false, addresses: [] });
  const [self, tower] = myPcs({ db });
  assert.deepEqual(self.addresses, ['http://203.0.113.7:47812', 'http://192.168.1.20:47812', 'http://[2001:db8::7]:47812']);
  assert.equal('addresses' in tower, false, 'no addresses: the field stays out (older phones see the same rows)');

  const now = new Date(2026, 10, 16, 15, 0).getTime();
  const clock = () => '14:02';
  assert.equal(phoneLinkHint({ deviceId: 'd', name: 'Pixel', via: 'direct', direct: 12.4 * 1024 * 1024, rtc: 0, relay: 300 * 1024, since: new Date(2026, 10, 16).getTime() }, now, clock), 'Direct · 12.4 MB direct, 300 KB via the meeting server today');
  assert.equal(phoneLinkHint({ deviceId: 'd', name: 'Pixel', via: 'relay', direct: 0, rtc: 0, relay: 2048, since: new Date(2026, 10, 16, 14, 2).getTime() }, now, clock), 'Via the meeting server · 0 B direct, 2 KB via the meeting server since 14:02');
  assert.equal(phoneLinkHint({ deviceId: 'd', name: 'iPhone', direct: 0, rtc: 0, relay: 0, since: 0 }, now, clock), 'Not connected · 0 B direct, 0 B via the meeting server today');
  assert.match(IPHONE_LINK, /meeting server/);
});
