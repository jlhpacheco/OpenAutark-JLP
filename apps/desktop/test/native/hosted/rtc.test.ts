// F25 P3 (18.11.2026): the iPhone web app's direct way (src/ui/hosted/rtc.ts, rtc-signal.ts) without a browser – the
// address filter (never stricter than the PC needs for the phone's own candidates, as strict as Android for the PC's),
// the STUN list (only the built-in endpoint if offered, an empty list stays empty), the offer limits (SDP ≤ 16 KiB, ≤ 32 candidates), the data channel's
// framing against the PC's own RtcSocket (pieces of exactly 16 KiB, the pinned handshake over it, broken pieces, a full
// send buffer), the plan (30 s → 2 min → 10 min, at once after a resume, never after refused), the try's answers on A
// (no answer = older PC, no, end before an offer, an offer past the limit), and one whole run with werift standing in
// for the browser's RTCPeerConnection against the real PhoneBridge: ready on B, the page's streams there (counted rtc),
// the WebSocket moved, and the way's end when the PC stops (the page's move back to A: test/native/hosted-rtc.test.mjs).
// The same against real Chromium: test/native/hosted-rtc.test.mjs. Owns: these assertions. Never: a browser or a handset.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RTCPeerConnection } from 'werift';
import { acceptSecure, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { allowedCandidate } from '../../../src/runtime/devices/rendezvous/rtc.ts';
import { RtcSocket, type DataChannelLike as PcDataChannel } from '../../../src/runtime/devices/rendezvous/rtc-socket.ts';
import { PhoneBridge } from '../../../src/runtime/devices/rendezvous/phone.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { b64url } from '../../../src/runtime/devices/keys.ts';
import { fromUtf8 } from '../../../src/ui/hosted/bytes.ts';
import { connectChannel, type SecureChannel } from '../../../src/ui/hosted/channel.ts';
import { httpFetch } from '../../../src/ui/hosted/http.ts';
import { AGAIN_MS, MAX_BUFFERED, PIECE, RtcPipe, RtcPlan, RtcWay, type DataChannelLike, type PeerLike, type RtcEnv } from '../../../src/ui/hosted/rtc.ts';
import { MAX_SDP, allowedAddress, ownCandidate, pcCandidate, readOffer, rtcConfig, stunOf } from '../../../src/ui/hosted/rtc-signal.ts';
import { StreamMux } from '../../../src/ui/hosted/streams.ts';
import { pcIdentity, phoneKey, tunnelPair, until } from '../../unit/hosted/rig.ts';

type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const line = (address: string, port: number, extra = 'udp', type = 'host') => `candidate:1 1 ${extra} 2122260223 ${address} ${port} typ ${type} generation 0`;

test('the address filter: the PC\'s candidates only as IP literals; the phone\'s own as the PC takes them (mDNS names too)', () => {
  for (const [host, ok] of [['192.168.1.20', true], ['10.0.0.1', true], ['100.64.1.1', true], ['8.8.8.8', true], ['fd00::1', true], ['2001:db8::1', true],
    ['127.0.0.1', false], ['0.1.2.3', false], ['169.254.169.254', false], ['224.0.0.251', false], ['255.255.255.255', false], ['240.0.0.1', false],
    ['::1', false], ['::', false], ['::ffff:127.0.0.1', false], ['::ffff:192.168.1.2', true], ['64:ff9b::1.2.3.4', false], ['fe80::1', false], ['ff02::1', false],
    ['192.168.001.1', false], ['1.2.3', false], ['1:2:3:4:5:6:7:8:9', false], ['a.local', false], ['example.com', false]] as const) {
    assert.equal(allowedAddress(host, 50_000), ok, host);
  }
  assert.equal(allowedAddress('192.168.1.20', 1023), false, 'a port below 1024');
  assert.equal(pcCandidate(line('192.168.1.20', 50_000)), 'host');
  assert.equal(pcCandidate(line('3f0e1c2a-1111-2222-3333-444455556666.local', 50_000)), undefined, 'no name from the PC: the browser would resolve it');
  assert.equal(pcCandidate(line('192.168.1.20', 50_000, 'tcp')), undefined, 'UDP only');
  assert.equal(pcCandidate(`${line('192.168.1.20', 50_000)} ${'x'.repeat(600)}`), undefined, 'a line past 512 characters');
  assert.equal(ownCandidate(line('3f0e1c2a-1111-2222-3333-444455556666.local', 50_000)), 'host', 'Safari\'s and Chromium\'s mDNS host candidates go');
  assert.equal(ownCandidate(line('a.local', 80)), undefined);
  assert.equal(ownCandidate(line('203.0.113.9', 41_000, 'udp', 'srflx')), 'srflx');
  assert.equal(ownCandidate(line('192.168.1.20', 9, 'tcp')), undefined);
  // every own candidate the phone sends is one the PC takes, and the PC's filter is not wider for the PC's own lines
  const samples = [line('3f0e1c2a-1111-2222-3333-444455556666.local', 50_000), line('192.168.1.20', 50_000), line('127.0.0.1', 50_000), line('fe80::1', 50_000),
    line('192.168.1.20', 50_000, 'tcp'), line('10.1.1.1', 1000), line('2001:db8::5', 61_000, 'udp', 'srflx'), line('a.local', 99)];
  for (const sample of samples) assert.equal(Boolean(ownCandidate(sample)), Boolean(allowedCandidate(sample)), sample);
});

const allowedStun = 'stun:stun.cloudflare.com:3478';
const rejectedStun = [
  'stun:127.0.0.1:22', 'stun:169.254.169.254:80', 'stun:stun.cloudflare.com:80',
  'stun:other.example:3478', 'stun:[2001:db8::1]:3478', 'stun:stun.cloudflare.com',
  'stun:stun.cloudflare.com:3478?transport=tcp', 'stun:stun.cloudflare.com.example:3478',
  'turn:stun.cloudflare.com:3478',
];

test('iceServers: only the exact bundle STUN endpoint, only if offered, and at most once', () => {
  for (const url of rejectedStun) assert.deepEqual(stunOf([{ urls: url }]), [], url);
  assert.deepEqual(stunOf([]), []);
  assert.deepEqual(stunOf(undefined), []);
  assert.deepEqual(stunOf([{ urls: rejectedStun }, { urls: allowedStun }, { urls: [allowedStun] }]), [allowedStun]);
  assert.deepEqual(rtcConfig([]).iceServers, []);
  assert.deepEqual(rtcConfig(rejectedStun).iceServers, [], 'RTC config enforces the same policy');
  assert.deepEqual(rtcConfig([allowedStun, ...rejectedStun, allowedStun]).iceServers, [{ urls: [allowedStun] }]);
});

test('an offer: SDP ≤ 16 KiB, an id, the version; its candidates through the filter, at most 32', () => {
  const head = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n';
  const cands = Array.from({ length: 40 }, (_, i) => `a=${line(`192.168.1.${i + 1}`, 50_000 + i)}\r\n`).join('');
  const offer = readOffer({ t: 'rtc', v: 1, op: 'offer', id: 'abc123', sdp: `${head}a=${line('127.0.0.1', 50_000)}\r\n${cands}a=end-of-candidates\r\n`, ice: [] })!;
  assert.equal(offer.candidates.length, 32);
  assert.equal(offer.dropped, 9, 'loopback plus the 8 past 32');
  assert.equal(offer.mid, '0');
  assert.ok(!offer.sdp.includes('a=candidate') && !offer.sdp.includes('end-of-candidates'), 'the browser gets the SDP without them');
  assert.deepEqual(offer.stun, []);
  assert.equal(readOffer({ t: 'rtc', v: 1, op: 'offer', id: 'abc', sdp: head + 'a=x:' + 'y'.repeat(MAX_SDP) }), undefined, 'past 16 KiB');
  assert.equal(readOffer({ t: 'rtc', v: 2, op: 'offer', id: 'abc', sdp: head }), undefined, 'another version');
  assert.equal(readOffer({ t: 'rtc', v: 1, op: 'offer', id: 'a b', sdp: head }), undefined, 'a strange id');
  assert.equal(readOffer({ t: 'rtc', v: 1, op: 'offer', id: 'x'.repeat(65), sdp: head }), undefined);
});

// ---------------------------------------------------------------- framing against the PC's RtcSocket

/** A browser-shaped data channel (ArrayBuffer messages) joined to a werift-shaped one (Buffer) the PC's RtcSocket takes. */
function channels() {
  const toPc: Array<string | Uint8Array> = [];
  const pcListeners: Array<(data: string | Buffer) => void> = [];
  const pcStates: Array<(state: string) => void> = [];
  let closed = false;
  const close = () => { if (closed) return; closed = true; browser.onclose?.(); for (const state of pcStates) state('closed'); };
  const browser: DataChannelLike & { bufferedAmount: number } = {
    label: 'autark', readyState: 'open', bufferedAmount: 0, binaryType: 'blob', onopen: null, onmessage: null, onclose: null,
    send(data) {
      if (closed) throw new Error('closed');
      toPc.push(typeof data === 'string' ? data : data.slice());
      const copy = typeof data === 'string' ? data : Buffer.from(data);
      queueMicrotask(() => { if (!closed) for (const listener of pcListeners) listener(copy); });
    },
    close,
  };
  const pc: PcDataChannel = {
    bufferedAmount: 0,
    send(data) {
      if (closed) return;
      const copy = typeof data === 'string' ? data : new Uint8Array(data).slice().buffer;
      queueMicrotask(() => { if (!closed) browser.onmessage?.({ data: copy }); });
    },
    close,
    onMessage: { subscribe: (listener) => { pcListeners.push(listener); } },
    stateChanged: { subscribe: (listener) => { pcStates.push(listener); } },
  };
  return { browser, pc, toPc, isClosed: () => closed };
}

test('the data channel framing matches the PC: the pinned handshake over it, 8 MiB both ways in pieces of exactly 16 KiB', async () => {
  const desk = await pcIdentity('Desk');
  const key = await phoneKey();
  const { browser, pc, toPc } = channels();
  const pipe = new RtcPipe(browser);
  assert.equal(browser.binaryType, 'arraybuffer');
  const socket = new RtcSocket(pc);
  const accepted = acceptSecure(socket, desk, (pub) => (Buffer.compare(pub, Buffer.from(key.pub)) === 0 ? 'dev_phone0000000001' : undefined));
  const phone = await connectChannel(pipe, { key, deviceId: 'dev_phone0000000001' }, desk.publicKey);
  const atPc = await accepted;
  socket.trusted();
  assert.equal(typeof toPc[0], 'string', 'the handshake is text');
  const big = 'x'.repeat(8 * 1024 * 1024 - 64);
  const gotPc = new Promise<unknown>((resolve) => atPc.onMessage(resolve));
  const gotPhone = new Promise<unknown>((resolve) => phone.onMessage(resolve));
  void phone.send({ big });
  atPc.send({ big: big.slice(0, 3_000_000) });
  assert.equal(((await gotPc) as { big: string }).big.length, big.length);
  assert.equal(((await gotPhone) as { big: string }).big.length, 3_000_000);
  const pieces = toPc.filter((data): data is Uint8Array => typeof data !== 'string');
  const frame = pieces.slice(-Math.ceil((big.length + 9 + 24 + 16) / PIECE));
  for (const piece of frame.slice(0, -1)) assert.deepEqual([piece.length, piece[0]], [PIECE + 1, 1], 'MORE pieces carry exactly 16 KiB');
  assert.equal(frame.at(-1)![0], 0, 'the last piece has no MORE');
  phone.close();
  await until(() => atPc.closed, Boolean, 'the PC side closes with it');
});

test('a piece out of shape, text inside a frame or a send buffer past 16 MiB ends the data channel', async () => {
  for (const bad of [new Uint8Array([1, 1, 2, 3]).buffer, new Uint8Array([2, 9]).buffer, new Uint8Array([0]).buffer, new Uint8Array(PIECE + 2).buffer, { not: 'bytes' }]) {
    const { browser, isClosed } = channels();
    const pipe = new RtcPipe(browser);
    browser.onmessage!({ data: bad });
    assert.ok(pipe.closed && isClosed(), 'closed');
  }
  const { browser } = channels();
  const pipe = new RtcPipe(browser);
  const more = new Uint8Array(PIECE + 1);
  more[0] = 1;
  browser.onmessage!({ data: more.buffer });
  browser.onmessage!({ data: 'text' });
  assert.ok(pipe.closed, 'text in the middle of a frame');
  const full = channels();
  const slow = new RtcPipe(full.browser);
  full.browser.bufferedAmount = MAX_BUFFERED + 1;
  slow.sendBinary(new Uint8Array(10));
  assert.ok(slow.closed, 'too slow: the tunnel takes over');
});

test('the plan: 30 s, 2 min, then 10 min; at once after a resume; never on an A that said no; never after refused', () => {
  const plan = new RtcPlan();
  const a = {};
  assert.equal(plan.due(a, 0), true);
  plan.ended(a, 'timeout', 0);
  assert.deepEqual([plan.due(a, 29_999), plan.due(a, 30_000), plan.wait(a, 0)], [false, true, AGAIN_MS[0]]);
  plan.ended(a, 'failed', 30_000);
  assert.equal(plan.wait(a, 30_000), 120_000);
  plan.ended(a, 'lost', 150_000);
  assert.equal(plan.wait(a, 150_000), 600_000);
  plan.ended(a, 'busy', 750_000);
  assert.equal(plan.wait(a, 750_000), 600_000, 'it stays at 10 min');
  plan.check();
  assert.equal(plan.due(a, 750_001), true, 'a resume or network change tries at once');
  plan.ended(a, 'closed', 0);
  assert.equal(plan.due(a, 0), true, 'A ended: the next A tries at once');
  plan.ended(a, 'off', 0);
  plan.check();
  assert.deepEqual([plan.due(a, 0), plan.wait(a, 0), plan.due({}, 0)], [false, undefined, true], 'no on this A only');
  plan.ended(a, 'refused', 0);
  plan.check();
  assert.deepEqual([plan.due({}, 0), plan.isRefused], [false, true], 'refused: never again in this session');
});

// ---------------------------------------------------------------- a try's answers on A

function fakeA() {
  const sent: Message[] = [];
  const a = { closed: false, send: (message: unknown) => { sent.push(message as Message); } } as unknown as SecureChannel;
  return { a, sent };
}

async function way(env: Partial<RtcEnv> = {}) {
  const { a, sent } = fakeA();
  const configs: RTCConfiguration[] = [];
  const ends: Array<{ outcome: string; wasReady: boolean }> = [];
  const key = await phoneKey();
  const w = new RtcWay(a, { key, deviceId: 'dev_x' }, new Uint8Array(32), { ready: () => undefined, over: (_w, outcome, wasReady) => ends.push({ outcome, wasReady }) }, {
    peer: (config) => { configs.push(config); return fakePeer(); }, net: () => 'cell', helloMs: 60, tryMs: 200, ...env,
  });
  w.start();
  return { w, sent, configs, ends };
}

function fakePeer(): PeerLike {
  return {
    onicecandidate: null, ondatachannel: null, oniceconnectionstatechange: null, iceConnectionState: 'new',
    localDescription: { sdp: 'v=0\r\na=mid:0\r\na=candidate:1 1 udp 1 192.168.1.9 50000 typ host\r\na=candidate:2 1 tcp 1 192.168.1.9 9 typ host\r\n' },
    setRemoteDescription: async () => undefined, createAnswer: async () => ({ type: 'answer', sdp: '' }), setLocalDescription: async () => undefined,
    addIceCandidate: async () => undefined, close: () => undefined,
  };
}

test('a try on A: hello with the net kind; no answer in 5 s is an older PC; no and end-before-offer are a no', async () => {
  const quiet = await way();
  assert.deepEqual(quiet.sent[0], { t: 'rtc', v: 1, op: 'hello', net: 'cell' });
  await until(() => quiet.ends.length, (n) => n === 1, 'no answer');
  assert.deepEqual(quiet.ends, [{ outcome: 'old', wasReady: false }]);
  const off = await way();
  off.w.signal({ t: 'rtc', v: 1, op: 'no', why: 'off' });
  const ended = await way();
  ended.w.signal({ t: 'rtc', v: 1, op: 'end', id: 'zz', why: 'failed' });
  await until(() => off.ends.length + ended.ends.length, (n) => n === 2, 'both');
  assert.equal(off.ends[0].outcome, 'off');
  assert.equal(ended.ends[0].outcome, 'nooffer');
  assert.equal(off.sent.length + ended.sent.length, 2, 'nothing but the two hellos');
});

test('an offer past 16 KiB ends the try with end on A; a good one: the browser gets only allowed STUN, the PC our filtered candidates', async () => {
  const big = await way();
  big.w.signal({ t: 'rtc', v: 1, op: 'offer', id: 'abc', sdp: 'v=0\r\n' + 'a=x:' + 'y'.repeat(MAX_SDP), ice: [] });
  await until(() => big.ends.length, (n) => n === 1, 'ended');
  assert.deepEqual([big.ends[0].outcome, big.sent.at(-1)], ['failed', { t: 'rtc', v: 1, op: 'end', id: 'abc', why: 'failed' }]);
  assert.equal(big.configs.length, 0, 'no peer connection for it');
  for (const [urls, expected] of [[rejectedStun, []], [[...rejectedStun, allowedStun], [{ urls: [allowedStun] }]]] as const) {
    const ice = [{ urls }];
    const good = await way();
    good.w.signal({ t: 'rtc', v: 1, op: 'offer', id: 'abc', sdp: 'v=0\r\na=mid:0\r\n', ice });
    await until(() => good.sent.some((m) => m.op === 'answer'), Boolean, 'the answer');
    assert.deepEqual(good.configs[0].iceServers, expected, 'only the explicit allowed STUN endpoint reaches the peer factory');
    assert.deepEqual(good.sent.filter((m) => m.op === 'cand').map((m) => m.c.candidate), ['candidate:1 1 udp 1 192.168.1.9 50000 typ host'], 'UDP only');
    assert.ok(!good.sent.find((m) => m.op === 'answer')!.sdp.includes('candidate'));
    await until(() => good.ends.length, (n) => n === 1, 'the try times out');
    assert.equal(good.ends[0].outcome, 'timeout');
    assert.deepEqual(good.sent.at(-1), { t: 'rtc', v: 1, op: 'end', id: 'abc', why: 'timeout' });
  }
});

// ---------------------------------------------------------------- a whole run, werift as the browser

const peers = new Set<RTCPeerConnection>();
afterEach(async () => { await Promise.all([...peers].map((peer) => peer.close().catch(() => undefined))); peers.clear(); });
/** werift in place of the browser's RTCPeerConnection (it never adds a STUN server of its own with these two settings). */
const weriftEnv: RtcEnv = {
  peer: (config) => { const peer = new RTCPeerConnection({ ...config, iceUseDefaultStunServer: false, iceUseTcp: false } as never); peers.add(peer); return peer as unknown as PeerLike; },
};

test('werift as the browser against the real PhoneBridge: ready on B, the streams there (counted rtc), the socket moves; the PC ends it and the way ends', { timeout: 60_000 }, async (t) => {
  const pc = await pcIdentity('Desk');
  const key = await phoneKey();
  const body = Buffer.alloc(1_000_000, 7);
  const runtime = http.createServer((req, res) => { res.setHeader('content-length', String(body.length)); res.end(body); });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const record: DeviceRecord = { id: 'dev_phone0000000001', name: 'iPhone', kind: 'phone', role: 'client', fingerprint: 'fp', publicKey: b64url(Buffer.from(key.pub)), addresses: [], caps: {}, status: 'online', self: false };
  const bridge = new PhoneBridge({ identity: pc, log: { debug() {}, info() {}, warn() {}, error() {} }, port: () => (runtime.address() as { port: number }).port, phone: () => record, rtc: { stun: () => [] } });
  t.after(() => { bridge.closeAll(); runtime.closeAllConnections(); runtime.close(); });
  const pair = await tunnelPair();
  void bridge.accept(pair.runtime as SocketLike, record);
  const a = await connectChannel(pair.hosted, { key, deviceId: record.id }, pc.publicKey);
  const muxA = new StreamMux(a);
  const lasting = muxA.openStream(true);
  const states: string[] = [];
  let ready: RtcWay | undefined;
  const ended: string[] = [];
  const w = new RtcWay(a, { key, deviceId: record.id }, pc.publicKey, { ready: (r) => { ready = r; }, over: (_w, outcome) => ended.push(outcome) }, weriftEnv);
  a.onMessage((m) => { if ((m as Message)?.t === 'rtc') { states.push((m as Message).op); w.signal(m as Message); } });
  w.start();
  await until(() => ready, Boolean, `ready on B (${states.join(',')} ${ended.join(',')})`, 20_000);
  const muxB = new StreamMux(w.carrying!);
  muxA.endLasting();
  assert.ok(lasting.ended, 'the lasting stream on A ends (the page\'s socket reopens on B)');
  const relayBefore = bridge.counts()[0].relay;
  const got = await httpFetch(muxB, { method: 'GET', path: '/big' });
  assert.equal(got.body.length, body.length);
  const count = bridge.counts()[0];
  assert.equal(count.via, 'rtc');
  assert.ok(count.rtc > body.length, `the bytes went over rtc (${count.rtc})`);
  assert.ok(count.relay - relayBefore < 2_000, `the tunnel carried only a little (${count.relay - relayBefore} bytes)`);
  assert.ok(!pair.toPc.some((frame) => /v=0|candidate|ice-ufrag|a=fingerprint/.test(fromUtf8(frame))), 'no SDP readable on the tunnel');
  // the PC ends the way: the phone hears it and B closes; A still carries
  bridge.closeAll();
  await until(() => ended.length, (n) => n === 1, 'the way ends');
  assert.ok(['lost', 'closed'].includes(ended[0]), ended[0]);
  assert.equal(w.carrying, undefined);
});
