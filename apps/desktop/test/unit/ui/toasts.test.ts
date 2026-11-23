// The in-window toasts (src/ui/lib/toasts.ts): a toast expires after its time (6 s by default), one pushed with 0
// stays until it is dismissed, at most three at once (the oldest goes first); a runtime notification for a to-do or a
// blocker stays until Open or Dismiss (or until store-events drops it: its chat or the Tasks page open, its to-do finished),
// an important message goes after 20 s, a reply or a result expires.
// Owns: these assertions only. Never: the status line's markup (shell/StatusLine.tsx) or a real window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_ONLY_MS, dismissToast, dismissToastsWhere, pushToast, toastNotification, toastStartNotice, toasts } from '../../../src/ui/lib/toasts.ts';
import { atToastTarget } from '../../../src/ui/lib/store-events.ts';
import { parseRoute } from '../../../src/ui/lib/router.ts';
import type { Route } from '../../../src/ui/lib/router.ts';

const titles = () => toasts.value.map((toast) => toast.title);

test('a toast expires after its time; one pushed with 0 stays until dismissed; at most three at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  pushToast({ title: 'Copied', tone: 'info' }, 1500);
  pushToast({ title: 'Kept' }, 0);
  pushToast({ title: 'Default' });
  t.mock.timers.tick(1500);
  assert.deepEqual(titles(), ['Kept', 'Default']);
  t.mock.timers.tick(4500);
  assert.deepEqual(titles(), ['Kept'], 'the default time is 6 s');
  t.mock.timers.tick(30 * 24 * 60 * 60_000);
  assert.deepEqual(titles(), ['Kept'], 'no timer for 0');
  for (const title of ['a', 'b', 'c']) pushToast({ title }, 0);
  assert.deepEqual(titles(), ['a', 'b', 'c'], 'the oldest goes first');
  dismissToast(toasts.value[0].id);
  assert.deepEqual(titles(), ['b', 'c']);
});

test('a notification for a to-do or a blocker stays until Open or Dismiss; an important message goes after 20 s; a reply or a result expires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  toastNotification({ kind: 'important', title: 'Max posted on X', body: 'The launch post is live', conversationId: 'ch_1' });
  toastNotification({ kind: 'reply', title: 'Max', body: 'Done.', conversationId: 'ch_1' });
  assert.deepEqual(titles(), ['Max posted on X', 'Max']);
  t.mock.timers.tick(6000);
  assert.deepEqual(toasts.value.map(({ title, body, conversationId }) => ({ title, body, conversationId })), [{ title: 'Max posted on X', body: 'The launch post is live', conversationId: 'ch_1' }], 'the reply expired');
  t.mock.timers.tick(NOTICE_ONLY_MS - 6000);
  assert.deepEqual(titles(), [], 'feedback F10: the important message went by itself (it stays unread in its chat)');
  toasts.value = [];
  for (const kind of ['todo', 'blocker', 'done'] as const) toastNotification({ kind, title: kind, body: '', taskId: 'task_1' });
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(titles(), ['todo', 'blocker'], 'the result expired');
  assert.equal(toasts.value[0].taskId, 'task_1', 'Open goes to the to-do');
});

test('dismissToastsWhere drops only the toasts it picks (a chat opened, a to-do finished elsewhere)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  toastNotification({ kind: 'important', title: 'In chat 1', body: '', conversationId: 'ch_1' });
  toastNotification({ kind: 'todo', title: 'To-do 1', body: '', taskId: 'task_1' });
  toastNotification({ kind: 'blocker', title: 'Blocker in chat 2', body: '', conversationId: 'ch_2', taskId: 'task_2' });
  const before = toasts.value;
  dismissToastsWhere((toast) => toast.conversationId === 'ch_3');
  assert.equal(toasts.value, before, 'none picked: the list is left as it is (no redraw)');
  dismissToastsWhere((toast) => toast.conversationId === 'ch_1');
  assert.deepEqual(titles(), ['To-do 1', 'Blocker in chat 2'], 'chat 1 opened');
  dismissToastsWhere((toast) => toast.taskId === 'task_1');
  assert.deepEqual(titles(), ['Blocker in chat 2'], 'to-do 1 answered on the phone');
  dismissToastsWhere((toast) => toast.taskId === 'task_2');
  assert.deepEqual(titles(), []);
});

test('F25: a start notice saying an update did not install stays until Dismiss; "Updated to" goes by itself', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  toastStartNotice({ text: 'The update to 0.3.8 did not install · still on 0.3.6', failed: true });
  toastStartNotice({ text: 'Updated to 0.3.8 · 2 tasks continued' });
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(toasts.value.map(({ title, tone }) => [title, tone]), [['The update to 0.3.8 did not install · still on 0.3.6', 'error']]);
});

test('feedback F09/F10: important notices go by themselves after a while, with or without a chat; a to-do with a chat stays', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  toastNotification({ kind: 'important', title: 'office-pc is now linked', body: 'Remove it in Settings › Devices.' });
  toastNotification({ kind: 'important', title: 'Max posted on X', body: '', conversationId: 'ch_1' });
  toastNotification({ kind: 'todo', title: 'Confirm the login', body: '', conversationId: 'ch_1', taskId: 'task_1' });
  t.mock.timers.tick(6000);
  assert.deepEqual(titles(), ['office-pc is now linked', 'Max posted on X', 'Confirm the login'], 'longer than a reply');
  t.mock.timers.tick(NOTICE_ONLY_MS - 6000);
  assert.deepEqual(titles(), ['Confirm the login'], 'both important notices went, the to-do stays');
});

test('store-events: a toast is seen already where its Open leads – its chat, or the Tasks page (#/tasks, Home, an older #/day link) for a to-do outside a chat or on the For-you list', () => {
  const todo = { taskId: 'task_1' };
  assert.equal(atToastTarget({ conversationId: 'ch_a' }, { view: 'chat', id: 'ch_a' }, []), true);
  assert.equal(atToastTarget({ conversationId: 'ch_a' }, { view: 'chat', id: 'ch_b' }, []), false);
  for (const at of [{ view: 'home' }, { view: 'tasks' }, parseRoute('#/day')] as Route[]) assert.equal(atToastTarget(todo, at, []), true, at.view);
  assert.equal(atToastTarget(todo, { view: 'team' }, []), false);
  assert.equal(atToastTarget({ taskId: 'task_1', conversationId: 'ch_a' }, { view: 'tasks' }, []), false, 'a chat\'s to-do not on the list is seen in its chat');
  assert.equal(atToastTarget({ taskId: 'task_1', conversationId: 'ch_a' }, { view: 'tasks' }, [{ id: 'task_1' }]), true, 'its row on For you');
  assert.equal(atToastTarget({ conversationId: 'ch_a' }, { view: 'tasks' }, []), false, 'a chat message is seen in its chat');
});
