// B-082 (decision 8): the end of a person's spoken line in a conversation, in the page, from 16 kHz audio in
// 32 ms frames (512 samples, Silero's window). A frame is speech by Silero VAD when that model runs here, else by the
// level detector's rule made sturdier: louder than both 0.018 RMS and three times the learned noise floor, AND not
// spectrally flat (a voice has harmonics; a fan, breath or a keystroke is broadband) – a line starts after 3 of 4
// speech frames (one click never does; the capture's pre-roll keeps the first word). After TURN_CHECK_MS of non-speech
// Smart Turn (when it runs here) hears the last 8 s: finished -> 'end'; not finished -> the line ends only after
// TURN_WAIT_MS more silence (speech in between asks again at the next pause). Without Smart Turn the old 1.1 s
// silence ends the line. A model that fails is dropped for good and the fallback takes over; 120 s caps a line.
// Model answers are async: an edge they cause is handed out by the next feed (the next block, <= ~85 ms later).
// Where the models run (VOICE 19.11.2026, checked): the desktop window (app://app/turn/) and the Android app's page
// (the PC's /turn/ through the phone's link) load both (ui/lib/turn-models.ts) once the PC has them; the iPhone web
// app's shell allows no WebAssembly, so the level fallback decides there and wherever a model is missing or fails.
// The fallback's noise floor also creeps up under steady sound it took for speech (a tonal hum or fan: harmonic and
// loud, so it never counted as noise and held a line open until the 120 s cap – measured on TTS speech + hum).
// Owns: the speech/turn decision and its timing (sample time, never a clock). Never: loads models (the caller
// injects them as TurnModels), touches the microphone or the DOM.

import { rms } from './pcm.ts';

export const FRAME = 512;
const FRAME_MS = 32;
/** Non-speech after which the turn model is asked "finished?". */
export const TURN_CHECK_MS = 250;
/** How long a line Smart Turn called unfinished may pause before it ends anyway. */
export const TURN_WAIT_MS = 3_000;
/** Without the turn model: the level detector's silence (the legacy rule). */
export const LEVEL_SILENCE_MS = 1_100;
const MAX_TURN_MS = 120_000;
const TURN_SAMPLES = 8 * 16_000; // Smart Turn hears the last 8 s
const MAX_BACKLOG = 30; // frames waiting for the VAD model (~1 s): slower than real time -> the fallback takes over
const FLOOR_RATIO = 3;
/** Per frame under 'speech' the floor creeps up by this factor (never above the frame): a steady tone is noise after ~6 s at 0.03 RMS, a word's gaps pull it back down. */
const FLOOR_RISE = 1.005;
const FLAT_MAX = 0.45;

/** The small models as the detector asks them; either may be missing. */
export interface TurnModels {
  /** Speech probability (0..1) of one 512-sample 16 kHz frame – stateful, frames in order (Silero VAD). */
  speech?(frame: Float32Array): Promise<number>;
  /** Probability (0..1) that the line is finished, from up to its last 8 s of 16 kHz audio (Smart Turn v3.2). */
  finished?(audio: Float32Array): Promise<number>;
}

export interface TurnDetectorOptions {
  models?: TurnModels;
  /** Minimum RMS of a speech frame (default 0.018, the level detector's). */
  threshold?: number;
  /** Silence that ends a line without the turn model (default LEVEL_SILENCE_MS). */
  silenceMs?: number;
  maxMs?: number;
  /** A model failed and was dropped (for a log line; the detector goes on with the fallback). */
  onModelError?(error: unknown): void;
}

export type TurnEdge = 'start' | 'end';

export interface TurnDetector {
  /** 16 kHz mono floats in any block size; 'start' when a line begins, 'end' when it is over, else null. */
  feed(pcm16k: Float32Array): TurnEdge | null;
  /** A line begins now without a 'start' edge (the person talked over the reading: the capture takes it at once). */
  begin(): void;
  /** Forget the running line and any answer still on its way (the loop transcribes or speaks). */
  reset(): void;
  readonly speaking: boolean;
}

export function createTurnDetector(options: TurnDetectorOptions = {}): TurnDetector {
  return new Turns(options);
}

