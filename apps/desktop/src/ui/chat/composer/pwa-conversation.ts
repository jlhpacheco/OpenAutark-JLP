// The voice conversation of this page – ONE loop on the desktop window and the phone (shared/voice/conversation.ts
// VoiceSessions): the level detector cuts an utterance → it is uploaded → voice.transcribe (the profile language as
// the hint) → messages.send marked spoken live → the agent's reply is read aloud → listen again. Up to three chats
// talk over the one microphone; the chat started or focused last listens. The microphone opens once, inside the tap
// of the first chat; later chats just join the loop. While a reply is spoken (and its tail) nothing is taken (echo
// guard), unless the person talks over it (barge-in). The screen stays on (wake lock). Owner 19.11.2026 ("Call läuft
// weiter, wenn man die App verlässt"): in the Android app (native port) the call goes on when the page is hidden – the
// app keeps it running (boot/voice-live.ts tells it); a browser page without the app (the iPhone web app) cannot record
// in the background, so there every conversation ends when the page is hidden (app switched, screen locked).
// B-081: start with a callId takes that call (an agent's ring or a call on another device); agents' names for the
// reading voice come from the org store. Each call turn's times go out once as calls.turn (ui/chat/call/turn-meter.ts).
// Owns: the page side (capture, speaking, wake lock, hide, the chat topics it holds). Never: audio processing beyond
// the capture, API keys (the runtime transcribes), or messages the loop did not send.

import { effect } from '@preact/signals';
import { newId } from '../../../shared/ids.ts';
import type { Topic } from '../../../shared/api/protocol.ts';
import { VoiceSessions } from '../../../shared/voice/conversation.ts';
import type { ConversationRpc, VoiceSessionEntry, VoiceSessionView } from '../../../shared/voice/conversation.ts';
import { recordingProblem } from '../../lib/dictation.ts';
import { platform } from '../../lib/platform.ts';
import { hasNativePort } from '../../pwa/native-port.ts';
import { rpc } from '../../lib/rpc.ts';
import { activeConversationId, agentMap, settings } from '../../lib/store.ts';
import { TurnMeter } from '../call/turn-meter.ts';
import { browserCapture, ConversationCapture } from './conversation-audio.ts';
import type { CaptureDeps } from './conversation-audio.ts';
import { browserSpeech, type SpeechOutput } from './device-speech.ts';
import { shownWith } from '../call/call-view.ts';
import type { Attachment } from '../../../shared/model/chat.ts';

/** What the page conversation needs (browser defaults: createBrowserConversation). */
export interface PageConversationDeps {
  rpc: Pick<ConversationRpc, 'call' | 'on'>;
  /** Keeps the chat's topic subscribed until the release is called. */
  holdTopic(topic: Topic): () => void;
  capture: CaptureDeps;
  speech: SpeechOutput;
  /** Keeps the screen on; null when this browser cannot. */
  wakeLock(): Promise<{ release(): unknown } | null>;
  /** Calls `listener` once the page is hidden; returns the removal. */
  onHide(listener: () => void): () => void;
  /** Why this page cannot record (no microphone API, plain http), or undefined. */
  microphoneProblem(): string | undefined;
  /** The transcription's language hint: the profile language ("de", "en-US"). */
  language?(): string | undefined;
  /** An agent's name for the reading voice (B-081: said when the speaker changes). */
  nameOf?(agentId: string): string | undefined;
  /** Owner 19.11.2026: the picture this device shows on the chat's call (call/call-view.ts shownWith). */
  shown?(conversationId: string): Promise<Attachment[]>;
  publish(mic: VoiceSessionView | null, error: string | undefined, chats: VoiceSessionEntry[]): void;
  after(ms: number, fn: () => void): () => void;
  newId(): string;
}

/** The conversation was ended while it was starting – nothing to report. */
export class ConversationCancelled extends Error {
  constructor() { super('Voice conversation was cancelled.'); this.name = 'ConversationCancelled'; }
}

