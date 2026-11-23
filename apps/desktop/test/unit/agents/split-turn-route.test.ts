// B-057 S10 and the route-memory exclusions: a split's model choice as RouteRequest fields (agents/split-turn.ts
// splitPrevious / splitRoute; 17.11.2026: a part that names no model asks for none – it starts from its origin's, a fresh one
// marked so for the router, and from its second turn on it is on its own session's model), its policy without the agent's pin
// and fixed effort (routing/split-route.ts); split runs never feed the model I am on (next-route.ts) nor another scope's recaps
// (context/recent-actions.ts – also when many split runs fill the journal). Pure
// functions with small fakes. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../models/harness.ts';
import { planSplit, splitPrevious, splitRoute } from '../../../src/runtime/agents/split-turn.ts';
import { splitPolicy } from '../../../src/runtime/routing/split-route.ts';
import { returnChoice } from '../../../src/runtime/agents/next-route.ts';
import { recentActions } from '../../../src/runtime/context/recent-actions.ts';
import type { EffectivePolicy } from '../../../src/runtime/routing/policies.ts';
import type { Pool } from '../../../src/runtime/routing/pool.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';
import type { Run, RunItem } from '../../../src/shared/model/runs.ts';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const parent = (run: Partial<Run> | undefined) => ({ runs: { get: () => run }, log }) as never;

test('S10: a model the part names is the explicit request of its route; a part that names none asks for none – it starts where its origin is', () => {
  const s = parent({ model: 'claude:opus', effort: 'high' });
  const base = { parentRunId: 'run_parent' };
  // On the code before 17.11.2026 a part without a model sent its origin's as an explicit request: the route read "requested by the agent".
  assert.deepEqual(splitPrevious(s, base), { modelId: 'claude:opus', effort: 'high' }, "none named: its origin's model and effort, asked for by nobody");
  assert.deepEqual(splitPrevious(s, { ...base, model: 'same', effort: 'low' }), { modelId: 'claude:opus', effort: 'low', explicit: true, asked: 'effort' }, 'an effort it names is its request');
  assert.deepEqual(splitPrevious(s, { ...base, model: 'cheap' }), { modelId: 'claude:opus', effort: 'high', explicit: true, asked: 'model', need: { kind: 'cheaper', from: 'claude:opus' }, from: 'claude:opus' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'cheap', effort: 'low' }), { modelId: 'claude:opus', effort: 'low', explicit: true, need: { kind: 'cheaper', from: 'claude:opus' }, from: 'claude:opus' });
  assert.equal(splitPrevious(s, { ...base, model: 'strong' }), undefined, "'strong' leaves the model to the router inside the tier floor");
  assert.deepEqual(splitPrevious(s, { ...base, model: 'strong', effort: 'max' }), { modelId: '', effort: 'max', explicit: true, asked: 'effort' });
  // B-083 D1: an explicit model carries `from` – the model the part is on (its origin's before its first turn); it stays there while the named one cannot run
  assert.deepEqual(splitPrevious(s, { ...base, model: 'codex:gpt-6-sol', effort: 'xhigh' }), { modelId: 'codex:gpt-6-sol', effort: 'xhigh', explicit: true, from: 'claude:opus' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'codex:gpt-6-sol' }), { modelId: 'codex:gpt-6-sol', effort: 'high', explicit: true, asked: 'model', from: 'claude:opus' });
  assert.equal(splitPrevious(parent(undefined), base), undefined, 'no parent run: the usual rules');
  // From its second turn on the part is on the model its own session is on – whatever its origin runs on by then.
  assert.deepEqual(splitPrevious(s, base, 'claude:sonnet'), { modelId: 'claude:sonnet', effort: 'high' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'strong' }, 'claude:sonnet'), { modelId: 'claude:sonnet', effort: 'high' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'codex:gpt-6-sol' }, 'codex:gpt-6-sol')?.from, 'codex:gpt-6-sol');
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', model: 'strong' } as never }), { split: { splitId: 'sp_1' }, needs: { tier: 'strong' } });
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', model: 'cheap' } as never }), { split: { splitId: 'sp_1' } });
  // `fresh`: the first turn of a part that starts from its brief and names no model.
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', context: 'brief', firstTurn: true } as never }), { split: { splitId: 'sp_1', fresh: true } });
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', context: 'brief', firstTurn: false } as never }), { split: { splitId: 'sp_1' } }, 'past its start it stays where it is');
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', context: 'fork', firstTurn: true } as never }), { split: { splitId: 'sp_1' } }, 'a fork starts on its origin\'s warm cache');
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', context: 'brief', firstTurn: true, model: 'codex:gpt-6-sol' } as never }), { split: { splitId: 'sp_1' } }, 'it named its model');
  assert.deepEqual(splitRoute({}), {});
});

