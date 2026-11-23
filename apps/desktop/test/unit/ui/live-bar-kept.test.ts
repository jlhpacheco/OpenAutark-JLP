// The live bar's kept height (ui/chat/live-text.ts keptHeight, LiveBar.tsx): a click inside its open lines fixes the
// bar's height while the same lines stay open, so a part's steps opening there scroll inside it instead of moving the
// rows above the click; a line opening, closing or ending lets go. The window check is splits-window-more (a).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptHeight, openLines } from '../../../src/ui/chat/live-text.ts';

const runs = [{ runId: 'run_a' }, { runId: 'run_b' }, { runId: 'run_c' }];

test('the open lines are one key in bar order; none open is the empty key', () => {
  assert.equal(openLines(runs, new Set(['run_c', 'run_a'])), 'run_a run_c');
  assert.equal(openLines(runs, new Set(['run_gone'])), '', 'a run that left the bar is no open line');
  assert.equal(openLines(runs, new Set()), '');
});

test('the bar keeps the height of the click while the same lines are open, and lets go when they change', () => {
  const kept = { lines: 'run_a run_c', height: 214.5 };
  assert.equal(keptHeight(kept, 'run_a run_c'), 214.5, 'same lines: the frame stays');
  assert.equal(keptHeight(kept, 'run_a run_b run_c'), undefined, 'another line opened: the bar takes its own height');
  assert.equal(keptHeight(kept, 'run_a'), undefined, 'a line closed or its run ended');
  assert.equal(keptHeight(kept, ''), undefined, 'every line closed');
  assert.equal(keptHeight(undefined, 'run_a run_c'), undefined, 'no click inside yet');
  assert.equal(keptHeight({ lines: '', height: 40 }, ''), undefined, 'a closed bar never keeps a height');
});
