// The microphone feed of a voice conversation (pwa-conversation.ts runs the loop in this page, on the desktop
// and the phone alike): the turn detector (ui/lib/turn-detect.ts) cuts utterances from the 16 kHz PCM; each one is a
// WAV with a PRE_ROLL_MS pre-roll in front (the first word is never cut), uploaded at once and handed to the sink in the
// order it was said, while the microphone's view is 'listening' or 'transcribing' (words said while the last line is
// still heard are the next line, KI-Runde 17.11.) and not right after a reply was spoken (echo guard: its tail may still
// reach the microphone). The sink also hears when each take's speech ended (`spoke`, for the call turn's log line,
// ui/chat/call/turn-meter.ts). Replies are read through the page's one speech output (device-speech.ts);
// while anything is read (and its tail) the capture takes nothing. Self barge-in (`bargeIn`): with the browser's
// echo cancellation on, a voice clearly above the reading's echo stops the reading and is taken at once
// (ui/lib/barge-in.ts); without it the echo guard stays as it was. B-082: Silero VAD + Smart Turn (ui/lib/turn-models.ts, a
// lazy chunk) load while the conversation starts and replace the level detector between two lines; failing, it stays.
// Owns: the capture's microphone/take lifetime. Never: the conversation loop (shared/voice/conversation.ts),
// chat messages or reading aloud.

import type { VoiceSessionView } from '../../../shared/voice/conversation.ts';
import { uploadRef } from '../../lib/files.ts';
import { openMicrophone } from '../../lib/microphone.ts';
import type { Microphone, SampleListener } from '../../lib/microphone.ts';
import { PCM_RATE, Pcm16Encoder, rms, wavFile } from '../../lib/pcm.ts';
import { pcm16Samples } from '../../../shared/voice/wav.ts';
import { createTurnDetector, type TurnModels } from '../../lib/turn-detect.ts';
import { BargeInDetector, echoCancelled } from '../../lib/barge-in.ts';
import { deviceSpeech, prepareLocalVoice } from './device-speech.ts';
import { callMuted } from '../call/mute.ts';

/** After a spoken reply its tail (room echo, a slow speaker) is not taken for the person. */
export const ECHO_TAIL_MS = 450;
/** Audio kept before the start edge, so the first word is whole. */
export const PRE_ROLL_MS = 300;
const PRE_ROLL_BYTES = (PRE_ROLL_MS * PCM_RATE * 2) / 1000;

/** Where captured speech goes: the page's conversation loop. */
export interface CaptureSink {
  /** One uploaded utterance. */
  utterance(micId: string, fileId: string): Promise<void>;
  /** A take's speech ended at `at` (its upload starts now). */
  spoke?(micId: string, at: number): void;
  /** Self barge-in: the person talks over this device's own reading; true when the reading stopped for it. */
  bargeIn?(micId: string): boolean;
}

export interface CaptureDeps {
  openMicrophone(onSamples: SampleListener): Promise<Microphone>;
  upload(blob: Blob, name: string): Promise<{ id: string }>;
  now(): number;
  /** This device reads something aloud now (or just stopped): the microphone may hear it (echo guard). */
  speaking?(): boolean;
  /** B-082: the turn models (Silero VAD, Smart Turn); missing or failing -> the level detector decides. */
  turnModels?(): Promise<TurnModels>;
}

export const browserCapture: CaptureDeps = {
  // 85 ms blocks, as before PCM: the barge-in levels are tuned to them (a 32 ms block dips between syllables); the turn detector frames itself.
  openMicrophone: (onSamples) => openMicrophone(onSamples, { sampleRate: PCM_RATE, blockMs: 85 }),
  upload: (blob, name) => uploadRef(blob, name),
  now: () => Date.now(),
  speaking: () => deviceSpeech.speaking(ECHO_TAIL_MS),
  turnModels: () => import('../../lib/turn-models.ts').then((loaded) => loaded.loadTurnModels()),
};

const modelsLost = (error: unknown) => { console.warn('[workforce] turn models off, the level detector decides:', String(error)); };

/** One conversation's microphone: opened first, bound to the microphone's id by the first `follow`. */
export class ConversationCapture {
  private readonly sink: CaptureSink;
  private readonly onFailure: (error: unknown) => void;
  private readonly deps: CaptureDeps;
  private micId: string | null = null;
  private status: VoiceSessionView['status'] = 'starting';
  private mic: Microphone | null = null;
  private take: Uint8Array[] | null = null; // the running take's 16 kHz PCM16
  private preRoll: Uint8Array[] = [];
  private preBytes = 0;
  private encoder: Pcm16Encoder | null = null;
  private rate = 0;
  private detector = createTurnDetector();
  private models: TurnModels | null = null; // loaded, waiting for the gap between two lines
  private readonly barge = new BargeInDetector();
  private handing: Promise<void> = Promise.resolve(); // the takes go to the sink one after another, in the order said
  private closed = false;
  private quietUntil = 0;
  private aec = false; // the browser cancels this device's echo on the microphone
  private barged = false; // this take began by talking over the device's own reading

