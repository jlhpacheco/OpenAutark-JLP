// KI-Runde 17.11.2026, decision 10 (a lead needs a look-up inside its own turn): `agents.split {wait: true}` over the
// real split service and the real split tools –
// - the parts start at the call, not at the turn's end, and the call answers with each part's closing words, its model
//   and how it ended; those parts wake nobody and are gathered when that turn ends 'done' (FIXES-2 A2);
// - a part that failed stands in the same result with its reason;
// - the person stops the turn that waits (afterParentTurn 'stopped', on every engine whatever the call's signal says):
//   its groups stop as the person's and nobody wakes (FIXES-2 A1); a call cut for another reason (an urgent line, the
//   stall watch, a shutdown, the hub's lease) leaves them working, and the parts that ended meanwhile wake the origin;
// - a line for the turn ends its wait early with what is there, the parts go on (FIXES-2 A3); what the turn then reads with
//   agents.split_results is gathered when it ends 'done' (FIXES-3 A3);
// - a call that outlives its turn, or a turn that fails after its call answered, loses nothing: the origin is woken;
// - a part's note to its origin (agents.split_tell {to: 'origin'}) rides in that result instead of a wake;
// - at the wait's bound the call answers with what is there, and the parts that still work come back on their own; that
//   bound lies below the hub's call limit and the stall watch's limit for a silent call;
// - a part's own split with wait answers at once: its new parts join the group and report to the origin.
// Owns: these assertions only. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { splitTools } from '../../../src/runtime/tools/builtin/agents-split.ts';
import { tellTool } from '../../../src/runtime/tools/builtin/agents-split-tell.ts';
import { STILL_WORKING, TOLD_WAITING } from '../../../src/runtime/splits/gather.ts';
import { WAIT_STOPPED } from '../../../src/runtime/splits/service.ts';
import { WAIT_MS } from '../../../src/runtime/splits/wait.ts';
import { HUB_CALL_MS } from '../../../src/runtime/engines/claude/lean.ts';
import { STALL_TOOL_MS } from '../../../src/runtime/agents/stall-watch.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';
import { agent } from '../chat/harness.ts';
import { CHAT, PARENT, part, world, type World } from './fixture.ts';

const AVA = agent('ag_ava', 'Ava');
const splitTool = splitTools.find((tool) => tool.name === 'agents.split')!;

/** A turn of Ava calling a split tool: its own turn, or a part's (`split`). */
function caller(w: World, signal: AbortSignal) {
  const ctx = (split?: SplitTurn): ToolContext => ({
    agent: AVA, runId: split ? 'run_part' : PARENT, mode: 'general', services: w.services, signal, status: () => {},
    ...(split ? { split } : { conversationId: CHAT }),
  } as unknown as ToolContext);
  return async (tool: ToolDef, args: Record<string, unknown>, split?: SplitTurn) => {
    const out = await tool.run(args as never, ctx(split));
    const text = out.content.map((item) => ('text' in item ? item.text : '')).join('\n');
    let data: Record<string, unknown> | undefined;
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { data = undefined; }
    return { failed: Boolean(out.isError), text, data };
  };
}

/** A group whose two parts start at once because the call waits for them. */
function waiting(w: World, titles: string[] = ['Look on D:', 'List the channel']) {
  const group = w.splits.create(w.ctx(), { goal: 'Find the real material', parts: titles.map((title) => part(title)), wait: true });
  return { groupId: group.id, splitIds: group.splits.map((split) => split.id) };
}

