// B-048 E4.2 – model by need through the real router (routing/need.ts): stronger (the next tier up; on
// the top tier a clearly better fit, else the same model one effort step higher), cheaper and faster
// (lower real cost / a lower tier, never weak at the work), vision, long context; the model model.set
// named is kept while it still fits; nothing fits → the usual rules, the reason says so; a pin wins.
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, mode, standardSetup } from '../models/harness.ts';
import { needCandidates, type ModelNeed } from '../../../src/runtime/routing/need.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Effort, ModelInfo } from '../../../src/shared/model/providers.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const HAIKU = 'claude:claude-haiku-5-5';

async function needSetup() {
  const h = await standardSetup();
  const route = (category: string, need: ModelNeed, from: string, extra: Partial<NonNullable<RouteRequest['previous']>> = {}, effort: Effort = 'medium') =>
    h.router.route({ agent: agent('ag_1'), mode: mode(category), previous: { modelId: extra.modelId ?? from, effort, explicit: true, asked: 'model', need: { kind: need, from }, ...extra } });
  return { ...h, route };
}

test('stronger: from a small model to the next tier; on the top tier a clearly better fit, else one effort step up', async () => {
  const h = await needSetup();
  const up = await h.route('chat', 'stronger', LUNA);
  assert.equal(h.catalog.get(up.modelId)!.tier, 'frontier');
  assert.equal(up.by, 'request');
  assert.match(up.reason, /^asked for a stronger model · chat/);
  // Opus → Sol for coding (0.8 vs 0.7: at least STRONGER_MARGIN better on the same tier).
  assert.equal((await h.route('coding', 'stronger', OPUS)).modelId, SOL);
  // Video: Opus is the best fit there – it stays, one effort step higher.
  const raised = await h.route('video-animation', 'stronger', OPUS, {}, 'high');
  assert.equal(raised.modelId, OPUS);
  assert.equal(raised.effort, 'xhigh');
  assert.match(raised.reason, /no stronger model fits · effort raised/);
  // A requested effort is kept as asked (model.set stores the raised one itself).
  const asked = await h.route('video-animation', 'stronger', OPUS, { asked: undefined }, 'max');
  assert.equal(asked.effort, 'max');
});

test('cheaper, faster, vision, long context', async () => {
  const h = await needSetup();
  const cheaper = await h.route('chat', 'cheaper', OPUS);
  assert.ok([LUNA, HAIKU].includes(cheaper.modelId), cheaper.modelId);
  assert.match(cheaper.reason, /asked for a cheaper model/);
  const faster = await h.route('chat', 'faster', OPUS);
  assert.equal(h.catalog.get(faster.modelId)!.tier, 'small', 'no measured speed: a lower tier');
  const vision = await h.route('chat', 'vision', LUNA);
  assert.equal(h.catalog.get(vision.modelId)!.caps.vision, true);
  const long = await h.route('chat', 'long_context', SOL);
  assert.equal(long.modelId, OPUS, 'the only window ≥ 400k tokens');
  // The model model.set named is kept while it still meets the need.
  assert.equal((await h.route('chat', 'cheaper', OPUS, { modelId: HAIKU })).modelId, HAIKU);
  assert.equal((await h.route('chat', 'cheaper', OPUS, { modelId: SOL })).modelId, SOL, 'Sol costs less than Opus too: the named one is kept');
  const moved = await h.route('chat', 'cheaper', SOL, { modelId: OPUS });
  assert.notEqual(moved.modelId, OPUS, 'a named model that no longer meets the need gives way');
  assert.match(moved.reason, /asked for a cheaper model/);
});

test("nothing meets the need: the usual rules, led by why; B-079: the agent's own request beats its own pin", async () => {
  const h = await needSetup();
  const none = await h.route('chat', 'long_context', OPUS);
  assert.match(none.reason, /^no model with a longer context fits/);
  assert.notEqual(none.by, 'request');
  // live 07.11.2026: Jonas's "Opus high for code" (model.set) lost to his own Sol pin – the pin is his default, the request his choice now.
  const asked = await h.router.route({ agent: agent('ag_1', { modelPolicy: { pin: LUNA } }), mode: mode('chat'), previous: { modelId: OPUS, effort: 'medium', explicit: true, asked: 'model', need: { kind: 'stronger', from: LUNA } } });
  assert.notEqual(asked.modelId, LUNA, 'the request leaves the agent pin');
  assert.equal(asked.by, 'request');
  const plain = await h.router.route({ agent: agent('ag_1', { modelPolicy: { pin: LUNA } }), mode: mode('chat'), previous: { modelId: LUNA, effort: 'medium' } });
  assert.equal(plain.modelId, LUNA, 'without a request the agent pin holds');
  assert.equal(plain.by, 'pin');
});

test('needCandidates: never weak at the work (except stronger), cost from the account, faster a lower tier', () => {
  const model = (id: string, patch: Partial<ModelInfo>): ModelInfo => ({ id, provider: 'codex', model: id, name: id, engine: 'codex', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [], ...patch });
  const entry = (m: ModelInfo) => ({ model: m, accounts: [] });
  const base = model('base', { tier: 'frontier', relCost: 0.6 });
  const fast = model('fast', { relCost: 0.2 });
  const slowSmall = model('slow', { tier: 'small', relCost: 0.05 });
  const weak = model('weak', { tier: 'small', relCost: 0.01, strengths: { chat: -0.5 } });
  const local = model('local', { tier: 'local', relCost: 0 });
  const entries = [base, fast, slowSmall, weak, local].map(entry);
  const cost = (e: { model: ModelInfo }) => e.model.relCost ?? 1;
  const ids = (need: ModelNeed) => needCandidates(entries, { need, from: base, category: 'chat', cost }).map((e) => e.model.id);
  assert.deepEqual(ids('cheaper'), ['fast', 'slow', 'local'], 'weak is never offered');
  assert.deepEqual(ids('faster'), ['fast', 'slow'], 'a lower tier, never a local runtime');
  assert.deepEqual(needCandidates(entries, { need: 'faster', from: model('fast', {}), category: 'chat', cost }).map((e) => e.model.id), ['slow'], 'the same tier is not faster');
});

test('B-079 startEffort: my own model.set effort first, then my own fixed effort', async () => {
  const { startEffort } = await import('../../../src/runtime/routing/previous.ts');
  const asked = { modelId: 'm', effort: 'xhigh' as const, explicit: true, asked: 'effort' as const };
  assert.deepEqual(startEffort({ agentEffort: 'medium' } as never, asked, 'chat', true), { effort: 'xhigh', requested: true }, 'live 07.11.: Nora\'s xhigh, asked for by the owner');
  assert.deepEqual(startEffort({ agentEffort: 'medium' } as never, { ...asked, asked: 'model' as const }, 'chat', true), { effort: 'medium', requested: false }, 'a model-only request keeps the fixed effort');
  assert.deepEqual(startEffort({ agentEffort: 'medium' } as never, { modelId: 'm', effort: 'max' }, 'chat', true), { effort: 'medium', requested: false }, 'no request: the fixed effort');
  assert.deepEqual(startEffort({} as never, { modelId: 'm', effort: 'max' }, 'chat', true), { effort: 'max', requested: false }, 'nothing fixed: the kept model keeps its effort');
});
