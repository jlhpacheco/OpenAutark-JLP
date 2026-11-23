// F25 P3 (18.11.2026): the iPhone web app's direct way to its PC – the browser's own RTCPeerConnection (Safari/WebKit,
// Chromium), no library – so the bytes of the page run straight between phone and PC whenever their networks let them,
// and the meeting server stays the meeting point and the way back. The PC's end is runtime/devices/rendezvous/rtc.ts;
// Android's relay/RtcSignal, RtcWay, RtcPipe and RtcPlan do the same. Everything is said inside the finished pinned
// channel A on the tunnel (a SecureChannel exists only after its handshake, so nothing goes out before): hello {net}; the
// PC's offer (SDP ≤ 16 KiB with its candidates, which go one by one through the address filter, ≤ 32; and its STUN
// list – only the bundled STUN endpoint if offered, otherwise no iceServers) or no {why}; the answer (≤ 16 KiB,
// without candidates) and this phone's candidates as cand messages (UDP only, ≤ 32, the names the PC takes), then done;
// end either way. When the PC's data channel "autark" opens, the pinned handshake runs again over it with this phone's
// own key, and the PC must prove the key pinned for it – DTLS is only the wrapper, never the trust. The PC's ready {id}
// on that channel (B) makes B the page's (connection.ts moves new streams there). The way ends – and the page is back on
// A at once – when the PC says end, the data channel closes, ICE fails or stays disconnected for 5 s, B breaks, or
// nothing comes: 5 s without an answer to hello (an older PC), 15 s from the offer to ready.
// RtcPlan says when to try: once per channel A, again after 30 s, 2 min, then 10 min, at once after a resume or a network
// change; never again on that A after the PC said no (off, version) or never answered, never again in this session after
// it refused this phone's key on B. Framing on B exactly as the PC's rtc-socket.ts: text (the handshake) as a string, a
// binary channel frame in pieces [flags u8][bytes], flags 1 (MORE) on every piece but the last, and such a piece carries
// exactly 16384 bytes; the last one 1–16384.
// Owns: the signalling of one try (its limits and filters: rtc-signal.ts), the data channel as a Wire and the plan. Never: opens A, picks the
// page's channel (connection.ts), names a STUN server itself, or logs anything (no address, no SDP, not even types).

import { concat, utf8, type Bytes } from './bytes.ts';
import { connectChannel, type SecureChannel, type Wire } from './channel.ts';
import type { DeviceKey } from './crypto.ts';
import { candidatesOf, MAX_CANDIDATES, MAX_SDP, ownCandidate, readOffer, RTC_VERSION, rtcConfig, validId, withoutCandidates, type Offer } from './rtc-signal.ts';

export const HELLO_MS = 5_000;
export const TRY_MS = 15_000;
export const LOST_MS = 5_000;
/** A handshake on B that broke waits this long for the PC's end on A, which says why (refused: no more tries). */
export const WORD_MS = 1_000;
/** Pauses before the next try after a failed try or a lost way (a resume or a network change starts over). */
export const AGAIN_MS = [30_000, 120_000, 600_000];
/** Bytes of a frame per piece on the data channel. */
export const PIECE = 16 * 1024;
const MORE = 1;
const MAX_MESSAGE = 8 * 1024 * 1024 + 1024;
/** Unsent bytes past which B ends (that way is too slow: the tunnel takes over). */
export const MAX_BUFFERED = 16 * 1024 * 1024;
const NETS = new Set(['wifi', 'cell', 'ethernet', 'vpn', 'other']);
const NO = new Set(['off', 'busy', 'full', 'refused', 'version', 'later']);
const ENDS = new Set(['timeout', 'failed', 'refused', 'lost', 'closed']);

// ---------------------------------------------------------------- the data channel as a Wire

/** The members of the browser's RTCDataChannel used here (werift's stands in for it in the Node tests). */
export interface DataChannelLike {
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | Bytes): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null | undefined;
  onmessage: ((event: { data: unknown }) => void) | null | undefined;
  onclose: ((event?: unknown) => void) | null | undefined;
}

const bytesOf = (data: unknown): Bytes | undefined =>
  data instanceof ArrayBuffer ? new Uint8Array(data)
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      : undefined;

/** A data channel framed as the PC's rtc-socket.ts: the handshake and SecureChannel run over it as over a tunnel. */
export class RtcPipe implements Wire {
  closed = false;
  private readonly channel: DataChannelLike;
  private readonly messageListeners: Array<(data: Bytes, isText: boolean) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private parts: Bytes[] = [];
  private size = 0;

