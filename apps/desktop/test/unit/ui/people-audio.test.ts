// Team-Call 21.11.2026: the negotiation of people audio (src/ui/chat/call/people-audio.ts) with fake peer connections –
// the smaller id offers, the larger says hello (and a hello makes the smaller offer anew); a signal from a window that is no
// peer is left alone; an offer is answered; the SDP goes out with Opus mono, FEC, DTX and the bitrate cap; a peer that
// leaves the list is closed with bye; a failed connection is offered again; mute and leaving reach the microphone.
// Owns: these assertions only. Never: a real browser or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallSignal } from '../../../src/shared/model/call.ts';
import { peopleCalls } from '../../../src/ui/chat/call/people-call.ts';
import { AUDIO_MAX_BPS, PeopleAudio, RETRIES, tunedOpus, type PeerLike } from '../../../src/ui/chat/call/people-audio.ts';

const SDP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=candidate:1 1 udp 1 192.168.1.2 50000 typ host'].join('\r\n');

class FakePeer implements PeerLike {
  localDescription: { sdp: string } | null = null;
  iceGatheringState = 'complete';
  connectionState = 'new';
  signalingState = 'stable';
  remote: Array<{ type: string; sdp: string }> = [];
  tracks = 0;
  recvOnly = 0;
  closed = false;
  bitrate?: unknown;
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: readonly MediaStream[] }) => void) | null = null;
  addTrack() { this.tracks++; return { getParameters: () => ({ encodings: [{}] }), setParameters: async (parameters: unknown) => { this.bitrate = parameters; } }; }
  addTransceiver() { this.recvOnly++; return {}; }
  async createOffer() { return { type: 'offer', sdp: SDP }; }
  async createAnswer() { return { type: 'answer', sdp: SDP }; }
  async setLocalDescription(description: { type: string; sdp?: string }) { this.localDescription = { sdp: description.sdp ?? '' }; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }) { this.remote.push(description); this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  close() { this.closed = true; }
}

