// 20.11.2026 (owner: "dass man da austreten kann"): a company taken off this PC says the goodbye 'left' (runtime/devices/
// away.ts) – the other PC drops it from its linked PCs (revoked, its link ended, not let in again); an employee's PC leaving its
// firm is dropped the same way; an ordinary goodbye still only marks the PC away.
// Owns: these assertions only. Never: network beyond the in-memory nodes of mesh-nodes.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLeft, LEFT } from '../../../src/runtime/devices/away.ts';
import { idOf, linkedPair, settle } from './mesh-nodes.ts';

const listed = (node: Awaited<ReturnType<typeof linkedPair>>['a'], other: Awaited<ReturnType<typeof linkedPair>>['a']) => node.mesh.list().some((device) => device.id === idOf(other));

test('a PC that left is dropped by the other one: revoked, its link gone, no away state', async () => {
  const { low, high } = await linkedPair();
  await low.mesh.bye(LEFT);
  await settle();
  assert.equal(listed(high, low), false, 'gone from its linked PCs (revoked)');
  assert.equal(high.mesh.online(idOf(low)), false, 'its link ends');
  low.timers.fire(); // the smaller id would dial again: the revoked PC is refused
  await settle();
  assert.equal(listed(high, low), false, 'and stays gone');
});

test('an employee\'s PC that leaves is dropped by the firm\'s PC; a plain goodbye is still only away', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'pe_1' });
  await b.mesh.bye('quit');
  assert.equal(a.mesh.list().find((device) => device.id === idOf(b))?.away?.reason, 'quit');
  assert.equal(listed(a, b), true);
  await b.mesh.bye(LEFT);
  await settle();
  assert.equal(listed(a, b), false);
  assert.equal(isLeft({ reason: 'left' }), true);
  assert.equal(isLeft({ reason: 'quit' }), false);
  assert.equal(isLeft(null), false);
});