  constructor(channel: DataChannelLike) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => this.receive(event.data);
    channel.onclose = () => this.ended();
  }

  sendText(text: string): void {
    if (this.closed) return;
    try { this.channel.send(text); } catch { this.close(); }
  }

  sendBinary(data: Bytes): void {
    if (this.closed || !data.length) return;
    if (this.channel.bufferedAmount > MAX_BUFFERED) { this.close(); return; }
    try {
      for (let offset = 0; offset < data.length; offset += PIECE) {
        const chunk = data.subarray(offset, offset + PIECE);
        const piece = new Uint8Array(1 + chunk.length);
        piece[0] = offset + chunk.length < data.length ? MORE : 0;
        piece.set(chunk, 1);
        this.channel.send(piece);
      }
    } catch {
      this.close();
    }
  }

  /** A message of the data channel. */
  receive(data: unknown): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (this.parts.length) { this.close(); return; } // text in the middle of a frame
      this.emit(utf8(data), true);
      return;
    }
    const bytes = bytesOf(data);
    const payload = bytes ? bytes.length - 1 : -1;
    const more = bytes !== undefined && bytes[0] === MORE;
    if (!bytes || payload < 1 || payload > PIECE || (bytes[0] & ~MORE) || (more && payload !== PIECE)) { this.close(); return; }
    this.size += payload;
    if (this.size > MAX_MESSAGE) { this.close(); return; }
    this.parts.push(bytes.slice(1));
    if (more) return;
    const whole = this.parts.length === 1 ? this.parts[0] : concat(...this.parts);
    this.parts = [];
    this.size = 0;
    this.emit(whole, false);
  }

  private emit(data: Bytes, isText: boolean): void {
    for (const listener of [...this.messageListeners]) listener(data, isText);
  }

  close(): void {
    if (this.closed) return;
    try { this.channel.close(); } catch { /* already gone */ }
    this.ended();
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.parts = [];
    queueMicrotask(() => { for (const listener of this.closeListeners) listener(); });
  }

  onMessage(listener: (data: Bytes, isText: boolean) => void): void { this.messageListeners.push(listener); }
  onClose(listener: () => void): void { this.closeListeners.push(listener); }
}

// ---------------------------------------------------------------- one try

/** The members of the browser's RTCPeerConnection used here (werift's stands in for it in the Node tests). */
export interface PeerLike {
  onicecandidate: ((event: { candidate: { candidate: string } | null }) => void) | null | undefined;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null | undefined;
  oniceconnectionstatechange: ((event?: unknown) => void) | null | undefined;
  readonly iceConnectionState: string;
  readonly localDescription: { sdp: string } | null | undefined;
  setRemoteDescription(description: { type: 'offer'; sdp: string }): Promise<unknown>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<unknown>;
  addIceCandidate(candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number }): Promise<unknown>;
  close(): unknown;
}

/** What a try needs from its surroundings: the browser's peer connection (absent: no WebRTC here), the network kind. */
export interface RtcEnv {
  peer(config: RTCConfiguration): PeerLike;
  net?(): string | undefined;
  helloMs?: number;
  tryMs?: number;
  lostMs?: number;
}

/** This browser's WebRTC, or undefined when it has none (the page stays on its tunnel). */
export function browserRtc(): RtcEnv | undefined {
  const Peer = (globalThis as { RTCPeerConnection?: new (config: RTCConfiguration) => unknown }).RTCPeerConnection;
  if (typeof Peer !== 'function') return undefined;
  return {
    peer: (config) => new Peer(config) as PeerLike,
    net: () => {
      const type = (globalThis.navigator as { connection?: { type?: unknown } } | undefined)?.connection?.type;
      return type === 'wifi' ? 'wifi' : type === 'cellular' ? 'cell' : type === 'ethernet' ? 'ethernet' : typeof type === 'string' ? 'other' : undefined;
    },
  };
}

export interface WayOwner {
  /** The PC said ready on B and the handshake there is done: B carries the page from now. */
  ready(way: RtcWay): void;
  /** The try or the way ended (`wasReady`: it had carried the page). */
  over(way: RtcWay, outcome: string, wasReady: boolean): void;
}

type WayState = 'hello' | 'answering' | 'trying' | 'shaking' | 'ready' | 'over';

export class RtcWay {
  /** The channel on the tunnel it signals on. */
  readonly a: SecureChannel;
  state: WayState = 'hello';
  /** B once its handshake is done. */
  b: SecureChannel | undefined;
  /** How it ended (undefined while it runs). */
  outcome: string | undefined;
  /** Candidates of either side the filter left out (a count, never the lines). */
  dropped = 0;
  private readonly self: { key: DeviceKey; deviceId: string };
  private readonly pcPub: Uint8Array;
  private readonly owner: WayOwner;
  private readonly env: RtcEnv;
  private id: string | undefined;
  private mid = '0';
  private peer: PeerLike | undefined;
  private pipe: RtcPipe | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lost: ReturnType<typeof setTimeout> | undefined;
  private word: ReturnType<typeof setTimeout> | undefined;
  private readonly sent = new Set<string>();
  private early: string[] = [];
  private gathered = false;
  private done = false;

