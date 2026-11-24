// A phone app (apps/android) reaches this PC the way a linked PC does: through the meeting server, by Remote ID, with
// no VPN and no address of its own. B-078 (D5): it pairs with the normal connect request (role 'phone', its own key,
// the same code on both screens, Accept on the PC – rendezvous/phone-pair.ts) and gets its device token in the accepted
// answer. From then on every PC of mine pins that key at the server (the roster carries the phone to my other PCs), the
// phone opens a tunnel to one that is online, the usual pinned-key handshake (devices/channel.ts) runs over it, and the
// channel carries plain byte streams to this PC's own HTTP listener – the phone shows the unchanged phone UI over them,
// authenticated by its token like any phone. Removing the phone unpins it (the server cuts the tunnel) and revokes the token.
// Streams: {t:'o',s} opens one, {t:'d',s,b} carries base64 bytes, {t:'a',s,n} acknowledges n bytes taken, {t:'e',s}
// ends it. Each side sends at most WINDOW unacknowledged bytes per stream, so a big download never piles up in RAM.
// F29 stage 1 (16.11.2026): the Android app reaches this PC directly whenever one of its addresses answers – its own
// socket to the peer listener's /peer/phone (http/peer.ts) – with the same handshake and streams; the tunnel stays the
// fallback. On that path only the key of an accepted phone record (relayPhone) gets a channel, a PC key or an unknown one
// is refused in the handshake (4003), before any stream exists. A removed phone's channels end after the drain (prune);
// the key is checked again when the auth arrives, so a phone removed between its hello and its auth gets no channel.
// The bytes per phone and path are counted (phone-traffic.ts) for Settings › Devices and the daily log line.
// F25 stage 2 (16.11.2026): on a phone's tunnel channel, once the handshake is done, the phone may ask for a WebRTC way
// (rendezvous/rtc.ts, signalling inside this channel); the data channel that comes up runs the handshake again with
// exactly that phone's key (acceptRtc), then the same streams ('rtc' in the counts) – the tunnel stays the way back.
// Owns: the channel on a phone tunnel or direct socket and its streams. Never: gives a phone the owner token, a PC's
// sync, or a stream to anything but this PC's own runtime port.

import net from 'node:net';
import type { Logger } from '../../contracts.ts';
import { REFUSED_CLOSE, acceptSecure, type SecureChannel, type SocketLike } from '../channel.ts';
import type { Signer } from '../handshake.ts';
import { fingerprintOf, fromB64url } from '../keys.ts';
import type { DeviceRecord } from '../repo.ts';
import { PhoneTraffic, type PhoneCount, type PhonePath } from './phone-traffic.ts';
import { PhoneRtc, type PhoneRtcDeps } from './rtc.ts';
import type { RtcSocket } from './rtc-socket.ts';

export const STREAM_WINDOW = 256 * 1024;
const CHUNK = 32 * 1024;
const MAX_STREAMS = 24;

export interface PhoneBridgeDeps {
  identity: Signer;
  log: Logger;
  /** This PC's runtime HTTP port (the phone UI and its /ws). */
  port(): number;
  /** The device record behind a key's fingerprint: a direct socket names its phone only in the handshake. */
  phone?(fingerprint: string): DeviceRecord | undefined;
  /** F25: the WebRTC way (rtc.ts) – its STUN list, or off; absent, a phone's rtc hello goes unanswered, as at an older PC. */
  rtc?: Omit<PhoneRtcDeps, 'log'>;
  now?: () => number;
}

/** A relay phone: a phone record carrying the key it pairs with. */
export const relayPhone = (record: DeviceRecord | undefined): record is DeviceRecord =>
  Boolean(record && record.kind === 'phone' && !record.self && !record.revokedAt && record.status !== 'revoked' && record.publicKey);

/** True while a phone app is linked (the peer listener stays open for its direct socket). */
export const hasRelayPhone = (records: readonly DeviceRecord[]): boolean => records.some(relayPhone);

/** `socket` with every frame's bytes counted once (both ways), however many listeners it gets. */
function counted(socket: SocketLike, add: (bytes: number) => void): SocketLike {
  const listeners: Array<(data: Buffer, isText: boolean) => void> = [];
  return {
    send: (data) => { add(typeof data === 'string' ? Buffer.byteLength(data) : data.length); socket.send(data); },
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => {
      if (!listeners.length) socket.onMessage((data, isText) => { add(data.length); for (const each of [...listeners]) each(data, isText); });
      listeners.push(listener);
    },
    onClose: (listener) => socket.onClose(listener),
  };
}

export class PhoneBridge {
  private readonly deps: PhoneBridgeDeps;
  private readonly channels = new Set<SecureChannel>();
  private readonly changes = new Set<() => void>();
  private readonly traffic: PhoneTraffic;
  private readonly rtc?: PhoneRtc;

  constructor(deps: PhoneBridgeDeps) {
    this.deps = deps;
    this.traffic = new PhoneTraffic(deps.log, deps.now);
    if (deps.rtc) this.rtc = new PhoneRtc({ ...deps.rtc, log: deps.log });
  }

  /** A tunnel a pinned phone opened: the handshake with exactly its key, then its streams. */
  async accept(tunnel: SocketLike, record: DeviceRecord): Promise<void> {
    const expected = fromB64url(record.publicKey!);
    await this.serve(tunnel, 'relay', (pub) => (Buffer.compare(pub, expected) === 0 ? record.id : undefined));
  }

  /** F29: a phone's own socket to the peer listener – a channel only for the key of an accepted phone; its device id. */
  async acceptDirect(socket: SocketLike): Promise<string> {
    return (await this.serve(socket, 'direct', (pub) => this.accepted(pub))).peerId;
  }

