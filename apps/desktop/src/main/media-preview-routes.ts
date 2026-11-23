// 17.11.2026 (Konrad task_d4pdwppg): the routes of the video preview window's private session (media-preview.ts runs the jobs):
// wf-file://media-preview/page.js (the page script, built from src/main/preview/page.ts with mediabunny) and, for the running job only,
// /job/<n>/ (the page with its CSP), spec (the numbers it works to), video (the job's blob, streamed with ranges – the page reads it as it needs
// it), and what the page sends back – out?at=<byte> (the finished copy in pieces, in order, one at a time, into a temp file), progress (a sign of
// life), then done (its picture, length and type) or fail; everything the page sends is checked.
// Owns: the job record, these routes, their verbs and limits, the failure texts the runtime logs.
// Never: serves a file other than the running job's blob, answers a job that is not running, trusts the page's numbers or bytes unchecked,
// writes anywhere but the job's own temp file.

import type { ReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { WorkforceError } from '../shared/errors.ts';
import { PREVIEW_LIMITS, previewSpec } from '../shared/model/video-preview.ts';
import type { VideoPreview } from '../shared/model/video-preview.ts';
import { PREVIEW_CSP, PREVIEW_HTML } from './media-preview-page.ts';
import { body, parseJson, readBody, status, streamBlob } from './hidden-jobs.ts';

const HOST = 'media-preview';
export const PREVIEW_ORIGIN = `wf-file://${HOST}`;
const JOB_ROUTE = /^\/job\/(\d{1,9})\/(spec|video|out|progress|done|fail)?$/;
const MAX_JSON_BYTES = 4 * 1024;
const SMALLEST_COPY = 512;

/** Why the page gave up (its stage) → what the runtime logs. 'light': nothing to do – the video is light enough already. */
const FAILURES: Record<string, { code: 'bad_request' | 'unavailable'; text: string }> = {
  decode: { code: 'bad_request', text: 'This video cannot be read here: the format or codec is not supported, or the file is damaged.' },
  'no-video': { code: 'bad_request', text: 'This file has no picture.' },
  'too-long': { code: 'bad_request', text: `This video is over ${Math.round(PREVIEW_LIMITS.maxDurationMs / 60_000)} minutes long; no preview is made of it.` },
  'no-encoder': { code: 'unavailable', text: 'This PC cannot encode a preview of this video (no H.264 or VP9 encoder).' },
  audio: { code: 'bad_request', text: 'The sound of this video cannot be taken over into a preview.' },
  encode: { code: 'unavailable', text: 'The preview could not be written.' },
  light: { code: 'bad_request', text: 'This video is light enough already.' },
};

/** One preview job: its blob, its temp file and what the page sent so far. */
export interface PreviewJob {
  id: number;
  file: string;
  size: number;
  mime: string;
  /** The temp file the copy is written to, open for the job. */
  out: string;
  handle: FileHandle;
  /** Bytes of the copy accepted so far = the offset the next piece must name. */
  written: number;
  /** A piece is being read (two posts at the same time cannot both pass). */
  busy: boolean;
  streams: Set<ReadStream>;
  settled: boolean;
  /** A sign of life: the stall watchdog starts again (media-preview.ts). */
  touch(): void;
  done: Promise<VideoPreview>;
  finish(result: VideoPreview | WorkforceError): void;
}

export function newPreviewJob(id: number, file: string, size: number, mime: string, out: string, handle: FileHandle, touch: () => void): PreviewJob {
  let settle: (result: VideoPreview | WorkforceError) => void = () => {};
  const done = new Promise<VideoPreview>((resolve, reject) => {
    settle = (result) => (result instanceof WorkforceError ? reject(result) : resolve(result));
  });
  const job: PreviewJob = {
    id, file, size, mime, out, handle, written: 0, busy: false, streams: new Set(), settled: false, touch, done,
    finish: (result) => {
      if (job.settled) return;
      job.settled = true;
      settle(result);
    },
  };
  return job;
}

const failure = (stage: string) => {
  const known = Object.hasOwn(FAILURES, stage) ? FAILURES[stage] : FAILURES.decode;
  return new WorkforceError(known.code, known.text);
};

/** One request of the private session, answered for `job` (the running one, or null); `script` is the page script's text. */
export async function servePreview(request: Request, job: PreviewJob | null, script: () => string): Promise<Response> {
  let url: URL;
  try { url = new URL(request.url); } catch { return status(400); }
  if (url.protocol !== 'wf-file:' || url.host !== HOST) return status(404);
  const verb = request.method;
  if (url.pathname === '/page.js') return verb === 'GET' ? body(script(), 'text/javascript; charset=utf-8') : status(405);
  const match = JOB_ROUTE.exec(url.pathname);
  if (!match) return status(404);
  if (!job || job.settled || job.id !== Number(match[1])) return status(410);
  const part = match[2] ?? '';
  const verbs = part === 'video' ? ['GET', 'HEAD'] : part === '' || part === 'spec' ? ['GET'] : ['POST'];
  if (!verbs.includes(verb)) return status(405);
  job.touch();
  switch (part) {
    case '': return body(PREVIEW_HTML, 'text/html; charset=utf-8', { 'Content-Security-Policy': PREVIEW_CSP });
    case 'spec': return body(JSON.stringify(previewSpec(job.size, job.mime)), 'application/json');
    case 'video': return streamBlob(job, request);
    case 'out': return out(job, request, url.searchParams.get('at') ?? '');
    case 'progress': return status(204);
    case 'done': return done(job, request);
    default: return failed(job, request);
  }
}

/** One piece of the copy at byte offset `at`: in order, one at a time, at most one chunk, within the most a copy may be. */
async function out(job: PreviewJob, request: Request, at: string): Promise<Response> {
  const offset = /^\d{1,12}$/.test(at) ? Number(at) : -1;
  if (job.busy || offset !== job.written) return status(409);
  job.busy = true;
  try {
    const bytes = await readBody(request, PREVIEW_LIMITS.chunkBytes);
    if (job.settled) return status(410); // timed out or stopped while the body was read
    if (!bytes || !bytes.byteLength || job.written + bytes.byteLength > PREVIEW_LIMITS.maxOutputBytes) {
      job.finish(failure('encode'));
      return status(400);
    }
    await job.handle.write(bytes, 0, bytes.byteLength, offset);
    job.written += bytes.byteLength;
    return status(204);
  } catch {
    job.finish(failure('encode'));
    return status(500);
  } finally {
    job.busy = false;
  }
}

/** The page's report: what the copy is. Checked against what arrived: its size, a picture within the edge, its container's first bytes. */
async function done(job: PreviewJob, request: Request): Promise<Response> {
  const report = parseJson(await readBody(request, MAX_JSON_BYTES)) as { width?: unknown; height?: unknown; durationMs?: unknown; mime?: unknown; size?: unknown } | null;
  if (job.settled) return status(410);
  const mime = report?.mime === 'video/mp4' || report?.mime === 'video/webm' ? report.mime : undefined;
  const whole = (value: unknown, max: number) => (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max ? value : undefined);
  const width = whole(report?.width, 8192);
  const height = whole(report?.height, 8192);
  const durationMs = whole(report?.durationMs, PREVIEW_LIMITS.maxDurationMs + 60_000);
  if (!mime || !width || !height || !durationMs || report?.size !== job.written || job.written < SMALLEST_COPY || Math.min(width, height) > PREVIEW_LIMITS.shortEdge) {
    job.finish(failure('encode'));
    return status(400);
  }
  const head = Buffer.alloc(8);
  await job.handle.read(head, 0, 8, 0);
  const ok = mime === 'video/mp4' ? head.subarray(4, 8).toString('latin1') === 'ftyp' : head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if (job.settled) return status(410);
  job.finish(ok ? { file: job.out, size: job.written, width, height, durationMs, mime } : failure('encode'));
  return status(ok ? 204 : 400);
}

async function failed(job: PreviewJob, request: Request): Promise<Response> {
  const report = parseJson(await readBody(request, MAX_JSON_BYTES)) as { reason?: unknown; detail?: unknown } | null;
  const error = failure(typeof report?.reason === 'string' ? report.reason : 'decode');
  // the page's own words for the log: printable ASCII only, short
  const detail = typeof report?.detail === 'string' ? report.detail.replace(/[^ -~]/g, ' ').trim().slice(0, 160) : '';
  job.finish(detail ? new WorkforceError(error.code, `${error.message} (${detail})`) : error);
  return status(204);
}