test('Halb 21.11.2026: a needs word routes by the kind default of its cost mode, at its effort – a named effort wins', () => {
  const s = parent({ model: 'claude:opus', effort: 'xhigh' });
  const base = { parentRunId: 'run_parent' };
  // the origin's model is not where it starts: the kind default decides, in the cost mode the needs stand for
  assert.deepEqual(splitPrevious(s, { ...base, model: 'check' }), { modelId: '', effort: 'medium', explicit: true, asked: 'effort' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'chain' }), { modelId: '', effort: 'high', explicit: true, asked: 'effort' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'judgment' }), { modelId: '', effort: 'high', explicit: true, asked: 'effort' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'check', effort: 'low' }), { modelId: '', effort: 'low', explicit: true, asked: 'effort' }, 'a named effort wins');
  assert.deepEqual(splitPrevious(s, { ...base, model: 'check' }, 'claude:haiku'), { modelId: 'claude:haiku', effort: 'medium', explicit: true, asked: 'effort' }, 'past its start: on its own session\'s model');
  const first = { splitId: 'sp_1', context: 'brief', firstTurn: true } as const;
  assert.deepEqual(splitRoute({ split: { ...first, model: 'check' } as never }), { split: { splitId: 'sp_1', needs: 'check' }, needs: { tier: 'small' } }, 'check keeps local runtimes out');
  assert.deepEqual(splitRoute({ split: { ...first, model: 'chain' } as never }), { split: { splitId: 'sp_1', needs: 'chain' } });
  assert.deepEqual(splitRoute({ split: { ...first, model: 'judgment', firstTurn: false } as never }), { split: { splitId: 'sp_1', needs: 'judgment' } });
  const policy: EffectivePolicy = { pin: { modelId: 'claude:haiku', source: 'agent' }, agentEffort: 'low', costMode: 'balanced', prefer: [], avoid: [] };
  const effort = { modelId: '', effort: 'medium' as const, explicit: true as const, asked: 'effort' as const };
  assert.equal(splitPolicy(policy, { split: { splitId: 'sp_1', needs: 'check' }, previous: effort }).costMode, 'economy');
  assert.equal(splitPolicy(policy, { split: { splitId: 'sp_1', needs: 'chain' }, previous: effort }).costMode, 'balanced');
  assert.equal(splitPolicy(policy, { split: { splitId: 'sp_1', needs: 'judgment' }, previous: effort }).costMode, 'best');
  assert.equal(splitPolicy({ ...policy, costMode: 'best' }, { split: { splitId: 'sp_1' } }).costMode, 'best', 'no needs: the cost mode stays');
});

test("decision 10 (real run 18.11.2026): a part of a turn that waits for it starts on its origin's model, which only the origin's session names yet", () => {
  // The waiting parent run is still running: its row has no model (runs get it when they end). Its session on the parent
  // thread is on Terra. Before the fix the part asked for no model, and the router gave it the kind's default (Sonnet).
  const session = { agent_id: 'ag_tes', conversation_id: 'main', engine: 'codex', account_id: 'acc_1', session_ref: 'thr_1', cursor_seq: 0, generation: 1,
    context_tokens: 18_000, context_window: 475_000, model: 'codex:gpt-6.1-terra', prompt_key: null, mode: null, updated_at: 0 };
  const db = { get: (sql: string, params: unknown[]) => (params[1] === 'main' ? (sql.startsWith('SELECT engine') ? { engine: 'codex' } : session) : undefined) };
  const services = { org: { get: () => ({ id: 'ag_tes', name: 'Tessa', mode: 'general' }) }, runs: { get: () => ({ id: 'run_parent', status: 'running' }) }, log, clock: { now: () => 0 }, db } as never;
  const split = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'A', parentRunId: 'run_parent', parentThread: 'main', context: 'fork' as const, firstTurn: true, effort: 'low' as const };
  const plan = planSplit(services, { agentId: 'ag_tes', runId: 'run_s', reason: 'split', notes: [], split } as never, () => ({ key: 'general' }) as never);
  assert.deepEqual(plan?.previous, { modelId: 'codex:gpt-6.1-terra', effort: 'low', explicit: true, asked: 'effort' });
  // A parent run that ended names its own model: that one counts, whatever the session says now.
  assert.deepEqual(splitPrevious(parent({ model: 'claude:opus', effort: 'high' }), { parentRunId: 'run_parent' }, undefined, 'codex:gpt-6.1-terra'), { modelId: 'claude:opus', effort: 'high' });
  assert.equal(splitPrevious(parent(undefined), { parentRunId: 'run_parent' }, undefined, 'codex:gpt-6.1-terra'), undefined, 'no parent run: the usual rules');
});

