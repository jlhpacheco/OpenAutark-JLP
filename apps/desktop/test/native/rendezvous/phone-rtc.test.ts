// F25 stage 2 (16.11.2026): the PC end of the WebRTC way (rendezvous/rtc.ts, PhoneBridge.acceptRtc) against a test phone
// in plain Node with werift – real ICE, DTLS and SCTP between two stacks on this PC's own network addresses, no STUN, no
// window. The phone's tunnel through the meeting server is an in-memory socket pair carrying the pinned channel A.
// The three proofs without a handset: the right phone opens the way, does the handshake again and gets a stream; a wrong
// key on the data channel is refused while the tunnel goes on; a way that never connects ends and the tunnel stays.
// Noah's conditions (16.11.2026), each with its test here: signalling only inside the finished, pinned channel (an rtc
// message before the handshake is no handshake; the tunnel's bytes carry no SDP or address); DTLS is no trust (the
// handshake again, any other key 4003, also another paired phone's); candidates that would aim this PC's checks at
// loopback, 0/8, link-local, multicast, broadcast or ports below 1024 never get a packet (T1d); SDP ≤ 16 KiB; werift
// pinned exactly with iceUseDefaultStunServer false (T3a) and no DNS or foreign address in a whole run (T3b); logs and
// counts with candidate types, never addresses; bytes per phone direct, rtc and relay; an older phone that never says
// hello keeps its tunnel unchanged, and werift never runs for it. Also: the settings' STUN list reaches werift (a local
// STUN server, a srflx candidate); a stranger's datagrams at the PC's ICE sockets – the network side of Noah's fuzz
// test – never end the way (without onlyFromPairs one DTLS-shaped packet did); a way the PC ends is told on A at once.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { connectSecure, type SecureChannel, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from '../../unit/devices/socket-pair.ts';
import type { Signer } from '../../../src/runtime/devices/handshake.ts';
import { b64url } from '../../../src/runtime/devices/keys.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { PhoneBridge } from '../../../src/runtime/devices/rendezvous/phone.ts';
import { MAX_SDP, MAX_TRIES, TRIES_WINDOW_MS, allowedAddress, allowedCandidate, guardSctp, onlyFromPairs, peerConfig, rtcStun, splitCandidates } from '../../../src/runtime/devices/rendezvous/rtc.ts';
import { RtcSocket } from '../../../src/runtime/devices/rendezvous/rtc-socket.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { validateSettings } from '../../../src/runtime/settings/validate.ts';
import type { Logger } from '../../../src/runtime/contracts.ts';
import { fakeHost, memoryDb } from '../../unit/devices/fakes.ts';

type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const identity = (name: string) => DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name });
const ownAddresses = Object.values(os.networkInterfaces()).flat().map((each) => each!.address.replace(/%.*$/, ''));

/** The test phones' peer connections: closed after each test, whatever happened in it. */
const peers = new Set<RTCPeerConnection>();
afterEach(async () => { await Promise.all([...peers].map((peer) => peer.close().catch(() => undefined))); peers.clear(); });

/** The PC: a runtime port that counts its TCP connections, the phone bridge with the WebRTC way, every log line. */
async function desk(t: { after(fn: () => unknown): void }, rtc: { stun?: () => readonly string[] | undefined; tryMs?: number; now?: () => number } = {}) {
  const pc = await identity('Desk');
  let connections = 0;
  const runtime = http.createServer((_req, res) => res.end('hello phone'));
  runtime.on('connection', () => { connections++; });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const records = new Map<string, DeviceRecord>();
  const lines: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const keep = (message: string, data?: Record<string, unknown>) => { lines.push({ message, data }); };
  const log: Logger = { debug: keep, info: keep, warn: keep, error: keep };
  const bridge = new PhoneBridge({
    identity: pc, log, port: () => (runtime.address() as { port: number }).port, phone: (fp) => records.get(fp),
    rtc: { stun: rtc.stun ?? (() => []), ...(rtc.tryMs ? { tryMs: rtc.tryMs } : {}), ...(rtc.now ? { now: rtc.now } : {}) },
  });
  t.after(() => { bridge.closeAll(); runtime.closeAllConnections(); runtime.close(); });
  /** A phone app paired with this PC. */
  const paired = async (name: string) => {
    const who = await identity(name);
    const record: DeviceRecord = { id: `dev_${name.toLowerCase()}`.padEnd(16, '0'), name, kind: 'phone', role: 'client', fingerprint: who.fingerprint, publicKey: b64url(who.publicKey), addresses: [], caps: {}, status: 'online', self: false };
    records.set(who.fingerprint, record);
    return { who, record };
  };
  return { pc, bridge, lines, paired, connections: () => connections, outcomes: () => lines.filter((line) => line.message.startsWith('phone rtc')).map((line) => line.data?.outcome) };
}

