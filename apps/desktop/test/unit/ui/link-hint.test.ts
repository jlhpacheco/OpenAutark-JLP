// Settings › Devices, G (Fest round 22.11.2026): a device row's hint ends with its connection now (connect-text.ts
// linkHint) – "45 ms", "1.2 s", "Slow connection · 450 ms" when the runtime says slow; nothing while unmeasured, for a PC
// that is not online, or for a figure older than five minutes (a phone's kept list shows no old round trip).
// Owns: these assertions only. Never: RPC or rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkHint } from '../../../src/ui/settings/connect-text.ts';
import { LINK_STALE_MS } from '../../../src/shared/model/devices.ts';

const NOW = 1_000_000;
const pc = (link?: { rttMs: number; slow?: true; at: number }, status: 'online' | 'offline' = 'online') => ({ kind: 'pc' as const, status, ...(link ? { link } : {}) });

test('the round trip in ms, from a second in s, slow ones said so', () => {
  assert.equal(linkHint(pc({ rttMs: 45, at: NOW }), NOW), '45 ms');
  assert.equal(linkHint(pc({ rttMs: 1_240, slow: true, at: NOW }), NOW), 'Slow connection · 1.2 s');
  assert.equal(linkHint(pc({ rttMs: 450, slow: true, at: NOW }), NOW), 'Slow connection · 450 ms');
  assert.equal(linkHint({ kind: 'phone', status: 'offline', link: { rttMs: 120, at: NOW } }, NOW), '120 ms', 'a phone: its pings say it is there');
});

test('nothing while unmeasured, for a PC not online, or for an old figure', () => {
  assert.equal(linkHint(pc(), NOW), '');
  assert.equal(linkHint(pc({ rttMs: 45, at: NOW }, 'offline'), NOW), '');
  assert.equal(linkHint({ kind: 'phone', status: 'online', link: { rttMs: 45, at: NOW - LINK_STALE_MS - 1 } }, NOW), '');
});
