// A chat's voice mode in the chat header: one fixed 32×32 call cell (lib/header.tsx), rendered for every chat that
// may talk (else an inert placeholder of the same size). Tap while voice or realtime voice runs in this chat → it
// stops (phone-disconnect, danger tint). Otherwise it starts: with settings.voice.realtime 'auto' realtime voice first
// (the audio output is made inside the tap – prepareRealtimeOutput); when that cannot start, or ends by itself, the
// chat's voice conversation takes over (composer/voice.ts startVoice). With 'off' the voice conversation directly.
// Both are this device's one call in the chat (its bubble, runtime/calls/call-log.ts): the voice conversation joins the call
// a realtime session opened, and End ends it. Only its icon, label and tone change – nothing beside it moves.
// B-081: answerCall takes a call – an agent's ring (the status line's Accept, call-notices.ts) or a call on another
// device (Take over); the cell does the same while this chat's call rings or runs elsewhere. A part that ends because
// another device took the call over (TAKEN_OVER) ends quietly: no fallback, no error.
// B-085: while this device talks in the chat the cell is a slot holding the same End button plus the floating call
// card (CallCard.tsx), which it lays into the chat column of its own chat view – so the card lives exactly as long as
// the call shows here, and its Hang up is the cell's End.
// Owner 18.11.2026: a call asked for by the floating to-do button (lib/router.ts callRequest) starts once the cell shows.
// Owner 19.11.2026: answerCall with `join` (the status line's Join beside Take over, call-notices.ts) joins the running call
// beside the devices in it (calls.start with join) and then talks in it with the voice conversation – never realtime, whose
// session would be a call of its own; when talking cannot start here, this device leaves again.
// Team-Call 21.11.2026: while another person's call runs in the chat (LiveCall.others) the cell is Join – it joins them.
// Owns: the cell's states and what a tap starts. Never: the voice loop (voice.ts) or realtime audio (realtime-call.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import { TAKEN_OVER } from '../../../shared/model/call.ts';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import type { HeaderCell } from '../../lib/header.tsx';
import { cellClass } from '../../lib/header-model.ts';
import { callRequest } from '../../lib/router.ts';
import { rpc } from '../../lib/rpc.ts';
import { voiceSessions } from '../../lib/shell-state.ts';
import { settings } from '../../lib/store.ts';
import { toastError } from '../../lib/toasts.ts';
import { Icon } from '../../lib/ui.tsx';
import { conversationAvailable, startVoice, stopVoice } from '../composer/voice.ts';
import { CallCard } from './CallCard.tsx';
import { liveCalls } from './call-notices.ts';
import { discardRealtimeOutput, prepareRealtimeOutput, realtimeChat, startRealtime, stopRealtime } from './realtime-call.ts';

/** The call cell's id (`.frame-header [data-cell="call"]`). */
export const CALL_CELL = 'call';

/** This chat may talk on this connection (no system chats). */
export function callable(chat: ConversationSummary): boolean {
  return !chat.settings.system && conversationAvailable();
}

/** Voice or realtime voice runs in this chat on this device. */
export function talking(conversationId: string): boolean {
  return realtimeChat.value === conversationId || voiceSessions.value.some((chat) => chat.conversationId === conversationId);
}

/** Starts the chat's voice mode from the tap: realtime voice when it is on, else (or when it fails) the voice conversation. */
async function startCall(conversationId: string, callId?: string): Promise<void> {
  if (settings.peek()?.voice?.realtime !== 'auto') { await startVoice(conversationId, callId); return; }
  const output = prepareRealtimeOutput(); // inside the tap: mobile browsers keep a later one suspended
  try {
    await startRealtime(conversationId, (reason) => {
      if (reason === TAKEN_OVER) return; // B-081: the call goes on on another device
      if (reason) toastError(new Error(reason), 'Realtime voice ended');
      void startVoice(conversationId); // the call goes on in the chat's voice conversation
    }, undefined, output, callId);
  } catch {
    discardRealtimeOutput(output);
    await startVoice(conversationId, callId); // no realtime model here (or it failed): the voice conversation
  }
}

/** Owner 19.11.2026: this device joins the running call beside the devices in it, then talks in it (the voice conversation finds it). */
async function joinCall(conversationId: string, callId: string): Promise<void> {
  await rpc.call('calls.start', { conversationId, callId, join: true });
  if (!(await startVoice(conversationId))) await rpc.call('calls.end', { callId }).catch(() => undefined);
}

/** B-081: takes the call `callId` on this device – answers a ring or takes it over from another device; `join`: joins it beside them. Call from the tap. */
export function answerCall(conversationId: string, callId: string, join = false): Promise<void> {
  return (join ? joinCall(conversationId, callId) : startCall(conversationId, callId)).catch((error: unknown) => toastError(error, join ? 'Call not joined' : 'Call not taken'));
}

/** Ends the chat's voice mode on this device. */
function endCall(conversationId: string): void {
  if (realtimeChat.peek() === conversationId) stopRealtime();
  void stopVoice(conversationId);
}

const LEAVE_CLASS = cellClass({ id: CALL_CELL, icon: 'phone-disconnect', label: 'End voice', tone: 'danger', class: 'call-cell call-leave' });

/** The cell while this device talks here: End (the look of a danger cell) and the call card in this chat's column. */
function CallLeave(props: { chat: ConversationSummary }) {
  const button = useRef<HTMLButtonElement>(null);
  const end = () => endCall(props.chat.id);
  return (
    <>
      <button ref={button} type="button" class={`icon-button ${LEAVE_CLASS}`} aria-label="End voice" title="End voice" onClick={end}>
        <Icon name="phone-disconnect" size={18} />
      </button>
      <CallCard chat={props.chat} anchor={button} onHangUp={end} />
    </>
  );
}

/** The header's call cell: Talk → End in the same box (busy while it starts); Answer / Take over while this chat's call rings or runs elsewhere. */
export function useCallCell(chat: ConversationSummary): HeaderCell {
  const [busy, setBusy] = useState(false);
  // Owner 18.11.2026: the floating to-do button's Call opens this chat with its call asked for (lib/router.ts callRequest)
  const asked = callRequest.value === chat.id;
  useEffect(() => {
    if (!asked) return;
    callRequest.value = null;
    if (!callable(chat) || talking(chat.id)) return;
    setBusy(true);
    void startCall(chat.id).catch((error: unknown) => toastError(error)).finally(() => setBusy(false));
  }, [asked, chat.id]);
  if (!callable(chat)) return { id: CALL_CELL, placeholder: true };
  if (talking(chat.id)) return { id: CALL_CELL, slot: <CallLeave chat={chat} /> };
  const live = liveCalls.value.find((call) => call.conversationId === chat.id && (call.state === 'running' || (call.until ?? 0) > Date.now()));
  const start = () => {
    setBusy(true);
    const started = live?.others ? answerCall(chat.id, live.callId, true) : startCall(chat.id, live?.callId); // Team-Call: another person's call is joined
    void started.catch((error: unknown) => toastError(error)).finally(() => setBusy(false));
  };
  const label = live ? (live.state === 'ringing' ? 'Answer' : live.others ? 'Join' : 'Take over') : 'Talk';
  return { id: CALL_CELL, icon: 'phone', label, busy, class: 'call-cell call-start', onClick: start };
}
