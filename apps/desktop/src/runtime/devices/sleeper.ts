// Sicher-Runde 19.11.2026 – the wake helper ("sleeper"): what runs while this PC's app is closed, so my other devices can
// start it again. The same Autark.exe as Node (ELECTRON_RUN_AS_NODE, sleeper-main.ts – Smart App Control blocks every new
// unsigned executable, so it is no new program), without window, runtime or database: one outbound WebSocket to the
// meeting server under the helper's own key (wake-sign.ts; registered findable, pinning nobody – nothing is shared with
// anyone), and one kind of message it takes: a sealed 'pair' request carrying a wake signed by one of my own linked PCs,
// fresh and once (checkWake). Then it answers, starts the app (an ordinary start – the person's, so a quit by the person
// does not hold it back) and ends. Anything else gets a refusal. It ends as well when the meeting server hands its key to
// another helper (close 4009) or when the app starts by itself (sleeper-main.ts watches run-state.json).
// Reconnects with backoff (1 s … 1 min, one-shot timers); no ping from the server for 90 s ends the socket (re-armed by
// traffic – no polling).
// Owns: the helper's server connection and its one decision. Never: tunnels data, answers anything but a wake, starts
// anything but the app, or logs keys.

import type { KeyObject } from 'node:crypto';
import { importPrivate, signEd25519, b64url } from './keys.ts';
import { PAIR_INFO, boxText, fromSender, helloText, newBox, openJson, sealJson, type Box } from './rendezvous/seal.ts';
import { checkWake, wakeFpOf, type WakeFile } from './wake-sign.ts';

/** The part of a `ws` WebSocket the helper uses. */
export interface SleeperSocket {
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: 'ping' | 'open', listener: () => void): unknown;
  on(event: 'close', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export interface SleeperDeps {
  file: WakeFile;
  socket(url: string): SleeperSocket;
  /** Starts the app the ordinary way (sleeper-main.ts: the same executable, without the Node switch). */
  startApp(): void;
  exit(): void;
  now?(): number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?(line: string): void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const WATCHDOG_MS = 90_000;
/** After the answer to a wake: the socket gets this long to send it before the helper ends. */
const FLUSH_MS = 1_000;
export const REFUSED = { ok: false, error: { code: 'forbidden', message: 'This PC wakes only for its own linked devices.' } };

const realTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Sleeper {
  private readonly deps: SleeperDeps;
  private readonly timers: NonNullable<SleeperDeps['timers']>;
  private readonly key: KeyObject;
  private readonly fp: string;
  private readonly box: Box = newBox();
  private readonly seen = new Set<string>();
  private ws?: SleeperSocket;
  private attempt = 0;
  private watchdog?: unknown;
  private retry?: unknown;
  private ended = false;

  constructor(deps: SleeperDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.key = importPrivate(deps.file.key.pkcs8);
    this.fp = wakeFpOf(deps.file.key.pub);
  }

  start(): void { this.connect(); }

  /** Ends the helper: the socket closes and nothing reconnects. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const handle of [this.watchdog, this.retry]) if (handle !== undefined) this.timers.clear(handle);
    try { this.ws?.close(); } catch { /* closing */ }
    this.deps.exit();
  }

  private connect(): void {
    if (this.ended) return;
    let ws: SleeperSocket;
    try { ws = this.deps.socket(this.deps.file.relay); } catch { this.again(); return; }
    this.ws = ws;
    this.arm();
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.arm();
      if (isBinary) return; // no tunnels here
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>; } catch { return; }
      if (frame && typeof frame === 'object') this.control(ws, frame);
    });
    ws.on('ping', () => { if (this.ws === ws) this.arm(); });
    ws.on('close', (code) => { if (this.ws === ws) this.closed(code); });
    ws.on('error', () => undefined);
  }

  private control(ws: SleeperSocket, frame: Record<string, unknown>): void {
    if (frame.t === 'challenge' && typeof frame.n === 'string' && frame.n.length <= 64) {
      const sign = (text: string) => b64url(signEd25519(this.key, Buffer.from(text, 'utf8')));
      send(ws, { t: 'hello', v: 1, pub: this.deps.file.key.pub, sig: sign(helloText(frame.n)), box: this.box.pub, boxSig: sign(boxText(this.box.pub)), peers: [], findable: true });
    } else if (frame.t === 'ready') {
      this.attempt = 0;
      this.deps.log?.('waiting for a wake at the meeting server');
    } else if (frame.t === 'pair') {
      this.pair(ws, frame);
    }
  }

  /** A sealed request: a wake from one of my own PCs starts the app; anything else is refused. */
  private pair(ws: SleeperSocket, frame: Record<string, unknown>): void {
    const ref = frame.ref;
    const cipher = fromSender(this.box, frame.e, PAIR_INFO);
    const body = cipher ? openJson(cipher, frame.c) : undefined;
    if (!cipher || body === undefined) { send(ws, { t: 'pairReply', ref, error: 'stale' }); return; }
    const woken = !this.ended && checkWake(body, frame.from, this.deps.file.pins, { wakeFp: this.fp, box: this.box.pub }, (this.deps.now ?? Date.now)(), this.seen);
    send(ws, { t: 'pairReply', ref, c: sealJson(cipher, woken ? { ok: true } : REFUSED) });
    if (!woken) return;
    this.deps.log?.('woken by a linked PC: starting the app');
    this.deps.startApp();
    this.timers.set(() => this.end(), FLUSH_MS);
  }

  private closed(code: number): void {
    this.ws = undefined;
    if (this.watchdog !== undefined) this.timers.clear(this.watchdog);
    this.watchdog = undefined;
    if (this.ended) return;
    if (code === 4009) { this.deps.log?.('another wake helper took over'); this.end(); return; }
    this.again();
  }

  private again(): void {
    if (this.ended || this.retry !== undefined) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.retry = this.timers.set(() => { this.retry = undefined; this.connect(); }, delay);
  }

  private arm(): void {
    if (this.watchdog !== undefined) this.timers.clear(this.watchdog);
    const ws = this.ws;
    this.watchdog = this.timers.set(() => { this.watchdog = undefined; if (this.ws === ws) ws?.terminate(); }, WATCHDOG_MS);
  }
}

function send(ws: SleeperSocket, frame: Record<string, unknown>): void {
  try { ws.send(JSON.stringify(frame)); } catch { /* closing: the close handler reconnects */ }
}