/** The phone's tunnel: channel A over an in-memory pair, as through the meeting server; `wire` keeps every frame. */
async function tunnel(bridge: PhoneBridge, pc: DeviceIdentity, who: Signer, record: DeviceRecord) {
  const [mine, theirs] = socketPair();
  const wire: Buffer[] = [];
  const tap = (socket: SocketLike): SocketLike => ({ ...socket, send: (data) => { wire.push(Buffer.from(data)); socket.send(data); } });
  const accepted = bridge.accept(tap(theirs), record);
  const a = await connectSecure(tap(mine), who, pc.fingerprint);
  await accepted;
  return { a, wire, inbox: inbox(a) };
}

/** The rtc messages arriving on a channel: next(ops) takes the next one of these ops, seen(op) waits for one without
 * taking it (for a race whose loser must leave the message to the next reader). */
function inbox(channel: SecureChannel) {
  const queue: Message[] = [];
  let read = 0;
  const waiters = new Set<() => void>();
  channel.onMessage((value) => { if ((value as Message)?.t === 'rtc') { queue.push(value as Message); for (const wake of [...waiters]) wake(); } });
  const until = async (find: () => Message | undefined, what: string, ms: number): Promise<Message> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${what} within ${ms} ms`);
      await new Promise<void>((resolve) => { const wake = () => { waiters.delete(wake); resolve(); }; waiters.add(wake); setTimeout(wake, left).unref(); });
    }
  };
  return {
    queue,
    next: (ops: string[], ms = 20_000) => until(() => { while (read < queue.length) { const message = queue[read++]; if (ops.includes(message.op)) return message; } return undefined; }, ops.join('/'), ms),
    seen: (op: string, ms = 20_000) => until(() => queue.slice(read).find((message) => message.op === op), op, ms),
  };
}

interface PhoneOptions {
  /** The key the phone runs the handshake on the data channel with (default: its own). */
  key?: Signer;
  /** Candidates as cand messages after an answer without them (default: inside the answer's SDP). */
  trickle?: boolean;
  /** The phone's candidates replaced (a phone that names other addresses). */
  candidates?: (lines: string[]) => string[];
  /** ICE blocked on the phone's side: no checks, no answers. */
  blocked?: boolean;
  /** Bytes the phone sends on the data channel before any handshake. */
  garbage?: Buffer;
  /** Extra bytes in the answer's SDP. */
  pad?: number;
}

/** The phone's side of a try: hello on A, werift answers the offer, the data channel's handshake, ready on B. */
interface PhoneWay { offer: Message; end?: Message; peer?: RTCPeerConnection; socket?: RtcSocket; b?: SecureChannel; ready?: Message }

async function phoneWay(tun: Awaited<ReturnType<typeof tunnel>>, pc: DeviceIdentity, me: Signer, options: PhoneOptions = {}): Promise<PhoneWay> {
  const { a, inbox: box } = tun;
  a.send({ t: 'rtc', v: 1, op: 'hello', net: 'wifi' });
  const offer = await box.next(['offer', 'no']);
  if (offer.op === 'no') return { offer };
  const blocked = options.blocked ? { iceFilterCandidatePair: () => false, iceFilterStunResponse: () => false } : {};
  const peer = new RTCPeerConnection({ iceServers: offer.ice, iceUseDefaultStunServer: false, iceUseTcp: false, ...blocked });
  peers.add(peer);
  const opened = new Promise<RTCDataChannel>((resolve) => peer.onDataChannel.subscribe(resolve));
  await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await peer.setLocalDescription(await peer.createAnswer());
  const sdp = peer.localDescription!.sdp;
  const { description, candidates } = splitCandidates(sdp);
  const lines = options.candidates ? options.candidates(candidates) : candidates;
  const pad = options.pad ? `a=x-pad:${'x'.repeat(options.pad)}\r\n` : '';
  if (options.trickle) {
    a.send({ t: 'rtc', op: 'answer', id: offer.id, sdp: description + pad });
    for (const candidate of lines) a.send({ t: 'rtc', op: 'cand', id: offer.id, c: { candidate, sdpMid: '0', sdpMLineIndex: 0 } });
    a.send({ t: 'rtc', op: 'cand', id: offer.id, done: true });
  } else {
    a.send({ t: 'rtc', op: 'answer', id: offer.id, sdp: options.candidates || pad ? description + lines.map((line) => `a=${line}\r\n`).join('') + pad : sdp });
  }
  const first = await Promise.race([opened.then((dc) => ({ dc })), box.seen('end').then(() => ({ ended: true }))]);
  if ('ended' in first) { await peer.close(); return { offer, end: await box.next(['end']), peer }; }
  const socket = new RtcSocket(first.dc);
  if (options.garbage) {
    socket.send(options.garbage);
    const end = await box.next(['end']);
    await peer.close();
    return { offer, end, peer, socket };
  }
  const b = await connectSecure(socket, options.key ?? me, pc.fingerprint).catch(() => undefined);
  if (!b) { const end = await box.next(['end']); await peer.close(); return { offer, end, peer, socket }; }
  socket.trusted();
  const ready = await inbox(b).next(['ready']);
  return { offer, peer, socket, b, ready };
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

/** Every UDP destination, UDP socket and DNS name this process used while `run` ran (the PC's and the test phone's). */
async function spied<T>(run: () => Promise<T>): Promise<{ result: T; sent: Set<string>; sockets: number; looked: string[] }> {
  const sent = new Set<string>();
  const looked: string[] = [];
  let sockets = 0;
  const proto = dgram.Socket.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const [send, bind, lookup, lookupAsync] = [proto.send, proto.bind, dns.lookup, dns.promises.lookup];
  proto.send = function (this: unknown, ...args: unknown[]) {
    const offsetForm = typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number';
    sent.add(String(offsetForm ? args[4] : args[2]).replace(/^::ffff:/, '') + ' ' + String(offsetForm ? args[3] : args[1]));
    return send.apply(this, args);
  };
  proto.bind = function (this: unknown, ...args: unknown[]) { sockets++; return bind.apply(this, args); };
  const name = (host: string) => { if (!net.isIP(host)) looked.push(host); }; // dgram resolves its IP literals too
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => { name(host); return (lookup as (...a: unknown[]) => unknown)(host, ...rest); };
  dns.promises.lookup = ((host: string, ...rest: unknown[]) => { name(host); return (lookupAsync as (...a: unknown[]) => unknown)(host, ...rest); }) as typeof dns.promises.lookup;
  try {
    return { result: await run(), sent, sockets, looked };
  } finally {
    Object.assign(proto, { send, bind });
    (dns as { lookup: unknown }).lookup = lookup;
    dns.promises.lookup = lookupAsync;
  }
}

const textOf = (value: unknown) => JSON.stringify(value);
const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/;

test('the right phone: offer and answer inside its tunnel, the handshake again on the data channel, a stream – counted as rtc, no STUN, no DNS, nothing the relay could read', async (t) => {
  const { pc, bridge, lines, paired, connections, outcomes } = await desk(t);
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  const { result: way, sent, looked } = await spied(async () => {
    const way = await phoneWay(tun, pc, who, { trickle: true }); // as Android and Safari send them (inside the SDP: the next test)
    assert.ok(way.b, `the way stands (${textOf(way.end ?? {})})`);
    const reply = await get(way.b!, 1);
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /hello phone$/);
    return way;
  });
  assert.deepEqual(way.offer.ice, [], 'the offer names exactly the STUN list of the settings: none here');
  assert.equal(way.ready?.id, way.offer.id, 'ready on B names the try');
  assert.equal(connections(), 1, 'exactly the one stream reached the runtime port');

  const [count] = bridge.counts();
  assert.equal(count.via, 'rtc', 'the phone runs on the WebRTC way now');
  assert.ok(count.rtc > 200 && count.relay > 0 && count.direct === 0, `bytes per way: rtc ${count.rtc}, relay ${count.relay}`);
  assert.equal(tun.a.closed, false, 'the tunnel stays open as the way back');
  assert.match(await get(tun.a, 2), /hello phone$/, 'and still carries streams');

  assert.deepEqual(looked, [], 'no DNS name was looked up (no STUN, never stun.l.google.com)');
  for (const target of sent) assert.ok(ownAddresses.includes(target.split(' ')[0]), `UDP only to this PC's own addresses, not ${target}`);
  const tunnelBytes = Buffer.concat(tun.wire).toString('latin1');
  for (const marker of ['candidate', 'ice-ufrag', 'fingerprint', 'v=0', 'webrtc-datachannel', ...ownAddresses.filter((address) => address.length > 3)]) {
    assert.equal(tunnelBytes.includes(marker), false, `the tunnel's bytes never show "${marker}" (sealed in channel A)`);
  }

  way.b!.send({ t: 'rtc', v: 1, op: 'hello' }); // a hello on B itself
  await assert.rejects(inbox(way.b!).next(['offer', 'no'], 800), 'B carries no signalling');

  const ok = lines.find((line) => line.message === 'phone rtc' && line.data?.outcome === 'ok');
  assert.ok(ok, `the try is logged (${textOf(outcomes())})`);
  assert.deepEqual([ok.data?.local, ok.data?.remote, ok.data?.net], ['host', 'host', 'wifi'], 'with candidate types and the phone\'s network kind');
  for (const address of ownAddresses) assert.equal(textOf(lines).includes(`"${address}"`) || textOf(lines).includes(` ${address} `), false, `no log line names ${address}`);
  assert.equal(IPV4.test(textOf(lines)), false, 'no IPv4 address in any log line');

  way.b!.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(bridge.counts()[0].via, 'relay', 'B closed: the phone is on its tunnel again');
  assert.ok(lines.some((line) => line.message === 'phone rtc ended'), 'the way\'s end is logged');
});

