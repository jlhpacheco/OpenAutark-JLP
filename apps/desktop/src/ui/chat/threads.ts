// Threads in the window (B-078, owner 06.11.: "wie bei Discord … ein Arbeitsding, eine Sache, an der man gerade
// arbeitet"): a thread is a sub-chat on one message (settings.anchorId, runtime/chat/children.ts). Under its message it
// is one quiet line ("3 replies · Mara") that opens or closes it in the chat's side panel; it never shows in the list.
// Quests 20.11.2026 (owner: "pro einzelnen Task einen Chat …, also einen Verlauf"): a task's own thread is the
// conversation whose id is the task's (runtime/tasks/thread.ts); it lives in the task's detail (TaskThread.tsx), never in
// a chat list – isThread is the one check every list filter uses – and its unread lines are a dot on the task
// (hasThreadNews), not a count in the chat list.
// Owns: finding a message's thread in the store, the line's words, starting one, what counts as a thread, and which
// tasks' threads hold news. Never: renders (MessageItem.tsx, ThreadPanel.tsx, TaskThread.tsx) or decides members (the runtime does).

import { computed, signal } from '@preact/signals';
import { isTaskThread, type ConversationSummary, type Message } from '../../shared/model/chat.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { agentName, conversationMap, conversations } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toggleThread } from '../lib/shell-state.ts';
import { toastError } from '../lib/toasts.ts';

/** Every thread in the store by the message it answers. */
export const threadsByAnchor = computed(() => {
  const map = new Map<string, ConversationSummary>();
  for (const chat of conversations.value) if (chat.settings.anchorId && !map.has(chat.settings.anchorId)) map.set(chat.settings.anchorId, chat);
  return map;
});

/** A thread – a message's or a task's own – never a chat-list row. */
export const isThread = (chat: Pick<ConversationSummary, 'id' | 'settings'>): boolean => Boolean(chat.settings.anchorId) || isTaskThread(chat.id);

/**
 * The quiet line under the anchor: the thread's real replies (the runtime's count – status lines, edit notices, silent
 * and still streaming rows never count) and who wrote the last one ("3 replies · Mara"); '' while it has none.
 */
export function threadLine(thread: Pick<ConversationSummary, 'replies'>, nameOf: (id: string) => string = agentName): string {
  const count = thread.replies?.count ?? 0;
  if (!count) return '';
  const who = thread.replies?.authorId;
  const name = !who || who === SYSTEM_ID ? '' : who === HUMAN_ID ? 'You' : nameOf(who);
  return `${count} ${count === 1 ? 'reply' : 'replies'}${name ? ` · ${name}` : ''}`;
}

/** "Start thread": finds or opens the thread on `message` and shows it in the side panel of its chat. */
export async function startThread(message: Pick<Message, 'id' | 'conversationId'>): Promise<void> {
  try {
    const thread = await rpc.call('chats.thread', { messageId: message.id });
    toggleThread(message.conversationId, thread.id, true);
  } catch (error) {
    toastError(error, 'Thread not opened');
  }
}

/** The tasks whose thread had unread lines at the last (re)connect (chats.threadNews) – the store's summary rules once it holds the thread. */
const newsAtConnect = signal<ReadonlySet<string>>(new Set());
let newsWatched = false;

function loadNews(): void {
  rpc.call('chats.threadNews').then((ids) => { newsAtConnect.value = new Set(ids); }, () => undefined); // a link without chats: no dots
}

/** Whether task `taskId`'s thread holds lines the person has not read (the dot on the task). Reactive. */
export function hasThreadNews(taskId: string): boolean {
  if (!newsWatched) {
    newsWatched = true;
    rpc.onOpen(loadNews);
    if (rpc.status.peek() === 'open') loadNews();
  }
  const chat = conversationMap.value.get(taskId);
  return chat ? chat.unread > 0 : newsAtConnect.value.has(taskId);
}
