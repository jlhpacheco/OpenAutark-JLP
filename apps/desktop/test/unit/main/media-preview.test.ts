// 17.11.2026 (Konrad task_d4pdwppg, "Videos im Chat flüssig"): main's video preview maker (main/media-preview.ts, media-preview-routes.ts) – the job
// protocol of its private session, checked with a fake hidden window that talks to the routes the way the real page does (spec, the video read with
// ranges, the copy back in pieces, done or fail): the copy lands in a temp file of main's own with its facts; pieces out of order, too large or at the
// same time are refused; a report that does not match what arrived, a stall, a timeout, a crash or a page's fail leave no file and a user-safe error; the
// queue holds one job and a few waiting; a request is checked; the routes answer the running job only; the window is reused and destroyed after its idle time.
// The conversion itself (mediabunny in the page) runs only in a real window: test/live/media-preview.test.ts.
// Owns: these assertions only. Never: a real window, codec or video.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { PREVIEW_LIMITS } from '../../../src/shared/model/video-preview.ts';
import { MediaPreview } from '../../../src/main/media-preview.ts';
import { HIDDEN_IDLE_MS, type HiddenWindow, type Serve } from '../../../src/main/hidden-jobs.ts';
import type { MediaPreviewDeps } from '../../../src/main/media-preview.ts';
import { PREVIEW_ORIGIN } from '../../../src/main/media-preview-routes.ts';
import { PREVIEW_CSP } from '../../../src/main/media-preview-page.ts';
import { blobPath } from '../../../src/main/protocols/rules.ts';
import { tempDir } from '../store/helpers.ts';

/** A manual clock for the job and idle timers. */
class Timers {
  private now = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): unknown => { const id = this.next++; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clear = (handle: unknown): void => { this.timers.delete(handle as number); };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.now && this.timers.delete(id)) timer.fn();
  }
  get pending(): number { return this.timers.size; }
}

/** What a page does with a job: it gets the routes' base URL and the serve function of the session. */
type Page = (api: Api) => Promise<void> | void;
interface Api {
  base: string;
  get(route: string, headers?: Record<string, string>): Promise<Response>;
  post(route: string, body?: Uint8Array | string): Promise<Response>;
}

class FakeWindow implements HiddenWindow {
  destroyed = false;
  loads: string[] = [];
  private gone = new Set<() => void>();
  private readonly serve: Serve;
  private readonly page: Page;
  constructor(serve: Serve, page: Page) { this.serve = serve; this.page = page; }
  async load(url: string): Promise<void> {
    this.loads.push(url);
    const base = url;
    const api: Api = {
      base,
      get: (route, headers) => this.serve(new Request(`${base}${route}`, { headers })),
      post: (route, body) => this.serve(new Request(`${base}${route}`, { method: 'POST', ...(body === undefined ? {} : { body: body as BodyInit }) })),
    };
    setImmediate(() => { void Promise.resolve(this.page(api)).catch(() => undefined); });
  }
  onGone(listener: () => void): void { this.gone.add(listener); }
  crash(): void { for (const listener of [...this.gone]) listener(); }
  destroy(): void { this.destroyed = true; this.gone.clear(); }
}

