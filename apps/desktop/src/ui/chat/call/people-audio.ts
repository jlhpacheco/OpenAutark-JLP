// Team-Call 21.11.2026 (owner: "die sollten ja eigentlich ihr Audio wirklich hören, wie beim WhatsApp-Call … gecompacted,
// aber schon gute Qualität … je nachdem, wie die Internetqualität … so schnell wie möglich"): the people in a call hear
// each other live. Each PC window in the call holds one WebRTC peer connection (Chromium's: Opus, echo cancellation, noise
// suppression and auto gain on the microphone, congestion control picks the bitrate) to every other person's PC window
// the runtime names (calls.peers – never another device of this person). Direct between the PCs over UDP; the SDP goes
// through the runtimes' mesh link (calls.signal → runtime/calls/call-peer.ts → the event calls.signal there).
// Who offers: the smaller id (callHolder form) of a pair; the larger says hello when it sees the other, and a hello
// makes the smaller offer anew – so a signal that arrived before the other side knew the call heals by itself. No
// trickle: an SDP goes out with its candidates (≤ GATHER_MS of gathering). The SDP that goes out asks the other side to
// send Opus mono with in-band FEC and DTX at ≤ AUDIO_MAX_BPS (tunedOpus); the sender caps itself the same way. No
// buffering of our own: the remote track plays as it comes (Chromium's jitter buffer only). A failed connection is offered
// again by the offerer, up to RETRIES times. Mute (mute.ts) disables the microphone track; leaving closes every
// connection and the microphone.
// Owns: the peer connections of this window's call and their negotiation. Never: who is in the call (the runtime) or the
// agent's voice (the voice conversation reads it on this device).

import type { CallPeer, CallSignal } from '../../../shared/model/call.ts';

/** The most the far side should send us (bits per second of Opus mono). */
export const AUDIO_MAX_BPS = 40_000;
/** How long an SDP waits for its candidates before it goes out with those it has. */
export const GATHER_MS = 1_500;
/** A failed connection is offered again this many times, RETRY_MS apart. */
export const RETRIES = 3;
export const RETRY_MS = 2_000;

/** The part of RTCPeerConnection this file uses (the browser's, or a test's fake). */
export interface PeerLike {
  readonly localDescription: { sdp: string } | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  readonly signalingState: string;
  onicegatheringstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: { streams: readonly MediaStream[] }) => void) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): { setParameters?(parameters: unknown): Promise<void>; getParameters?(): { encodings?: Array<Record<string, unknown>> } };
  addTransceiver(kind: 'audio', init: { direction: 'recvonly' }): unknown;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  close(): void;
}

export interface PeopleAudioDeps {
  peer(): PeerLike;
  /** The microphone (opened once, with echo cancellation, noise suppression, auto gain); a rejection: receive only. */
  mic(): Promise<MediaStream>;
  /** Plays a peer's audio (null: stops it). */
  play(peerId: string, stream: MediaStream | null): void;
  send(to: string, data: CallSignal): Promise<boolean>;
  wait?(ms: number): Promise<void>;
}

interface Link { pc: PeerLike; offerer: boolean; tries: number }

/** The SDP as it goes out: its Opus line asks the far side for mono, FEC, DTX and at most AUDIO_MAX_BPS. */
export function tunedOpus(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const want: Record<string, string> = { minptime: '10', useinbandfec: '1', usedtx: '1', stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: String(AUDIO_MAX_BPS) };
  const lines = sdp.split('\r\n');
  const at = lines.findIndex((line) => line.startsWith(`a=fmtp:${pt} `));
  const have = new Map((at >= 0 ? lines[at].slice(`a=fmtp:${pt} `.length).split(';') : []).filter(Boolean).map((part) => part.trim().split('=') as [string, string]));
  for (const [key, value] of Object.entries(want)) have.set(key, value);
  const line = `a=fmtp:${pt} ${[...have].map(([key, value]) => `${key}=${value}`).join(';')}`;
  if (at >= 0) lines[at] = line;
  else lines.splice(lines.findIndex((entry) => entry.startsWith(`a=rtpmap:${pt} `)) + 1, 0, line);
  return lines.join('\r\n');
}

export class PeopleAudio {
  private readonly deps: PeopleAudioDeps;
  private me = '';
  private peers = new Set<string>();
  private readonly links = new Map<string, Link>();
  private stream?: Promise<MediaStream | undefined>;
  private muted = false;
  private closed = false;

  constructor(deps: PeopleAudioDeps) { this.deps = deps; }

