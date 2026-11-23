// B-080 (context/ledger/window.ts): the chat lines' reach (13.11.2026: the last CHAT_DAYS, at most CHAT_TOKENS – older ones hidden),
// and the fit of the window hides the oldest tool work –
// never a chat line, the newest turn, a pin or a nested call – and nothing at all when hiding could not bring the history in.
// KI-Runde 17.11.2026: sizes are in tokensOf at 2 characters per token (measured against the engines' own counts: at 3 a history
// estimated at 787,902 passed as fitting a 1M window and was 1.2M real tokens); the fold's choice (foldHides).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHARS_PER_TOKEN, CHAT_DAYS, CHAT_REASON, CHAT_TOKENS, FIT_REASON, FOLD_REASON, entryTokens, fitHides, foldHides, oldChatLines, tokensOf } from '../../../src/runtime/context/ledger/window.ts';
import { fitLimit } from '../../../src/runtime/agents/compaction-policy.ts';
import type { LedgerItem, LedgerViewItem } from '../../../src/shared/model/context-ledger.ts';

test('the chat lines\' reach: older than CHAT_DAYS before the newest, or past CHAT_TOKENS of newer lines, are hidden – never the newest or a pin', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const row = (itemId: string, order: number, createdAt: number, tokens: number, extra: Partial<LedgerItem> = {}) =>
    ({ itemId, kind: 'message', order, createdAt, tokens, state: 'keep', title: itemId, ...extra }) as LedgerItem;
  const now = 10 * DAY;
  const rows = [
    row('m1', 1, now - 5 * DAY, 100), row('m2', 2, now - 3 * DAY, 100, { pinnedUntil: 0 }), row('a3', 3, now - 5 * DAY, 100, { kind: 'assistant' }),
    row('m4', 4, now - DAY, CHAT_TOKENS), row('m5', 5, now - DAY, 100), row('m6', 6, now, 100), row('m7', 7, now, 50, { state: 'hidden' }),
  ];
  const hidden = oldChatLines(rows, new Set(['m2']));
  assert.deepEqual(hidden.map((mark) => mark.itemId).sort(), ['a3', 'm1'], 'm1 and my own posted words a3 are past 2 days; m2 is pinned; a hidden line is no line to hide again');
  assert.equal(hidden[0].reason, CHAT_REASON);
  const full = oldChatLines([...rows, row('m8', 8, now, CHAT_TOKENS)], new Set());
  assert.deepEqual(full.map((mark) => mark.itemId).sort(), ['a3', 'm1', 'm2', 'm4', 'm5', 'm6'], 'the newest line alone fills the budget: every older one goes, the newest stays');
  assert.deepEqual(oldChatLines([row('m1', 1, 0, CHAT_TOKENS * 2)], new Set()), [], 'the newest line stays however big');
  assert.equal(CHAT_DAYS, 2);
  assert.equal(CHAT_TOKENS * CHARS_PER_TOKEN, 48_000, 'the reach holds the characters it held before the unit changed (16,000 × 3)');
});

const entry = (itemId: string, kind: LedgerViewItem['kind'], chars: number, extra: Partial<LedgerViewItem> = {}): LedgerViewItem => ({
  itemId, kind, role: kind === 'message' ? 'user' : 'tool', text: 'x'.repeat(chars), origin: {}, order: Number(itemId.slice(1)), state: 'keep',
  ...(kind === 'tool' ? { call: { name: 'shell', args: {}, callId: itemId, output: 'x'.repeat(chars) } } : {}), ...extra,
});

test('the fit hides the oldest tool work first and only as much as needed; lines, the newest turn, pins and nested calls stay', () => {
  const entries = [
    entry('m1', 'message', 40_000), entry('t2', 'tool', 40_000, { runId: 'r1' }), entry('t3', 'tool', 40_000, { runId: 'r1', nested: true }),
    entry('t4', 'tool', 40_000, { runId: 'r1' }), entry('t5', 'tool', 40_000, { runId: 'r2' }), entry('m6', 'message', 40_000), entry('t7', 'tool', 40_000, { runId: 'r3' }),
  ];
  assert.equal(entryTokens(entries[1]), 20_001, 'a call counts its arguments and output (40,002 characters)');
  assert.equal(entryTokens(entries[2]), 0, 'a nested call costs nothing');
  assert.deepEqual(fitHides(entries, 22_000, { newestRun: 'r3', pinned: new Set() }), ['t2', 't4'], 'oldest first, the nested one skipped, then stop');
  assert.deepEqual(fitHides(entries, 22_000, { newestRun: 'r3', pinned: new Set(['t2']) }), ['t4', 't5'], 'a pin stays');
  assert.deepEqual(fitHides(entries, 65_000, { newestRun: 'r3', pinned: new Set() }), [], 't2, t4 and t5 free 60k: not enough – nothing is hidden for nothing');
  assert.deepEqual(fitHides(entries, 0, { pinned: new Set() }), []);
  assert.match(FIT_REASON, /fit the model window/);
});

