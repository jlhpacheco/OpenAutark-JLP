// Owner 19.11.2026: the to-do bubble's way back – the round icon in the phone's top row is pulled a little away and the
// bubble follows the finger (src/ui/pwa/bubble-pull.ts, bubble-handle.tsx, lib/header.tsx; the app's side is
// phoneuse/BubblePull.java via NativePort.java). Pure steps: a press under the slop sends nothing, the pull starts
// beyond it, then moves, then the drop at the lift; the app's state message read strictly; the header places the icon
// only in a phone row without a lead.
// Owns: these assertions. Never: a WebView, a phone or the bubble.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PULL_SLOP, bubbleStateOf, startPull } from '../../../src/ui/pwa/bubble-pull.ts';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('a press under the slop sends nothing; beyond it the pull, then moves, then the drop where the finger lifts', () => {
  const pull = startPull(20, 20);
  assert.equal(pull.move(20 + PULL_SLOP - 1, 20), null, 'still a press');
  assert.equal(pull.pulled, false);
  assert.deepEqual(pull.move(24, 34), { t: 'bubble.pull', x: 24, y: 34 });
  assert.equal(pull.pulled, true);
  assert.deepEqual(pull.move(120, 300), { t: 'bubble.move', x: 120, y: 300 });
  assert.deepEqual(pull.move(121, 301), { t: 'bubble.move', x: 121, y: 301 }, 'every move follows once pulled, small ones too');
  assert.deepEqual(pull.up(140, 320), { t: 'bubble.drop', x: 140, y: 320 });
  const cancelled = startPull(0, 0);
  cancelled.move(30, 40);
  cancelled.move(60, 90);
  assert.deepEqual(cancelled.cancel(), { t: 'bubble.drop', x: 60, y: 90 }, 'a cancel drops where the last move put it');
  assert.equal(startPull(0, 0).cancel(), null, 'a cancelled press sends nothing');
  const tap = startPull(5, 5);
  tap.move(6, 6);
  assert.equal(tap.up(6, 6), null, 'a lift before the slop is the press (the click sends the plain pull)');
});

test('the app\'s state message: only true booleans count', () => {
  assert.deepEqual(bubbleStateOf({ t: 'bubble.state', available: true, out: false }), { available: true, out: false });
  assert.deepEqual(bubbleStateOf({ t: 'bubble.state', available: true, out: true }), { available: true, out: true });
  assert.deepEqual(bubbleStateOf({ t: 'bubble.state', available: 'yes', out: 1 }), { available: false, out: false });
  assert.deepEqual(bubbleStateOf({ t: 'bubble.state' }), { available: false, out: false }, 'an older app: no icon');
});

test('wiring: the phone row without a lead gets the icon; the port replays the state; the app hands the steps on', () => {
  const header = source('src/ui/lib/header.tsx');
  assert.match(header, /const lead = props\.lead \?\? \(zone === 'phone' \? bubbleLead\(\) : undefined\);/);
  assert.match(header, /lead: !!lead/);
  assert.match(source('src/ui/pwa/native-port.ts'), /const REPLAYED = new Set\(\[[^\]]*'bubble\.state'\]\)/);
  const handle = source('src/ui/pwa/bubble-handle.tsx');
  assert.match(handle, /onNative\('bubble\.state'/);
  assert.match(handle, /touchAction: 'none'/, 'the page does not scroll while the icon is pulled');
  const port = readFileSync(new URL('../../../../android/app/src/main/java/com/teydralab/autark/android/NativePort.java', import.meta.url), 'utf8');
  for (const type of ['bubble.pull', 'bubble.move', 'bubble.drop', 'bubble.state']) assert.ok(port.includes(`"${type}"`), `the app knows ${type}`);
});
