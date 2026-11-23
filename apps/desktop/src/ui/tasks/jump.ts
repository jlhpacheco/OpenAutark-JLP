// Navigation helpers shared by every task surface: jump to the anchor message of a task in its chat (paging older
// history in, bounded, when the message is not loaded yet), and open a task in the Tasks page's detail (Quests round
// 20.11.2026: #/tasks/<id> – the to-do's or quest's detail where the calendar was, its own thread in it). B-054: a task
// without a chat (made on the Tasks page, by a mail run, a reminder …) always opens the detail.
// Owns: the jump flow and where a task opens. Never: copies tasks – the overview always returns to the original chat
// and message – or opens an anchor chat (the old To-do chat, the old Inbox) as a chat.

import { effect } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { SystemChat } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { navigate } from '../lib/router.ts';
import { focusMessage } from '../lib/shell-state.ts';
import { activeConversationId, conversationMap, historyComplete, loadOlder, messagesFor } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { openDetail } from './page-state.ts';

// ------------------------------------------------------------------ jumping to the chat

const MAX_PAGES = 15;
const LOAD_WAIT_MS = 8000;

/** Resolves on the next change of a signal (or after the timeout). No polling. */
function nextChange<T>(source: Signal<T>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const initial = source.peek();
    let done = false;
    let dispose: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => dispose?.());
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    dispose = effect(() => { if (source.value !== initial) finish(); });
  });
}

/**
 * App-owned anchor chats that held task records before B-054 (the To-do chat, the task center's
 * Inbox): inert rows with old messages only (receipts, approval history); the person never opens
 * them as a chat – also after an event or a lookup put the hidden chat into the store.
 */
const ANCHOR_CHATS: ReadonlySet<SystemChat> = new Set<SystemChat>(['todo', 'inbox']);

/** True when the chat is visible to the human (no chat, hidden agent-only chats, the old To-do chat and Inbox cannot be opened). */
export function canOpenChat(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const chat = conversationMap.value.get(conversationId);
  return chat !== undefined && !(chat.settings.system !== undefined && ANCHOR_CHATS.has(chat.settings.system));
}

/** Opens the chat and scrolls to (and highlights) one message. */
export async function jumpToMessage(conversationId: string, messageId: string): Promise<void> {
  const list = messagesFor(conversationId);
  const wasOpen = activeConversationId.peek() === conversationId;
  focusMessage.value = { conversationId, messageId };
  if (!wasOpen) {
    const loaded = nextChange(list, LOAD_WAIT_MS); // ChatView loads the newest page on open
    navigate({ view: 'chat', id: conversationId });
    await loaded;
  }
  // Older than the loaded page: page back (bounded) – MessageList scrolls once it is there.
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (list.peek().some((message) => message.id === messageId)) return;
      if (historyComplete.has(conversationId) || activeConversationId.peek() !== conversationId) break;
      if (!(await loadOlder(conversationId))) break;
    }
  } catch (error) {
    toastError(error, 'Messages could not be loaded');
  }
  if (!list.peek().some((message) => message.id === messageId) && focusMessage.peek()?.messageId === messageId) focusMessage.value = null;
}

/** "Open in chat" for a task: its anchor message, else just the chat. */
export function openTaskInChat(task: Pick<TaskView, 'conversationId' | 'messageId'>): void {
  const chatId = task.conversationId;
  if (!chatId || !canOpenChat(chatId)) return;
  if (task.messageId) void jumpToMessage(chatId, task.messageId);
  else navigate({ view: 'chat', id: chatId });
}

/** Shows a task in the Tasks page's detail (from the page itself a new history entry: Back closes it). */
export function openTaskDetail(taskId: string): void {
  openDetail('main', taskId);
}

/**
 * Row click on an overview (Home, follow-up chips, a chat's task card): the original message in
 * its chat; tasks without a chat or in chats the human cannot open (agent-only rooms) open the
 * detail.
 */
export function openTask(task: Pick<TaskView, 'id' | 'conversationId' | 'messageId'>): void {
  if (canOpenChat(task.conversationId)) openTaskInChat(task);
  else openTaskDetail(task.id);
}
