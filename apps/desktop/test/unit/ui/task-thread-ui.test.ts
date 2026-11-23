// Per-task threads in the window (Quests round 20.11.2026; src/ui/chat/threads.ts, src/ui/lib/router.ts chatRoute): a
// task's own thread (its id is the task's) is a thread like a message's – one isThread check keeps both out of every
// list (here: the chat list's nesting and "Share in chat"); a chat route to it ('#/chat/task_…' from a search hit
// or a notification tap) opens the task; its unread lines are a dot on the task (hasThreadNews), read from the store's
// summary once the store holds the thread.
// Owns: these assertions. Never: renders (TaskThread.tsx is placed and checked with the new Tasks page).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import { hasThreadNews, isThread } from '../../../src/ui/chat/threads.ts';
import { nestChats } from '../../../src/ui/chat/list-order.ts';
import { shareChats } from '../../../src/ui/workspace/share-tab.ts';
import { chatRoute, parseRoute } from '../../../src/ui/lib/router.ts';
import { conversations } from '../../../src/ui/lib/store.ts';

const TASK = 'task_ab12cd34';

function chat(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, title: id, titleNamed: true, createdBy: 'human', pinned: false, settings: {}, lastSeq: 1, createdAt: 1, updatedAt: 1, lastMessageAt: 1,
    members: [{ conversationId: id, memberId: 'human', kind: 'human', role: 'owner', readSeq: 0, joinedAt: 1 }],
    unread: 0, working: [], openTasks: 0, ...extra,
  } as ConversationSummary;
}

test('isThread: a message\'s thread and a task\'s own thread – never a plain chat', () => {
  assert.equal(isThread(chat(TASK)), true);
  assert.equal(isThread(chat('ch_ab12cd34', { settings: { parentId: 'ch_zz12cd34', anchorId: 'msg_1' } })), true);
  assert.equal(isThread(chat('ch_ab12cd34')), false);
  assert.equal(isThread(chat('ch_ab12cd34', { settings: { parentId: 'ch_zz12cd34' } })), false, 'a sub-chat is a row');
});

test('a task\'s thread is in no list: not a row of the chat list, nowhere to share a page', () => {
  const room = chat('ch_room0001');
  const thread = chat(TASK);
  assert.deepEqual(nestChats([thread, room]).map((node) => node.chat.id), [room.id]);
  assert.deepEqual(shareChats([room, thread]).map((entry) => entry.id), [room.id]);
});

test('a chat route to a task\'s thread opens the task (search hit, notification tap); any other chat stays a chat', () => {
  assert.deepEqual(parseRoute(`#/chat/${TASK}`), { view: 'tasks', task: TASK });
  assert.deepEqual(chatRoute(TASK), { view: 'tasks', task: TASK });
  assert.deepEqual(parseRoute('#/chat/ch_ab12cd34'), { view: 'chat', id: 'ch_ab12cd34' });
});

test('hasThreadNews: the store\'s summary of the thread says it once the store holds it', () => {
  conversations.value = [];
  assert.equal(hasThreadNews(TASK), false, 'nothing known: no dot');
  conversations.value = [chat(TASK, { unread: 2 })];
  assert.equal(hasThreadNews(TASK), true);
  conversations.value = [chat(TASK, { unread: 0 })];
  assert.equal(hasThreadNews(TASK), false, 'read: the dot goes');
  conversations.value = [];
});