  /** Who this window is and whom it hears now: new peers are greeted, gone ones closed. */
  update(me: string, peers: readonly CallPeer[]): void {
    if (this.closed) return;
    this.me = me;
    const next = new Set(peers.map((peer) => peer.id).filter((id) => id !== me));
    for (const id of [...this.links.keys()]) if (!next.has(id)) { void this.deps.send(id, { op: 'bye' }).catch(() => false); this.drop(id); }
    const added = [...next].filter((id) => !this.peers.has(id));
    this.peers = next;
    for (const id of added) this.greet(id);
  }

  /** A signal from a peer (the event calls.signal); one from a window that is no peer now is left alone (its hello heals it). */
  receive(from: string, data: CallSignal): void {
    if (this.closed || !this.peers.has(from)) return;
    if (data.op === 'hello') { if (this.offers(from)) void this.offer(from).catch(() => undefined); }
    else if (data.op === 'offer') void this.answer(from, data.sdp).catch(() => undefined);
    else if (data.op === 'answer') void this.answered(from, data.sdp);
    else this.drop(from);
  }

  setMuted(on: boolean): void {
    this.muted = on;
    void this.stream?.then((stream) => { for (const track of stream?.getAudioTracks() ?? []) track.enabled = !on; });
  }

  /** This window leaves the call: every connection and the microphone close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.links.keys()]) { void this.deps.send(id, { op: 'bye' }).catch(() => false); this.drop(id); }
    void this.stream?.then((stream) => { for (const track of stream?.getTracks() ?? []) track.stop(); });
  }

  /** The peer connection to `id` while it stands (tests read its state). */
  link(id: string): PeerLike | undefined { return this.links.get(id)?.pc; }

  private offers(id: string): boolean { return this.me < id; }

  private greet(id: string): void {
    if (this.offers(id)) void this.offer(id).catch(() => undefined);
    else void this.deps.send(id, { op: 'hello' }).catch(() => false);
  }

  private microphone(): Promise<MediaStream | undefined> {
    this.stream ??= this.deps.mic().then((stream) => { for (const track of stream.getAudioTracks()) track.enabled = !this.muted; return stream; }, () => undefined);
    return this.stream;
  }

  /** A fresh connection to `id` (the old one closes) with this window's microphone on it. */
  private async open(id: string, offerer: boolean, tries = 0): Promise<Link | undefined> {
    this.drop(id);
    const link: Link = { pc: this.deps.peer(), offerer, tries };
    this.links.set(id, link);
    const { pc } = link;
    pc.ontrack = (event) => { if (this.links.get(id) === link && event.streams[0]) this.deps.play(id, event.streams[0]); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && this.links.get(id) === link) void this.again(id, link).catch(() => undefined); };
    const stream = await this.microphone();
    if (this.links.get(id) !== link) return undefined;
    const track = stream?.getAudioTracks()[0];
    if (!track || !stream) { pc.addTransceiver('audio', { direction: 'recvonly' }); return link; }
    const sender = pc.addTrack(track, stream);
    const parameters = sender.getParameters?.();
    if (parameters && sender.setParameters) {
      const encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      void sender.setParameters({ ...parameters, encodings: encodings.map((encoding) => ({ ...encoding, maxBitrate: AUDIO_MAX_BPS, priority: 'high', networkPriority: 'high' })) }).catch(() => undefined);
    }
    return link;
  }

  private async offer(id: string, tries = 0): Promise<void> {
    const link = await this.open(id, true, tries);
    if (!link) return;
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await this.out(id, link, 'offer');
  }

  private async answer(id: string, sdp: string): Promise<void> {
    const link = await this.open(id, false);
    if (!link) return;
    await link.pc.setRemoteDescription({ type: 'offer', sdp });
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    await this.out(id, link, 'answer');
  }

  private async answered(id: string, sdp: string): Promise<void> {
    const link = this.links.get(id);
    if (link?.offerer && link.pc.signalingState === 'have-local-offer') await link.pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => undefined);
  }

  /** The description goes out once its candidates are there (or GATHER_MS passed). */
  private async out(id: string, link: Link, op: 'offer' | 'answer'): Promise<void> {
    const { pc } = link;
    if (pc.iceGatheringState !== 'complete') {
      await Promise.race([
        new Promise<void>((resolve) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; }),
        this.wait(GATHER_MS),
      ]);
    }
    const sdp = pc.localDescription?.sdp;
    if (sdp && this.links.get(id) === link) await this.deps.send(id, { op, sdp: tunedOpus(sdp) }).catch(() => false);
  }

  private async again(id: string, link: Link): Promise<void> {
    if (!link.offerer || link.tries >= RETRIES) return;
    await this.wait(RETRY_MS);
    if (this.links.get(id) === link && !this.closed) await this.offer(id, link.tries + 1);
  }

  private drop(id: string): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    try { link.pc.close(); } catch { /* closed already */ }
    this.deps.play(id, null);
  }

  private wait(ms: number): Promise<void> {
    return this.deps.wait?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}
