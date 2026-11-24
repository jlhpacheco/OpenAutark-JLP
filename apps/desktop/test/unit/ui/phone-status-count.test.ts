// 0.3.20, no PC outranks another: the phone's status line (ui/pwa/phone-companies.ts) says how many PCs of the company
// are online instead of naming the one the page is on; an app before 0.3.20 sends no counts and still shows the name.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, statusLine } from '../../../src/ui/pwa/phone-companies.ts';

test('the status line counts the PCs online and names none of them', () => {
  assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: true, pc: 'Desk', online: 2, total: 3 })), 'Teydra Lab · 2 of 3 PCs online');
  assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: true, pc: 'Desk', online: 1, total: 1 })), 'Teydra Lab · 1 PC online');
  assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: true, online: 3, total: 3 })), 'Teydra Lab · 3 of 3 PCs online');
});

test('an app from before 0.3.20 sends no counts: the PC\'s name as before; link down: Connecting…', () => {
  assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: true, pc: 'Desk' })), 'Teydra Lab · Desk');
  assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: true })), 'Teydra Lab');
  assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: false, pc: 'Desk', online: 2, total: 3 })), 'Connecting…');
  assert.equal(statusLine('Teydra Lab', null), 'Connecting…');
});

test('counts that make no sense are ignored (more online than paired, none paired, not whole numbers)', () => {
  for (const bad of [{ online: 4, total: 3 }, { online: 0, total: 0 }, { online: 1.5, total: 3 }, { online: -1, total: 3 }, { online: '2', total: '3' }, { online: 2 }, { total: 3 }]) {
    assert.equal(statusLine('Teydra Lab', parseStatus({ t: 'status', connected: true, pc: 'Desk', ...bad })), 'Teydra Lab · Desk', JSON.stringify(bad));
  }
});
