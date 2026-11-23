// B-057 track A: what create() refuses, before anything is written, with one clear sentence each – the goal and the
// 1–12 parts, titles/briefs/returns within SPLIT_LIMITS, context, model (same | cheap | strong | a known, usable catalog
// model), effort, temperature (B-083), `after` naming only earlier parts, a worktree without a working folder, the
// active groups per agent, a fresh part's needs (Halb 21.11.2026: check | chain | judgment, stored as its model word; a
// fork's plays no part); and what it stores (trimmed texts, 'same' as no model, catalog ids). B-083: a part's own call
// adds parts to its running group (numbered after it, `after` by group numbers, at most 12 in all) and they start at once.
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_LIMITS, type SplitPartInput, type SplitTurn } from '../../../src/shared/model/splits.ts';
import { PARENT, part, splitAndEnd, world } from './fixture.ts';

const refusal = (fn: () => unknown): { code?: string; message: string } => {
  try { fn(); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  return { message: 'not refused' };
};

const SPLIT: SplitTurn = { splitId: 'spl_x', groupId: 'sgr_x', idx: 1, of: 2, title: 'X', parentRunId: PARENT, parentThread: 'ch', context: 'fork', firstTurn: true };

test('B-083: a part adds parts to its own running group – numbered after it, started at once, limits hold', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const [a] = w.lanes.started;
  const self: SplitTurn = { ...w.lanes.turns[0].turn };
  const view = w.splits.create(w.ctx({ runId: 'run_part', split: self }), { goal: 'More hands', parts: [part('C'), part('D', { after: [1, 3], temperature: 0.4 })] });
  assert.equal(view.id, groupId, 'the same group – depth stays 1');
  assert.equal(view.goal, 'Review the release', 'the group keeps its goal');
  assert.deepEqual(view.splits.map((split) => [split.idx, split.title, split.of]), [[1, 'A', 4], [2, 'B', 4], [3, 'C', 4], [4, 'D', 4]]);
  assert.deepEqual(view.splits[3].after, [1, 3], 'after names group numbers');
  assert.equal(w.splits.list({ agentId: 'ag_ava' }).length, 1, 'no second group');
  assert.ok(w.lanes.started.includes(view.splits[2].id), 'C starts at once (the group runs)');
  assert.equal(view.splits[3].status, 'pending', 'D waits for #1 and #3');
  w.lanes.end(a, 'done', { answer: 'A' });
  w.lanes.end(view.splits[2].id, 'done', { answer: 'C' });
  assert.ok(w.lanes.started.includes(view.splits[3].id), 'D starts once #1 and #3 are done');

  const full = refusal(() => w.splits.create(w.ctx({ split: self }), { goal: 'g', parts: Array.from({ length: 9 }, (_, index) => part(`X${index}`)) }));
  assert.equal(full.message, 'My group has 4 parts and holds 12: I add 1–8 (got 9).');
  const other = refusal(() => w.splits.create(w.ctx({ split: SPLIT }), { goal: 'Deeper', parts: [part('A')] }));
  assert.deepEqual(other, { code: 'conflict', message: 'My group is no longer at work, so I add no parts to it.' });
  const bad = refusal(() => w.splits.create(w.ctx({ split: self }), { goal: 'g', parts: [part('E', { after: [5] })] }));
  assert.equal(bad.message, 'Part #5: after names earlier parts only (#1–#4).');
  const blind = refusal(() => w.splits.create(w.ctx({ split: self }), { goal: 'g', parts: [part('F', { needs: undefined })] }));
  assert.match(blind.message, /^Part #5 starts fresh: needs says what its hardest step asks/, 'a part from inside a part says its needs too');
});

test('the input checks, each with a clear sentence, and nothing is stored', () => {
  const w = world();
  const create = (parts: unknown, goal: unknown = 'Goal') => refusal(() => w.splits.create(w.ctx(), { goal, parts } as never));
  const cases: Array<[unknown, RegExp, string?]> = [
    [[], /^Give 1–12 parts \(got 0\)\.$/],
    [Array.from({ length: 13 }, (_, index) => part(`P${index}`)), /^Give 1–12 parts \(got 13\)\.$/],
    [[{ brief: 'x' }], /^Part #1's title is missing\.$/],
    [[part('x'.repeat(SPLIT_LIMITS.titleChars + 1))], /^Part #1's title is 81 characters long; at most 80\.$/],
    [[{ title: 'A', brief: '   ' }], /^Part #1's brief is empty\.$/],
    [[part('A', { brief: 'b'.repeat(SPLIT_LIMITS.briefChars + 1) })], /brief is 12001 characters long; at most 12000/],
    [[part('A', { returns: 'r'.repeat(401) })], /returns is 401 characters long; at most 400/],
    [[part('A', { context: 'full' as never })], /^Part #1: context must be fork or brief\.$/],
    [[part('A', { effort: 'minimal' as never })], /^Part #1: effort must be one of none, low, medium, high, xhigh, max\.$/],
    [[part('A', { model: 'gpt-9-ultra' })], /^Part #1: Unknown model "gpt-9-ultra"\..* It also takes same, cheap or strong\.$/], // B-080 wave 3: the one lookup's text (catalogModel)
    [[part('A', { model: 'claude:claude-opus-5-5' })], /^Part #1: Claude Opus 5\.5 has no usable account right now.* It also takes same, cheap or strong\.$/],
    [[part('A', { after: [1] })], /^Part #1: the first part waits for no other – leave its after out\.$/],
    [[part('A'), part('B', { after: [3] })], /^Part #2: after names earlier parts only \(#1–#1\)\.$/],
    [[part('A'), part('B', { after: 1 as never })], /^Part #2: after must be a list of part numbers\.$/],
    [[part('A', { worktree: 'yes' as never })], /^Part #1: worktree must be true or false\.$/],
    [[part('A', { temperature: 2.5 })], /^Part #1: temperature is a number from 0 to 2\.$/],
    [[part('A', { temperature: '0.3' as never })], /^Part #1: temperature is a number from 0 to 2\.$/],
    // Halb 21.11.2026: an old call without needs, and a wrong word, get the three values with what each means
    [[part('A', { needs: undefined })], /^Part #1 starts fresh: needs says what its hardest step asks: check \(.+\), chain \(.+\) or judgment \(.+\)\.$/],
    [[part('A', { model: 'same', needs: undefined })], /^Part #1 starts fresh: needs says/],
    [[part('A', { needs: 'hard' as never })], /^Part #1: needs says what its hardest step asks: check/],
    ['not a list', /^Give 1–12 parts \(got none\)\.$/],
  ];
  for (const [parts, pattern, code] of cases) {
    const found = create(parts);
    assert.match(found.message, pattern, JSON.stringify(parts).slice(0, 80));
    assert.equal(found.code, code ?? 'bad_request');
  }
  assert.match(create([part('A')], '').message, /^The goal is empty\.$/);
  assert.match(create([part('A')], 'g'.repeat(401)).message, /^The goal is 401 characters long; at most 400\.$/);
  const noFolder = refusal(() => w.splits.create(w.ctx({ cwd: undefined }), { goal: 'Code', parts: [part('A', { worktree: true })] }));
  assert.match(noFolder.message, /^Part #1 asks for its own worktree, but this turn has no working folder/);
  assert.equal(w.splits.list({ agentId: 'ag_ava' }).length, 0, 'nothing stored');
  assert.equal(w.of('split.upserted').length, 0);
});

test('stored as given: trimmed texts, the needs word for a fresh part, catalog ids for a model name (it wins over needs), after sorted', () => {
  const w = world();
  const parts: SplitPartInput[] = [
    { title: '  Tests  ', brief: ' Run them. ', returns: ' Failures ', model: 'same', needs: 'check' },
    { title: 'Docs', brief: 'Check docs.', model: 'GPT-6.1 Sol', needs: 'judgment', effort: 'high', after: [1, 1] },
    { title: 'Judge', brief: 'Try to refute #1.', model: 'STRONG', context: 'brief', after: [2, 1] },
    { title: 'Mine', brief: 'Go on from here.', context: 'fork', needs: 'judgment' },
  ];
  const view = w.splits.create(w.ctx(), { goal: '  Release check  ', parts });
  assert.equal(view.goal, 'Release check');
  const [one, two, three, four] = view.splits;
  assert.deepEqual([one.title, one.brief, one.returns, one.model], ['Tests', 'Run them.', 'Failures', 'check']);
  assert.deepEqual([two.model, two.effort, two.after], ['codex:gpt-6.1-sol', 'high', [1]]);
  assert.deepEqual([three.model, three.context, three.after], ['strong', 'brief', [1, 2]]);
  assert.deepEqual([four.model, four.context], [undefined, 'fork'], 'a fork runs on my model: its needs plays no part');
  assert.equal(view.cwd, 'C:/work/repo');
  assert.equal(view.modeKey, 'general');
  assert.equal(view.ultra, false);
  assert.match(view.id, /^sgr_/);
  assert.match(one.id, /^spl_/);
});

test('at most activeGroupsPerAgent pending or running groups per agent', () => {
  const w = world();
  for (let n = 0; n < SPLIT_LIMITS.activeGroupsPerAgent; n++) w.splits.create(w.ctx(), { goal: `Goal ${n}`, parts: [part('A')] });
  const found = refusal(() => w.splits.create(w.ctx(), { goal: 'One more', parts: [part('A')] }));
  assert.equal(found.code, 'conflict');
  assert.equal(found.message, '3 groups of my parts are still at work (at most 3). I wait for their results, or stop one with agents.split_tell {to: "all", stop: true}.');
  assert.equal(w.splits.create(w.ctx({ agentId: 'ag_ben' }), { goal: 'Ben', parts: [part('A')] }).agentId, 'ag_ben', 'per agent');
});

test('an archived or unknown agent cannot split', () => {
  const w = world();
  w.org.require('ag_ben').archivedAt = 1;
  assert.deepEqual(refusal(() => w.splits.create(w.ctx({ agentId: 'ag_ben' }), { goal: 'G', parts: [part('A')] })), { code: 'conflict', message: 'Ben is archived.' });
  assert.equal(refusal(() => w.splits.create(w.ctx({ agentId: 'ag_nobody' }), { goal: 'G', parts: [part('A')] })).code, 'not_found');
});