test('DTLS is no trust: a stranger\'s key or another paired phone\'s on the data channel is refused (4003) – no stream, the tunnel goes on and takes no more tries', async (t) => {
  const { pc, bridge, paired, connections, outcomes } = await desk(t);
  const { who, record } = await paired('Pixel');
  const other = await paired('Galaxy');
  const stranger = await identity('Stranger');
  for (const [key, what] of [[stranger, 'an unknown key'], [other.who, 'another paired phone\'s key']] as const) {
    const tun = await tunnel(bridge, pc, who, record);
    const before = connections();
    const way = await phoneWay(tun, pc, who, { key });
    assert.equal(way.b, undefined, `${what} gets no channel`);
    assert.equal(way.end?.why, 'refused', `${what}: the phone hears why on its tunnel`);
    assert.equal(connections(), before, `${what}: nothing reached the runtime port`);
    tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
    assert.deepEqual((await tun.inbox.next(['no', 'offer'])).why, 'refused', 'no further try on this tunnel');
    assert.match(await get(tun.a, 1), /hello phone$/, `${what}: the tunnel keeps serving the phone`);
    tun.a.close();
  }
  assert.deepEqual(outcomes().filter((outcome) => outcome === 'refused').length, 4, `two refusals and two refused hellos (${textOf(outcomes())})`);
});