class Turns implements TurnDetector {
  private speechModel: TurnModels['speech'];
  private finishedModel: TurnModels['finished'];
  private readonly threshold: number;
  private readonly silenceMs: number;
  private readonly maxMs: number;
  private readonly onModelError?: (error: unknown) => void;
  private partial = new Float32Array(FRAME);
  private filled = 0;
  private t = 0; // sample time of the frame being stepped (ms)
  private startedAt: number | null = null;
  private lastSpeech = 0;
  private askedFor = -1; // lastSpeech of the pause the turn model was asked about
  private recent = 0; // speech bits of the last 4 frames before a line
  private floor = 0.004;
  private audio: Float32Array[] = []; // the line's last frames (<= 8 s)
  private edges: TurnEdge[] = [];
  private gen = 0;
  private backlog = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: TurnDetectorOptions) {
    this.speechModel = options.models?.speech?.bind(options.models);
    this.finishedModel = options.models?.finished?.bind(options.models);
    this.threshold = options.threshold ?? 0.018;
    this.silenceMs = options.silenceMs ?? LEVEL_SILENCE_MS;
    this.maxMs = options.maxMs ?? MAX_TURN_MS;
    this.onModelError = options.onModelError;
  }

  get speaking(): boolean { return this.startedAt !== null; }

  feed(pcm16k: Float32Array): TurnEdge | null {
    for (let at = 0; at < pcm16k.length;) {
      const take = Math.min(FRAME - this.filled, pcm16k.length - at);
      this.partial.set(pcm16k.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled < FRAME) break;
      const frame = this.partial;
      this.partial = new Float32Array(FRAME);
      this.filled = 0;
      this.push(frame);
    }
    return this.edges.shift() ?? null;
  }

  begin(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.t;
    this.lastSpeech = this.t;
    this.recent = 0;
  }

  reset(): void {
    this.gen += 1;
    this.startedAt = null;
    this.recent = 0;
    this.audio = [];
    this.edges = [];
    this.askedFor = -1;
  }

  private push(frame: Float32Array): void {
    if (!this.speechModel && !this.backlog) { this.step(frame, this.levelSpeech(frame)); return; }
    this.backlog += 1;
    const gen = this.gen;
    this.chain = this.chain.then(async () => {
      let speech: boolean;
      const model = this.speechModel;
      if (model && this.backlog <= MAX_BACKLOG) {
        try { speech = (await model(frame)) >= (this.startedAt !== null ? 0.35 : 0.5); } catch (error) { this.drop('speech', error); speech = this.levelSpeech(frame); }
      } else {
        if (model) this.drop('speech', new Error('The voice activity model is slower than real time.'));
        speech = this.levelSpeech(frame);
      }
      this.backlog -= 1;
      if (gen === this.gen) this.step(frame, speech);
    });
  }

  private step(frame: Float32Array, speech: boolean): void {
    this.t += FRAME_MS;
    if (this.startedAt === null) {
      this.recent = ((this.recent << 1) | (speech ? 1 : 0)) & 0b1111;
      if (bits(this.recent) < 3) return;
      this.startedAt = this.t;
      this.lastSpeech = this.t;
      this.recent = 0;
      this.audio = [frame];
      this.edges.push('start');
      return;
    }
    this.audio.push(frame);
    if (this.audio.length * FRAME > TURN_SAMPLES) this.audio.shift();
    if (this.t - this.startedAt >= this.maxMs) { this.end(); return; }
    if (speech) { this.lastSpeech = this.t; return; }
    const silence = this.t - this.lastSpeech;
    if (this.askedFor === this.lastSpeech) { if (silence >= TURN_CHECK_MS + TURN_WAIT_MS) this.end(); return; }
    if (!this.finishedModel) { if (silence >= this.silenceMs) this.end(); return; }
    if (silence >= TURN_CHECK_MS) this.ask(this.finishedModel);
  }

  /** Smart Turn on the line so far: finished while the same pause lasts -> 'end'. */
  private ask(model: NonNullable<TurnModels['finished']>): void {
    const pause = this.lastSpeech;
    const gen = this.gen;
    this.askedFor = pause;
    const audio = new Float32Array(this.audio.length * FRAME);
    this.audio.forEach((frame, index) => audio.set(frame, index * FRAME));
    model(audio).then((p) => {
      if (gen === this.gen && this.startedAt !== null && this.lastSpeech === pause && p >= 0.5) this.end();
    }, (error: unknown) => {
      this.drop('finished', error);
      if (gen === this.gen && this.startedAt !== null && this.lastSpeech === pause) this.askedFor = -1; // the silence rule decides this pause
    });
  }

  private end(): void {
    this.startedAt = null;
    this.recent = 0;
    this.audio = [];
    this.askedFor = -1;
    this.edges.push('end');
  }

  private drop(which: 'speech' | 'finished', error: unknown): void {
    if (which === 'speech' ? !this.speechModel : !this.finishedModel) return;
    if (which === 'speech') this.speechModel = undefined; else this.finishedModel = undefined;
    this.onModelError?.(error);
  }

  /** The fallback: loud against the absolute minimum and the noise floor, and not flat (harmonics, not noise); a steady sound becomes the floor. */
  private levelSpeech(frame: Float32Array): boolean {
    const level = rms(frame);
    const speech = level > Math.max(this.threshold, this.floor * FLOOR_RATIO) && flatness(frame) < FLAT_MAX;
    if (!speech) this.floor = level < this.floor ? level : this.floor + (level - this.floor) * 0.02;
    else this.floor = Math.min(level, this.floor * FLOOR_RISE);
    return speech;
  }
}

const bits = (value: number) => (value & 1) + ((value >> 1) & 1) + ((value >> 2) & 1) + ((value >> 3) & 1);

const HANN = Float32Array.from({ length: FRAME }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FRAME));
const re = new Float64Array(FRAME);
const im = new Float64Array(FRAME);
const LOW_BIN = 3; // ~94 Hz
const HIGH_BIN = 128; // 4 kHz: where voiced speech has its harmonics

/**
 * Spectral flatness (geometric / arithmetic mean of the power, 94 Hz–4 kHz) of one 512-sample frame: near 0 for a
 * voice's harmonics, ~0.56 for white noise, 1 for no energy in the band at all.
 */
export function flatness(frame: Float32Array): number {
  for (let n = 0; n < FRAME; n++) { re[n] = (frame[n] ?? 0) * HANN[n]; im[n] = 0; }
  fft(re, im);
  let logSum = 0;
  let sum = 0;
  for (let k = LOW_BIN; k < HIGH_BIN; k++) {
    const power = re[k] * re[k] + im[k] * im[k] + 1e-12;
    logSum += Math.log(power);
    sum += power;
  }
  const count = HIGH_BIN - LOW_BIN;
  return Math.exp(logSum / count) / (sum / count);
}

/** In-place radix-2 FFT (length a power of two). */
function fft(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < size; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = real[b] * wr - imag[b] * wi;
        const ti = real[b] * wi + imag[b] * wr;
        real[b] = real[a] - tr; imag[b] = imag[a] - ti;
        real[a] += tr; imag[a] += ti;
      }
    }
  }
}
