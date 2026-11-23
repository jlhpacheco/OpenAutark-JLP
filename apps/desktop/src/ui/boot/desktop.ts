// Desktop-only glue between the window and Electron main (window.workforce, see
// shared/api/desktop.ts): update state, notification-click navigation, the pre-restart draft
// flush and the "safe to restart" signal (sent on change only; not while someone dictates or talks).
// Owner 19.11.2026: the page's "voice live" (voice-live.ts) goes to main (voiceLive: a hidden window keeps full speed) and,
// on the phone, to the Android app (native port {t:'voice.live', on, kind}; the app's {t:'voice.stop'} – its "End" in the
// notification – ends every call, conversation and dictation here: stopAllVoice); the call the page holds goes to the
// floating bubble (bubbleCall) and the bubble's End ends it here (endCallHere).
// Owns: those bridge listeners and reports. Never: talks to main for anything that is runtime state (that
// is RPC), never adds bridge members beyond WorkforceDesktopApi.

import { computed, effect, signal } from '@preact/signals';
import type { BubbleCall, NavigateRequest } from '../../shared/api/desktop.ts';
import { chatTitle } from '../lib/chat-naming.ts';
import { dictationLive } from '../lib/dictation.ts';
import { bridge, platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { callRequest, chatRoute, navigate, route } from '../lib/router.ts';
import { feedbackOpen, focusMessage, newChatOpen, paletteOpen, voiceSession, voiceSessions } from '../lib/shell-state.ts';
import { activeConversationId, conversationMap, tasks, todos, updateState } from '../lib/store.ts';
import { draftFor, flushAllDrafts } from '../chat/composer/draft.ts';
import { cancelDictation, dictateIntoDraft, dictating, dictationStarting, stopVoice } from '../chat/composer/voice.ts';
import { realtimeChat, stopRealtime } from '../chat/call/realtime-call.ts';
import { onNative, sendNative } from '../pwa/native-port.ts';
import { recordingLive, stopRecordings } from '../blocks/ui/recorder.ts';
import { changeNotifier, isRestartReady } from './readiness.ts';
import { follow, reportToApp, voiceSignals } from './voice-live.ts';

/** True while any modal <dialog> is open (kept by an attribute observer, no polling). */
const dialogOpen = signal(false);

function watchDialogs(): void {
  const check = () => { dialogOpen.value = document.querySelector('dialog[open]') !== null; };
  new MutationObserver(check).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  // A dialog that unmounts while open removes no attribute: re-check after view changes.
  effect(() => { void route.value; queueMicrotask(check); });
  check();
}

/**
 * Opens what a notification click points at: a chat; a task (its notice tag – Quests 20.11.2026: the task's page holds
 * its own thread, its tool and its line in the chat); a chat with a task's message there (the floating bar's request).
 */
export async function openTarget(request: NavigateRequest): Promise<void> {
  if (request.taskId && !request.conversationId) { navigate(chatRoute(request.taskId)); return; }
  let conversationId = request.conversationId;
  let messageId: string | undefined;
  if (request.taskId) {
    const known = tasks.value.find((task) => task.id === request.taskId) ?? todos.value.find((task) => task.id === request.taskId);
    const task = known ?? await rpc.call('tasks.get', { id: request.taskId }).catch(() => undefined);
    if (task) {
      conversationId ??= task.conversationId;
      messageId = task.messageId;
    }
  }
  if (!conversationId) return;
  navigate({ view: 'chat', id: conversationId });
  if (request.call) callRequest.value = conversationId; // the floating to-do button's Call (CallHeader.tsx starts it)
  if (messageId) focusMessage.value = { conversationId, messageId };
}

/**
 * Saves every pending draft and waits until the open chat's draft reached the runtime.
 * Rejects when that draft could not be saved (no connection, runtime error): the preload then
 * acks `ok: false` and main keeps the window instead of restarting over unsaved input.
 */
export async function saveDraftsNow(): Promise<void> {
  flushAllDrafts();
  const id = activeConversationId.value;
  if (!id) return;
  const draft = draftFor(id).value;
  if (!draft.text && !draft.attachments.length) return;
  // A queued call would only resolve after a reconnect; fail fast instead of hitting main's timeout.
  if (rpc.status.value !== 'open') throw new Error('The runtime is not connected; the draft is not saved.');
  await rpc.call('ui.saveDraft', { conversationId: id, text: draft.text, attachments: draft.attachments });
}

function watchRestartReadiness(setReady: (ready: boolean) => void): void {
  watchDialogs();
  const notify = changeNotifier(setReady);
  effect(() => {
    const id = activeConversationId.value;
    const draft = id ? draftFor(id).value : undefined;
    notify(isRestartReady({
      view: route.value.view,
      overlayOpen: dialogOpen.value || paletteOpen.value || !!newChatOpen.value || !!feedbackOpen.value,
      composerDirty: !!draft && (draft.text.trim().length > 0 || draft.attachments.length > 0),
      listening: dictating.value !== null || voiceSession.value !== null || realtimeChat.value !== null,
    }));
  });
}

/** The floating bubble's End: this page's call in that chat ends (and a call still asked for does not start). */
export function endCallHere(conversationId: string): void {
  if (callRequest.peek() === conversationId) callRequest.value = null;
  if (realtimeChat.peek() === conversationId) stopRealtime();
  void stopVoice(conversationId);
}

/** The Android app's voice.stop: every call and conversation of this page ends; a dictation ends into its draft (its
 *  words are kept) and a recording stops like its Stop (the take goes into the draft). The app hears voice.live off
 *  once all of it stopped. */
export function stopAllVoice(): void {
  callRequest.value = null;
  if (realtimeChat.peek()) stopRealtime();
  for (const chat of voiceSessions.peek()) void stopVoice(chat.conversationId);
  if (dictating.peek()) void dictateIntoDraft();
  else if (dictationStarting.peek()) void cancelDictation();
  stopRecordings();
}

/** Wires the desktop bridge listeners; in the PWA only "voice live" for the Android app (and its voice.stop). */
export function startDesktopBridge(): void {
  const voice = voiceSignals({
    dictation: computed(() => dictationLive.value || recordingLive.value), chats: voiceSessions, realtime: realtimeChat, // a take: dictated or recorded
    title: (id) => { const chat = conversationMap.value.get(id); return chat ? chatTitle(chat) : 'Call'; },
  });
  if (platform === 'pwa') {
    const onVisible = (fn: () => void) => {
      const shown = () => { if (document.visibilityState === 'visible') fn(); };
      document.addEventListener('visibilitychange', shown);
      return () => document.removeEventListener('visibilitychange', shown);
    };
    reportToApp(voice.kind, { send: sendNative, onPort: (fn) => onNative('port', fn), onVisible });
    onNative('voice.stop', stopAllVoice);
  }
  if (platform !== 'desktop' || !bridge) return;
  const desktop = bridge;
  follow(voice.live, (on) => desktop.voiceLive?.(on));
  follow(voice.call, (call) => desktop.bubbleCall?.(JSON.parse(call) as BubbleCall | null));
  desktop.onEndCall?.(endCallHere);
  const { updates } = bridge;
  void updates.state().then((state) => { updateState.value = state; }).catch(() => undefined);
  bridge.onUpdate((state) => { updateState.value = state; });
  bridge.onNavigate((request: NavigateRequest) => { void openTarget(request); });
  bridge.onPrepareRestart(saveDraftsNow);
  watchRestartReadiness((ready) => { try { updates.setReady(ready); } catch { /* main gone */ } });
}
