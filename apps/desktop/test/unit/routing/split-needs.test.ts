// Halb 21.11.2026 – a fresh part's needs through the real router (agents/split-turn.ts splitPrevious/splitRoute →
// routing/split-route.ts → router.ts step 5, routing/kind.ts): check runs on the small tier's best value at medium, chain on
// the strong tier's best value at high, judgment on the top tier's first choice at high, whatever the origin runs on; a
// tier with nothing that can run lands on the next tier up; a named effort wins; the person's Work model still applies.
// Owns: these assertions only. Never: real engines, accounts or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { splitPrevious, splitRoute } from '../../../src/runtime/agents/split-turn.ts';
import type { Effort } from '../../../src/shared/model/providers.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';

const OPUS = 'claude:claude-opus-5-5';
const SONNET = 'claude:claude-sonnet-5-5';
const HAIKU = 'claude:claude-haiku-5-5';
const LUNA = 'codex:gpt-6-luna';
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const caps = { vision: true, tools: true, structuredOutput: true };
const PRIORS = Priors.parse({
  version: 'test-needs', categories: {},
  models: [
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, smarts: 94, caps, efforts: ALL, strengths: { chat: 0.4 } },
    { match: 'claude-sonnet-5-5*', name: 'Claude Sonnet 5.5', tier: 'strong', relCost: 0.3, smarts: 88, caps, efforts: ALL, strengths: { chat: 0.4 } },
    { match: 'claude-haiku-5-5*', name: 'Claude Haiku 5.5', tier: 'small', relCost: 0.03, smarts: 74, caps, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, smarts: 72, caps: { tools: true, structuredOutput: true }, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4 } },
  ],
});

async function world() {
  const h = setup({ priors: PRIORS });
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high'], vision: false }]);
  h.engine('claude').lists.set('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ model, name: model, efforts: model.includes('haiku') ? ['low', 'medium', 'high'] as Effort[] : ALL, vision: true })));
  await h.catalog.refresh({ force: true });
  const ava = agent('ag_ava', { name: 'Ava' });
  h.agents.set(ava.id, ava);
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  /** The first turn of a fresh part of an origin on Opus at xhigh. */
  const part = (model: string, extra: { effort?: Effort; exclude?: string[] } = {}) => {
    const split = { splitId: 'sp_1', parentRunId: 'run_p', context: 'brief', firstTurn: true, model, ...(extra.effort ? { effort: extra.effort } : {}) } as unknown as SplitTurn;
    const previous = splitPrevious({ runs: { get: () => ({ model: OPUS, effort: 'xhigh' }) }, log } as never, split);
    return h.router.route({ agent: ava, mode: mode('chat'), ...(previous ? { previous } : {}), boundary: true, ...splitRoute({ split }), ...(extra.exclude ? { exclude: extra.exclude } : {}) });
  };
  const tier = (id: string) => h.catalog.get(id)!.tier;
  return { ...h, part, tier };
}

test("check: the small tier's best value at medium – an origin on the frontier tier changes nothing", async () => {
  const w = await world();
  const check = await w.part('check');
  assert.equal(w.tier(check.modelId), 'small', check.reason);
  assert.equal(check.effort, 'medium');
  assert.match(check.reason, /executing runs on the small tier's best value/);
  assert.equal((await w.part('check', { effort: 'low' })).effort, 'low', 'a named effort wins');
});

test('check with no small model that can run: the next tier up', async () => {
  const w = await world();
  const up = await w.part('check', { exclude: [HAIKU, LUNA] });
  assert.equal(up.modelId, SONNET, up.reason);
});

test("chain: the strong tier's best value at high; judgment: the top tier's first choice at high", async () => {
  const w = await world();
  const chain = await w.part('chain');
  assert.deepEqual([chain.modelId, chain.effort], [SONNET, 'high'], chain.reason);
  const judgment = await w.part('judgment');
  assert.deepEqual([judgment.modelId, judgment.effort], [OPUS, 'high'], judgment.reason);
  // no frontier model that can run: the strongest there is
  const below = await w.part('judgment', { exclude: [OPUS] });
  assert.equal(below.modelId, SONNET, below.reason);
});

test("the person's Work model still decides a part's model; its needs still set the effort", async () => {
  const w = await world();
  w.settings.update({ routing: { work: SONNET } });
  const check = await w.part('check');
  assert.deepEqual([check.modelId, check.effort], [SONNET, 'medium'], check.reason);
});
