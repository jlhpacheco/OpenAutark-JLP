// One speech output per device page (this window, or the phone page): every reader – the page's voice
// conversation (pwa-conversation.ts) – speaks through its own channel of one queue, so readers take turns
// instead of cutting each other off. A channel's
// cancel stops only its own line and drops its own queued lines. A line cut by something else (the
// browser, the system) counts as finished: its reader is told it is done and the queue moves on – a token
// per line keeps a late "end" of a cut line from finishing the next one. The queue also tells the capture
// whether anything is read aloud right now (echo guard for every reader, not only the conversation's own).
// B-047 D14 / VOICE 19.11.2026: with voice.speak allowed here, a line is read by the PC's own voice model – whichever
// it has; the person chose none and gets it anyway (runtime/voice/local/service.ts fetches one by itself), only a
// system voice picked by name (settings.voice.ttsVoice) keeps the device's voice – split into sentences, each one
// asked of voice.speak while the one before plays (Web Audio), so speaking starts after the first sentence. This
// device's own voice reads whatever the PC's voice cannot – speechSynthesis, or in the Android app (no voices in its
// WebView) the phone's voice over the native port: a refused call (no voice on the PC yet: the next REST_MS of lines
// go straight to the device's voice), audio output not allowed yet, and a sentence that is not here LATE_MS after it
// is due (a slow link or a busy PC: the device's voice reads the rest of that line at once, the call never stalls).
// Owns: the queue, the line tokens, the speaking state, the device-voice engine with the reading
// voice and profile language, and the local voice engine in front of it. Never: decides what
// is read or when (the readers do).

import type { VoiceSettings } from '../../../shared/model/system.ts';
import type { SpokenAudio } from '../../../shared/model/local-speech-models.ts';
import { pcm16Samples } from '../../../shared/voice/wav.ts';
import { hasNativePort, onNative, sendNative } from '../../pwa/native-port.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { settings } from '../../lib/store.ts';

export interface SpeechOutput {
  /** Reads `text` aloud; `done` runs once when it finished, failed or was cut by someone else (not after this channel's own cancel). */
  speak(text: string, done: () => void): void;
  /** Stops this channel's line and drops its queued lines (other channels' lines go on). */
  cancel(): void;
}

/** How a channel's lines are read. */
export interface SpeechReading { voice?: Pick<VoiceSettings, 'ttsVoice'>; language?: string }

/** The platform's speech engine: plays one line, reports its end (finished, failed or cut – once), stops the current one. */
export interface SpeechEngine {
  play(text: string, reading: SpeechReading, ended: () => void): void;
  stop(): void;
}

interface Line { channel: number; text: string; reading: () => SpeechReading; done: () => void }

export class DeviceSpeech {
  private readonly engine: SpeechEngine;
  private readonly now: () => number;
  private queue: Line[] = [];
  private current: Line | null = null;
  private quietSince = 0;
  private channels = 0;

  constructor(engine: SpeechEngine, now: () => number = () => Date.now()) {
    this.engine = engine;
    this.now = now;
  }

  /** A new reader's channel; `reading` is asked when each of its lines starts. */
  channel(reading: () => SpeechReading = () => ({})): SpeechOutput {
    const id = ++this.channels;
    return {
      speak: (text, done) => { this.queue.push({ channel: id, text, reading, done }); this.next(); },
      cancel: () => this.cancel(id),
    };
  }

  /** Something is read aloud now, or stopped less than `tailMs` ago (its tail may still reach the microphone). */
  speaking(tailMs = 0): boolean {
    return this.current !== null || this.now() < this.quietSince + tailMs;
  }

  private next(): void {
    if (this.current) return;
    const line = this.queue.shift();
    if (!line) return;
    this.current = line;
    let reading: SpeechReading = {};
    try { reading = line.reading(); } catch { reading = {}; }
    this.engine.play(line.text, reading, () => this.ended(line));
  }

  private ended(line: Line): void {
    if (this.current !== line) return; // a line this queue already cut or finished
    this.current = null;
    this.quietSince = this.now();
    try { line.done(); } finally { this.next(); }
  }

  private cancel(channel: number): void {
    this.queue = this.queue.filter((line) => line.channel !== channel);
    if (this.current?.channel !== channel) return;
    this.current = null; // its late end is ignored (token), its done never runs
    this.quietSince = this.now();
    this.engine.stop();
    this.next();
  }
}