test('a way that never connects ends after the try\'s time; the tunnel keeps serving, and a later try is welcome', async (t) => {
  const { pc, bridge, paired, outcomes } = await desk(t, { tryMs: 2_500 });
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  const started = Date.now();
  const way = await phoneWay(tun, pc, who, { blocked: true });
  assert.equal(way.b, undefined);
  assert.ok(['timeout', 'failed'].includes(way.end?.why), `the try ended: ${way.end?.why}`);
  assert.ok(Date.now() - started < 6_000, 'within the try\'s time');
  assert.match(await get(tun.a, 1), /hello phone$/, 'the tunnel carries the stream');
  assert.equal(bridge.counts()[0].via, 'relay');
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  const again = await tun.inbox.next(['offer', 'no']);
  assert.equal(again.op, 'offer', 'a failed way is no refusal: the next try gets an offer');
  tun.a.send({ t: 'rtc', op: 'end', id: again.id });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(outcomes().includes('ended'), textOf(outcomes()));
});

test('binary data before the handshake on the data channel ends it – nothing reaches the runtime port', async (t) => {
  const { pc, bridge, paired, connections } = await desk(t);
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  const way = await phoneWay(tun, pc, who, { garbage: Buffer.from(JSON.stringify({ t: 'o', s: 1 })) });
  assert.equal(way.b, undefined);
  assert.equal(way.end?.why, 'failed');
  assert.equal(way.socket?.closed, true, 'the PC closed the data channel');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(connections(), 0);
});