test('one token unit, measured against the engines\' own counts – a 30,000-character output is 15,000 tokens', () => {
  assert.equal(CHARS_PER_TOKEN, 2, 'measured 15.–17.11.2026: 1.89–1.99 characters per real token; real = 44k + 1.51 × the estimate at 3');
  assert.equal(tokensOf(30_000), 15_000);
  assert.equal(tokensOf(1), 1, 'rounded up');
  assert.equal(entryTokens(entry('a1', 'assistant', 30_000)), 15_000, 'a text');
  const output = entry('t2', 'tool', 0, { call: { name: 'shell', args: '', callId: 't2', output: 'x'.repeat(30_000) } });
  assert.equal(entryTokens(output), 15_000, 'a call\'s output');
});

test('the measured case: the history that was estimated at 787,902 and passed as fitting a 1M window no longer fits', () => {
  const chars = 787_902 * 3; // what the unit of before (3 characters per token) counted as 787,902 tokens
  assert.ok(Math.ceil(chars / 3) <= fitLimit(1_000_000), 'at 3 characters per token it passed the fit of 800,000');
  assert.equal(tokensOf(chars), 1_181_853, 'in the measured unit it is the 1.2M tokens the engine counted');
  assert.ok(tokensOf(chars) > fitLimit(1_000_000), 'so it no longer passes as fitting');
  // a history of that size: the fit hides the oldest tool work until the excess is gone
  const entries = Array.from({ length: 12 }, (_unused, index) => entry(`t${index + 1}`, 'tool', chars / 12 - 2, { runId: `r${index + 1}` }));
  const total = entries.reduce((sum, item) => sum + entryTokens(item), 0);
  assert.equal(total, 1_181_856);
  const hidden = fitHides(entries, total - fitLimit(1_000_000), { newestRun: 'r12', pinned: new Set() });
  assert.deepEqual(hidden, ['t1', 't2', 't3', 't4'], 'four of the twelve go: 4 × 98,488 covers the 381,856 above the fit');
});

test('a fold hides my own work before the hand-over – never a chat line, a finishing tasks.update call, what I brought back or what is hidden already', () => {
  const row = (itemId: string, kind: LedgerItem['kind'], order: number, extra: Partial<LedgerItem> = {}) =>
    ({ itemId, kind, order, createdAt: 0, tokens: 10, state: 'keep', title: itemId, origin: {}, ...extra }) as LedgerItem;
  const rows = [
    row('m1', 'message', 1), row('t2', 'tool', 2), row('s3', 'skill', 3), row('f4', 'file', 4), row('r5', 'reasoning', 5), row('a6', 'assistant', 6),
    row('t7', 'tool', 7), // a tasks.update call that finished a task
    row('t8', 'tool', 8, { nested: true }), row('t9', 'tool', 9, { pinnedUntil: 99 }), row('t10', 'tool', 10, { state: 'hidden' }),
    row('t11', 'tool', 11, { state: 'condensed', condensed: 'short' }), row('c12', 'checkpoint', 12, { pinnedUntil: Number.MAX_SAFE_INTEGER }),
    row('m13', 'message', 13), row('c14', 'checkpoint', 14), row('a15', 'assistant', 15),
  ];
  assert.deepEqual(foldHides(rows, 14, new Set(['t7'])), ['t2', 's3', 'f4', 'r5', 'a6', 't8', 't11', 'c12'],
    'tools (the inner call of a script too), skills, files, reasoning, my own words, a condensed item and the earlier hand-over go; lines, the finish call, the pinned and the hidden stay; nothing from the hand-over on');
  assert.deepEqual(foldHides(rows, 1, new Set()), [], 'nothing before the first item');
  assert.match(FOLD_REASON, /hand-over/);
});