  /** F25: the data channel the phone with key `pub` signalled for on its tunnel – the handshake again, with exactly that
   * key while the phone is still accepted (any other key: 4003), then its streams. */
  async acceptRtc(socket: RtcSocket, pub: Buffer): Promise<SecureChannel> {
    const channel = await this.serve(socket, 'rtc', (key) => (key.equals(pub) ? this.accepted(key) : undefined));
    socket.trusted();
    return channel;
  }

  /** Bytes per phone and path today, and the way each phone's channel runs now. */
  counts(): PhoneCount[] { return this.traffic.list(); }

  /** Called when a phone channel opens or closes. */
  onChange(listener: () => void): () => void {
    this.changes.add(listener);
    return () => { this.changes.delete(listener); };
  }

  /** Channels of phones no longer accepted (removed, revoked) end – after the drain, so their sockets heard why. */
  prune(): void {
    const phone = this.deps.phone;
    if (!phone) return;
    for (const channel of [...this.channels]) if (!relayPhone(phone(fingerprintOf(channel.peerPub)))) channel.close();
  }

  /** The bridge stops: every phone channel ends, and the day's traffic line is written. */
  closeAll(): void {
    for (const channel of [...this.channels]) channel.close();
    this.traffic.flush();
  }

  /** The device id of an accepted phone with this key. */
  private accepted(pub: Buffer): string | undefined {
    const record = this.deps.phone?.(fingerprintOf(pub));
    return relayPhone(record) && Buffer.compare(fromB64url(record.publicKey!), pub) === 0 ? record.id : undefined;
  }

  private async serve(socket: SocketLike, path: PhonePath, trust: (pub: Buffer) => string | undefined): Promise<SecureChannel> {
    const meter = { id: '', early: 0 };
    const measured = counted(socket, (bytes) => { if (meter.id) this.traffic.add(meter.id, path, bytes); else meter.early += bytes; });
    const channel = await acceptSecure(measured, this.deps.identity, trust);
    // trust ran at the hello; a phone removed while its auth was on the way is refused now – prune() sees open channels only
    if (trust(channel.peerPub) !== channel.peerId) {
      measured.close(REFUSED_CLOSE, 'unknown device');
      throw new Error('The phone was removed during the handshake');
    }
    meter.id = channel.peerId;
    this.traffic.add(channel.peerId, path, meter.early);
    const closed = this.traffic.opened(channel.peerId, path);
    const end = () => { this.channels.delete(channel); closed(); this.changed(); };
    this.channels.add(channel);
    channel.onClose(end);
    if (channel.closed) end(); // it ended before it was here: its close listeners never run
    else {
      serveStreams(channel, () => this.deps.port(), this.deps.log);
      // F25: only a tunnel's channel signals a WebRTC way – never a direct socket or a data channel itself
      if (path === 'relay') this.rtc?.attach(channel, channel.peerId, (dataChannel) => this.acceptRtc(dataChannel, channel.peerPub));
    }
    this.changed();
    return channel;
  }

  private changed(): void {
    for (const listener of [...this.changes]) {
      try { listener(); } catch (error) { this.deps.log.warn('phone change hook failed', { error: String((error as Error)?.message ?? error) }); }
    }
  }
}

interface Stream { socket: net.Socket; unacked: number; ended: boolean }

/** The PC end of the stream protocol: each stream is one TCP connection to 127.0.0.1:port. */
export function serveStreams(channel: SecureChannel, port: () => number, log: Logger): void {
  const streams = new Map<number, Stream>();
  const send = (message: unknown) => { if (!channel.closed) channel.send(message); };
  const end = (id: number, tell: boolean) => {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    stream.socket.destroy();
    if (tell) send({ t: 'e', s: id });
  };
  channel.onMessage((value) => {
    const message = value as { t?: unknown; s?: unknown; b?: unknown; n?: unknown } | null;
    const id = message?.s;
    if (!Number.isInteger(id) || (id as number) < 0) return;
    const s = id as number;
    switch (message?.t) {
      case 'o': {
        if (streams.has(s) || streams.size >= MAX_STREAMS) { send({ t: 'e', s }); return; }
        const socket = net.connect({ host: '127.0.0.1', port: port() });
        const stream: Stream = { socket, unacked: 0, ended: false };
        streams.set(s, stream);
        socket.on('data', (data: Buffer) => {
          for (let offset = 0; offset < data.length; offset += CHUNK) send({ t: 'd', s, b: data.subarray(offset, offset + CHUNK).toString('base64') });
          stream.unacked += data.length;
          if (stream.unacked >= STREAM_WINDOW) socket.pause();
        });
        socket.on('close', () => end(s, true));
        socket.on('error', (error) => log.debug('phone stream ended', { error: error.message }));
        return;
      }
      case 'd': {
        const stream = streams.get(s);
        if (!stream || typeof message.b !== 'string') return;
        const data = Buffer.from(message.b, 'base64');
        stream.socket.write(data, () => send({ t: 'a', s, n: data.length }));
        return;
      }
      case 'a': {
        const stream = streams.get(s);
        if (!stream || !Number.isInteger(message.n)) return;
        stream.unacked = Math.max(0, stream.unacked - (message.n as number));
        if (stream.unacked < STREAM_WINDOW && stream.socket.isPaused()) stream.socket.resume();
        return;
      }
      case 'e': end(s, false); return;
    }
  });
  channel.onClose(() => { for (const id of [...streams.keys()]) end(id, false); });
}