test('signalling only after the tunnel\'s handshake: an rtc hello in its place is no handshake – no offer, no UDP socket; an older phone that never says hello keeps its tunnel as before', async (t) => {
  const { pc, bridge, lines, paired, connections } = await desk(t);
  const { who, record } = await paired('Pixel');
  const { result, sockets } = await spied(async () => {
    const [mine, theirs] = socketPair();
    const refused = bridge.accept(theirs, record);
    mine.send(JSON.stringify({ t: 'rtc', v: 1, op: 'hello' }));
    await assert.rejects(refused, 'the PC wanted the handshake\'s hello');
    const [binary, binaryTheirs] = socketPair();
    const refusedBinary = bridge.accept(binaryTheirs, record);
    binary.send(Buffer.from(JSON.stringify({ t: 'rtc', v: 1, op: 'hello' })));
    await assert.rejects(refusedBinary);
    const older = await tunnel(bridge, pc, who, record); // never says hello
    return get(older.a, 1);
  });
  assert.match(result, /hello phone$/, 'the older phone\'s stream runs through its tunnel');
  assert.equal(connections(), 1);
  assert.equal(sockets, 0, 'werift never bound a UDP socket');
  assert.equal(lines.some((line) => line.message.startsWith('phone rtc')), false, 'no try was made');
  assert.deepEqual(bridge.counts().map((count) => [count.via, count.rtc]), [['relay', 0]]);
});

test('the limits: an SDP past 16 KiB ends the try; one try per phone (busy); off; an unknown version; at most 8 peer connections (full)', async (t) => {
  let stun: readonly string[] | undefined = [];
  const { pc, bridge, paired } = await desk(t, { stun: () => stun });
  const { who, record } = await paired('Pixel');
  const big = await phoneWay(await tunnel(bridge, pc, who, record), pc, who, { pad: MAX_SDP });
  assert.equal(big.end?.why, 'failed', 'the oversized answer ended the try');

  const tun = await tunnel(bridge, pc, who, record);
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  assert.equal((await tun.inbox.next(['no'])).why, 'busy', 'a second hello while one try runs');
  tun.a.send({ t: 'rtc', v: 2, op: 'hello' });
  assert.equal((await tun.inbox.next(['no'])).why, 'version');
  stun = undefined;
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  assert.equal((await tun.inbox.next(['no'])).why, 'off', 'devices.rtc false');
  stun = [];
  tun.a.close();

  const tunnels = [];
  for (let i = 0; i < 9; i++) {
    const phone = await paired(`Phone${i}`);
    const each = await tunnel(bridge, pc, phone.who, phone.record);
    each.a.send({ t: 'rtc', v: 1, op: 'hello' });
    tunnels.push(each);
  }
  const answers = await Promise.all(tunnels.map((each) => each.inbox.next(['offer', 'no'])));
  assert.deepEqual(answers.map((answer) => answer.op === 'no' ? answer.why : answer.op), [...Array(8).fill('offer'), 'full']);
  for (const each of tunnels) each.a.close();
});

