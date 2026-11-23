// Which chats a task surface may open and how the Tasks page's detail opens and closes (src/ui/tasks/jump.ts,
// src/ui/tasks/page-state.ts): ordinary chats in the store open; the app-owned anchor chats – the task center's Inbox
// and the To-do chat – never do, also once a conversation.upserted event or a lookup has put them into the store, so
// their tasks open the task's detail instead. Quests 20.11.2026: the selection is the route's #/tasks/<id> – opened
// from the page it is a history entry Back closes, a switch to another task replaces it, Close returns to the page's
// calendar, a link straight to a task closes in place; the side pane keeps a selection of its own.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, SystemChat } from '../../../src/shared/model/chat.ts';
import { parseRoute } from '../../../src/ui/lib/router.ts';
import { conversations, route } from '../../../src/ui/lib/store.ts';
import { canOpenChat, openTask, openTaskDetail } from '../../../src/ui/tasks/jump.ts';
import { closeDetail, openDetail, selected, showDay, shownDay } from '../../../src/ui/tasks/page-state.ts';

function chat(id: string, system?: SystemChat): ConversationSummary {
  return {
    id, title: id, members: [], settings: system ? { hiddenFromList: true, system } : {}, createdAt: 0, unread: 0, working: [],
  } as unknown as ConversationSummary;
}

const A = 'task_aaaaaaaa01';
const B = 'task_bbbbbbbb02';

// The router writes the hash in a window: a small history stand-in (entries, push, replace, back with its popstate).
const entries: string[] = ['#/home'];
let at = 0;
Object.assign(globalThis, {
  location: { get hash() { return entries[at]; } },
  history: {
    get length() { return entries.length; },
    pushState: (_state: unknown, _title: string, hash: string) => { entries.splice(at + 1); entries.push(hash); at++; },
    replaceState: (_state: unknown, _title: string, hash: string) => { entries[at] = hash; },
    back: () => { if (at > 0) at--; route.value = parseRoute(entries[at]); },
  },
});

/** Starts from `hash` as the only history entry. */
function startAt(hash: string): void {
  entries.splice(0, entries.length, hash);
  at = 0;
  route.value = parseRoute(hash);
}

test('ordinary chats open; the Inbox and the To-do chat never do, even when they are in the store', () => {
  conversations.value = [chat('ch_lea'), chat('ch_inbox', 'inbox'), chat('ch_todo', 'todo'), chat('ch_customize', 'customize')];
  assert.equal(canOpenChat('ch_lea'), true);
  assert.equal(canOpenChat('ch_customize'), true, 'the Customize chat is a chat the person works in');
  assert.equal(canOpenChat('ch_inbox'), false, 'the Inbox only holds intake records');
  assert.equal(canOpenChat('ch_todo'), false, 'the To-do chat only anchors the person\'s to-dos');
  assert.equal(canOpenChat('ch_unknown'), false, 'not in the store: not openable from here');
});

test('openTask: a task in the Inbox opens its detail on the Tasks page, not the hidden chat; Close shows the page', () => {
  conversations.value = [chat('ch_lea'), chat('ch_inbox', 'inbox')];
  startAt('#/home');
  openTask({ id: A, conversationId: 'ch_inbox', messageId: 'msg_1' });
  assert.equal(selected('main'), A);
  assert.equal(location.hash, `#/tasks/${A}`);
  assert.ok(!entries.some((hash) => hash.includes('ch_inbox')), 'never navigates to the Inbox');
  closeDetail('main');
  assert.deepEqual([...entries], ['#/home', '#/tasks'], 'Close shows the page (not back to Home)');
  assert.equal(selected('main'), null);
});

test('on the page: a row opens #/tasks/<id> as a new entry (the day kept), another row replaces it, Close and Back close it', () => {
  startAt('#/tasks?date=2026-11-21');
  openDetail('main', A);
  assert.deepEqual([...entries], ['#/tasks?date=2026-11-21', `#/tasks/${A}?date=2026-11-21`], 'the day stays');
  openDetail('main', B);
  assert.deepEqual([...entries], ['#/tasks?date=2026-11-21', `#/tasks/${B}?date=2026-11-21`], 'a switch replaces the entry');
  closeDetail('main');
  assert.equal(at, 0, 'Close went back to the page it was opened from');
  assert.equal(selected('main'), null);
  openDetail('main', A);
  (globalThis as unknown as { history: History }).history.back();
  assert.equal(selected('main'), null, 'Back closes it the same way');
  assert.equal(shownDay('main'), '2026-11-21');
});

test('a link straight to a task (a notification, a chat\'s "Open"): Close stays on the page and drops the task in place', () => {
  startAt(`#/tasks/${A}`);
  assert.equal(selected('main'), A);
  closeDetail('main');
  assert.deepEqual([...entries], ['#/tasks']);
  closeDetail('main'); // nothing open: nothing happens
  assert.deepEqual([...entries], ['#/tasks']);
  startAt('#/chat/ch_lea');
  openTaskDetail(B);
  assert.equal(location.hash, `#/tasks/${B}`);
  closeDetail('main');
  assert.deepEqual([...entries], ['#/chat/ch_lea', '#/tasks']);
});

test('the day: shown in the route (today drops it); the side pane keeps its own selection and day', () => {
  startAt('#/tasks');
  showDay('main', '2026-11-22');
  assert.equal(location.hash, '#/tasks?date=2026-11-22');
  showDay('main', null);
  assert.equal(location.hash, '#/tasks');
  openDetail('pane', A);
  showDay('pane', '2026-11-23');
  assert.equal(selected('pane'), A);
  assert.equal(shownDay('pane'), '2026-11-23');
  assert.equal(selected('main'), null, 'the main zone does not move');
  assert.equal(location.hash, '#/tasks');
  closeDetail('pane');
  assert.equal(selected('pane'), null);
});