export class PageConversation {
  private readonly deps: PageConversationDeps;
  private readonly sessions: VoiceSessions;
  private readonly meter: TurnMeter;
  private capture: ConversationCapture | null = null;
  private opening: Promise<void> | null = null; // the microphone opening (a second tap meanwhile waits for it)
  private stops = 0; // bumped by every stop: a start that a stop overtook gives up quietly
  private releases: Array<() => void> = [];

  constructor(deps: PageConversationDeps) {
    this.deps = deps;
    const meter = new TurnMeter(() => deps.capture.now(), (note) => { void deps.rpc.call('calls.turn', note).catch(() => undefined); });
    this.meter = meter;
    deps.rpc.on('message.created', (message) => meter.seen(message));
    deps.rpc.on('message.updated', (message) => meter.seen(message));
    const call = deps.rpc.call.bind(deps.rpc) as (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
    this.sessions = new VoiceSessions({
      rpc: {
        call: (async (method: string, params?: unknown, timeoutMs?: number) => {
          const result = await call(method, params, timeoutMs);
          meter.answered(method, params, result);
          return result;
        }) as ConversationRpc['call'],
        on: deps.rpc.on.bind(deps.rpc),
        subscribe: async (topic) => deps.holdTopic(topic),
      },
      publish: (mic, error, chats) => this.published(mic, error, chats),
      speak: (micId, text) => { meter.spoken(); deps.speech.speak(text, () => this.sessions.spokenDone(micId)); },
      silence: () => deps.speech.cancel(),
      newId: deps.newId,
      after: deps.after,
      language: () => deps.language?.(),
      nameOf: (agentId) => deps.nameOf?.(agentId),
      shown: (conversationId) => deps.shown?.(conversationId) ?? Promise.resolve([]),
    });
  }

  get active(): boolean { return this.capture !== null || this.sessions.active; }

  /** The chats talking now, the listening one first. */
  chats(): VoiceSessionEntry[] { return this.sessions.sessions(); }

  /** Talks in `conversationId` (call from the tap: the first chat opens the microphone); a running chat listens now; `callId` takes that call. */
  async start(conversationId: string, callId?: string): Promise<VoiceSessionView> {
    const stops = this.stops;
    if (!this.capture) this.opening = this.openCapture().finally(() => { this.opening = null; });
    if (this.opening) await this.opening;
    if (stops !== this.stops) throw new ConversationCancelled();
    try {
      return await this.sessions.start(conversationId, callId);
    } catch (error) {
      if (!this.sessions.active) this.teardown();
      throw stops !== this.stops ? new ConversationCancelled() : error;
    }
  }

  /** B-081: a pin as a line of the call in `conversationId`; false when that chat does not talk here. */
  add(conversationId: string, text: string): boolean { return this.sessions.add(conversationId, text); }

  /** Ends the chat's conversation (without one: the listening chat's). */
  stop(conversationId?: string): void {
    this.stops += 1;
    this.sessions.stop(conversationId);
    if (!this.sessions.active) this.teardown();
  }

  /** Ends every conversation (a dictation takes the microphone, the page hid, the microphone failed). */
  stopAll(error?: string): void {
    this.stops += 1;
    this.sessions.stopAll(error);
    this.teardown();
  }

  private async openCapture(): Promise<void> {
    const problem = this.deps.microphoneProblem();
    if (problem) throw new Error(problem);
    const capture = new ConversationCapture(
      { utterance: (micId, fileId) => this.sessions.utterance(micId, fileId), bargeIn: (micId) => this.sessions.bargeIn(micId), spoke: (_micId, at) => this.meter.spoke(at) },
      (error) => { if (this.capture === capture) this.stopAll(error instanceof Error ? error.message : 'The utterance could not be sent.'); },
      this.deps.capture,
    );
    this.capture = capture;
    try {
      await capture.open();
    } catch (error) {
      if (this.capture === capture) { this.sessions.stopAll(); this.teardown(); }
      throw error;
    }
    if (this.capture !== capture) throw new ConversationCancelled(); // ended while the microphone opened
    this.releases.push(this.deps.onHide(() => { if (this.capture === capture) this.stopAll(); }));
    this.keepAwake(capture);
  }

  private published(mic: VoiceSessionView | null, error: string | undefined, chats: VoiceSessionEntry[]): void {
    if (mic) this.capture?.follow(mic);
    else if (!this.sessions.active) this.teardown();
    this.deps.publish(mic, error, chats);
  }

  private keepAwake(capture: ConversationCapture): void {
    void this.deps.wakeLock().then((lock) => {
      if (!lock) return;
      const release = () => { try { void Promise.resolve(lock.release()).catch(() => undefined); } catch { /* already released */ } };
      if (this.capture === capture) this.releases.push(release);
      else release();
    }, () => undefined); // no wake lock (battery saver, policy): the conversation still works
  }

  private teardown(): void {
    const capture = this.capture;
    this.capture = null;
    capture?.close();
    this.deps.speech.cancel();
    for (const release of this.releases.splice(0)) { try { release(); } catch { /* ignore */ } }
  }
}

// ------------------------------------------------------------------ browser defaults

/**
 * Holds `chat:<id>` while talking. store-events keeps only the open chat's topic and drops this
 * one when the person opens another chat – it is taken back right after that change (a
 * microtask, after every effect of the navigation ran); on release it stays when that chat is open.
 */
export function holdChatTopic(topic: Topic): () => void {
  let held = true;
  rpc.subscribe([topic]);
  const dispose = effect(() => {
    void activeConversationId.value;
    queueMicrotask(() => { if (held) rpc.subscribe([topic]); });
  });
  return () => {
    if (!held) return;
    held = false;
    dispose();
    if (`chat:${activeConversationId.peek()}` !== topic) rpc.unsubscribe([topic]);
  };
}

interface WakeLockApi { request(type: 'screen'): Promise<{ release(): Promise<void> }> }

function screenWakeLock(): Promise<{ release(): unknown } | null> {
  const api = (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock);
  return api ? api.request('screen') : Promise.resolve(null);
}

/** Hiding the page ends the talk: a browser page on the phone without the Android app's port; the desktop window and
 *  the Android app keep talking hidden (checked at the moment it hides – the app's port may come after the start). */
export function hideEndsTalk(kind: string, nativePort: boolean): boolean {
  return kind === 'pwa' && !nativePort;
}

/** The phone page hidden (app switched, screen locked) where that ends the talk (hideEndsTalk). */
function onPageHidden(listener: () => void): () => void {
  if (platform !== 'pwa' || typeof document === 'undefined') return () => {};
  const ends = () => hideEndsTalk(platform, hasNativePort());
  const changed = () => { if (document.visibilityState === 'hidden' && ends()) listener(); };
  const left = () => { if (ends()) listener(); };
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('pagehide', left);
  return () => {
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener('pagehide', left);
  };
}

/** The page conversation with the browser's microphone, speech, wake lock and the app's rpc. */
export function createBrowserConversation(publish: PageConversationDeps['publish']): PageConversation {
  return new PageConversation({
    rpc,
    holdTopic: holdChatTopic,
    capture: browserCapture,
    speech: browserSpeech(),
    wakeLock: screenWakeLock,
    onHide: onPageHidden,
    microphoneProblem: () => recordingProblem() ?? (typeof MediaRecorder === 'undefined' ? 'This browser cannot record audio.' : undefined),
    language: () => settings.value?.profile.language,
    nameOf: (agentId) => agentMap.peek().get(agentId)?.name,
    shown: shownWith,
    publish,
    after: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
    newId: () => newId('req'),
  });
}
