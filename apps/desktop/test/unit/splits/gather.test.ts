// B-057 track A: the parent's results – pendingResults gives one "Split results" block per thread for the settled groups
// (from each part's 'Answer' run item), bounded to SPLIT_LIMITS.resultChars with a fair share per part and a pointer to
// agents.split_results for a cut one; markGathered closes them (and withdraws the unclaimed fan-in wake); results()
// gives the full text of a group or a part, only to its own agent – B-080: from any of its threads; the fair share itself.
// B-080: a part without last words shows its last note to its origin (agents.split_tell); one that brought nothing failed.
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_LIMITS } from '../../../src/shared/model/splits.ts';
import { TOLD_ITEM, fairShare } from '../../../src/runtime/splits/results.ts';
import { NOTHING_BACK } from '../../../src/runtime/agents/split-turn.ts';
import { CHAT, part, splitAndEnd, world } from './fixture.ts';

test('fair share: short texts whole, the rest split what is left equally', () => {
  assert.deepEqual(fairShare([100, 5000, 9000], 6100), [100, 3000, 3000]);
  assert.deepEqual(fairShare([10, 20], 100), [10, 20]);
  assert.deepEqual(fairShare([50, 50], 0), [0, 0]);
});

test('pendingResults: one bounded block, a fair share per part, a pointer for a cut part', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('Short'), part('Long one'), part('Long two')]);
  const [a, b, c] = w.lanes.started;
  w.lanes.end(a, 'done', { answer: 'Short result.' });
  w.lanes.end(b, 'done', { answer: 'x'.repeat(4000) + 'y'.repeat(16_000) });
  w.lanes.end(c, 'done', { answer: 'z'.repeat(20_000) });
  assert.equal(w.splits.pendingResults('ag_ava', 'other-thread'), undefined, 'only the thread it was split in');
  const block = w.splits.pendingResults('ag_ava', CHAT)!;
  assert.equal(block.splitIds.length, 3);
  assert.ok(block.text.length <= SPLIT_LIMITS.resultChars, `${block.text.length} characters`);
  assert.ok(block.text.length > SPLIT_LIMITS.resultChars - 200, 'the budget is used');
  assert.match(block.text, /^# Split results\n/);
  assert.match(block.text, /## Review the release – 3 parts: 3 done \(group sgr_/);
  assert.match(block.text, /### #1 Short – done · codex:gpt-6\.1-sol · low\nAsked: Do short\.\nShort result\.\n/, 'a short result stays whole (B-086: under its brief)');
  assert.match(block.text, new RegExp(`more characters – the whole result: agents\\.split_results \\{"groupId":"${groupId}","idx":2\\}\\]`));
  assert.match(block.text, new RegExp(`agents\\.split_results \\{"groupId":"${groupId}","idx":3\\}`));
  const longTwo = block.text.split('### #3')[1];
  const longOne = block.text.split('### #2')[1].split('### #3')[0];
  assert.ok(Math.abs(longOne.length - longTwo.length) < 40, 'the two long parts get the same share');
});

test('markGathered closes the groups, withdraws the waiting wake, and the next block is empty', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A')]);
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'A' });
  assert.equal(w.wakes.list('ag_ava').length, 1);
  // The person wrote meanwhile: the parent's next chat turn carries the results and ends 'done'.
  const block = w.splits.pendingResults('ag_ava', CHAT)!;
  w.splits.markGathered('run_next', block.splitIds);
  const group = w.splits.list({ groupId })[0];
  assert.equal(group.status, 'gathered');
  assert.equal(group.gatheredAt, w.clock.now());
  assert.equal(w.wakes.list('ag_ava').length, 0, 'the fan-in wake is withdrawn: its results arrived');
  assert.equal(w.splits.pendingResults('ag_ava', CHAT), undefined);
  w.splits.markGathered('run_next', [...block.splitIds, 'spl_missing']); // idempotent, unknown ids ignored
  assert.equal(w.splits.list({ groupId })[0].status, 'gathered');
});