/** No speechSynthesis here or one without voices (Android's WebView), but the Android app's port: the phone's own voice. */
function phoneVoice(): boolean {
  if (!hasNativePort()) return false;
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return true;
  try { return speechSynthesis.getVoices().length === 0; } catch { return true; }
}

let phoneLines = 0;

/**
 * speechSynthesis with the reading voice and the profile language. In the Android app, whose WebView reads nothing,
 * the line goes to the phone's own voice over the native port (`speak {id, text, lang}` → PhoneSpeech.java, its end
 * comes back as `speechDone {id}`; stop sends `stopSpeech`).
 */
export function synthesisEngine(): SpeechEngine {
  let phoneLine: (() => void) | null = null; // unsubscribes the current phone line's end
  return {
    play(text, reading, ended) {
      if (text.trim() && phoneVoice()) {
        const id = `line-${++phoneLines}`;
        const off = onNative('speechDone', (msg) => { if (msg.id !== id) return; off(); if (phoneLine === off) phoneLine = null; ended(); });
        phoneLine = off;
        if (!sendNative({ t: 'speak', id, text, ...(reading.language ? { lang: reading.language } : {}) })) { off(); phoneLine = null; ended(); }
        return;
      }
      if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined' || !text.trim()) { ended(); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      if (reading.language) utterance.lang = reading.language;
      const wanted = reading.voice?.ttsVoice;
      const chosen = wanted ? speechSynthesis.getVoices().find((entry) => entry.name === wanted) : undefined;
      if (chosen) { utterance.voice = chosen; utterance.lang = chosen.lang; }
      utterance.onend = () => ended();
      // Failed, interrupted or canceled: the line is over either way (DeviceSpeech ignores the end of a line it cut itself).
      utterance.onerror = () => ended();
      try { speechSynthesis.speak(utterance); } catch { ended(); }
    },
    stop() {
      if (phoneLine) { phoneLine(); phoneLine = null; sendNative({ t: 'stopSpeech' }); }
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    },
  };
}

/** A sentence of the PC's voice not here this long after it is due: the device's voice reads the rest of the line. */
export const LATE_MS = 1_500;
/** After a refused voice.speak the device's voice reads this long without asking the PC (no voice there yet, or it fails). */
export const REST_MS = 60_000;

/** Longest sentence sent to voice.speak at once (a longer one is cut at a space). */
export const MAX_SENTENCE = 400;
/** Pieces shorter than this join the next sentence (one word alone sounds clipped). */
const MIN_SENTENCE = 24;

/** A line as the local voice reads it: sentences (after . ! ? … and line breaks), short pieces joined, ≤ MAX_SENTENCE each. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let carry = '';
  const push = (piece: string) => {
    for (let rest = piece; rest;) {
      if (rest.length <= MAX_SENTENCE) { out.push(rest); return; }
      const space = rest.lastIndexOf(' ', MAX_SENTENCE);
      const at = space > MAX_SENTENCE / 2 ? space : MAX_SENTENCE;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
  };
  for (const part of text.split(/(?<=[.!?…])\s+|\n+/).map((piece) => piece.trim()).filter(Boolean)) {
    const joined = carry ? `${carry} ${part}` : part;
    if (joined.length < MIN_SENTENCE) { carry = joined; continue; }
    carry = '';
    push(joined);
  }
  if (carry) push(carry);
  return out;
}

/** What the local voice engine needs of its page (fakes in tests). */
export interface LocalVoiceDeps {
  /** A local voice is chosen on the PC and this page may call voice.speak. */
  active(): boolean;
  speak(params: { text: string; voice?: string; language?: string }): Promise<SpokenAudio>;
  /** Plays PCM floats; `ended` runs once when they finished; resolves to the stop (rejects when audio cannot play here). */
  play(samples: Float32Array, rate: number, ended: () => void): Promise<() => void>;
  /** Opens the audio output while the reader's tap is still current (a phone allows audio only then). */
  prepare?(): void;
  now?(): number;
}

const unbase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * The PC's local voice in front of `fallback`: sentence by sentence through voice.speak (the next one is
 * asked while the current one plays); a failed call or playback, or a sentence later than `lateMs` after it is due,
 * hands the rest of the line to `fallback`; a failed call also rests the PC's voice for REST_MS.
 */