test('B-083: a part\'s temperature goes on its plan like a model.set request\'s; without one the plan has none', () => {
  const services = { org: { get: () => ({ id: 'ag_ava', name: 'Ava', mode: 'general' }) }, runs: { get: () => ({ model: 'claude:opus', effort: 'high' }) }, log, clock: { now: () => 0 }, db: { get: () => undefined } } as never; // db: no session of the part yet (agents/boundary.ts)
  const split = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'A', parentRunId: 'run_parent', parentThread: 'ch_1', context: 'fork' as const, firstTurn: true };
  const request = (temperature?: number) => ({ agentId: 'ag_ava', runId: 'run_s', reason: 'split', notes: [], split: { ...split, ...(temperature !== undefined ? { temperature } : {}) } }) as never;
  const mode = () => ({ key: 'general' }) as never;
  assert.equal(planSplit(services, request(0.3), mode)?.temperature, 0.3);
  assert.equal(planSplit(services, request(0), mode)?.temperature, 0, 'zero is a temperature too');
  assert.equal('temperature' in (planSplit(services, request(), mode) ?? {}), false);
  assert.equal(planSplit(services, request(), mode)?.boundary, true, 'no session of its own yet: its first turn stands at a boundary');
});

test('S10: a split\'s policy drops the agent pin (the Work use still applies in the router) and the fixed effort when it names one', () => {
  const policy: EffectivePolicy = { pin: { modelId: 'claude:haiku', source: 'agent' }, agentEffort: 'low', prefer: [], avoid: [] };
  assert.equal(splitPolicy(policy, {}), policy, 'not a split: unchanged');
  const named = splitPolicy(policy, { split: { splitId: 'sp_1' }, previous: { modelId: 'claude:opus', effort: 'high', explicit: true } });
  assert.equal(named.pin, undefined);
  assert.equal(named.agentEffort, undefined);
  const modelOnly = splitPolicy(policy, { split: { splitId: 'sp_1' }, previous: { modelId: 'x', effort: 'high', explicit: true, asked: 'model' } });
  assert.equal(modelOnly.agentEffort, 'low', 'no effort named: the fixed effort holds');
  assert.equal(splitPolicy(policy, { split: { splitId: 'sp_1' } }).pin, undefined, 'the default model is the Work use (settings), never a policy pin');
});

test('split runs never feed the return rule nor another scope\'s recap', () => {
  const run = (id: string, patch: Partial<Run>): Run => ({ id, agentId: 'ag_tom', trigger: 'message', status: 'done', startedAt: 1, ...patch } as Run);
  const runs = [
    run('run_split', { model: 'claude:haiku', effort: 'low', splitId: 'sp_1' }), // newest: a split's (chat-free) run
    run('run_own', { model: 'claude:opus', effort: 'high' }),
  ];
  assert.equal(returnChoice(runs, undefined)?.modelId, 'claude:opus', 'a chat-free turn returns to its own model, never a split\'s');

  const call = (runId: string): RunItem => ({ id: `ri_${runId}`, runId, seq: 1, kind: 'tool_call', name: 'files.read', data: { callId: 'c1', args: 'notes.md', own: true }, effectStatus: 'none', createdAt: 5 } as RunItem);
  const journal = [
    run('run_split_failed', { status: 'failed', splitId: 'sp_1', origin: { source: 'mail:inbox' } as never }),
    run('run_mail_failed', { status: 'failed', origin: { source: 'mail:inbox' } as never }),
  ];
  const s = { runs: { list: () => journal, items: (runId: string) => [call(runId)], get: () => undefined }, secrets: { redact: (text: string) => text } } as never;
  assert.deepEqual(recentActions(s, { agentId: 'ag_tom', source: 'mail:inbox' }).map((action) => action.runId), ['run_mail_failed'], 'the source scope leaves the split out');
  assert.deepEqual(recentActions(s, { agentId: 'ag_tom', splitId: 'sp_1' }).map((action) => action.runId), ['run_split_failed'], 'a split sees only its own runs');

  // A group's many split runs never push the agent's own unfinished run out of the recap window.
  const crowd = Array.from({ length: 40 }, (_, i) => run(`run_part_${i}`, { status: 'failed', splitId: `sp_${i}` }));
  const own = run('run_own_cut', { status: 'interrupted', conversationId: 'ch_1' });
  const journal2 = {
    list: (_agentId: string, limit: number) => [...crowd, own].slice(0, limit),
    listTopLevel: (_agentId: string, limit: number) => [own].slice(0, limit),
    listBySplit: (ids: readonly string[]) => crowd.filter((item) => ids.includes(item.splitId!)),
    items: (runId: string) => [call(runId)], get: () => undefined,
  };
  const s2 = { runs: journal2, secrets: { redact: (text: string) => text } } as never;
  assert.deepEqual(recentActions(s2, { agentId: 'ag_tom', conversationId: 'ch_1' }).map((action) => action.runId), ['run_own_cut']);
  assert.deepEqual(recentActions(s2, { agentId: 'ag_tom', splitId: 'sp_7' }).map((action) => action.runId), ['run_part_7']);
});
