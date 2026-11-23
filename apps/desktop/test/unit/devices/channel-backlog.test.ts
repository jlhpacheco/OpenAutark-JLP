// SecureChannel's backlog (devices/channel.ts, 18.11.2026): messages that arrive before anyone listens go, in order and
// before anything newer, to every listener registered in the same synchronous run – a phone's channel registers the
// streams and then the WebRTC signalling (rendezvous/phone.ts), and an rtc hello sent right after the handshake must
// reach the second one (it went only to the first before). A listener added later gets only newer messages.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptSecure, connectSecure } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from './socket-pair.ts';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { fakeHost, memoryDb } from './fakes.ts';

const identity = (name: string) => DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the backlog reaches every listener of the same run, in order and before newer messages', async () => {
  const [pc, phone] = await Promise.all([identity('Desk'), identity('Phone')]);
  const [a, b] = socketPair();
  const [server, client] = await Promise.all([
    acceptSecure(a, pc, (pub) => (pub.equals(phone.publicKey) ? phone.deviceId : undefined)),
    connectSecure(b, phone, pc.fingerprint),
  ]);
  client.send({ n: 1 });
  client.send({ t: 'rtc', op: 'hello' });
  await settle(); // both wait in the backlog: nobody listens yet
  const streams: unknown[] = [];
  const rtc: unknown[] = [];
  server.onMessage((message) => streams.push(message));
  server.onMessage((message) => rtc.push(message));
  client.send({ n: 2 });
  await settle();
  assert.deepEqual(streams, [{ n: 1 }, { t: 'rtc', op: 'hello' }, { n: 2 }]);
  assert.deepEqual(rtc, [{ n: 1 }, { t: 'rtc', op: 'hello' }, { n: 2 }], 'the second listener hears the early hello too');
  const late: unknown[] = [];
  server.onMessage((message) => late.push(message));
  client.send({ n: 3 });
  await settle();
  assert.deepEqual(late, [{ n: 3 }], 'a later listener gets only newer messages');
  server.close();
});
