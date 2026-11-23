// The page's "voice is live" (owner 19.11.2026: "wenn ich transkribiere anfange und dann zu einer anderen App switche,
// dass dann das Transkribieren weitergeht. Egal ob auf Handy oder PC"): true while a call (realtime voice), a voice
// conversation, a dictation/transcription take or a recording of this page holds the microphone. boot/desktop.ts feeds it the page's
// signals and reports it: the desktop window over the bridge (voiceLive – main keeps a hidden window's page at full
// speed), the Android app over the native port ({t:'voice.live', on, kind: 'call' | 'dictation'} – the app keeps the page
// and the microphone running in the background; sent on change, when a port arrives and when the page shows again).
// Beside it the call the page holds, as the floating bubble shows it (bubbleCall).
// Owns: the rule what counts as live, which chat is the call, and reporting both on change. Never: starts or stops
// voice, or reads the page's stores itself (the sources come in).

import { computed, effect, type ReadonlySignal } from '@preact/signals';
import type { BubbleCall } from '../../shared/api/desktop.ts';

/** One chat talking on this page (lib/shell-state.ts VoiceChat). */
export interface TalkingChat { conversationId: string; listening?: boolean }

/** What the page's voice is made of right now (`dictation`: a dictated or recorded take). */
export interface VoiceFacts { dictation: boolean; chats: readonly TalkingChat[]; realtime: string | null }

/** The page's signals behind the facts, and a chat's title for the bubble. */
export interface VoiceSources {
  dictation: ReadonlySignal<boolean>;
  chats: ReadonlySignal<readonly TalkingChat[]>;
  realtime: ReadonlySignal<string | null>;
  title(conversationId: string): string;
}

/** Any take, conversation or realtime call holds the microphone. */
export function isVoiceLive(facts: VoiceFacts): boolean {
  return facts.dictation || facts.chats.length > 0 || facts.realtime !== null;
}

/** What is live: a call (realtime voice or a conversation) before a dictation; null when nothing is. */
export function voiceKind(facts: VoiceFacts): 'call' | 'dictation' | null {
  if (facts.realtime !== null || facts.chats.length > 0) return 'call';
  return facts.dictation ? 'dictation' : null;
}

/** The chat whose call the page holds: realtime voice's, else the listening conversation's, else the first one's. */
export function callChat(facts: VoiceFacts): string | null {
  return facts.realtime ?? facts.chats.find((chat) => chat.listening)?.conversationId ?? facts.chats[0]?.conversationId ?? null;
}

/** "Voice live", what kind, and the bubble's call (as JSON, 'null' without one – a string, so an equal call is no change). */
export function voiceSignals(sources: VoiceSources): { live: ReadonlySignal<boolean>; kind: ReadonlySignal<'call' | 'dictation' | null>; call: ReadonlySignal<string> } {
  const facts = (): VoiceFacts => ({ dictation: sources.dictation.value, chats: sources.chats.value, realtime: sources.realtime.value });
  return {
    live: computed(() => isVoiceLive(facts())),
    kind: computed(() => voiceKind(facts())),
    call: computed(() => {
      const id = callChat(facts());
      return id ? JSON.stringify({ conversationId: id, title: sources.title(id) } satisfies BubbleCall) : 'null';
    }),
  };
}

/** Reports `value` now and on every change; returns the stop. */
export function follow<T>(value: ReadonlySignal<T>, report: (value: T) => void): () => void {
  return effect(() => {
    const now = value.value;
    try { report(now); } catch { /* the other side is gone: the next change tries again */ }
  });
}

/** The app's message: {t:'voice.live', on} with the kind while live. */
export function liveMessage(kind: 'call' | 'dictation' | null): { t: 'voice.live'; on: boolean; kind?: 'call' | 'dictation' } {
  return kind ? { t: 'voice.live', on: true, kind } : { t: 'voice.live', on: false };
}

/** The Android app: voice.live on every change, and the state now whenever a (new) port arrives or the page shows again. */
export function reportToApp(
  kind: ReadonlySignal<'call' | 'dictation' | null>,
  native: { send(msg: ReturnType<typeof liveMessage>): boolean; onPort(fn: () => void): () => void; onVisible?(fn: () => void): () => void },
): () => void {
  const tell = () => { native.send(liveMessage(kind.peek())); };
  const off = native.onPort(tell);
  const offVisible = native.onVisible?.(tell) ?? (() => undefined);
  let first = true;
  const stop = effect(() => {
    void kind.value;
    if (first) { first = false; return; } // the port's arrival tells the first state
    tell();
  });
  return () => { off(); offVisible(); stop(); };
}
