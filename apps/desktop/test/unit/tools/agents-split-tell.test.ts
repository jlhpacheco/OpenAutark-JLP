// B-083 (Ultra as one being) – agents.split_tell and agents.split_results {steps} over the real split service (the split
// test world) with a dispatcher that records tell / continueNow:
// - a part → its origin: folded into the origin's running turn on the group's thread, else a 'child' wake there with the
//   note (notes not yet read and the group's own fan-in join one wake);
// - the origin → a working part: into its lane's turn; → a part not started yet: read with its input at its start;
//   model / effort: the part's row from now on and a switch inside its running turn (continueNow with its run), the part
//   is told; stop ends a part (to "all" without a group: every group of this thread); 'all' from a part: its other parts only; refusals in one line each;
// - review 08.11.: a note the origin's turn never took wakes it (onLost); a chat-free group's note reaches only its own
//   thread; effort alone switches a working part on the model its turn runs on now (its activity row), a model word,
//   a temperature or a part still routing waits for its next start – and the part is told so;
// - agents.split_results {steps: n}: a working part's last n commands, a failed one marked.
// Owns: these assertions only. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tellTool } from '../../../src/runtime/tools/builtin/agents-split-tell.ts';
import { splitTools } from '../../../src/runtime/tools/builtin/agents-split.ts';
import { SELF_STOPPED } from '../../../src/runtime/splits/runner.ts';
import { TOLD_ITEM } from '../../../src/runtime/splits/results.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';
import { agent } from '../chat/harness.ts';
import { CHAT, part, splitAndEnd, world, type World } from '../splits/fixture.ts';

const AVA = agent('ag_ava', 'Ava');

function rig(w: World) {
  const told: Array<{ runId: string; text: string }> = [];
  const switched: Array<{ runId: string; target?: { modelId: string; effort?: string } }> = [];
  const state = { activity: [] as AgentActivity[], result: 'all' as 'all' | 'refused' | 'held', lost: [] as Array<() => void> };
  Object.assign(w.lanes, {
    tell: async (_agentId: string, runId: string, text: string, onLost?: () => void) => {
      told.push({ runId, text });
      if (state.result === 'refused' && onLost) state.lost.push(onLost);
      return state.result;
    },
    continueNow: (_agentId: string, runId: string, _note: string, target?: { modelId: string; effort?: string }) => { switched.push({ runId, target }); return true; },
    activity: () => state.activity,
  });
  const ctx = (split?: SplitTurn): ToolContext => ({
    agent: AVA, runId: split ? 'run_part' : 'run_origin', mode: 'general', services: w.services, signal: new AbortController().signal, status: () => {},
    ...(split ? { split } : { conversationId: CHAT }),
  } as unknown as ToolContext);
  const call = async (tool: ToolDef, args: Record<string, unknown>, split?: SplitTurn) => {
    const out = await tool.run(args as never, ctx(split));
    const text = out.content.map((item) => ('text' in item ? item.text : '')).join('\n');
    let data: Record<string, any> | undefined;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { failed: Boolean(out.isError), text, data };
  };
  const tell = (args: Record<string, unknown>, split?: SplitTurn) => call(tellTool, args, split);
  const laneOf = (splitId: string) => w.lanes.lanes.get(splitId)!.runId;
  const turnOf = (splitId: string) => w.lanes.turns.find((entry) => entry.turn.splitId === splitId)!.turn;
  return { told, switched, state, tell, call, laneOf, turnOf };
}

test('a part tells its origin: into the origin\'s running turn on the group\'s thread, else one wake there', async () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const [a, b] = w.lanes.started;
  const r = rig(w);
  r.state.activity = [{ agentId: 'ag_ava', runId: 'run_origin', conversationId: CHAT, note: '', startedAt: 0 }];
  w.runs.start({ id: 'run_part', agentId: 'ag_ava', trigger: 'split' }); // the parts' turn the calls come from
  const folded = await r.tell({ to: 'origin', text: 'The API changed in v2.' }, r.turnOf(a));
  assert.deepEqual(folded.data, { ok: true, to: 'origin', note: 'my origin reads it at its next step' });
  assert.deepEqual(r.told, [{ runId: 'run_origin', text: `My part #1 “A” (group ${groupId}) tells me: The API changed in v2.` }]);
  assert.equal(w.wakes.list('ag_ava').length, 0);

  r.state.activity = []; // 13.11.2026: no turn of mine at work (any running main turn is my one context and takes it)
  assert.equal((await r.tell({ to: 'origin', text: 'Found the cause.' }, r.turnOf(a))).data?.note, 'it wakes my origin');
  await r.tell({ to: 'origin', text: 'Half of the files are done.' }, r.turnOf(b));
  assert.deepEqual(w.runs.items('run_part').filter((item) => item.name === TOLD_ITEM).map((item) => item.data.text),
    ['The API changed in v2.', 'Found the cause.', 'Half of the files are done.'], 'each note journaled whole on the run of the part (its result when it ends without last words)');
  const wakes = w.wakes.list('ag_ava');
  assert.equal(wakes.length, 1, 'notes not yet read join one wake');
  assert.equal(wakes[0].reason, 'child');
  assert.equal(wakes[0].conversationId, CHAT);
  assert.match(wakes[0].note ?? '', /My part #1 “A” .* tells me: Found the cause\.[\s\S]*My part #2 “B” .* tells me: Half of the files are done\./);
  w.lanes.end(a, 'done', { answer: 'A' });
  w.lanes.end(b, 'done', { answer: 'B' });
  const after = w.wakes.list('ag_ava');
  assert.equal(after.length, 1, 'the group\'s fan-in joins the same wake');
  assert.match(after[0].note ?? '', /Found the cause[\s\S]*My 2 parts for "Review the release" ended/);

  const refused = await r.tell({ to: 'origin', text: 'x', model: 'cheap' }, r.turnOf(a));
  assert.ok(refused.failed && /My origin sets its own model/.test(refused.text));
  assert.ok((await r.tell({ to: 'origin', text: 'x' })).failed, 'the origin has no origin');
});