  constructor(a: SecureChannel, self: { key: DeviceKey; deviceId: string }, pcPub: Uint8Array, owner: WayOwner, env: RtcEnv) {
    this.a = a;
    this.self = self;
    this.pcPub = pcPub;
    this.owner = owner;
    this.env = env;
  }

  /** hello goes out on A now. */
  start(): void {
    const net = this.env.net?.();
    this.say({ op: 'hello', ...(net && NETS.has(net) ? { net } : {}) });
    this.timer = setTimeout(() => { if (this.state === 'hello') this.over('old', false); }, this.env.helloMs ?? HELLO_MS);
  }

  get carrying(): SecureChannel | undefined { return this.state === 'ready' && this.b && !this.b.closed ? this.b : undefined; }

  /** The connection ends it (A closed, another PC, stop): the PC hears end while A is open. */
  close(why: string): void { this.over(why, true); }

  /** An rtc message of the PC on A. */
  signal(message: Record<string, unknown>): void {
    if (this.state === 'over') return;
    const { op, why } = message;
    if (this.state === 'hello') {
      if (op === 'no') { this.over(typeof why === 'string' && NO.has(why) ? why : 'no', false); return; }
      if (op === 'end') { this.over('nooffer', false); return; } // the PC could not guard its WebRTC (fail-closed): a no
      if (op !== 'offer') return;
      const offer = readOffer(message);
      if (!offer) { if (validId(message.id)) this.id = message.id; this.over('failed', true); return; }
      this.id = offer.id;
      this.mid = offer.mid;
      this.dropped += offer.dropped;
      this.state = 'answering';
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.state !== 'ready') this.over('timeout', true); }, this.env.tryMs ?? TRY_MS);
      void this.answer(offer).catch(() => this.over('failed', true));
      return;
    }
    if (op !== 'end' || message.id !== this.id) return;
    this.over(this.state === 'ready' && why !== 'refused' ? 'lost' : typeof why === 'string' && ENDS.has(why) ? why : 'failed', false);
  }

  /** The browser takes the offer and answers it; candidates go one by one through the filter. */
  private async answer(offer: Offer): Promise<void> {
    const peer = (this.peer = this.env.peer(rtcConfig(offer.stun)));
    peer.onicecandidate = (event) => {
      const line = event.candidate?.candidate;
      if (!line) { this.gathered = true; if (this.state === 'trying' || this.state === 'shaking') this.finishCandidates(); return; }
      if (this.state === 'answering') this.early.push(line);
      else if (this.state === 'trying' || this.state === 'shaking') this.own(line);
    };
    peer.oniceconnectionstatechange = () => this.ice(peer.iceConnectionState);
    peer.ondatachannel = (event) => this.opened(event.channel);
    await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (this.state !== 'answering') return;
    const sdp = peer.localDescription?.sdp ?? answer.sdp ?? '';
    const description = withoutCandidates(sdp);
    if (!description || utf8(description).length > MAX_SDP) { this.over('failed', true); return; }
    this.say({ op: 'answer', id: this.id, sdp: description });
    this.state = 'trying';
    for (const line of [...candidatesOf(sdp), ...this.early.splice(0)]) this.own(line);
    if (this.gathered) this.finishCandidates();
    for (const line of offer.candidates) {
      if ((this.state as WayState) === 'over') return; // it may end while a candidate is added
      await peer.addIceCandidate({ candidate: line, sdpMid: offer.mid, sdpMLineIndex: 0 }).catch(() => undefined);
    }
  }

  /** One of this phone's candidates goes to the PC when the filter passes it, at most 32, each once. */
  private own(line: string): void {
    const bare = line.replace(/^a=/, '');
    if (this.sent.has(bare)) return;
    if (this.sent.size >= MAX_CANDIDATES || !ownCandidate(bare)) { this.dropped++; return; }
    this.sent.add(bare);
    this.say({ op: 'cand', id: this.id, c: { candidate: bare, sdpMid: this.mid, sdpMLineIndex: 0 } });
  }

  private finishCandidates(): void {
    if (this.done) return;
    this.done = true;
    this.say({ op: 'cand', id: this.id, done: true });
  }

  private ice(state: string): void {
    if (this.state === 'over') return;
    if (state === 'failed' || state === 'closed') this.over(this.state === 'ready' ? 'lost' : 'failed', true);
    else if (state === 'disconnected') this.lost ??= setTimeout(() => this.over(this.state === 'ready' ? 'lost' : 'failed', true), this.env.lostMs ?? LOST_MS);
    else if (state === 'connected' || state === 'completed') { clearTimeout(this.lost); this.lost = undefined; }
  }

  /** The PC's data channel: the pinned handshake again over it, once it is open. */
  private opened(channel: DataChannelLike): void {
    if (this.state !== 'trying' || this.pipe || channel.label !== 'autark') { try { channel.close(); } catch { /* gone */ } return; }
    const pipe = (this.pipe = new RtcPipe(channel));
    this.state = 'shaking';
    pipe.onClose(() => { if (this.state === 'shaking' && !this.b) this.broke(); });
    if (channel.readyState === 'open') void this.shake(pipe);
    else channel.onopen = () => void this.shake(pipe);
  }

  /** This phone's key, and the PC must prove the key pinned for it – the same as on A, never one from the offer. */
  private async shake(pipe: RtcPipe): Promise<void> {
    let channel: SecureChannel;
    try {
      channel = await connectChannel(pipe, this.self, this.pcPub);
    } catch {
      this.broke();
      return;
    }
    if (this.state !== 'shaking' || channel.closed) { channel.close(); this.broke(); return; }
    this.b = channel;
    channel.onMessage((value) => {
      const message = value as { t?: unknown; op?: unknown; id?: unknown } | null;
      if (message?.t === 'rtc' && message.op === 'ready' && message.id === this.id && this.state === 'shaking') this.ready();
    });
    channel.onClose(() => this.over(this.state === 'ready' ? 'lost' : 'failed', true));
  }

  /** The handshake on B broke: the PC's end on A, if it comes within WORD_MS, says why; else it failed here. */
  private broke(): void {
    if (this.state === 'over' || this.word) return;
    this.word = setTimeout(() => this.over('failed', true), WORD_MS);
  }

  private ready(): void {
    this.state = 'ready';
    clearTimeout(this.timer);
    queueMicrotask(() => { if (this.state === 'ready') this.owner.ready(this); });
  }

  /** Ends the try or the way: the PC hears end (`tell`, while A is open), B and the peer connection close. */
  private over(outcome: string, tell: boolean): void {
    if (this.state === 'over') return;
    const wasReady = this.state === 'ready';
    this.state = 'over';
    this.outcome = outcome;
    clearTimeout(this.timer);
    clearTimeout(this.lost);
    clearTimeout(this.word);
    if (tell && this.id) this.say({ op: 'end', id: this.id, why: outcome });
    if (this.b) this.b.close();
    else this.pipe?.close();
    try { void Promise.resolve(this.peer?.close()).catch(() => undefined); } catch { /* closed */ }
    queueMicrotask(() => this.owner.over(this, outcome, wasReady));
  }

  private say(message: Record<string, unknown>): void {
    if (!this.a.closed) void this.a.send({ t: 'rtc', v: RTC_VERSION, ...message });
  }
}