test('a waiting split starts its parts at the call and brings both closing words back in one result', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  assert.equal(w.splits.list({ groupId })[0].status, 'running', 'the group runs without the turn having ended');
  assert.equal(w.lanes.started.length, 2, 'both parts started at the call');

  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  assert.equal(w.wakes.list('ag_ava').length, 0, 'the first part does not wake the waiting origin');
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'Twelve videos on the channel.' });

  const waited = await result;
  assert.equal(waited.ended, 'parts');
  assert.match(waited.text, /^# Split results\n/);
  assert.match(waited.text, /## Find the real material – 2 parts: 2 done \(group sgr_/);
  assert.match(waited.text, /### #1 Look on D: – done · codex:gpt-6\.1-sol · low\nAsked: Do look on d:\.\nFour drone files lie on D:\./);
  assert.match(waited.text, /### #2 List the channel – done[^\n]*\nAsked: [^\n]*\nTwelve videos on the channel\./);
  assert.doesNotMatch(waited.text, new RegExp(STILL_WORKING), 'nothing of mine still works');

  assert.equal(w.wakes.list('ag_ava').length, 0, 'the call brought them back: no wake');
  assert.equal(w.splits.list({ groupId })[0].status, 'settled', 'gathered only when the turn that read them ends done');
  w.runs.finish(PARENT, { status: 'done', endedAt: w.clock.now() });
  w.splits.afterParentTurn(PARENT, 'done');
  assert.equal(w.splits.list({ groupId })[0].status, 'gathered');
  assert.equal(w.splits.pendingResults('ag_ava', CHAT), undefined, 'nothing waits for my next turn');
  assert.equal(w.lanes.started.length, 2, 'the turn\'s end starts nothing again');
});

test('a part that failed stands in the same result with its reason', async () => {
  const w = world();
  const { splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.lanes.end(w.lanes.started[0], 'failed', { error: 'There is no drive D: on this PC.' });
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'Twelve videos on the channel.' });
  const waited = await result;
  assert.equal(waited.ended, 'parts');
  assert.match(waited.text, /### #1 Look on D: – failed – There is no drive D: on this PC\./);
  assert.match(waited.text, /### #2 List the channel – done/);
  assert.equal(w.wakes.list('ag_ava').length, 0);
});

/** How the dispatcher aborts a turn (agents/dispatch-runs.ts abortTurn): its reason names the kind of stop. */
const cut = (stopKind: 'human' | 'urgent' | 'shutdown') => new WorkforceError('cancelled', 'stopped', { details: { stopKind } });
/** How the hub releases a Claude Code call's lease when its run ended (mcp/hub.ts): no stop kind at all. */
const lease = () => new WorkforceError('cancelled', 'The run ended.');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('the person stops the turn that waits (Claude: the call\'s signal knows nothing of it): its group stops, nobody wakes', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  w.splits.afterParentTurn(PARENT, 'stopped'); // dispatcher personStop -> split-stop.ts, on every stop path
  const waited = await result;
  assert.equal(waited.ended, 'stopped');
  const group = w.splits.list({ groupId })[0];
  assert.equal(group.status, 'stopped', 'stopped as a whole, as the person');
  assert.deepEqual(group.splits.map((split) => split.status), ['done', 'stopped']);
  assert.equal(group.splits[1].error, WAIT_STOPPED);
  assert.deepEqual(w.lanes.stopped.map((entry) => entry.splitId), [splitIds[1]], 'the working lane was aborted');
  await tick();
  assert.equal(w.wakes.list('ag_ava').length, 0, 'the person\'s Stop wakes nobody');
});

test('the person\'s Stop on Codex (the call\'s signal aborts first, as the person\'s): the group stops, nobody wakes', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const stop = new AbortController();
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: stop.signal });
  stop.abort(cut('human')); // abortTurn, then in the same tick stopPendingSplits
  w.splits.afterParentTurn(PARENT, 'stopped');
  await result;
  await tick();
  w.splits.stop({ conversationId: CHAT }, 'human'); // messages.stop afterwards
  assert.equal(w.splits.list({ groupId })[0].status, 'stopped');
  assert.equal(w.wakes.list('ag_ava').length, 0);
});

