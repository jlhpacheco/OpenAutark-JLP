// PC ↔ PC over WebRTC (rendezvous/pc-rtc.ts, 18.11.2026): two PcRtc ends agree on a direct path over a signalling tunnel
// (an in-memory socket pair here, sealed through the meeting server in the app) and run the pinned handshake over the
// data channel – real werift ICE/DTLS/SCTP on this PC's own addresses. The signalling tunnel carries only the two SDPs
// and closes; the data goes over the data channel. No direct path: the dialer rejects (the mesh then takes the tunnel)
// and goes straight to the tunnel for a while; an older PC that closes on the offer, a PC with the way off and a
// handshake with another key all end the try. Owns: these assertions only.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { acceptSecure, connectSecure, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from '../../unit/devices/socket-pair.ts';
import { PcRtc, pcOffer, SKIP_MS } from '../../../src/runtime/devices/rendezvous/pc-rtc.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { fakeHost, memoryDb, silentLog } from '../../unit/devices/fakes.ts';

const identity = (name: string) => DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name });
const ends: PcRtc[] = [];
afterEach(() => { ends.length = 0; });

/** A signalling tunnel that counts its bytes; `answer` gets the far end of each one the dialer opens. */
function signalling(answer: (far: SocketLike) => void) {
  const count = { bytes: 0, closed: 0 };
  const open = () => {
    const [near, far] = socketPair();
    const send = near.send.bind(near);
    near.send = (data) => { count.bytes += Buffer.byteLength(data as string); send(data); };
    near.onClose(() => { count.closed++; });
    answer(far);
    return Promise.resolve(near);
  };
  return { open, count };
}

/** The receiving PC: an incoming tunnel's first frame goes to `answer` when it is an offer (as Meeting.incoming does). */
function receiver(end: PcRtc, from: string) {
  return (far: SocketLike) => {
    let first = true;
    far.onMessage((data, isText) => {
      if (!first) return;
      first = false;
      const offer = pcOffer(data, isText);
      if (offer) end.answer(far, from, offer); else far.close(4000);
    });
  };
}

test('two PCs agree on a direct path through the signalling tunnel; the handshake and the data run on the data channel', async () => {
  const [a, b] = await Promise.all([identity('Desk'), identity('Laptop')]);
  let accepted: Promise<unknown> | undefined;
  const bEnd = new PcRtc({
    log: silentLog, stun: () => [],
    tunnel: () => undefined,
    accept: (socket, fp) => (accepted = acceptSecure(socket, b, (pub) => (fp === a.fingerprint && pub.equals(a.publicKey) ? a.deviceId : undefined)).then((channel) => { (socket as { trusted?: () => void }).trusted?.(); return channel; })),
  });
  const sig = signalling(receiver(bEnd, a.fingerprint));
  const aEnd = new PcRtc({ log: silentLog, stun: () => [], tunnel: () => sig.open(), accept: () => Promise.reject(new Error('dialer')) });
  ends.push(aEnd, bEnd);

  const socket = await aEnd.dial(b.fingerprint)!;
  const channelA = await connectSecure(socket, a, b.fingerprint);
  (socket as { trusted?: () => void }).trusted?.();
  const channelB = await accepted as Awaited<ReturnType<typeof acceptSecure>>;
  const big = 'x'.repeat(1024 * 1024);
  const got = new Promise<string>((resolve) => channelB.onMessage((message) => resolve((message as { big: string }).big)));
  channelA.send({ big });
  assert.equal((await got).length, big.length, '1 MiB over the data channel, past the pre-handshake cap');
  const back = new Promise<unknown>((resolve) => channelA.onMessage(resolve));
  channelB.send({ ok: true });
  assert.deepEqual(await back, { ok: true });
  assert.ok(sig.count.closed >= 1, 'the signalling tunnel closed once the data channel stood');
  assert.ok(sig.count.bytes < 16 * 1024, `only the offer went over the tunnel (${sig.count.bytes} bytes)`);
  channelA.close();
  channelB.close();
});

test('no direct path: the dialer rejects, then goes straight to the tunnel for a while', async () => {
  const [a, b] = await Promise.all([identity('Desk'), identity('Laptop')]);
  let clock = 1_000_000;
  const bEnd = new PcRtc({ log: silentLog, stun: () => undefined, tunnel: () => undefined, accept: () => Promise.reject(new Error('never')) });
  let opens = 0;
  const sig = signalling(receiver(bEnd, a.fingerprint));
  const aEnd = new PcRtc({ log: silentLog, stun: () => [], now: () => clock, tunnel: () => { opens++; return sig.open(); }, accept: () => Promise.reject(new Error('dialer')) });
  ends.push(aEnd, bEnd);
  await assert.rejects(aEnd.dial(b.fingerprint)!, /no direct path \(off\)/, 'the other PC has the way off');
  assert.equal(aEnd.dial(b.fingerprint), undefined, 'straight to the tunnel after a failure');
  clock += SKIP_MS + 1;
  const again = aEnd.dial(b.fingerprint);
  assert.ok(again, 'tried again after the pause');
  await assert.rejects(again!);
  assert.equal(opens, 2);
});

test('an older PC closes the tunnel on the offer: the dialer falls back at once', async () => {
  const b = await identity('Laptop');
  const sig = signalling((far) => far.onMessage(() => far.close(4000)));
  const aEnd = new PcRtc({ log: silentLog, stun: () => [], tunnel: () => sig.open(), accept: () => Promise.reject(new Error('dialer')), dialMs: 8_000 });
  const started = Date.now();
  await assert.rejects(aEnd.dial(b.fingerprint)!, /closed/);
  assert.ok(Date.now() - started < 4_000, 'no wait for the timeout');
});

test('a handshake with another key on the data channel ends that way', async () => {
  const [a, b, stranger] = await Promise.all([identity('Desk'), identity('Laptop'), identity('Stranger')]);
  let refused: Promise<unknown> | undefined;
  const bEnd = new PcRtc({
    log: silentLog, stun: () => [], tunnel: () => undefined,
    accept: (socket, fp) => (refused = acceptSecure(socket, b, (pub) => (fp === a.fingerprint && pub.equals(a.publicKey) ? a.deviceId : undefined)).catch((error: unknown) => { socket.close(4003); throw error; })),
  });
  const sig = signalling(receiver(bEnd, a.fingerprint));
  const aEnd = new PcRtc({ log: silentLog, stun: () => [], tunnel: () => sig.open(), accept: () => Promise.reject(new Error('dialer')) });
  const socket = await aEnd.dial(b.fingerprint)!;
  await assert.rejects(connectSecure(socket, stranger, b.fingerprint));
  await assert.rejects(refused!);
});

test('only an offer frame starts a try; anything else is a handshake', () => {
  assert.ok(pcOffer(Buffer.from(JSON.stringify({ t: 'rtc-pc', v: 1, op: 'offer', sdp: 'v=0' })), true));
  assert.equal(pcOffer(Buffer.from(JSON.stringify({ t: 'rtc-pc', v: 1, op: 'offer', sdp: 'v=0' })), false), undefined);
  assert.equal(pcOffer(Buffer.from(JSON.stringify({ t: 'hello', v: 1 })), true), undefined);
  assert.equal(pcOffer(Buffer.from('not json'), true), undefined);
  assert.equal(pcOffer(Buffer.from(JSON.stringify({ t: 'rtc-pc', op: 'offer', sdp: 'x'.repeat(20_000) })), true), undefined, 'too large');
});
