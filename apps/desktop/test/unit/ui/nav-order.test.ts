// Feedback 20031F6D (owner 21.11.2026, "die sachen würde ich gerne selber drag and drop anordnen wie ich will"): the
// left rail's destinations take the person's own order (src/ui/shell/nav-order.ts), kept in settings.preferences.navOrder.
// A saved order applies to the destinations this version has: ids it no longer knows drop out, destinations the saved
// list does not name (a newer version's) come after the named ones in their default order; a drag, Alt+Arrow and the
// menu's Move up/down move one destination; Reset order is the default again (saved as []).
// Owns: these assertions. Never: renders (the drag's look is checked in a preview).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NAV_ORDER, dropNav, isDefaultNav, moveNav, navToSave, orderNav } from '../../../src/ui/shell/nav-order.ts';

const KEYS = DEFAULT_NAV_ORDER;

test('the default order is Tasks, Chats, Team', () => {
  assert.deepEqual([...KEYS], ['tasks', 'chats', 'team']);
});

test('nothing saved shows the default order', () => {
  assert.deepEqual(orderNav(KEYS, undefined), ['tasks', 'chats', 'team']);
  assert.deepEqual(orderNav(KEYS, null), ['tasks', 'chats', 'team']);
  assert.deepEqual(orderNav(KEYS, []), ['tasks', 'chats', 'team']);
});

test('a saved order applies', () => {
  assert.deepEqual(orderNav(KEYS, ['team', 'tasks', 'chats']), ['team', 'tasks', 'chats']);
  assert.deepEqual(orderNav(KEYS, ['chats', 'team', 'tasks']), ['chats', 'team', 'tasks']);
});

test('ids this version no longer has drop out, duplicates and non-strings are ignored', () => {
  assert.deepEqual(orderNav(KEYS, ['day', 'team', 'work', 'chats', 'tasks']), ['team', 'chats', 'tasks']);
  assert.deepEqual(orderNav(KEYS, ['team', 'team', 7 as unknown as string, 'chats']), ['team', 'chats', 'tasks']);
});

test('a destination the saved order does not name (a newer version) still appears, after the named ones', () => {
  assert.deepEqual(orderNav(KEYS, ['team']), ['team', 'tasks', 'chats']);
  assert.deepEqual(orderNav(['tasks', 'chats', 'team', 'files'] as const, ['team', 'chats', 'tasks']), ['team', 'chats', 'tasks', 'files']);
});

test('a saved value that is not a list reads as the default', () => {
  assert.deepEqual(orderNav(KEYS, 'team' as unknown as string[]), ['tasks', 'chats', 'team']);
});

test('dropping a destination on another takes that one\'s place', () => {
  const order = ['tasks', 'chats', 'team'] as const;
  assert.deepEqual(dropNav(order, 'team', 'tasks'), ['team', 'tasks', 'chats']);
  assert.deepEqual(dropNav(order, 'tasks', 'team'), ['chats', 'team', 'tasks']);
  assert.deepEqual(dropNav(order, 'chats', 'tasks'), ['chats', 'tasks', 'team']);
  assert.equal(dropNav(order, 'chats', 'chats'), null, 'on itself: no change');
  assert.equal(dropNav(order, 'chats', 'files' as never), null, 'an unknown target: no change');
});

test('Alt+Arrow and Move up/down move one step, not past the ends', () => {
  const order = ['tasks', 'chats', 'team'] as const;
  assert.deepEqual(moveNav(order, 'chats', -1), ['chats', 'tasks', 'team']);
  assert.deepEqual(moveNav(order, 'chats', 1), ['tasks', 'team', 'chats']);
  assert.equal(moveNav(order, 'tasks', -1), null);
  assert.equal(moveNav(order, 'team', 1), null);
});

test('what is saved: the whole order, or [] when it is the default (Reset order)', () => {
  assert.deepEqual(navToSave(KEYS, ['team', 'tasks', 'chats']), ['team', 'tasks', 'chats']);
  assert.deepEqual(navToSave(KEYS, ['tasks', 'chats', 'team']), []);
  assert.equal(isDefaultNav(KEYS, ['tasks', 'chats', 'team']), true);
  assert.equal(isDefaultNav(KEYS, ['chats', 'tasks', 'team']), false);
  assert.deepEqual(orderNav(KEYS, navToSave(KEYS, ['tasks', 'chats', 'team'])), ['tasks', 'chats', 'team']);
});