  constructor(sink: CaptureSink, onFailure: (error: unknown) => void, deps: CaptureDeps = browserCapture) {
    this.sink = sink;
    this.onFailure = onFailure;
    this.deps = deps;
  }

  get sessionId(): string | null { return this.micId; }

  /** Opens the microphone (blocks before the first `follow` are dropped). */
  async open(): Promise<void> {
    this.deps.turnModels?.().then((models) => { if (!this.closed) this.models = models; }, modelsLost);
    const mic = await this.deps.openMicrophone((samples, rate) => this.samples(samples, rate));
    if (this.closed) { mic.close(); return; } // stopped while the microphone opened
    this.mic = mic;
    this.aec = echoCancelled(mic.stream);
  }

  /** Follows the microphone's view; the first view binds the capture to its id. */
  follow(view: VoiceSessionView): void {
    if (this.closed) return;
    this.micId ??= view.id;
    if (view.id !== this.micId) return;
    if (this.status === 'speaking' && view.status !== 'speaking' && !this.barged) this.quietUntil = this.deps.now() + ECHO_TAIL_MS;
    if (view.status !== 'speaking') this.barge.stop();
    this.status = view.status;
  }

  close(): void {
    this.discard();
    this.closed = true;
    this.mic?.close();
    this.mic = null;
  }

  private samples(samples: Float32Array, rate: number): void {
    const micId = this.micId;
    if (this.closed || !micId) return;
    if (callMuted.peek()) { this.discard(); this.detector.reset(); return; } // B-085 mute: a block is silence, a take in progress goes
    if (!this.encoder || rate !== this.rate) { this.encoder = new Pcm16Encoder(rate, PCM_RATE, { lowPass: true }); this.rate = rate; }
    const pcm = this.encoder.push(samples);
    this.take?.push(pcm);
    this.keepPreRoll(pcm);
    const echo = this.deps.speaking?.() === true; // another reader of this device is heard aloud
    const now = this.deps.now();
    const level = rms(samples);
    if (this.status === 'speaking' && this.aec && this.sink.bargeIn && this.barge.feed(level, now) && this.sink.bargeIn(micId)) {
      this.barged = true; // talked over this device's own reading: take it now, no echo tail
      this.status = 'listening';
      this.quietUntil = 0;
      this.detector.reset();
      this.detector.begin(); // the take has begun
      this.record();
      return;
    }
    if ((this.status !== 'listening' && this.status !== 'transcribing') || now < this.quietUntil || (echo && !this.barged)) {
      this.discard(); // nothing is taken while the loop starts or speaks
      this.detector.reset();
      return;
    }
    if (this.models && !this.take && !this.detector.speaking) { this.detector = createTurnDetector({ models: this.models, onModelError: modelsLost }); this.models = null; }
    const edge = this.detector.feed(pcm16Samples(pcm));
    if (edge === 'start') this.record(); else if (edge === 'end') this.finish();
  }

  /** The block and at least PRE_ROLL_MS of PCM before it, always kept: a take starts with it (the start edge comes a block late). */
  private keepPreRoll(pcm: Uint8Array): void {
    while (this.preRoll.length && this.preBytes - this.preRoll[0].byteLength >= PRE_ROLL_BYTES) this.preBytes -= this.preRoll.shift()!.byteLength;
    this.preRoll.push(pcm);
    this.preBytes += pcm.byteLength;
  }

  private record(): void {
    if (!this.mic || this.take) return;
    this.take = [...this.preRoll]; // already holds the block that started it
  }

  private finish(): void {
    const take = this.take;
    this.take = null;
    this.barged = false;
    if (take) this.send(new Blob([wavFile(take).buffer as ArrayBuffer], { type: 'audio/wav' }));
  }

  /** Drops a running take. */
  private discard(): void {
    this.take = null;
    this.barged = false;
  }

  /** Uploads the take at once; it reaches the sink after the takes before it. */
  private send(blob: Blob): void {
    const micId = this.micId;
    if (this.closed || !micId || !blob.size) return;
    this.sink.spoke?.(micId, this.deps.now());
    const upload = this.deps.upload(blob, 'Utterance.wav');
    upload.catch(() => undefined); // its failure is reported in its turn below
    this.handing = this.handing.then(async () => {
      try {
        const ref = await upload;
        if (!this.closed) await this.sink.utterance(micId, ref.id);
      } catch (error) {
        if (!this.closed) this.onFailure(error);
      }
    });
  }
}

// ------------------------------------------------------------------ speaking

/**
 * A phone plays audio only after it was started inside a tap: call this synchronously in the "Start conversation"
 * click. It opens the page's audio output for the PC's voice (device-speech.ts prepareLocalVoice) and, for Mobile
 * Safari, starts speechSynthesis with an empty utterance (nothing is heard).
 */
export function primeSpeech(): void {
  prepareLocalVoice();
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
  try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* reading aloud may still work */ }
}
