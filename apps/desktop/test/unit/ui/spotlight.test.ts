// B-085 T2: the spotlight tour's pure rules (src/ui/tour/spotlight-steps.ts) – the steps (at most six, existing
// selectors only, no data-tour), what counts as a target (a placeholder or a hidden box is none; the Secure-mode
// step only with its action's text), the hole kept inside the window, the bubble below / above / as a sheet (at the
// top over a hole in the bottom part), passing over a gone target in the direction of the last move, and the keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHEET_BELOW, SPOTLIGHT_STEPS, holeOf, isTarget, keyStep, passOver, placeBubble, sameBox } from '../../../src/ui/tour/spotlight-steps.ts';

const VIEW = { width: 1280, height: 800 };
const BUBBLE = { width: 320, height: 120 };

test('five short steps on existing selectors, the last one only with its action text (B-083: the Ultra switch is gone)', () => {
  assert.equal(SPOTLIGHT_STEPS.length, 5);
  assert.deepEqual(SPOTLIGHT_STEPS.map((step) => step.selector), [
    '.frame-header [data-cell="call"]', '[data-cell="workspace"]', '.composer .composer-plus',
    '.composer .send-button', '.status-note .status-action',
  ]);
  assert.equal(SPOTLIGHT_STEPS[4]!.text, 'Security settings');
  for (const step of SPOTLIGHT_STEPS) {
    assert.doesNotMatch(step.selector, /data-tour/);
    assert.ok(step.body.length <= 140, `${step.title} stays short`);
  }
});

test('a target: visible, no placeholder, with the step text', () => {
  const box = { width: 32, height: 32, placeholder: false, text: '' };
  assert.equal(isTarget({}, box), true);
  assert.equal(isTarget({}, { ...box, placeholder: true }), false, 'an inert placeholder (no Ultra, a chat that cannot talk)');
  assert.equal(isTarget({}, { ...box, width: 0 }), false, 'a hidden box');
  assert.equal(isTarget({ text: 'Security settings' }, { ...box, text: 'Accept' }), false, 'another notice');
  assert.equal(isTarget({ text: 'Security settings' }, { ...box, text: 'Security settings' }), true);
});

test('the hole: a little room, kept inside the window', () => {
  assert.deepEqual(holeOf({ left: 100, top: 100, width: 32, height: 32 }, VIEW), { left: 94, top: 94, width: 44, height: 44 });
  assert.deepEqual(holeOf({ left: 2, top: 1, width: 32, height: 32 }, VIEW), { left: 0, top: 0, width: 40, height: 39 });
  assert.deepEqual(holeOf({ left: 1260, top: 780, width: 32, height: 32 }, VIEW), { left: 1254, top: 774, width: 26, height: 26 });
});

test('the bubble: below, else above, else a sheet; never past the edges', () => {
  assert.deepEqual(placeBubble({ left: 400, top: 10, width: 40, height: 40 }, BUBBLE, VIEW), { kind: 'below', left: 260, top: 62 });
  assert.deepEqual(placeBubble({ left: 400, top: 700, width: 40, height: 40 }, BUBBLE, VIEW), { kind: 'above', left: 260, top: 568 });
  assert.deepEqual(placeBubble({ left: 0, top: 10, width: 40, height: 40 }, BUBBLE, VIEW), { kind: 'below', left: 16, top: 62 }, 'kept off the left edge');
  assert.deepEqual(placeBubble({ left: 1240, top: 10, width: 40, height: 40 }, BUBBLE, VIEW), { kind: 'below', left: 944, top: 62 }, 'kept off the right edge');
  assert.deepEqual(placeBubble({ left: 400, top: 60, width: 40, height: 100 }, BUBBLE, { width: 1280, height: 240 }), { kind: 'sheet', top: true }, 'no room either way');
  assert.deepEqual(placeBubble({ left: 100, top: 10, width: 40, height: 40 }, BUBBLE, { width: SHEET_BELOW - 1, height: 800 }), { kind: 'sheet', top: false }, 'a narrow window');
  assert.equal(placeBubble({ left: 100, top: 10, width: 40, height: 40 }, BUBBLE, { width: SHEET_BELOW, height: 800 }).kind, 'below');
});

test('on a phone a hole at the bottom (the composer) gets the sheet at the top, so it never covers the hole', () => {
  const phone = { width: 375, height: 812 };
  assert.deepEqual(placeBubble({ left: 320, top: 750, width: 44, height: 44 }, { width: 320, height: 130 }, phone), { kind: 'sheet', top: true });
  assert.deepEqual(placeBubble({ left: 320, top: 40, width: 44, height: 44 }, { width: 320, height: 130 }, phone), { kind: 'sheet', top: false });
});

test('a gone target is passed over in the direction of the last move; back from the first step turns forwards', () => {
  assert.equal(passOver(2, 6, 1), 3);
  assert.equal(passOver(5, 6, 1), null, 'past the last step: the tour ends');
  assert.equal(passOver(2, 6, -1), 1, 'Back onto a gone step goes on back');
  assert.equal(passOver(0, 6, -1), 1, 'Back at the first step turns forwards');
  assert.equal(passOver(0, 1, -1), null);
});

test('the hole is set again only when it moved', () => {
  const box = { left: 1, top: 2, width: 3, height: 4 };
  assert.equal(sameBox(null, box), false);
  assert.equal(sameBox({ ...box }, box), true);
  assert.equal(sameBox({ ...box, top: 3 }, box), false);
});

test('keys: Enter and right go on, left goes back, Enter on a button presses that button', () => {
  assert.deepEqual(['ArrowRight', 'Enter', 'ArrowLeft', 'Escape', 'x'].map((key) => keyStep(key, false)), ['next', 'next', 'back', null, null]);
  assert.equal(keyStep('Enter', true), null);
  assert.equal(keyStep('ArrowRight', true), 'next');
});