// ---------------------------------------------------------------- when to try

/** When the page tries the direct way to its PC (one Connection, one plan). */
export class RtcPlan {
  private refused = false;
  private declinedOn: object | undefined;
  private againAt = 0;
  private misses = 0;

  /** True when a try on channel `a` (the page's channel on the tunnel) is due at `now`. */
  due(a: object, now: number): boolean {
    return !this.refused && a !== this.declinedOn && now >= this.againAt;
  }

  /** Milliseconds until a try is due (undefined: none waits – refused, or declined on `a`). */
  wait(a: object, now: number): number | undefined {
    if (this.refused || a === this.declinedOn) return undefined;
    return Math.max(0, this.againAt - now);
  }

  /** B carries: the next loss pauses 30 s again. */
  carried(): void { this.misses = 0; }

  /** The try or way on `a` ended with `outcome`. */
  ended(a: object, outcome: string, now: number): void {
    if (outcome === 'refused') { this.refused = true; return; }
    if (outcome === 'off' || outcome === 'version' || outcome === 'old' || outcome === 'nooffer') { this.declinedOn = a; return; }
    if (outcome === 'closed' || outcome === 'moved') return; // A ended (or the page left its PC): a new A tries at once
    this.againAt = now + AGAIN_MS[Math.min(this.misses++, AGAIN_MS.length - 1)];
  }

  /** The app came back or the network changed: a try is due now, and the pauses start over. */
  check(): void {
    this.misses = 0;
    this.againAt = 0;
  }

  get isRefused(): boolean { return this.refused; }
}