test('the origin tells a working part at its next step, a waiting one at its start; model and effort switch it; stop ends it', async () => {
  const w = world();
  const groupId = splitAndEnd(w, Array.from({ length: 5 }, (_, index) => part(`P${index + 1}`)));
  const [p1, p2] = w.lanes.started;
  const r = rig(w);
  const note = await r.tell({ to: 1, text: 'Check v2 too.' });
  assert.deepEqual(note.data, { ok: true, groupId, told: [{ idx: 1, note: 'it reads it at its next step' }] });
  assert.deepEqual(r.told, [{ runId: r.laneOf(p1), text: 'My origin tells me: Check v2 too.' }]);

  const waiting = w.splits.list({ groupId })[0].splits[4];
  assert.equal(waiting.status, 'queued', 'beyond the four running parts');
  assert.deepEqual((await r.tell({ to: 5, text: 'Start with the docs.' })).data?.told, [{ idx: 5, note: 'it reads it when it starts' }]);
  w.lanes.end(p2, 'done', { answer: 'P2' });
  const started = w.lanes.turns.find((entry) => entry.turn.splitId === waiting.id)!;
  assert.ok(started.notes.some((item) => item.text === 'My origin tells me: Start with the docs.'), 'read at its start');

  const tuned = await r.tell({ to: 1, model: 'GPT-6.1 Sol', effort: 'high' });
  assert.deepEqual(tuned.data?.told, [{ idx: 1, changed: 'switched inside its turn', note: 'it reads it at its next step' }]);
  assert.deepEqual(r.switched, [{ runId: r.laneOf(p1), target: { modelId: 'codex:gpt-6.1-sol', effort: 'high' } }]);
  assert.equal(r.told.at(-1)?.text, 'My origin set me to codex:gpt-6.1-sol · high.');
  const row = w.splits.list({ groupId })[0].splits[0];
  assert.deepEqual([row.model, row.effort], ['codex:gpt-6.1-sol', 'high'], 'its row: a retry runs on it too');
  const unknown = await r.tell({ to: 1, model: 'gpt-9' });
  assert.match(String(unknown.data?.told[0].error), /^Part #1: Unknown model "gpt-9"/); // B-080 wave 3: the one lookup's text

  const stopped = await r.tell({ to: 3, stop: true });
  assert.deepEqual(stopped.data?.told, [{ idx: 3, stopped: true }]);
  assert.equal(w.splits.list({ groupId })[0].splits[2].error, SELF_STOPPED);
  assert.deepEqual((await r.tell({ to: 2, text: 'x' })).data?.told, [{ idx: 2, ended: 'done' }]);
  assert.ok((await r.tell({ to: 9, text: 'x' })).failed, 'no such part');
  assert.ok((await r.tell({ to: 1 })).failed, 'nothing to say');
});

test('review 08.11.: a note the origin\'s turn never took wakes it; a chat-free group\'s note reaches only its own thread', async () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const [a] = w.lanes.started;
  const r = rig(w);
  r.state.activity = [{ agentId: 'ag_ava', runId: 'run_origin', conversationId: CHAT, note: '', startedAt: 0 }];
  r.state.result = 'refused'; // its engine was not bound yet
  assert.equal((await r.tell({ to: 'origin', text: 'Found the cause.' }, r.turnOf(a))).data?.note, 'my origin reads it at its next step');
  assert.equal(w.wakes.list('ag_ava').length, 0, 'tried again while that turn runs');
  r.state.lost.forEach((lost) => lost()); // the turn ended without it (failed before its engine, or ended first)
  const wakes = w.wakes.list('ag_ava');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].note ?? '', new RegExp(`My part #1 “A” \\(group ${groupId}\\) tells me: Found the cause\\.`));

  // A group split by a chat-free turn (a mail) – an origin turn on another source is not its thread.
  const mail = { source: 'app:mail', label: 'New mail' };
  w.runs.start({ id: 'run_mail', agentId: 'ag_ava', trigger: 'message', origin: mail });
  const chatFree = w.splits.create(w.ctx({ runId: 'run_mail', conversationId: undefined, thread: 'src:app:mail', origin: mail }), { goal: 'Sort the mail', parts: [part('M')] }).id;
  w.runs.finish('run_mail', { status: 'done', endedAt: w.clock.now() });
  w.splits.afterParentTurn('run_mail', 'done');
  const m = w.lanes.started.at(-1)!;
  r.state.result = 'all';
  r.told.length = 0;
  r.state.activity = []; // no main turn at work
  assert.equal((await r.tell({ to: 'origin', text: 'Two need an answer.' }, r.turnOf(m))).data?.note, 'it wakes my origin');
  assert.equal(r.told.length, 0, 'not folded into a turn on another source');
  const there = w.wakes.list('ag_ava').find((wake) => (wake.note ?? '').includes('Two need an answer.'));
  assert.equal(there?.conversationId, undefined, `group ${chatFree}: woken on its own thread`);
  assert.equal(there?.origin?.source, 'app:mail');
  r.state.activity = [{ agentId: 'ag_ava', runId: 'run_mail2', note: '', startedAt: 0, origin: mail }];
  assert.equal((await r.tell({ to: 'origin', text: 'Done sorting.' }, r.turnOf(m))).data?.note, 'my origin reads it at its next step');
  assert.deepEqual(r.told.map((item) => item.runId), ['run_mail2'], 'its own thread: folded');
});