test('a waiting turn cut for another reason leaves its parts working; they come back on their own', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const stop = new AbortController();
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: stop.signal });
  stop.abort(cut('urgent'));
  assert.equal((await result).ended, 'stopped');
  assert.deepEqual(w.splits.list({ groupId })[0].splits.map((split) => split.status), ['running', 'running']);
  assert.equal(w.lanes.stopped.length, 0, 'no lane was aborted');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  assert.equal(w.wakes.list('ag_ava').length, 1, 'nobody waits any more: the part wakes its origin');
});

test('a part that ended while the call waited, then the call is cut: its origin wakes for it at once, with the notes', async () => {
  const w = world();
  const { splitIds } = waiting(w);
  const stop = new AbortController();
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: stop.signal });
  assert.equal(w.splits.tellWaiting(splitIds[1], 'Halfway through the channel.'), true);
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  stop.abort(lease()); // the hub's lease, a client cancel, an urgent cut - not the person
  assert.equal((await result).ended, 'stopped');
  const wakes = w.wakes.list('ag_ava');
  assert.equal(wakes.length, 1, 'the ended part reaches its origin');
  assert.match(wakes[0].note ?? '', /ended \(1 done\)[\s\S]*Halfway through the channel\./);
  assert.deepEqual(w.splits.pendingResults('ag_ava', CHAT)?.splitIds, [splitIds[0]]);
});

test('a call that outlives its failed turn: its wait ends with the turn, and the parts wake their origin', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.runs.finish(PARENT, { status: 'failed', endedAt: w.clock.now() });
  w.splits.afterParentTurn(PARENT, 'failed');
  assert.equal((await result).ended, 'stopped');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'first' });
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'second' });
  assert.equal(w.splits.list({ groupId })[0].status, 'settled', 'nothing gathered: nobody read them');
  assert.ok(w.wakes.list('ag_ava').length >= 1, 'the origin is woken');
  assert.deepEqual(w.splits.pendingResults('ag_ava', CHAT)?.splitIds.sort(), [...splitIds].sort());
});

test('the call answered but its turn failed after: the parts it brought back are not gathered and wake the origin', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'first' });
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'second' });
  assert.equal((await result).ended, 'parts');
  assert.equal(w.wakes.list('ag_ava').length, 0);
  w.runs.finish(PARENT, { status: 'failed', endedAt: w.clock.now() }); // e.g. a usage limit on the next model call
  w.splits.afterParentTurn(PARENT, 'failed');
  assert.equal(w.splits.list({ groupId })[0].status, 'settled');
  assert.equal(w.wakes.list('ag_ava').length, 1, 'the next turn gets them');
  assert.equal(w.splits.pendingResults('ag_ava', CHAT)?.splitIds.length, 2);
});

test('a line for the waiting turn ends its wait with what is there; the parts go on and come back on their own', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  w.splits.endWait('run_other'); // another run's line ends nothing here
  w.splits.endWait(PARENT); // dispatcher: a person's line, an important line, a call voice's 'now'
  const waited = await result;
  assert.equal(waited.ended, 'early');
  assert.match(waited.text, /### #1 Look on D: – done[\s\S]*### #2 List the channel – still running/);
  assert.ok(waited.text.endsWith(STILL_WORKING));
  assert.equal(w.lanes.stopped.length, 0, 'the parts go on');
  w.splits.afterParentTurn(PARENT, 'done');
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'Twelve videos.' });
  assert.equal(w.wakes.list('ag_ava').length, 1, 'the second part returns on its own');
  assert.deepEqual(w.splits.pendingResults('ag_ava', CHAT)?.splitIds, [splitIds[1]]);
  assert.equal(w.splits.list({ groupId })[0].status, 'settled');
});