test('groups that settled earlier come first in one block', () => {
  const w = world();
  const first = splitAndEnd(w, [part('A')], 'First goal');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'first' });
  w.runs.start({ id: 'run_two', agentId: 'ag_ava', conversationId: CHAT, trigger: 'message' });
  w.clock.set(w.clock.now() + 1000);
  const second = w.splits.create(w.ctx({ runId: 'run_two' }), { goal: 'Second goal', parts: [part('B')] }).id;
  w.splits.afterParentTurn('run_two', 'done');
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'second' });
  const block = w.splits.pendingResults('ag_ava', CHAT)!;
  assert.equal(block.splitIds.length, 2);
  assert.ok(block.text.indexOf('First goal') < block.text.indexOf('Second goal'));
});

test('results(): the full text of a group or a part, only for its own agent – also named from another thread (B-080)', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'a'.repeat(30_000) });
  const whole = w.splits.results('ag_ava', { groupId, idx: 1 });
  assert.ok(whole.includes('a'.repeat(30_000)), 'never cut');
  assert.match(w.splits.results('ag_ava', { groupId }), /### #2 B – still running/);
  assert.match(w.splits.results('ag_ava', { thread: CHAT }), new RegExp(groupId));
  // My own group named from another chat: its whole text (chat.read shows me that chat anyway).
  assert.ok(w.splits.results('ag_ava', { groupId, idx: 1, thread: 'ch_kernteam' }).includes('a'.repeat(30_000)), 'named from another thread');
  assert.match(w.splits.results('ag_ava', { thread: 'task:other' }), new RegExp(`group ${groupId}`), 'no group in this thread: my newest');
  assert.equal(w.splits.results('ag_ben', { thread: CHAT }), 'I have no split results yet.');
  assert.throws(() => w.splits.results('ag_ben', { groupId, thread: CHAT }), /belongs to another agent/, 'another agent\'s group stays its own');
  assert.throws(() => w.splits.results('ag_ben', { groupId }), /belongs to another agent/);
  assert.throws(() => w.splits.results('ag_ava', { groupId, idx: 7 }), /has no part #7/);
  assert.throws(() => w.splits.results('ag_ava', { groupId: 'sgr_none' }), /I have no split group sgr_none\./);
});

test('a done part without words or note reads "(no result text)" (it brought files), a failed one names its error', () => {
  const w = world();
  splitAndEnd(w, [part('Quiet'), part('Broken'), part('Empty')]);
  w.lanes.end(w.lanes.started[0], 'done');
  w.lanes.end(w.lanes.started[1], 'failed', { error: 'The engine crashed.' });
  w.lanes.end(w.lanes.started[2], 'failed', { error: NOTHING_BACK }); // agents/split-turn.ts: no last words, no note, no files
  const text = w.splits.pendingResults('ag_ava', CHAT)!.text;
  assert.match(text, /### #1 Quiet – done · codex:gpt-6\.1-sol · low\nAsked: Do quiet\.\n\(no result text\)/);
  assert.match(text, /### #2 Broken – failed – The engine crashed\./);
  assert.match(text, /### #3 Empty – failed – It ended without last words or a note to its origin – nothing came back\./);
});

test('B-080: a done part that reported through agents.split_tell to its origin shows its last note as its result', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('Pairs')]);
  const splitId = w.lanes.started[0];
  const runId = w.lanes.lanes.get(splitId)!.runId;
  const told = (text: string) => w.runs.item(runId, { kind: 'note', name: TOLD_ITEM, effectStatus: 'none', data: { text } }); // agents.split_tell {to: 'origin'}
  told('First pair found.');
  w.runs.item(runId, { kind: 'tool_call', name: 'agents.split_tell', effectStatus: 'none', data: { callId: 'call_2', args: JSON.stringify({ to: 2, text: 'Take the EU pairs.' }), summary: 'To my part #2: Take the EU pairs.' } });
  told('EU-IN pairs: Anna and Ben.');
  w.lanes.end(splitId, 'done');
  const block = w.splits.pendingResults('ag_ava', CHAT)!.text;
  assert.match(block, /### #1 Pairs – done · codex:gpt-6\.1-sol · low\nAsked: Do pairs\.\nEU-IN pairs: Anna and Ben\./, 'its last note to its origin, not "(no result text)"');
  assert.doesNotMatch(block, /no result text|Take the EU pairs|First pair found/);
  assert.match(w.splits.results('ag_ava', { groupId, idx: 1 }), /### #1 Pairs – done · codex:gpt-6\.1-sol · low\nAsked: Do pairs\.\nEU-IN pairs: Anna and Ben\.$/);
});
