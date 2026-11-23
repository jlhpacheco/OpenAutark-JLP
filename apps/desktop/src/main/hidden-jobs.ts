// The one runner of main's hidden-window jobs (the media analyzer, media-analyzer.ts, and the video preview maker,
// media-preview.ts – two instances with their own private session and queue, so a long conversion never holds up a
// keyframe or a sound job): jobs run one at a time in their queue; the window opens for the first, is reused while jobs
// follow, closes after the idle time, and at once after a failure, a crash (the running job then fails with the
// instance's own words) or on quit. Plus the helpers both route modules share: HEADERS and status, the running job's
// blob streamed with ranges, a request body read up to a limit, and JSON parsed from it.
// Owns: the queue, the window's lifetime and the timers; those route helpers. Never: imports electron values, keeps a
// window without a job longer than the idle time, or knows what a job does (its instance does).

import { createReadStream, type ReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { WorkforceError } from '../shared/errors.ts';
import { parseRange } from '../shared/files/serving.ts';

/** A hidden window (Electron in the app, a fake in tests). */
export interface HiddenWindow {
  load(url: string): Promise<void>;
  /** The renderer went away or the window was closed. */
  onGone(listener: () => void): void;
  destroy(): void;
}

export type Serve = (request: Request) => Promise<Response>;

export interface HiddenJobsDeps {
  /** A fresh hidden window whose session answers every request with `serve`. */
  open(serve: Serve): HiddenWindow;
  idleMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const HIDDEN_IDLE_MS = 60_000;

export class HiddenJobs {
  private chain: Promise<unknown> = Promise.resolve();
  private count = 0;
  private current: HiddenWindow | null = null;
  private idle: unknown = null;
  private closing = false;
  private readonly deps: HiddenJobsDeps;
  private readonly own: { serve: Serve; gone(): void; openFailed: string };

  /** `serve` answers the window's session; `gone` fails the running job when its window goes; `openFailed` says why none opened. */
  constructor(deps: HiddenJobsDeps, own: { serve: Serve; gone(): void; openFailed: string }) {
    this.deps = deps;
    this.own = own;
  }

  /** Jobs running or waiting. */
  get pending(): number { return this.count; }
  get windowOpen(): boolean { return this.current !== null; }
  get disposed(): boolean { return this.closing; }

  /** Queues `work` behind the running job (counted at once); the window closes when the queue stays empty for the idle time. */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new WorkforceError('unavailable', 'The app is closing.'));
    this.count++;
    const run = this.chain.then(async () => {
      this.cancelIdle();
      try {
        if (this.closing) throw new WorkforceError('unavailable', 'The app is closing.');
        return await work();
      } finally {
        this.count--;
        this.scheduleIdle();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The open window, or a fresh one. */
  window(): HiddenWindow {
    if (this.current) return this.current;
    let window: HiddenWindow;
    try { window = this.deps.open(this.own.serve); } catch {
      throw new WorkforceError('unavailable', this.own.openFailed);
    }
    this.current = window;
    window.onGone(() => {
      if (this.current !== window) return;
      this.close(); // a crashed renderer leaves its hidden window behind otherwise
      this.own.gone();
    });
    return window;
  }

  close(): void {
    const window = this.current;
    this.current = null;
    try { window?.destroy(); } catch { /* already gone */ }
  }

  /** Quit: the window goes and nothing new runs (the instance fails its running job). */
  dispose(): void {
    this.closing = true;
    this.cancelIdle();
    this.close();
  }

  setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  }

  clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private scheduleIdle(): void {
    if (this.count > 0 || !this.current || this.closing) return;
    this.cancelIdle();
    this.idle = this.setTimer(() => {
      this.idle = null;
      if (this.count === 0) this.close();
    }, this.deps.idleMs ?? HIDDEN_IDLE_MS);
  }

  private cancelIdle(): void {
    if (this.idle === null) return;
    this.clearTimer(this.idle);
    this.idle = null;
  }
}

/** The size of a stored file; null when it is no file. */
export async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the routes' helpers

export const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
export const status = (code: number, extra: Record<string, string> = {}) => new Response(null, { status: code, headers: { ...HEADERS, ...extra } });
export const body = (text: string, type: string, extra: Record<string, string> = {}) => new Response(text, { status: 200, headers: { ...HEADERS, 'Content-Type': type, ...extra } });

/** The running job's blob, streamed; `Range: bytes=a-b` answers 206 so the page reads (or seeks) as it needs. */
export function streamBlob(job: { file: string; size: number; mime: string; streams: Set<ReadStream> }, request: Request): Response {
  const range = parseRange(request.headers.get('range'), job.size);
  if (range === 'invalid') return status(416, { 'Content-Range': `bytes */${job.size}` });
  const headers: Record<string, string> = { ...HEADERS, 'Content-Type': job.mime, 'Accept-Ranges': 'bytes' };
  const code = range ? 206 : 200;
  const { start, end } = range ?? { start: 0, end: job.size - 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${job.size}`;
  headers['Content-Length'] = String(job.size ? end - start + 1 : 0);
  if (request.method === 'HEAD' || job.size === 0) return new Response(null, { status: code, headers });
  const stream = createReadStream(job.file, { start, end });
  job.streams.add(stream);
  stream.once('close', () => job.streams.delete(stream));
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status: code, headers });
}

/** The request body up to `max` bytes; null when it is larger (the rest is not read). */
export async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

export function parseJson(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}
