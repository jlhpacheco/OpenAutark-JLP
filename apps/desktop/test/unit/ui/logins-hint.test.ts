// Settings › Devices, 24.11.2026 (ORENDA find): a PC that refuses this PC's plan sign-ins says so on its row (connect-text.ts
// loginsHint) – why, in plain words, and what the person can do; nothing for a PC that takes them, a phone or a browser.
// Owns: these assertions only. Never: RPC or rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginsHint } from '../../../src/ui/settings/connect-text.ts';

const refused = { loginsRefused: { at: 1 } };
const pc = (extra: Record<string, unknown> = {}) => ({ kind: 'pc' as const, caps: {}, ...extra });

test('nothing for a PC that takes the sign-ins, a phone or a browser', () => {
  assert.equal(loginsHint(pc()), '');
  assert.equal(loginsHint({ kind: 'phone', caps: {}, ...refused }), '');
  assert.equal(loginsHint({ kind: 'browser', caps: {}, ...refused }), '');
});

test('a PC where this PC is only an employee: says why and to sign in on that PC itself', () => {
  assert.equal(loginsHint(pc({ ...refused, joinedAs: 'employee' })), 'Your sign-ins aren’t shared with this PC – you’re connected there as an employee. Sign in on that PC itself (Settings › Models).');
});

test('an employee\'s PC refuses: they sign in there themselves', () => {
  assert.equal(loginsHint(pc({ ...refused, personId: 'per_anna0000001' })), 'Your sign-ins aren’t shared with this PC – it belongs to an employee, who signs in there themselves.');
});

test('an older Autark there: update it, or sign in there; the same or no version: just sign in there', () => {
  const list = [{ kind: 'pc' as const, status: 'online' as const, caps: { version: '0.3.19' } }, { kind: 'pc' as const, status: 'online' as const, caps: { version: '0.3.9' } }];
  assert.equal(loginsHint(pc({ ...refused, caps: { version: '0.3.9' } }), list), 'Your sign-ins aren’t shared with this PC – its Autark is older (0.3.9). Update it there, or sign in on that PC itself (Settings › Models).');
  assert.equal(loginsHint(pc({ ...refused, caps: { version: '0.3.19' } }), list), 'Your sign-ins aren’t shared with this PC – it doesn’t accept them from here. Sign in on that PC itself (Settings › Models).');
  assert.equal(loginsHint(pc(refused)), 'Your sign-ins aren’t shared with this PC – it doesn’t accept them from here. Sign in on that PC itself (Settings › Models).');
});