test('candidates that never get a packet: loopback, 0/8, link-local and the metadata address, multicast, broadcast, ports below 1024 – in the answer and trickled; private LAN, 100.64/10 and public pass', async (t) => {
  const line = (address: string, port: number, type = 'host') => `candidate:1 1 udp 2122260223 ${address} ${port} typ ${type}`;
  const refused = [['127.0.0.1', 50000], ['127.8.9.10', 50000], ['0.0.0.0', 50000], ['0.1.2.3', 50000], ['169.254.169.254', 50000], ['169.254.1.1', 50000],
    ['224.0.0.251', 50000], ['239.255.255.250', 50000], ['255.255.255.255', 50000], ['240.0.0.1', 50000], ['::1', 50000], ['::', 50000],
    ['::ffff:127.0.0.1', 50000], ['fe80::1', 50000], ['ff02::1', 50000], ['64:ff9b::7f00:1', 50000], ['10.0.0.5', 80], ['192.168.1.2', 1023], ['192.168.1.2', 0]] as const;
  for (const [address, port] of refused) assert.equal(allowedCandidate(line(address, port)), undefined, `${address} ${port}`);
  for (const [address, port] of [['10.0.0.5', 50000], ['172.16.4.4', 1024], ['192.168.1.2', 65535], ['100.64.1.1', 41641], ['100.127.255.1', 50000], ['fd7a:115c:a1e0::1', 50000], ['2001:db8::7', 50000], ['203.0.113.7', 50000]] as const) {
    assert.equal(allowedCandidate(line(address, port, 'srflx')), 'srflx', `${address} ${port}`);
  }
  assert.equal(allowedCandidate(line('5b9c1f2e-1d2a-4f6b-9c1e-0a1b2c3d4e5f.local', 50000)), 'host', 'an mDNS name passes; what it resolves to meets the pair filter');
  assert.equal(allowedCandidate('candidate:1 1 tcp 2122260223 10.0.0.5 50000 typ host tcptype passive'), undefined, 'UDP only');
  assert.equal(allowedCandidate(line('evil.example.com', 50000)), undefined, 'no DNS names');
  const config = peerConfig([]);
  assert.equal(config.iceFilterCandidatePair({ remoteCandidate: { host: '169.254.169.254', port: 50000 } }), false, 'pair filter: a resolved name on link-local');
  assert.equal(config.iceFilterCandidatePair({ remoteCandidate: { host: '10.0.0.5', port: 50000 } }), true);
  assert.equal(config.iceFilterStunResponse(undefined, ['127.0.0.1', 50000]), false, 'no answer to a check from loopback (no peer-reflexive pair)');
  assert.equal(allowedAddress('10.0.0.5', 50000), true);

  const { pc, bridge, lines, paired } = await desk(t);
  const { who, record } = await paired('Pixel');
  const forbidden = refused.filter(([address, port]) => port > 0 && !address.startsWith('::ffff')).map(([address, port]) => line(address, port));
  for (const trickle of [false, true]) {
    const tun = await tunnel(bridge, pc, who, record);
    const { result: way, sent } = await spied(() => phoneWay(tun, pc, who, { trickle, candidates: () => forbidden }));
    way.peer?.close();
    for (const [address, port] of refused) assert.equal(sent.has(`${address} ${port}`), false, `${trickle ? 'trickled' : 'in the answer'}: no packet to ${address} ${port}`);
    tun.a.close();
  }
  const dropped = lines.filter((each) => each.message === 'phone rtc' && typeof each.data?.dropped === 'number').map((each) => each.data!.dropped);
  assert.deepEqual(dropped, [forbidden.length, forbidden.length], `every forbidden candidate counted as dropped (${textOf(dropped)})`);
});

test('werift is pinned exactly and runs with exactly the settings\' STUN list – [] stays empty, never Google (werift\'s own default would be); settings: Cloudflare by default, off, checked', async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.match(pkg.dependencies.werift, /^\d+\.\d+\.\d+$/, 'an exact version, no range');
  assert.equal(lock.packages['node_modules/werift'].version, pkg.dependencies.werift);

  const config = peerConfig([]);
  assert.deepEqual([config.iceServers, config.iceUseDefaultStunServer, config.iceUseTcp], [[], false, false]);
  assert.deepEqual(peerConfig(['stun:stun.cloudflare.com:3478']).iceServers, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  const servers = async (options: object) => {
    const peer = new RTCPeerConnection(options);
    peers.add(peer);
    peer.createDataChannel('x');
    await peer.createOffer(); // no gathering, no packet
    const list = (peer.iceTransports[0] as unknown as { connection: { stunServers: unknown } }).connection.stunServers;
    await peer.close();
    return list;
  };
  assert.deepEqual(await servers(peerConfig([])), [], 'ours: no STUN server at all');
  assert.deepEqual(await servers({}), [['stun.l.google.com', 19302]], 'werift\'s defaults would ask Google – the test would see it');
  assert.deepEqual(await servers({ iceServers: [] }), [['stun.l.google.com', 19302]], 'even behind an empty list');

  const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  assert.deepEqual(rtcStun(settings.devices), ['stun:stun.cloudflare.com:3478'], 'Konrad 16.11.2026: Cloudflare by default');
  assert.deepEqual(rtcStun({ ...settings.devices, stun: [] }), [], 'empty stays empty');
  assert.equal(rtcStun({ ...settings.devices, rtc: false }), undefined, 'off');
  for (const stun of [['stun:[2606:4700:4700::1111]:3478'], [], ['stun:stun.example.org']]) validateSettings({ ...settings, devices: { ...settings.devices, stun } });
  for (const stun of [['turn:relay.example.org:3478'], ['https://example.org'], ['stun:a', 'stun:b', 'stun:c', 'stun:d', 'stun:e'], 'stun:x' as never]) {
    assert.throws(() => validateSettings({ ...settings, devices: { ...settings.devices, stun } }), /devices\.stun/, textOf(stun));
  }
  assert.throws(() => validateSettings({ ...settings, devices: { ...settings.devices, rtc: 'yes' as never } }), /devices\.rtc/);
});

