// The status line: a few small lines that lie over the top of the main zone (desktop) or under the phone's
// top row – never a reserved band, so nothing moves when one comes or goes. Shown: the connection, the
// emergency stop (Resume), an agent's ringing call (Accept, Decline) and a call on another device (Take over, Open –
// chat/call/call-notices.ts), running voice conversations (Open/Talk, End) and realtime voice (Open, End) – B-085: a call
// in the open chat shows on its call card (chat/call/CallCard.tsx) instead, a voice line stays only while it needs Talk –,
// an agent using the computer (Watch – computer-notice.ts) and the toasts (lib/toasts.ts, newest first; most expire by
// themselves – an important message after 20 s –, those for to-dos and blockers stay until Open, Dismiss or until their
// chat or the Tasks page is open; Open on a to-do's toast opens that to-do, on a toast of several due to-dos the page);
// other areas may register more
// (shell/notices.ts). At most three lines at once; the rest follow as earlier ones go.
// Owns: the line markup and the shell's own providers. Never: a notice's order (notices.ts).

import { useState } from 'preact/hooks';
import { rpc } from '../lib/rpc.ts';
import { activeConversationId, conversationMap, loadError, loaded } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { go, navigate } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { voicePhase, voiceSessions } from '../lib/shell-state.ts';
import { dismissToast, toasts } from '../lib/toasts.ts';
import { IconButton, Spinner } from '../lib/ui.tsx';
import { focusVoice, stopVoice } from '../chat/composer/voice.ts';
import { openTaskDetail } from '../tasks/jump.ts';
import { realtimeChat, stopRealtime } from '../chat/call/realtime-call.ts';
import { answerCall, talking } from '../chat/call/CallHeader.tsx';
import { registerCallNotices } from '../chat/call/call-notices.ts';
import { registerAiNotice } from '../onboarding/ai-notice.ts';
import { registerSpeechPullNotice } from '../settings/speech-models.ts';
import { registerComputerNotice } from './computer-notice.ts';
import { NOTICE_PRIORITY, connectionNotice, registerNotice, visibleNotices } from './notices.ts';
import type { Notice, NoticeAction } from './notices.ts';
import { resumeAllWork, watchWorkStop, workStop } from './work-stop.ts';

const SHOWN = 3;

const chatName = (id: string): string => {
  const chat = conversationMap.value.get(id);
  return (chat && chatTitle(chat)) || 'Conversation';
};

function workStopNotice(): Notice | null {
  const state = workStop.value;
  if (!state?.stopped) return null;
  const actions: NoticeAction[] = can('work.resume') ? [{ label: 'Resume', run: () => resumeAllWork() }] : [];
  return { id: 'work-stop', tone: 'warn', text: state.stoppedFrom ? `Agent work stopped from ${state.stoppedFrom}` : 'Agent work stopped', actions, priority: NOTICE_PRIORITY.workStop };
}

function voiceNotices(): Notice[] {
  const sessions = voiceSessions.value;
  const several = sessions.length > 1;
  const open = activeConversationId.value;
  // B-085: the open chat's call shows on its call card (chat/call/CallCard.tsx); the line stays only while it needs "Talk".
  return sessions.filter((session) => !(session.conversationId === open && session.listening !== false)).map((session) => {
    const id = session.conversationId;
    const phase = voicePhase(session, several);
    const actions: NoticeAction[] = [];
    if (open !== id) actions.push({ label: 'Open', run: () => navigate({ view: 'chat', id }) });
    else if (session.listening === false) actions.push({ label: 'Talk', run: () => focusVoice(id) });
    actions.push({ label: 'End', run: () => stopVoice(id) });
    return { id: `voice:${id}`, tone: 'info', text: phase ? `${chatName(id)} · ${phase}` : chatName(id), actions, priority: NOTICE_PRIORITY.voice };
  });
}

function realtimeNotice(): Notice | null {
  const id = realtimeChat.value;
  if (!id || activeConversationId.value === id) return null; // B-085: the open chat's call card shows it
  const actions: NoticeAction[] = [{ label: 'Open', run: () => navigate({ view: 'chat', id }) }];
  actions.push({ label: 'End', run: () => stopRealtime() });
  return { id: `realtime:${id}`, tone: 'info', text: `${chatName(id)} · realtime voice`, actions, priority: NOTICE_PRIORITY.call };
}

function toastNotices(): Notice[] {
  return [...toasts.value].reverse().map((toast): Notice => {
    const text = toast.body ? `${toast.title} · ${toast.body}` : toast.title;
    const chat = toast.conversationId;
    const task = toast.taskId;
    const open = chat ? () => navigate({ view: 'chat', id: chat })
      : task ? () => ((toast.due?.length ?? 1) > 1 ? go.tasks() : openTaskDetail(task)) : undefined;
    const own = toast.action; // B-082: the toast's own button (a kept recording's "Transcribe again")
    const actions = [...(own ? [{ label: own.label, run: () => { own.run(); dismissToast(toast.id); } }] : []),
      ...(open ? [{ label: 'Open', run: () => { open(); dismissToast(toast.id); } }] : [])];
    return {
      id: `toast-${toast.id}`, tone: toast.tone === 'error' ? 'error' : 'info', text, detail: text, priority: NOTICE_PRIORITY.toast,
      ...(actions.length ? { actions } : {}),
      onDismiss: () => dismissToast(toast.id),
    };
  });
}

/** Registers the shell's providers once per app start; returns the function that removes them. */
export function registerShellNotices(): () => void {
  watchWorkStop();
  const off = [
    registerNotice(() => connectionNotice({ status: rpc.status.value, loaded: loaded.value, loadError: loadError.value })),
    registerNotice(workStopNotice),
    registerCallNotices({ answer: answerCall, talking }), // B-081: rings and calls on another device
    registerNotice(voiceNotices),
    registerNotice(realtimeNotice),
    registerComputerNotice(),
    registerNotice(toastNotices),
    registerAiNotice(),
    registerSpeechPullNotice(),
  ];
  return () => off.forEach((unregister) => unregister());
}

function Action(props: { action: NoticeAction }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await props.action.run(); } finally { setBusy(false); }
  };
  return (
    <button type="button" class={`button ${props.action.primary ? 'primary' : 'secondary'} status-action`} title={props.action.title}
      disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}>
      {props.action.label}
      {busy && <span class="status-action-spin"><Spinner size={12} /></span>}
    </button>
  );
}

export function StatusLine() {
  const list = visibleNotices.value.slice(0, SHOWN);
  return (
    <div class="status-host" role="status" aria-live="polite">
      {list.map((notice) => (
        <div key={notice.id} class={`status-note tone-${notice.tone}`} data-notice={notice.id}>
          <span class="status-text" title={notice.detail ?? notice.text}>{notice.text}</span>
          {notice.actions?.map((action) => <Action key={action.label} action={action} />)}
          {notice.onDismiss && <IconButton icon="x" label="Dismiss" size="small" iconSize={12} class="status-dismiss" onClick={notice.onDismiss} />}
        </div>
      ))}
    </div>
  );
}
