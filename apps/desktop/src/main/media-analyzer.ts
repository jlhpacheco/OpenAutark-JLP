// MM4: keyframes of stored videos for agents (host op media.analyze → tool media.look). An
// on-demand hidden window (sandboxed, no preload, strict CSP, a private in-memory session that
// reaches nothing but the analyzer's routes; media-analyzer-window.ts, media-analyzer-routes.ts)
// reads the job's blob, samples small grey signatures across its time, and draws the moments
// picked from them (scene changes first, media-keyframes.ts) as JPEGs ≤ 768 px. B-058 (T2): the
// same window decodes any recording's or video's sound to 16 kHz mono PCM (host op media.audio,
// media-audio.ts) and prepares stored images for models (host op media.image, media-image.ts; HEIC
// is refused before a window opens). One job at a time in one queue – at most 3 keyframe jobs,
// 3 sound jobs and 8 image jobs waiting – with each task's own time (30 s, 120 s, 20 s); the window
// is reused while jobs follow and destroyed after 60 s idle, and at once after a timeout, a crash,
// a failed job or on quit (the queue and the window are hidden-jobs.ts's runner, shared with the preview maker).
// Owns: the tasks' limits and texts, the job timer.
// Never: imports electron values, keeps a blob open after its job, keeps a window without a job
// longer than the idle time.

import { open } from 'node:fs/promises';
import { AUDIO_DECODE_LIMITS, IMAGE_LIMITS, KEYFRAME_LIMITS } from '../shared/api/host-bridge.ts';
import type { DecodedAudio, Keyframes, NormalizedImage } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { audioRequest } from './media-audio.ts';
import { HiddenJobs, fileSize, type HiddenJobsDeps } from './hidden-jobs.ts';
import { ANALYZER_ORIGIN, newJob, serveJob } from './media-analyzer-routes.ts';
import type { Job, JobResult, JobTask } from './media-analyzer-routes.ts';
import { headerPixels, IMAGE_HEAD_BYTES, INPUT_BYTES as IMAGE_INPUT_BYTES, imageMime, imageRequest, isHeif, MAX_PIXELS } from './media-image.ts';
import { keyframeRequest } from './media-keyframes.ts';
import { sniffMime } from '../shared/files/mime.ts';
import { blobPath } from './protocols/rules.ts';

/** Per task: jobs waiting at most, one job's time and the texts of its failures. */
const TASKS: Record<JobTask['kind'], { waiting: number; jobMs: number; busy: string; missing: string; slow: string; gone: string; start: string }> = {
  keyframes: {
    waiting: KEYFRAME_LIMITS.waiting, jobMs: KEYFRAME_LIMITS.jobMs, busy: 'Several videos are being read already. Try again in a minute.',
    missing: 'The video is not in the file store on this PC.', slow: 'Reading the video took longer than', gone: 'The video reader stopped; the file may be damaged.',
    start: 'The video reader did not start.',
  },
  audio: {
    waiting: AUDIO_DECODE_LIMITS.waiting, jobMs: AUDIO_DECODE_LIMITS.jobMs, busy: 'Several recordings are being decoded already. Try again in a minute.',
    missing: 'The recording is not in the file store on this PC.', slow: 'Decoding the recording took longer than',
    gone: 'The sound decoder stopped; the file may be damaged or too large for the memory left.', start: 'The sound decoder did not start.',
  },
  image: {
    waiting: IMAGE_LIMITS.waiting, jobMs: IMAGE_LIMITS.jobMs, busy: 'Several images are being prepared already. Try again in a moment.',
    missing: 'The image is not in the file store on this PC.', slow: 'Preparing the image took longer than',
    gone: 'The image reader stopped; the file may be damaged or too large.', start: 'The image reader did not start.',
  },
};

export interface MediaAnalyzerDeps extends HiddenJobsDeps {
  blobsDir: string; // the runtime's content-addressed store: <blobs>/ab/cd/<sha256>
  /** One job's time for every task (tests); default: the task's own. */
  timeoutMs?: number;
}

export class MediaAnalyzer {
  /** Answers the private session's requests (wf-file://media-analyzer/…). */
  readonly serve = (request: Request) => serveJob(request, this.job);
  private readonly deps: MediaAnalyzerDeps;
  private readonly jobs: HiddenJobs;
  private readonly queued: Record<JobTask['kind'], number> = { keyframes: 0, audio: 0, image: 0 };
  private nextJob = 1;
  private job: Job | null = null;

  constructor(deps: MediaAnalyzerDeps) {
    this.deps = deps;
    this.jobs = new HiddenJobs(deps, {
      serve: this.serve,
      openFailed: 'The media reader could not be opened.',
      gone: () => { const job = this.job; job?.finish(new WorkforceError('unavailable', TASKS[job.task.kind].gone)); },
    });
  }