test('review 08.11.: effort alone switches a working part on the model its turn runs on now; a model word or no route waits for its next start', async () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B')]);
  const [a] = w.lanes.started;
  const r = rig(w);
  r.state.activity = [{ agentId: 'ag_ava', runId: r.laneOf(a), note: '', startedAt: 0, model: 'claude:claude-opus-5-5', effort: 'medium' }];
  assert.deepEqual((await r.tell({ to: 1, effort: 'high' })).data?.told, [{ idx: 1, changed: 'switched inside its turn', note: 'it reads it at its next step' }]);
  assert.deepEqual(r.switched, [{ runId: r.laneOf(a), target: { modelId: 'claude:claude-opus-5-5', effort: 'high' } }]);
  assert.equal(r.told.at(-1)?.text, 'My origin set me to high.');

  assert.deepEqual((await r.tell({ to: 2, effort: 'high' })).data?.told, [{ idx: 2, changed: 'from its next start (its running turn stays on what it runs)', note: 'it reads it at its next step' }], 'still routing: no model to switch on');
  assert.equal(r.told.at(-1)?.text, 'My origin set me to high from my next start.');
  assert.deepEqual((await r.tell({ to: 1, model: 'cheap' })).data?.told[0].changed, 'from its next start (its running turn stays on what it runs)', 'a word is routed at its start');
  assert.deepEqual((await r.tell({ to: 1, temperature: 0.3 })).data?.told[0].changed, 'from its next start (its running turn stays on what it runs)');
  assert.equal(r.switched.length, 1, 'no other switch');
});

test('a part tells "all": its other parts only; itself it cannot address', async () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B'), part('C')]);
  const [a, b, c] = w.lanes.started;
  const r = rig(w);
  const out = await r.tell({ to: 'all', text: 'I own src/api – keep out of it.' }, r.turnOf(a));
  assert.deepEqual(out.data?.told.map((item: { idx: number }) => item.idx), [2, 3]);
  assert.deepEqual(r.told.map((item) => item.runId), [r.laneOf(b), r.laneOf(c)]);
  assert.equal(r.told[0].text, 'My part #1 “A” tells me: I own src/api – keep out of it.');
  const self = await r.tell({ to: 1, text: 'x' }, r.turnOf(a));
  assert.ok(self.failed && /That part is me/.test(self.text));
});

test('agents.split_results {steps}: a working part\'s last commands, a failed one marked', async () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const [a] = w.lanes.started;
  const r = rig(w);
  const runId = r.laneOf(a);
  w.runs.item(runId, { kind: 'tool_call', name: 'files.read', data: { callId: 'c1', summary: 'Read src/api.ts' }, effectStatus: 'none' });
  w.runs.item(runId, { kind: 'tool_call', name: 'shell.exec', data: { callId: 'c2', summary: 'npm test' }, effectStatus: 'none' });
  w.runs.item(runId, { kind: 'tool_result', name: 'shell.exec', data: { callId: 'c2', ok: false }, effectStatus: 'none' });
  const results = splitTools.find((tool) => tool.name === 'agents.split_results')!;
  const all = await r.call(results, { steps: 5 });
  assert.equal(all.text, [
    '### #1 A – still running', '- files.read: Read src/api.ts', '- shell.exec: npm test (failed)',
    '### #2 B – still running', '(no steps yet)',
  ].join('\n'));
  assert.equal((await r.call(results, { groupId, idx: 1, steps: 1 })).text, '### #1 A – still running\n- shell.exec: npm test (failed)');
  assert.ok((await r.call(results, { groupId: 'sgr_none', steps: 1 })).failed);
});