/** A STUN server on this PC's network (RFC 5389 Binding): it answers every request with the public address 203.0.113.7:40000. */
async function stunServer() {
  const host = ownAddresses.find((address) => net.isIPv4(address) && !address.startsWith('127.'))!;
  const socket = dgram.createSocket('udp4');
  let asked = 0;
  socket.on('message', (request, from) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 0x0001) return;
    asked++;
    const mapped = Buffer.alloc(12);
    mapped.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
    mapped.writeUInt16BE(8, 2);
    mapped[5] = 0x01;
    mapped.writeUInt16BE(40000 ^ 0x2112, 6);
    mapped.writeUInt32BE((((203 << 24) | (0 << 16) | (113 << 8) | 7) ^ 0x2112a442) >>> 0, 8);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0);
    header.writeUInt16BE(mapped.length, 2);
    request.copy(header, 4, 4, 20);
    socket.send(Buffer.concat([header, mapped]), from.port, from.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, host, resolve));
  return { url: `stun:${host}:${socket.address().port}`, asked: () => asked, close: () => socket.close() };
}

test('the STUN list of the settings reaches both ends: the offer names it, and werift asks exactly that server – a server-reflexive candidate', async (t) => {
  const stun = await stunServer();
  t.after(() => stun.close());
  const { pc, bridge, paired } = await desk(t, { stun: () => [stun.url] });
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  const { result: offer, looked } = await spied(async () => {
    tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
    return tun.inbox.next(['offer']);
  });
  assert.deepEqual(offer.ice, [{ urls: [stun.url] }], 'the phone gets exactly this list');
  assert.ok(stun.asked() > 0, 'the PC asked the configured server');
  assert.match(offer.sdp, /203\.0\.113\.7 40000 typ srflx/, 'and offers the address it learned there');
  assert.deepEqual(looked, [], 'an address, no name: nothing looked up');
  tun.a.close();
});

