// Feedback c0b0a7d6 (17.11.2026: three "Due: …" toasts stood far too long; src/ui/lib/toasts.ts): to-dos falling due are
// one toast – a newer one replaces it, several read "3 to-dos due" with the newest titles, it has no chat (Open goes to My
// day, shell/StatusLine.tsx) and goes by itself after six seconds like the push; other to-do toasts keep their rule.
// Owns: these assertions only. Never: the status line's markup or a real window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUE_PREFIX, toastNotification, toasts } from '../../../src/ui/lib/toasts.ts';

const due = (title: string, taskId: string) => toastNotification({ kind: 'todo', title: `${DUE_PREFIX}${title}`, body: 'Notes', taskId, conversationId: 'ch_1' });

test('one due toast: replaced by the next, grouped with the newest titles, Open to My day, gone after 6 s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  due('Call the bank', 'ta_1');
  assert.equal(toasts.value.length, 1);
  assert.equal(toasts.value[0].title, 'Due: Call the bank');
  assert.equal(toasts.value[0].body, 'Notes');
  assert.equal(toasts.value[0].conversationId, undefined, 'no chat: Open goes to My day');
  assert.equal(toasts.value[0].taskId, 'ta_1');
  t.mock.timers.tick(4_000);
  due('Send the invoice', 'ta_2');
  due('Water the plants', 'ta_3');
  due('Book the train', 'ta_4');
  assert.equal(toasts.value.length, 1, 'never three stacked');
  assert.equal(toasts.value[0].title, '4 to-dos due');
  assert.equal(toasts.value[0].body, 'Book the train · Water the plants · Send the invoice');
  assert.equal(toasts.value[0].taskId, 'ta_4');
  t.mock.timers.tick(5_999);
  assert.equal(toasts.value.length, 1);
  t.mock.timers.tick(1);
  assert.equal(toasts.value.length, 0, 'it goes by itself; the to-dos stay on the Tasks page');
  due('Next morning', 'ta_5');
  assert.equal(toasts.value[0].title, 'Due: Next morning', 'a new group starts');
});

test('other to-do toasts keep their rule: they stay until Open or Dismiss', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  toastNotification({ kind: 'todo', title: 'Confirm the login', body: '', conversationId: 'ch_1', taskId: 'ta_9' });
  due('Call the bank', 'ta_1');
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(toasts.value.map((toast) => toast.title), ['Confirm the login']);
});
