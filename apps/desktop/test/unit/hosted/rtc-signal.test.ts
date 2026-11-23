// Socket-free RTC signalling regressions. Runtime/browser parity and real ICE remain in test/native.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SDP, allowedAddress, ownCandidate, pcCandidate, readOffer, rtcConfig, stunOf } from '../../../src/ui/hosted/rtc-signal.ts';

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
});

test('iceServers come only from the offer and only as the one opted-in STUN server; an empty list stays empty', () => {
  assert.deepEqual(stunOf([]), []);
  assert.deepEqual(stunOf(undefined), []);
  assert.deepEqual(rtcConfig([]).iceServers, [], 'no list, no server – never one of the browser’s own');
  assert.deepEqual(stunOf([{ urls: ['stun:stun.cloudflare.com:3478', 'turn:evil.example', 'stun:u@x.example', 'stun:a.example?transport=tcp'] }, { urls: 'stun:[2001:db8::1]:3478' }]),
    ['stun:stun.cloudflare.com:3478'], 'any other STUN, TURN or credentialed URL is dropped');
  assert.deepEqual(stunOf([{ urls: ['stun:a', 'stun:b', 'stun:c', 'stun:d', 'stun:e'] }]), [], 'servers outside the opt-in give none');
  assert.deepEqual(rtcConfig(['stun:a.example']).iceServers, [], 'the browser config reapplies the boundary');
  assert.deepEqual(rtcConfig(['stun:stun.cloudflare.com:3478']).iceServers, [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
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