test('a stranger\'s datagrams at the PC\'s ICE sockets – STUN-, DTLS- and RTP-shaped and random, from this very address – never end the way, and nothing throws', async (t) => {
  const thrown: unknown[] = [];
  const caught = (error: unknown) => { thrown.push(error); };
  process.on('unhandledRejection', caught);
  process.on('uncaughtException', caught);
  t.after(() => { process.off('unhandledRejection', caught); process.off('uncaughtException', caught); });
  const { pc, bridge, paired } = await desk(t);
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  const way = await phoneWay(tun, pc, who, { trickle: true });
  assert.ok(way.b, 'the way stands');
  const targets = [...String(way.offer.sdp).matchAll(/a=candidate:\S+ \d+ udp \d+ (\d+\.\d+\.\d+\.\d+) (\d+) typ host/g)].map((m) => [m[1], Number(m[2])] as const);
  assert.ok(targets.length > 0);
  const stranger = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => stranger.bind(0, resolve));
  t.after(() => stranger.close());
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let stream = 1;
  for (const kind of ['stun', 'dtls', 'rtp', 'random']) {
    for (let i = 0; i < 500; i++) {
      const datagram = Buffer.alloc(1 + Math.floor(random() * 1200));
      for (let j = 0; j < datagram.length; j++) datagram[j] = Math.floor(random() * 256);
      if (kind === 'stun') { datagram[0] = Math.floor(random() * 4); if (datagram.length > 8) datagram.writeUInt32BE(0x2112a442, 4); }
      if (kind === 'dtls') { datagram[0] = 20 + Math.floor(random() * 44); if (datagram.length > 3) { datagram[1] = 0xfe; datagram[2] = 0xfd; } }
      if (kind === 'rtp') datagram[0] = 128 + Math.floor(random() * 64);
      for (const [host, port] of targets) stranger.send(datagram, port, host);
      if (i % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reply = await Promise.race([get(way.b!, stream++), new Promise<string>((resolve) => setTimeout(() => resolve('no answer'), 5_000))]);
    assert.match(reply, /hello phone$/, `after 500 ${kind} datagrams the way still carries a stream`);
  }
  assert.equal(bridge.counts()[0].via, 'rtc');
  assert.deepEqual(thrown, [], 'no unhandled error in this process');
});

test('when the PC ends a standing way, the phone hears end on its tunnel at once – it never waits on a dead channel', async (t) => {
  const { pc, bridge, paired } = await desk(t);
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  const way = await phoneWay(tun, pc, who, { trickle: true });
  assert.ok(way.b);
  const ways = (bridge as unknown as { rtc: { live: Set<{ pc?: RTCPeerConnection }> } }).rtc.live;
  for (const each of ways) await each.pc!.close(); // the PC's side goes, as when its DTLS ends
  const end = await tun.inbox.next(['end'], 5_000);
  assert.equal(end.id, way.offer.id);
  assert.ok(['lost', 'closed'].includes(end.why), end.why);
  assert.match(await get(tun.a, 1), /hello phone$/, 'the streams run on the tunnel again');
});

// Noah's review of P1 (16.11.2026): fail-closed without the guards, werift's SCTP throw caught, at most 6 tries in 10 min.
test('fail-closed: when werift could not be guarded there is no offer – the try ends failed, the tunnel goes on', async (t) => {
  assert.equal(onlyFromPairs({ iceTransports: [] } as never), false, 'no ICE internals: no guard');
  assert.equal(guardSctp({} as never, () => undefined), false, 'no SCTP transport: no guard');
  const probe = new RTCPeerConnection({});
  probe.createDataChannel('probe');
  const proto = Object.getPrototypeOf((probe as unknown as { sctpTransport: { sctp: object } }).sctpTransport.sctp) as { handleData: unknown };
  await probe.close();
  const handle = proto.handleData;
  proto.handleData = undefined; // as if werift moved its insides: guardSctp finds no SCTP receive to hold
  t.after(() => { proto.handleData = handle; });
  const { pc, bridge, paired, outcomes, lines } = await desk(t);
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  const answer = await tun.inbox.next(['offer', 'end', 'no']);
  assert.equal(answer.op, 'end', 'no offer');
  assert.equal(answer.why, 'failed');
  assert.ok(lines.some((line) => /could not be guarded/.test(line.message)));
  assert.deepEqual(outcomes().filter(Boolean), ['failed'], 'one try, ended failed (the warning carries no outcome)');
  assert.match(await get(tun.a, 1), /hello phone$/, 'the tunnel still carries the streams');
});

test("werift's SCTP receive throws inside its guard: the try hears it, nothing is left unhandled", async (t) => {
  const pc = new RTCPeerConnection({});
  t.after(() => pc.close());
  pc.createDataChannel('autark');
  const thrown: unknown[] = [];
  assert.equal(guardSctp(pc, (error) => thrown.push(error)), true, 'werift 0.27.0: the association is reachable');
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', note);
  t.after(() => process.off('unhandledRejection', note));
  const sctp = (pc as unknown as { sctpTransport: { sctp: { handleData(data: unknown): Promise<unknown> } } }).sctpTransport.sctp;
  assert.equal(await sctp.handleData(undefined), undefined, 'a broken packet resolves instead of rejecting');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thrown.length, 1, 'the try heard the throw');
  assert.ok(thrown[0] instanceof TypeError);
  assert.deepEqual(unhandled, []);
});

test('at most 6 tries per phone in 10 minutes – the next hello hears no {why: later}; after the window it is welcome again', async (t) => {
  let now = 1_000_000;
  const { pc, bridge, paired } = await desk(t, { now: () => now });
  const { who, record } = await paired('Pixel');
  const tun = await tunnel(bridge, pc, who, record);
  for (let i = 0; i < MAX_TRIES; i++) {
    tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
    const offer = await tun.inbox.next(['offer', 'no']);
    assert.equal(offer.op, 'offer', `try ${i + 1}`);
    tun.a.send({ t: 'rtc', v: 1, op: 'end', id: offer.id, why: 'ended' });
    now += 1_000;
  }
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  assert.deepEqual(await tun.inbox.next(['offer', 'no']).then((m) => [m.op, m.why]), ['no', 'later']);
  const other = await paired('Galaxy');
  const tun2 = await tunnel(bridge, pc, other.who, other.record);
  tun2.a.send({ t: 'rtc', v: 1, op: 'hello' });
  assert.equal((await tun2.inbox.next(['offer', 'no'])).op, 'offer', 'the limit is per phone');
  now += TRIES_WINDOW_MS;
  tun.a.send({ t: 'rtc', v: 1, op: 'hello' });
  assert.equal((await tun.inbox.next(['offer', 'no'])).op, 'offer', 'ten minutes later');
});