  /** Up to 12 keyframes of a stored video, queued behind a running job. Throws bad_request, conflict, not_found, timeout, unavailable. */
  analyze(input: { fileId?: unknown; mime?: unknown; frames?: unknown }): Promise<Keyframes> {
    return this.enqueue(() => ({ kind: 'keyframes', request: keyframeRequest(input) })) as Promise<Keyframes>;
  }

  /** B-058 G6: a stored recording's or video's sound from startMs for at most maxMs as 16 kHz mono PCM16. Same errors. */
  audio(input: { fileId?: unknown; mime?: unknown; startMs?: unknown; maxMs?: unknown }): Promise<DecodedAudio> {
    return this.enqueue(() => ({ kind: 'audio', request: audioRequest(input) })) as Promise<DecodedAudio>;
  }

  /** B-058 G10: a stored image (or a region of it) as JPEG/PNG ≤ maxPx. Same errors; HEIC/HEIF is unavailable. */
  image(input: Parameters<typeof imageRequest>[0]): Promise<NormalizedImage> { // 21.11.2026: with cover and maxBytes
    return this.enqueue(() => ({ kind: 'image', request: imageRequest(input) })) as Promise<NormalizedImage>;
  }

  /** True while the hidden window exists (tests, the live check). */
  get windowOpen(): boolean {
    return this.jobs.windowOpen;
  }

  /** Quit: the running job fails, the window goes. */
  dispose(): void {
    this.jobs.dispose();
    this.job?.finish(new WorkforceError('unavailable', 'The app is closing.'));
  }

  private enqueue(check: () => JobTask): Promise<JobResult> {
    let task: JobTask;
    try { task = check(); } catch (error) { return Promise.reject(error); }
    if (this.jobs.disposed) return Promise.reject(new WorkforceError('unavailable', 'The app is closing.'));
    const rules = TASKS[task.kind];
    if (this.queued[task.kind] > rules.waiting) return Promise.reject(new WorkforceError('conflict', rules.busy));
    this.queued[task.kind]++;
    return this.jobs.enqueue(() => this.runOne(task));
  }

  private async runOne(task: JobTask): Promise<JobResult> {
    const rules = TASKS[task.kind];
    try {
      const file = blobPath(this.deps.blobsDir, task.request.fileId);
      const size = await fileSize(file);
      if (size === null) throw new WorkforceError('not_found', rules.missing);
      const job = newJob(this.nextJob++, task, file, size, await this.mimeOf(task, file, size));
      this.job = job;
      const ms = this.deps.timeoutMs ?? rules.jobMs;
      const timer = this.jobs.setTimer(() => job.finish(new WorkforceError('timeout', `${rules.slow} ${Math.round(ms / 1000)} s.`)), ms);
      try {
        this.jobs.window().load(`${ANALYZER_ORIGIN}/job/${job.id}/`).catch(() => job.finish(new WorkforceError('unavailable', rules.start)));
        return await job.done;
      } catch (error) {
        this.jobs.close(); // after a timeout, a crash or a failure the next job starts in a fresh window
        throw error;
      } finally {
        this.jobs.clearTimer(timer);
        if (this.job === job) this.job = null;
        for (const stream of job.streams) stream.destroy();
      }
    } finally {
      this.queued[task.kind]--;
    }
  }

  /** The type the page reads the blob as: the runtime's, else sniffed; images by their bytes first (HEIC, bombs and huge files are refused here). */
  private async mimeOf(task: JobTask, file: string, size: number): Promise<string> {
    if (task.kind !== 'image') return task.request.mime ?? sniffMime(await head(file, 64));
    if (size > IMAGE_INPUT_BYTES) throw new WorkforceError('bad_request', `This image file is over ${IMAGE_INPUT_BYTES / 1024 / 1024} MB, too large to prepare here.`);
    const start = await head(file, IMAGE_HEAD_BYTES);
    const mime = imageMime(start) || task.request.mime || 'application/octet-stream';
    if (isHeif(mime)) throw new WorkforceError('bad_request', 'HEIC/HEIF photos cannot be read here. Send the photo as JPEG or PNG instead.');
    if ((headerPixels(start) ?? 0) > MAX_PIXELS) throw new WorkforceError('bad_request', `This image has over ${MAX_PIXELS / 1_000_000} megapixels, too large to prepare here.`);
    return mime;
  }
}

/** The file's first bytes (fewer for a short file, none when it cannot be read). */
async function head(file: string, bytes: number): Promise<Uint8Array> {
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = new Uint8Array(bytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return new Uint8Array(0);
  }
}