// FIXES-3 A3 (Claude S2, 18.11.2026: Clara read both results with agents.split_results after the line ended her wait, and
// one more quiet turn got them again as "Split results"). Failed before the change: one wake left, two parts pending.
test('read is read: parts my turn read with agents.split_results are gathered when it ends done, their wake withdrawn', async () => {
  const w = world();
  const { groupId, splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  w.splits.endWait(PARENT); // the person's line
  await result;
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'Twelve videos.' });
  assert.equal(w.wakes.list('ag_ava').length, 1, 'their return woke the origin while its turn still runs');
  const call = caller(w, new AbortController().signal);
  const read = await call(splitTools.find((tool) => tool.name === 'agents.split_results')!, { groupId });
  assert.match(read.text, /Twelve videos\./);
  w.splits.afterParentTurn(PARENT, 'done');
  assert.equal(w.wakes.list('ag_ava').length, 0, 'no extra turn for what I already read');
  assert.equal(w.splits.pendingResults('ag_ava', CHAT), undefined);
  assert.equal(w.splits.list({ groupId })[0].status, 'gathered');

  const failed = world(); // a turn that did not end done gathers nothing it read
  const other = waiting(failed);
  failed.lanes.end(failed.lanes.started[0], 'done', { answer: 'a' });
  failed.lanes.end(failed.lanes.started[1], 'done', { answer: 'b' });
  await caller(failed, new AbortController().signal)(splitTools.find((tool) => tool.name === 'agents.split_results')!, { groupId: other.groupId });
  failed.splits.afterParentTurn(PARENT, 'failed');
  assert.equal(failed.splits.pendingResults('ag_ava', CHAT)?.splitIds.length, 2);
});

test('a part\'s note to its origin rides in the waiting call\'s result', async () => {
  const w = world();
  const { splitIds } = waiting(w);
  const call = caller(w, new AbortController().signal);
  const turnOf = (splitId: string) => w.lanes.turns.find((entry) => entry.turn.splitId === splitId)!.turn;

  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  const told = await call(tellTool, { to: 'origin', text: 'The drone card is on D:, 40 videos.' }, turnOf(splitIds[0]));
  assert.deepEqual(told.data, { ok: true, to: 'origin', note: 'my origin reads it in the result of the call it waits in' });
  assert.equal(w.wakes.list('ag_ava').length, 0, 'a waiting origin is not woken for a note');

  w.lanes.end(w.lanes.started[0], 'done', { answer: 'The card is on D:.' });
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'Twelve videos.' });
  const waited = await result;
  assert.ok(waited.text.includes(`${TOLD_WAITING}\n- My part #1 “Look on D:”`), waited.text);
  assert.match(waited.text, /tells me: The drone card is on D:, 40 videos\./);
  assert.equal(w.splits.tellWaiting(splitIds[0], 'too late'), false, 'nobody waits any more');
});

test('at the wait\'s bound the call answers with what is there; the rest comes back on its own', async () => {
  const w = world();
  const { splitIds } = waiting(w);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal, limit: 20 });
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  const waited = await result;
  assert.equal(waited.ended, 'early');
  assert.match(waited.text, /### #1 Look on D: – done[\s\S]*Four drone files lie on D:\./);
  assert.match(waited.text, /### #2 List the channel – still running/);
  assert.ok(waited.text.endsWith(STILL_WORKING), waited.text);

  assert.equal(w.wakes.list('ag_ava').length, 0, 'what the call brought back wakes nobody');
  w.splits.afterParentTurn(PARENT, 'done');
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'Twelve videos on the channel.' });
  assert.equal(w.wakes.list('ag_ava').length, 1, 'the part that was still working returns on its own');
  const pending = w.splits.pendingResults('ag_ava', CHAT)!;
  assert.deepEqual(pending.splitIds, [splitIds[1]], 'only the part the call did not bring back');
  assert.match(pending.text, /### #2 List the channel – done/);
});

test('the wait ends before the hub cuts the call and before the stall watch cuts the silent turn', () => {
  assert.ok(WAIT_MS > 0);
  assert.ok(WAIT_MS < HUB_CALL_MS, 'the hub\'s limit');
  assert.ok(WAIT_MS < STALL_TOOL_MS, 'a waiting call sends nothing while its parts work: the stall watch\'s limit');
});