export function localVoiceEngine(deps: LocalVoiceDeps, fallback: SpeechEngine, timing: { lateMs?: number; restMs?: number } = {}): SpeechEngine {
  let line: { cut: boolean; stop: () => void } | null = null;
  let restUntil = 0;
  const now = () => deps.now?.() ?? Date.now();
  const lateMs = timing.lateMs ?? LATE_MS;
  return {
    play(text, reading, ended) {
      if (!text.trim() || now() < restUntil || !deps.active()) { line = { cut: false, stop: () => fallback.stop() }; fallback.play(text, reading, ended); return; }
      // The output is first opened in the call's tap (conversation-audio.ts primeSpeech); this is the second chance
      // for a reader without one – a reply arrives long after any tap, so on a phone this alone may stay suspended.
      try { deps.prepare?.(); } catch { /* play() says whether audio can play */ }
      const mine = { cut: false, stop: () => {} };
      line = mine;
      let finished = false;
      const finish = () => { if (!finished && !mine.cut) { finished = true; ended(); } };
      const parts = sentences(text);
      const speaker = reading.voice?.ttsVoice;
      const ask = (index: number) => deps.speak({ text: parts[index], ...(speaker && /^\d{1,2}$/.test(speaker) ? { voice: speaker } : {}), ...(reading.language ? { language: reading.language } : {}) });
      const rest = (index: number) => { // the fallback reads what the local voice did not
        if (mine.cut) return;
        mine.stop = () => fallback.stop();
        fallback.play(parts.slice(index).join(' '), reading, finish);
      };
      if (!parts.length) { finish(); return; }
      let pending = ask(0);
      pending.catch(() => undefined); // a late sentence's failure is nobody's
      const step = async (index: number): Promise<void> => {
        let audio: SpokenAudio | 'late';
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), lateMs); });
        try { audio = await Promise.race([pending, late]); } catch { restUntil = now() + (timing.restMs ?? REST_MS); rest(index); return; } finally { clearTimeout(timer); }
        if (mine.cut) return;
        if (audio === 'late') { rest(index); return; }
        if (index + 1 < parts.length) { pending = ask(index + 1); pending.catch(() => undefined); }
        const next = () => { if (mine.cut) return; if (index + 1 < parts.length) void step(index + 1); else finish(); };
        if (!audio.audio || !audio.sampleRate) { next(); return; }
        try { mine.stop = await deps.play(pcm16Samples(unbase64(audio.audio)), audio.sampleRate, next); } catch { rest(index); return; }
        if (mine.cut) mine.stop();
      };
      void step(0);
    },
    stop() {
      const current = line;
      line = null;
      if (!current) return;
      current.cut = true;
      current.stop();
    },
  };
}

let output: AudioContext | null = null;

/** Makes and resumes this page's audio output – call it inside a tap where a phone allows audio only then. */
export function prepareLocalVoice(): void {
  try { output ??= new AudioContext(); void output.resume().catch(() => undefined); } catch { output = null; }
}

/** A system voice picked by name is the person's choice of the device's voice (a number picks a speaker of the PC's voice). */
export const systemVoicePicked = (ttsVoice: string | null | undefined): boolean => Boolean(ttsVoice) && !/^\d{1,2}$/.test(ttsVoice ?? '');

const browserLocalVoice: LocalVoiceDeps = {
  active: () => can('voice.speak') && !systemVoicePicked(settings.value?.voice?.ttsVoice),
  speak: (params) => rpc.call('voice.speak', params),
  prepare: () => prepareLocalVoice(),
  async play(samples, rate, ended) {
    output ??= new AudioContext();
    if (output.state === 'suspended') await Promise.race([output.resume(), new Promise((resolve) => setTimeout(resolve, 500))]);
    if (output.state !== 'running') throw new Error('audio output is not allowed yet');
    const buffer = output.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(output.destination);
    let done = false;
    source.onended = () => { if (!done) { done = true; ended(); } };
    source.start();
    return () => { done = true; source.onended = null; try { source.stop(); } catch { /* already over */ } };
  },
};

const readingFromSettings = (): SpeechReading => ({ voice: settings.value?.voice, language: settings.value?.profile.language });

/** This page's one speech output (the PC's voice, else the device's own). */
export const deviceSpeech = new DeviceSpeech(localVoiceEngine(browserLocalVoice, synthesisEngine()));

/** A reader's channel of this page's speech output (reading voice and language from Settings by default). */
export function browserSpeech(reading: () => SpeechReading = readingFromSettings): SpeechOutput {
  return deviceSpeech.channel(reading);
}