/** A copy that looks like an MP4 (an `ftyp` box first), `size` bytes. */
function mp4(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  for (let i = 12; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

const done = (size: number, extra: Record<string, unknown> = {}) => JSON.stringify({ width: 720, height: 1280, durationMs: 14_500, mime: 'video/mp4', size, ...extra });

/** The well-behaved page: reads the spec and a piece of the video, sends the copy in pieces, reports done. */
const goodPage = (copy = mp4(1_500_000)): Page => async (api) => {
  const spec = await (await api.get('spec')).json() as { chunkBytes: number; size: number };
  assert.equal(spec.size, 4096);
  const first = await api.get('video', { Range: 'bytes=0-15' });
  assert.equal(first.status, 206);
  assert.equal((await first.arrayBuffer()).byteLength, 16);
  for (let at = 0; at < copy.length; at += spec.chunkBytes) assert.equal((await api.post(`out?at=${at}`, copy.subarray(at, at + spec.chunkBytes))).status, 204);
  assert.equal((await api.post('done', done(copy.length))).status, 204);
};

function fixture(page: Page, options: Partial<MediaPreviewDeps> = {}) {
  const t = tempDir('wf-media-preview-');
  const blobs = path.join(t.dir, 'blobs');
  const video = new Uint8Array(4096).map((_, i) => i % 256);
  const fileId = createHash('sha256').update(video).digest('hex');
  mkdirSync(path.dirname(blobPath(blobs, fileId)), { recursive: true });
  writeFileSync(blobPath(blobs, fileId), video);
  const timers = new Timers();
  const windows: FakeWindow[] = [];
  let serving: Serve = async () => new Response(null, { status: 410 });
  const maker = new MediaPreview({
    open: (serve) => { serving = serve; const window = new FakeWindow(serve, page); windows.push(window); return window; },
    blobsDir: blobs, dir: path.join(t.dir, 'previews'), script: () => '/* page */', setTimer: timers.set, clearTimer: timers.clear, ...options,
  });
  const files = () => (existsSync(path.join(t.dir, 'previews')) ? readdirSync(path.join(t.dir, 'previews')) : []);
  return { t, maker, fileId, timers, windows, files, serve: (url: string, init?: RequestInit) => maker.serve(new Request(url, init)), serving: () => serving };
}

const rejected = (promise: Promise<unknown>, code: string, text?: RegExp) => assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code && (!text || text.test(error.message)));

test('a preview job: the page reads the spec and the video with ranges, sends the copy in pieces; main returns the temp file and its facts', async () => {
  const f = fixture(goodPage());
  try {
    const result = await f.maker.preview({ fileId: f.fileId, mime: 'video/mp4' });
    assert.deepEqual({ ...result, file: path.basename(result.file) }, { file: result.file.slice(result.file.lastIndexOf(path.sep) + 1), size: 1_500_000, width: 720, height: 1280, durationMs: 14_500, mime: 'video/mp4' });
    assert.equal(path.dirname(result.file), path.join(f.t.dir, 'previews'), 'in main\'s own folder');
    assert.deepEqual(new Uint8Array(readFileSync(result.file)), mp4(1_500_000), 'byte for byte');
    assert.equal(f.windows.length, 1);
    assert.deepEqual(f.windows[0].loads, [`${PREVIEW_ORIGIN}/job/1/`]);
    assert.equal(f.maker.windowOpen, true, 'kept for the next job');
    f.timers.advance(HIDDEN_IDLE_MS + 1);
    assert.equal(f.maker.windowOpen, false, 'destroyed after its idle time');
    assert.equal(f.windows[0].destroyed, true);
  } finally { f.t.cleanup(); }
});

test('pieces: in order, one at a time, within the chunk size and the most a copy may be – else refused and the job fails with no file left', async () => {
  for (const [name, page] of [
    ['out of order', async (api: Api) => { assert.equal((await api.post('out?at=7', mp4(100))).status, 409); await api.post('fail', JSON.stringify({ reason: 'decode' })); }],
    ['a piece over the chunk size', async (api: Api) => { assert.equal((await api.post('out?at=0', mp4(PREVIEW_LIMITS.chunkBytes + 1))).status, 400); }],
    ['an empty piece', async (api: Api) => { assert.equal((await api.post('out?at=0', new Uint8Array(0))).status, 400); }],
    ['two at once', async (api: Api) => {
      const both = await Promise.all([api.post('out?at=0', mp4(1000)), api.post('out?at=0', mp4(1000))]);
      assert.deepEqual(both.map((reply) => reply.status).sort(), [204, 409]);
      await api.post('fail', JSON.stringify({ reason: 'decode' }));
    }],
  ] as Array<[string, Page]>) {
    const f = fixture(page);
    try {
      await assert.rejects(f.maker.preview({ fileId: f.fileId }), (error: unknown) => error instanceof WorkforceError, name);
      assert.deepEqual(f.files(), [], `${name}: no half copy stays`);
    } finally { f.t.cleanup(); }
  }
});

test('done is checked against what arrived: its size, a picture within the edge, the type\'s first bytes; anything else is a failure with no file left', async () => {
  const cases: Array<[string, (copy: Uint8Array) => Promise<void> | void, RegExp]> = [
    ['a size that does not match', async () => undefined, /could not be written/],
  ];
  void cases;
  const wrong: Array<[string, Record<string, unknown>]> = [
    ['size', { size: 1234 }], ['short edge over 720', { width: 1080, height: 1920 }], ['no length', { durationMs: 0 }], ['unknown type', { mime: 'video/x-matroska' }], ['a float width', { width: 720.5 }],
  ];
  for (const [name, extra] of wrong) {
    const copy = mp4(2000);
    const f = fixture(async (api) => { await api.post('out?at=0', copy); assert.equal((await api.post('done', done(copy.length, extra))).status, 400, name); });
    try {
      await rejected(f.maker.preview({ fileId: f.fileId }), 'unavailable', /could not be written/);
      assert.deepEqual(f.files(), [], name);
    } finally { f.t.cleanup(); }
  }
  // bytes that are no MP4: refused too
  const notMp4 = new Uint8Array(2000).fill(7);
  const f = fixture(async (api) => { await api.post('out?at=0', notMp4); assert.equal((await api.post('done', done(2000))).status, 400); });
  try { await rejected(f.maker.preview({ fileId: f.fileId }), 'unavailable'); assert.deepEqual(f.files(), []); } finally { f.t.cleanup(); }
  // a copy too small to be one
  const tiny = fixture(async (api) => { await api.post('out?at=0', mp4(100)); assert.equal((await api.post('done', done(100))).status, 400); });
  try { await rejected(tiny.maker.preview({ fileId: tiny.fileId }), 'unavailable'); } finally { tiny.t.cleanup(); }
});

test('the page\'s fail: each stage reads as a user-safe text, its own words (printable, short) appended for the log', async () => {
  const stages: Array<[string, 'bad_request' | 'unavailable', RegExp]> = [
    ['no-video', 'bad_request', /no picture/], ['too-long', 'bad_request', /over 15 minutes/], ['no-encoder', 'unavailable', /no H\.264 or VP9 encoder/],
    ['audio', 'bad_request', /sound of this video/], ['decode', 'bad_request', /cannot be read here/], ['light', 'bad_request', /light enough already/], ['whatever', 'bad_request', /cannot be read here/],
  ];
  for (const [stage, code, text] of stages) {
    const f = fixture(async (api) => { await api.post('fail', JSON.stringify({ reason: stage })); });
    try { await rejected(f.maker.preview({ fileId: f.fileId }), code, text); } finally { f.t.cleanup(); }
  }
  const f = fixture(async (api) => { await api.post('fail', JSON.stringify({ reason: 'decode', detail: `convert: Error: Color\u0000/alpha\n${'x'.repeat(400)}` })); });
  try {
    await assert.rejects(f.maker.preview({ fileId: f.fileId }), (error: unknown) => error instanceof WorkforceError && /\(convert: Error: Color \/alpha x+\)$/.test(error.message) && error.message.length < 300);
  } finally { f.t.cleanup(); }
});

test('a window that hangs ends by the stall watchdog, one that never finishes by the job time, a crash at once – each leaves no file and the next job a fresh window', async () => {
  const f = fixture(async (api) => { await api.post('out?at=0', mp4(1000)); /* then nothing */ });
  try {
    const stalled = f.maker.preview({ fileId: f.fileId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.timers.advance(PREVIEW_LIMITS.stallMs + 1);
    await rejected(stalled, 'timeout', /no progress for 90 s/);
    assert.deepEqual(f.files(), []);
    assert.equal(f.windows[0].destroyed, true, 'a failed job closes its window');
  } finally { f.t.cleanup(); }

  let over = false; // the busy page stops with the job (an endless loop would keep the test process alive)
  const g = fixture(async (api) => { while (!over) { await new Promise((resolve) => setTimeout(resolve, 5)); await api.post('progress'); } }, { stallMs: 10 * 60_000 });
  try {
    const slow = g.maker.preview({ fileId: g.fileId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    g.timers.advance(PREVIEW_LIMITS.jobMs + 1);
    await rejected(slow, 'timeout', /longer than 40 minutes/);
  } finally { over = true; g.t.cleanup(); }

  const h = fixture(async () => { /* never answers */ });
  try {
    const crashed = h.maker.preview({ fileId: h.fileId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.windows[0].crash();
    await rejected(crashed, 'unavailable', /preview maker stopped/);
    assert.equal(h.windows[0].destroyed, true);
  } finally { h.t.cleanup(); }
});

test('requests: a blob id and a video type, a missing blob is not_found, the queue holds one running and a few waiting, quitting fails what runs', async () => {
  const f = fixture(async () => { /* the first job waits */ });
  try {
    await rejected(f.maker.preview({}), 'bad_request');
    await rejected(f.maker.preview({ fileId: 'nope' }), 'bad_request');
    await rejected(f.maker.preview({ fileId: f.fileId, mime: 'image/png' }), 'bad_request');
    await rejected(f.maker.preview({ fileId: 'a'.repeat(64) }), 'not_found', /not in the file store/);
    const jobs = Array.from({ length: PREVIEW_LIMITS.waiting + 1 }, () => f.maker.preview({ fileId: f.fileId }));
    jobs.forEach((job) => job.catch(() => undefined));
    await rejected(f.maker.preview({ fileId: f.fileId }), 'conflict', /Several previews/);
    f.maker.dispose();
    await Promise.all(jobs.map((job) => rejected(job, 'unavailable', /closing/)));
    await rejected(f.maker.preview({ fileId: f.fileId }), 'unavailable', /closing/);
  } finally { f.t.cleanup(); }
});

test('the routes answer the running job only, with the right verbs; the page carries its CSP; /page.js is the script; other hosts and ids get nothing', async () => {
  let seen: { csp: string | null; html: string; badId: number; badHost: number; wrongVerb: number; script: string; range: number; unsat: number; head: string | null } | undefined;
  const f = fixture(async (api) => {
    const page = await api.get('');
    const origin = PREVIEW_ORIGIN;
    seen = {
      csp: page.headers.get('Content-Security-Policy'), html: await page.text(),
      badId: (await f.serve(`${origin}/job/99/spec`)).status, badHost: (await f.serve('wf-file://media-analyzer/job/1/spec')).status,
      wrongVerb: (await f.serve(`${origin}/job/1/out?at=0`)).status, script: await (await f.serve(`${origin}/page.js`)).text(),
      range: (await api.get('video', { Range: 'bytes=0-9' })).status, unsat: (await api.get('video', { Range: 'bytes=9999-' })).status,
      head: (await f.serve(`${origin}/job/1/video`, { method: 'HEAD' })).headers.get('Content-Length'),
    };
    await api.post('fail', JSON.stringify({ reason: 'decode' }));
  });
  try {
    await assert.rejects(f.maker.preview({ fileId: f.fileId }));
    assert.equal(seen?.csp, PREVIEW_CSP);
    assert.match(seen?.html ?? '', /<script src="\/page\.js"><\/script>/);
    assert.deepEqual([seen?.badId, seen?.badHost, seen?.wrongVerb], [410, 404, 405], 'another job, another host, a GET where a POST belongs');
    assert.equal(seen?.script, '/* page */');
    assert.deepEqual([seen?.range, seen?.unsat, seen?.head], [206, 416, '4096']);
    // after the job nothing answers any more
    assert.equal((await f.serve(`${PREVIEW_ORIGIN}/job/1/spec`)).status, 410);
    assert.equal((await f.serve(`${PREVIEW_ORIGIN}/job/1/out?at=0`, { method: 'POST', body: mp4(16) })).status, 410);
  } finally { f.t.cleanup(); }
  assert.match(PREVIEW_CSP, /default-src 'none'.*script-src 'self'.*connect-src 'self'/);
  assert.doesNotMatch(PREVIEW_CSP, /unsafe-inline|unsafe-eval|https?:|\*/);
});

test('leftovers of an earlier run (older than six hours) are swept at the first job; young copies and other files stay', async () => {
  const f = fixture(goodPage());
  try {
    const dir = path.join(f.t.dir, 'previews');
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'preview-0123456789abcdef.tmp');
    const young = path.join(dir, 'preview-fedcba9876543210.tmp');
    const other = path.join(dir, 'notes.txt');
    for (const file of [old, young, other]) writeFileSync(file, 'x');
    const long = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(old, long, long);
    utimesSync(other, long, long);
    await f.maker.preview({ fileId: f.fileId });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(young), true);
    assert.equal(existsSync(other), true, 'only its own copies');
  } finally { f.t.cleanup(); }
});