test('four parts of mine run at once while the call waits; it holds until the fifth ended too', async () => {
  const w = world();
  const group = w.splits.create(w.ctx(), { goal: 'Five looks', parts: [1, 2, 3, 4, 5].map((n) => part(`P${n}`)), wait: true });
  assert.equal(w.lanes.started.length, 4, 'four parts of one agent run at once, the fifth waits');
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds: group.splits.map((split) => split.id), signal: new AbortController().signal });
  for (const splitId of [...w.lanes.started]) w.lanes.end(splitId, 'done', { answer: `${splitId} looked.` });
  assert.equal(w.lanes.started.length, 5, 'the fifth started when a lane freed');
  w.lanes.end(w.lanes.started[4], 'done', { answer: 'The fifth looked too.' });
  const waited = await result;
  assert.equal(waited.ended, 'parts');
  assert.match(waited.text, /5 parts: 5 done/);
  assert.match(waited.text, /### #5 P5 – done[\s\S]*The fifth looked too\./);
});

test('the tool: wait is a boolean of its own, the parts start inside the call and it answers with their results', async () => {
  const schema = splitTool.inputSchema as { properties: Record<string, { type?: string }>; additionalProperties?: boolean; required: string[] };
  assert.deepEqual(schema.properties.wait, { type: 'boolean', description: 'true: they start now and this call answers with what each of them brought back.' });
  assert.equal(schema.additionalProperties, false, 'nothing else reaches the service');
  assert.deepEqual(schema.required, ['goal', 'parts'], 'a split without wait is unchanged');

  const w = world();
  const call = caller(w, new AbortController().signal);
  const out = call(splitTool, { goal: 'Find the real material', parts: [{ title: 'Look on D:', brief: 'Look on drive D:.', needs: 'check' }], wait: true });
  assert.equal(w.lanes.started.length, 1, 'the part started inside the call');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  const answer = await out;
  assert.equal(answer.failed, false, answer.text);
  assert.equal(answer.data, undefined, 'the result is what the part brought back, not the "I end my turn" note');
  assert.match(answer.text, /### #1 Look on D: – done[\s\S]*Four drone files lie on D:\./);
  w.splits.afterParentTurn(PARENT, 'done');
  assert.equal(w.splits.list({ agentId: 'ag_ava' })[0].status, 'gathered');
});

test('a part\'s own split with wait does not hold its lane: its new parts start beside it and report to the origin', async () => {
  const w = world();
  const { splitIds } = waiting(w, ['Look on D:']);
  const call = caller(w, new AbortController().signal);
  const turn = w.lanes.turns.find((entry) => entry.turn.splitId === splitIds[0])!.turn;
  const answer = await call(splitTool, { goal: 'More looks', parts: [{ title: 'Look on E:', brief: 'Look on drive E:.', needs: 'check' }], wait: true }, turn);
  assert.equal(answer.failed, false, answer.text);
  assert.equal(answer.data?.ok, true, 'the call answers at once with the joined parts');
  assert.match(String(answer.data?.next), /to my origin/);
  assert.equal(w.lanes.started.length, 2, 'the new part started beside it');
});

test('a part one of mine added while I wait still works: the answer says it comes back on its own', async () => {
  const w = world();
  const { splitIds } = waiting(w, ['Look on D:']);
  const result = w.splits.waitFor({ agentId: 'ag_ava', runId: PARENT, splitIds, signal: new AbortController().signal });
  const call = caller(w, new AbortController().signal);
  const turn = w.lanes.turns.find((entry) => entry.turn.splitId === splitIds[0])!.turn;
  await call(splitTool, { goal: 'More looks', parts: [{ title: 'Look on E:', brief: 'Look on drive E:.', needs: 'check' }] }, turn);
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'Four drone files lie on D:.' });
  const waited = await result;
  assert.equal(waited.ended, 'parts');
  assert.ok(waited.text.endsWith(STILL_WORKING), waited.text);
});
