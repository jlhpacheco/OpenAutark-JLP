// Owns: feedback 16.11.2026 F20/F21 – which live bar line gets its own Stop (src/ui/chat/live-text.ts barStopRun).
// Never: renders the bar, or cancels a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { barStopRun } from '../../../src/ui/chat/live-text.ts';

test('only an agent\'s own known run gets a Stop, and only for whoever may cancel runs', () => {
  assert.equal(barStopRun({ runId: 'run_1' }, true), 'run_1');
  assert.equal(barStopRun({ runId: 'run_1' }, false), undefined, 'no right to cancel');
  assert.equal(barStopRun({ runId: '' }, true), undefined, 'working without a known run');
  assert.equal(barStopRun({ runId: 'run_1', split: { groupId: 'grp_1' } }, true), undefined, 'a split part is not the agent\'s own run');
});

test('F21: every non-split live bar line has its own Stop for its own run, however many agents work', () => {
  const runs = [{ runId: 'run_1' }, { runId: 'run_2' }, { runId: 'run_3', split: { groupId: 'grp_1' } }];
  assert.deepEqual(runs.map((run) => barStopRun(run, true)), ['run_1', 'run_2', undefined], 'each agent its own; a split part none');
  assert.deepEqual(runs.map((run) => barStopRun(run, false)), [undefined, undefined, undefined], 'no right to cancel');
});

test('F21: the bar holds each Stop in a fixed slot beside the line (never nested), the header line has none', () => {
  const read = (path: string) => readFileSync(new URL(`../../../src/ui/${path}`, import.meta.url), 'utf8');
  const bar = read('chat/LiveBar.tsx');
  // 19.11.2026: a ▾ cell comes first in each row (LiveBarMore.tsx); the Stop slot still follows the line button.
  assert.match(bar, /<div class="live-bar-row">\s*<button type="button" class="live-bar-caret"[\s\S]*?<\/button>\s*<button type="button" class="live-bar-line"[\s\S]*?<\/button>\s*\{stops && <span class="live-bar-stop">/, 'row = caret, line button, then the slot');
  assert.match(read('styles/live-bar.css'), /\.live-bar-stop \{[^}]*flex: none;[^}]*width: \d+px;/, 'the slot has a fixed width');
  assert.doesNotMatch(read('chat/ChatHeader.tsx'), /StopRun/, 'one run has one Stop in view');
});

test('20.11.2026: a Stop that went through offers Stop again when its line still shows after AGAIN_MS; it sends the line\'s agent and chat', () => {
  const source = readFileSync(new URL('../../../src/ui/chat/StopRun.tsx', import.meta.url), 'utf8');
  assert.match(source, /export const AGAIN_MS = 5_000;/);
  assert.match(source, /await rpc\.call\('runs\.cancel', \{ runId: props\.runId, \.\.\.props\.shown \}\);\s*again\.current = setTimeout\(\(\) => setStopping\(false\), AGAIN_MS\);/, 'after the call, not only on an error');
  assert.match(source, /useEffect\(\(\) => \(\) => clearTimeout\(again\.current\), \[\]\)/, 'a line that goes takes its timer along');
  const read = (path: string) => readFileSync(new URL(`../../../src/ui/${path}`, import.meta.url), 'utf8');
  assert.match(read('chat/LiveBar.tsx'), /<StopRun [^>]*shown=\{\{ agentId: run\.agentId, chatId: props\.chat\.id \}\}/);
});