function rig(options: { mic?: boolean } = {}) {
  const peers: FakePeer[] = [];
  const sent: Array<[string, CallSignal]> = [];
  const played: Array<[string, boolean]> = [];
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const audio = new PeopleAudio({
    peer: () => { const peer = new FakePeer(); peers.push(peer); return peer; },
    mic: async () => { if (options.mic === false) throw new Error('denied'); return stream; },
    play: (id, media) => played.push([id, media !== null]),
    send: async (to, data) => { sent.push([to, data]); return true; },
    wait: async () => undefined,
  });
  const settle = async () => { for (let round = 0; round < 10; round++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
  return { audio, peers, sent, played, track, settle };
}

test('tunedOpus: the Opus line asks for mono, FEC, DTX and the cap; other params stay; an SDP without Opus stays as it is', () => {
  const line = tunedOpus(SDP).split('\r\n').find((entry) => entry.startsWith('a=fmtp:111'))!;
  assert.equal(line, `a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=${AUDIO_MAX_BPS}`);
  const bare = tunedOpus(SDP.replace('\r\na=fmtp:111 minptime=10;useinbandfec=1', '')).split('\r\n');
  assert.equal(bare[bare.indexOf('a=rtpmap:111 opus/48000/2') + 1].startsWith('a=fmtp:111 '), true, 'a line is added after the codec');
  assert.equal(tunedOpus('v=0\r\nm=audio 9 RTP 0'), 'v=0\r\nm=audio 9 RTP 0');
});

test('the smaller id offers with its microphone and the capped SDP; the answer completes it; the larger one says hello', async () => {
  const a = rig();
  a.audio.update('pc_a/device:pc', [{ id: 'pc_b/device:pc', name: 'Momo' }]);
  await a.settle();
  assert.equal(a.peers.length, 1);
  assert.equal(a.peers[0].tracks, 1);
  assert.deepEqual((a.peers[0].bitrate as { encodings: Array<{ maxBitrate: number }> }).encodings[0].maxBitrate, AUDIO_MAX_BPS);
  const [to, offer] = a.sent[0];
  assert.equal(to, 'pc_b/device:pc');
  assert.equal(offer.op, 'offer');
  assert.match((offer as { sdp: string }).sdp, /usedtx=1/);
  a.audio.receive('pc_b/device:pc', { op: 'answer', sdp: SDP });
  await a.settle();
  assert.deepEqual(a.peers[0].remote.map((entry) => entry.type), ['answer']);
  a.peers[0].ontrack?.({ streams: [{} as MediaStream] });
  assert.deepEqual(a.played, [['pc_b/device:pc', true]], 'the far side plays as it comes');

  const b = rig();
  b.audio.update('pc_b/device:pc', [{ id: 'pc_a/device:pc', name: 'Dominik' }]);
  await b.settle();
  assert.deepEqual(b.sent, [['pc_a/device:pc', { op: 'hello' }]]);
  assert.equal(b.peers.length, 0, 'it waits for the offer');
  b.audio.receive('pc_x/device:pc', { op: 'offer', sdp: SDP });
  await b.settle();
  assert.equal(b.peers.length, 0, 'no peer: left alone');
  b.audio.receive('pc_a/device:pc', { op: 'offer', sdp: SDP });
  await b.settle();
  assert.deepEqual([b.peers[0].remote[0].type, b.sent.at(-1)?.[1].op], ['offer', 'answer']);
});

test('a hello makes the smaller offer anew; a peer gone from the list is closed with bye; a failed connection is offered again a few times', async () => {
  const { audio, peers, sent, settle } = rig();
  audio.update('pc_a/device:pc', [{ id: 'pc_b/device:pc', name: 'Momo' }]);
  await settle();
  audio.receive('pc_b/device:pc', { op: 'hello' });
  await settle();
  assert.deepEqual([peers.length, peers[0].closed, sent.filter(([, data]) => data.op === 'offer').length], [2, true, 2]);
  for (let round = 0; round < RETRIES + 2; round++) {
    const current = peers.at(-1)!;
    current.connectionState = 'failed';
    current.onconnectionstatechange?.();
    await settle();
  }
  assert.equal(peers.length, 2 + RETRIES, `offered again ${RETRIES} times, then it stops`);
  audio.update('pc_a/device:pc', []);
  assert.deepEqual([peers.at(-1)!.closed, sent.at(-1)], [true, ['pc_b/device:pc', { op: 'bye' }]]);
});

test('mute disables the microphone track; leaving closes the connections and stops it; no microphone: receive only', async () => {
  const { audio, peers, track, settle } = rig();
  audio.update('pc_a/device:pc', [{ id: 'pc_b/device:pc', name: 'Momo' }]);
  await settle();
  audio.setMuted(true);
  await settle();
  assert.equal(track.enabled, false);
  audio.close();
  await settle();
  assert.deepEqual([peers[0].closed, track.stopped], [true, true]);

  const deaf = rig({ mic: false });
  deaf.audio.update('pc_a/device:pc', [{ id: 'pc_b/device:pc', name: 'Momo' }]);
  await deaf.settle();
  assert.deepEqual([deaf.peers[0].tracks, deaf.peers[0].recvOnly, deaf.sent[0][1].op], [0, 1, 'offer']);
});

test('peopleCalls: every running call this window talks in, in any chat; its key changes with the devices in it', () => {
  const base = { rowId: 'm', state: 'running' as const, holder: 'pc_a/device:pc' };
  const calls = [
    { ...base, callId: 'call_1', conversationId: 'ch_1', device: 'Dominik and Momo' },
    { ...base, callId: 'call_2', conversationId: 'ch_2', device: 'Dominik' },
    { ...base, callId: 'call_3', conversationId: 'ch_3', state: 'ringing' as const },
  ];
  const talking = (id: string) => id !== 'ch_2';
  assert.deepEqual(peopleCalls(calls, talking), [{ callId: 'call_1', conversationId: 'ch_1', key: 'pc_a/device:pc Dominik and Momo' }]);
  assert.notEqual(peopleCalls([{ ...calls[0], device: 'Dominik' }], talking)[0].key, peopleCalls(calls, talking)[0].key);
});
