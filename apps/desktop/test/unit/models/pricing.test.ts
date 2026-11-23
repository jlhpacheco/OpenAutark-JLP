// PR9 – plan vs paid spend: a plan turn books no spend (its notional price stays on the run), a
// paid turn books tokens × Artificial Analysis list prices, a provider-reported cost (OpenRouter)
// wins over the computed one, curated prior prices are the last source, and a paid turn without
// any price is booked with 0 and flagged 'unpriced'. A failover turn is priced per attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptCost, cachePrices, combineCosts, listPrice, tokenPrice } from '../../../src/runtime/models/pricing.ts';
import { accountCharge } from '../../../src/shared/model/charge.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { firstUsage } from '../../../src/runtime/agents/turn-cost.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { RunCostRepo } from '../../../src/runtime/store/run-cost.ts';
import { runCostText } from '../../../src/shared/text/run-cost.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { account } from './harness.ts';
import { setup } from '../agents/fixture.ts';

/** A list price from the daily keyless list (models/price-feed.ts). */
const AA = { source: 'feed', inputPerM: 2, outputPerM: 8 } as const;
const model = (id: string, price?: Partial<NonNullable<ModelInfo['price']>>): ModelInfo => ({
  id, provider: id.split(':')[0] as ModelInfo['provider'], model: id.slice(id.indexOf(':') + 1), name: id, engine: 'compatible',
  efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [], ...(price ? { price: price as ModelInfo['price'] } : {}),
});

test('who pays: API keys, env keys and API-key CLI logins are paid; plans and local models are not', () => {
  assert.equal(accountCharge(account('a', 'openai')), 'paid');
  assert.equal(accountCharge({ ...account('a', 'openrouter'), auth: 'env' as Account['auth'] }), 'paid', 'the detected environment key (PR5)');
  assert.equal(accountCharge(account('a', 'claude', { plan: 'max' })), 'plan');
  assert.equal(accountCharge(account('a', 'claude')), 'plan', 'a CLI login without a reported plan is a subscription');
  assert.equal(accountCharge(account('a', 'claude', { plan: 'api' })), 'paid', 'Claude Code signed in with an API key');
  assert.equal(accountCharge(account('a', 'codex', { plan: 'api' })), 'paid');
  assert.equal(accountCharge(account('a', 'ollama')), 'free');
  assert.equal(accountCharge(account('a', 'lmstudio', { auth: 'api_key' })), 'free', 'a local runtime never bills');
  assert.equal(accountCharge(account('a', 'compatible', { auth: 'none' })), 'free', 'a server without a key bills nobody');
});

test('prices: provider-reported → AA list price → curated prior → unpriced; never a guessed price', () => {
  const paid = account('a', 'openai');
  const usage = { inputTokens: 1_000_000, outputTokens: 250_000 };
  assert.deepEqual(attemptCost({ account: paid, usage, model: model('openai:x', AA) }), { basis: 'list-price', usd: 4 }, '1M × $2 + 0.25M × $8');
  assert.deepEqual(attemptCost({ account: paid, usage: { ...usage, costUsd: 3.1 }, model: model('openai:x', AA) }), { basis: 'provider', usd: 3.1 }, 'the reported cost wins');
  const prior = Priors.parse({ models: [{ match: 'x*', strengths: {}, priceInputPerM: 1, priceOutputPerM: 4 }, { match: 'bad*', strengths: {}, priceInputPerM: -1, priceOutputPerM: 'free' }] });
  assert.deepEqual(attemptCost({ account: paid, usage, model: model('openai:x'), prior: prior.forModel('x') }), { basis: 'prior-price', usd: 2 });
  const bad = prior.forModel('bad-model')!;
  assert.ok(!('priceInputPerM' in bad) && !('priceOutputPerM' in bad), 'implausible prices are dropped');
  assert.deepEqual(attemptCost({ account: paid, usage, model: model('openai:x') }), { basis: 'unpriced', usd: 0 });
  // A list price must cover every token kind used: output tokens without an output price stay unpriced.
  assert.equal(tokenPrice(usage, { inputPerM: 2 }), undefined);
  assert.equal(tokenPrice({ inputTokens: 500, outputTokens: 0 }, { inputPerM: 2 }), 0.001, 'embeddings: input only');
  assert.equal(listPrice(usage, model('openai:x', { source: 'feed', inputPerM: 2 })), undefined);
  // Plans: no charge, the reported or list price is the notional cost.
  const plan = account('a', 'claude', { plan: 'max' });
  assert.deepEqual(attemptCost({ account: plan, usage: { ...usage, costUsd: 0.4 }, model: model('claude:x', AA) }), { basis: 'plan', notionalUsd: 0.4 });
  assert.deepEqual(attemptCost({ account: account('c', 'codex'), usage, model: model('codex:x', AA) }), { basis: 'plan', notionalUsd: 4 });
  assert.deepEqual(attemptCost({ account: account('o', 'ollama'), usage: { ...usage, costUsd: 1 } }), { basis: 'free' });
});

test('a failover run combines its attempts: paid amounts add up, the weakest paid basis names the run', () => {
  assert.deepEqual(combineCosts([{ basis: 'plan', notionalUsd: 0.4 }, { basis: 'list-price', usd: 0.25 }]), { basis: 'list-price', costUsd: 0.25, notionalUsd: 0.4 });
  assert.deepEqual(combineCosts([{ basis: 'provider', usd: 0.1 }, { basis: 'unpriced', usd: 0 }]), { basis: 'unpriced', costUsd: 0.1 });
  assert.deepEqual(combineCosts([{ basis: 'plan' }, { basis: 'free' }]), { basis: 'plan' });
  assert.deepEqual(firstUsage({ inputTokens: 1400, outputTokens: 150, costUsd: 0.75 }, { inputTokens: 400, outputTokens: 50, costUsd: 0.25 }), { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 });
  assert.deepEqual(firstUsage({ inputTokens: 1400, outputTokens: 150, costUsd: 0.25 }, { inputTokens: 400, outputTokens: 50, costUsd: 0.25 }), { inputTokens: 1000, outputTokens: 100 }, 'only the second attempt reported a cost');
  assert.equal(firstUsage({ inputTokens: 5, outputTokens: 1 }, { inputTokens: 5, outputTokens: 1 }), undefined, 'nothing before the failover');
});

/** finishTurn with the real journal: what reaches the run row, the cost columns and the budget. */
async function finish(input: { account: Account; modelId: string; catalog?: ModelInfo; result: EngineTurnResult; usage: { inputTokens: number; outputTokens: number; costUsd?: number }; lastUsage?: { inputTokens: number; outputTokens: number; costUsd?: number }; before?: (runs: Journal) => void }) {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const spends: Array<{ amount: number; kind: string; ref?: string }> = [];
  const accounts = new Map([[input.account.id, input.account], ['acc_plan', account('acc_plan', 'claude', { plan: 'max' })]]);
  Object.assign(h.services, {
    runs,
    spend: { record: (spend: { amount: number; kind: string; ref?: string }) => { spends.push(spend); } },
    catalog: { get: (id: string) => (id === input.catalog?.id ? input.catalog : undefined) },
    accounts: { get: (id: string) => accounts.get(id), updateLimits: () => {} },
  });
  const request = h.request({ runId: 'run_cost' });
  runs.start({ id: request.runId, agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  input.before?.(runs);
  const plan = (await planTurn(h.services, request))!;
  const routed = { ...h.routed(), account: input.account, route: { ...h.route, modelId: input.modelId, accountId: input.account.id } };
  finishTurn(h.services, plan, routed, request, h.attempt(input.result, { usage: input.usage, ...(input.lastUsage ? { lastUsage: input.lastUsage } : {}) }));
  return { run: runs.get(request.runId)!, cost: new RunCostRepo(h.db).get(request.runId), spends };
}

const DONE: EngineTurnResult = { text: 'Done.', stop: 'done' };

test('a Claude plan turn books no spend: costUsd stays empty, the notional price is stored as "plan, no charge"', async () => {
  const out = await finish({ account: account('acc_max', 'claude', { plan: 'max' }), modelId: 'claude:claude-opus-5-5', result: DONE, usage: { inputTokens: 1000, outputTokens: 40, costUsd: 0.4 } });
  assert.deepEqual(out.spends, [], 'no spend row');
  assert.equal(out.run.costUsd, undefined, 'no real charge on the run');
  assert.deepEqual(out.cost, { costBasis: 'plan', notionalUsd: 0.4 });
  assert.equal(runCostText({ ...out.run, ...out.cost }), '$0.400 · plan, no charge');
  // first real run 18.11.2026: the run as every reader gets it (agents.runs, splits.list, the bench meter) carries the cost too
  assert.deepEqual({ costBasis: out.run.costBasis, notionalUsd: out.run.notionalUsd }, { costBasis: 'plan', notionalUsd: 0.4 });
});

test('an OpenAI API-key turn books tokens × AA list prices', async () => {
  const out = await finish({ account: account('acc_key', 'openai'), modelId: 'openai:gpt-x', catalog: model('openai:gpt-x', AA), result: DONE, usage: { inputTokens: 10_000, outputTokens: 2_000 } });
  assert.deepEqual(out.spends.map((spend) => [spend.amount, spend.kind, spend.ref]), [[0.036, 'tokens', 'run_cost']], '10k × $2/M + 2k × $8/M');
  assert.equal(out.run.costUsd, 0.036);
  assert.deepEqual(out.cost, { costBasis: 'list-price' });
  assert.equal(runCostText({ ...out.run, ...out.cost }), '≈ $0.036');
});

test("OpenRouter's reported cost wins over the computed one", async () => {
  const out = await finish({ account: account('acc_or', 'openrouter'), modelId: 'openrouter:openai/gpt-x', catalog: model('openrouter:openai/gpt-x', AA), result: DONE, usage: { inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.0123 } });
  assert.deepEqual(out.spends.map((spend) => spend.amount), [0.0123]);
  assert.deepEqual([out.run.costUsd, out.cost?.costBasis], [0.0123, 'provider']);
});

test('a paid model without any price is booked with 0 and flagged unpriced', async () => {
  const out = await finish({ account: account('acc_custom', 'compatible'), modelId: 'compatible:my-model', result: DONE, usage: { inputTokens: 5_000, outputTokens: 500 } });
  assert.deepEqual(out.spends, [], 'a zero amount is no spend row');
  assert.equal(out.run.costUsd, 0);
  assert.deepEqual(out.cost, { costBasis: 'unpriced' });
  assert.equal(runCostText({ ...out.run, ...out.cost }), 'unpriced');
});

test("FIXES-3 C2: the shipped Haiku 5.5 prior prices a turn as Claude Code charged it – the published list price (0.10 / 0.50, cached 0.01, an hour's write 0.20)", () => {
  // 18.11.2026, Claude Code's running total (engine_sessions.cost_total) on three Haiku 5.5 turns of the test profile; the prior before
  // (0.50 / 2.50, cached 0.05, write 1 – the price above 100K-token prompts) gave 5× each.
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');
  const haiku = Priors.shipped(resources).data.models.find((entry) => entry.match === 'claude-haiku-5-5*');
  const charged: Array<[{ inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number }, number]> = [
    [{ inputTokens: 42_792, cachedInputTokens: 0, cacheWriteTokens: 42_790, outputTokens: 15 }, 0.008566], // first run, R2-4
    [{ inputTokens: 29_438, cachedInputTokens: 16_498, cacheWriteTokens: 12_938, outputTokens: 72 }, 0.002789], // W3-2
    [{ inputTokens: 63_027, cachedInputTokens: 60_540, cacheWriteTokens: 2_483, outputTokens: 899 }, 0.001552], // W3-3
  ];
  for (const [usage, usd] of charged) assert.equal(Math.round(listPrice(usage, undefined, haiku)!.usd * 1e6) / 1e6, usd);
});

test('curated prior prices from the shipped file are the last source (none are shipped unverified)', () => {
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');
  const shipped = Priors.shipped(resources);
  assert.ok(shipped.data.models.length > 0, 'the shipped priors load');
  assert.equal(Priors.shipped(resources), shipped, 'read once per process');
  assert.equal(Priors.shipped(undefined).data.models.length, 0);
  for (const entry of shipped.data.models) {
    for (const value of [entry.priceInputPerM, entry.priceOutputPerM]) assert.ok(value === undefined || (value >= 0 && value <= 10_000), entry.match);
  }
});

test('a failover from a plan to an API key books only the paid attempt', async () => {
  const out = await finish({
    account: account('acc_key', 'openai'), modelId: 'openai:gpt-x', catalog: model('openai:gpt-x', AA),
    result: DONE, usage: { inputTokens: 11_000, outputTokens: 2_100, costUsd: 0.5 }, lastUsage: { inputTokens: 10_000, outputTokens: 2_000 },
    before: (runs) => runs.item('run_cost', { kind: 'note', data: { failover: { from: 'claude:claude-opus-5-5', fromAccount: 'acc_plan', to: 'openai:gpt-x', toAccount: 'acc_key', reason: 'limit' } }, effectStatus: 'none' }),
  });
  assert.deepEqual(out.spends.map((spend) => spend.amount), [0.036], "the plan attempt's 0.5 is not booked");
  assert.equal(out.run.costUsd, 0.036);
  assert.deepEqual(out.cost, { costBasis: 'list-price', notionalUsd: 0.5 });
});

test('run cost wording: old runs keep their stored cost, local runs show nothing', () => {
  assert.equal(runCostText({ costUsd: 1.234 }), '$1.23');
  assert.equal(runCostText({ costUsd: 0.05, costBasis: 'provider' }), '$0.050');
  assert.equal(runCostText({ costBasis: 'plan' }), 'plan, no charge');
  assert.equal(runCostText({ costBasis: 'free' }), '');
});

test('package C: every path discounts the cached part and prices the written part; no write price means the input price', () => {
  // One Opus turn as Claude Code reports it: 9,000 uncached, 900,000 read, 100,000 written (1 h), 10,000 output.
  const usage = { inputTokens: 1_009_000, outputTokens: 10_000, cacheReadTokens: 900_000, cacheWriteTokens: 100_000 };
  const opus = Priors.parse({ models: [{ match: 'claude-opus-5-5*', strengths: {}, priceInputPerM: 4, priceOutputPerM: 20, priceCachedInputPerM: 0.2, priceCacheWritePerM: 8 }] }).forModel('claude-opus-5-5');
  assert.equal(opus?.priceCacheWritePerM, 8, 'the priors parse the write price');
  // 9k × 4 + 900k × 0.2 + 100k × 8 + 10k × 20 = 0.036 + 0.18 + 0.8 + 0.2 (the old code: 1,009k × 4 + 0.2 = 4.236)
  assert.deepEqual(listPrice(usage, undefined, opus), { usd: 1.216, basis: 'prior-price' });
  assert.deepEqual(attemptCost({ account: account('acc_plan', 'claude'), usage, prior: opus }), { basis: 'plan', notionalUsd: 1.216 });
  // The feed path knows input and output only: reads at a tenth, writes at the input price (the old code: 2.12).
  const fed = { ...model('codex:gpt-6.1-sol'), price: { source: 'feed', inputPerM: 2, outputPerM: 10 } } as unknown as ModelInfo;
  assert.deepEqual(listPrice({ inputTokens: 1_000_000, outputTokens: 10_000, cachedInputTokens: 970_000 }, fed), { usd: 0.354, basis: 'list-price' }, '30k × 2 + 970k × 0.2 + 10k × 10');
  // Cache reads and writes on the list price.
  assert.deepEqual(listPrice({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000, cacheWriteTokens: 500_000 }, model('openai:x', AA)), { usd: 1.1, basis: 'list-price' }, '500k × 0.2 + 500k × 2');
  assert.equal(tokenPrice({ inputTokens: 100, outputTokens: 0, cacheWriteTokens: 500 }, { inputPerM: 1_000_000 }), 100, 'a write report larger than the input counts no more than the input');
});

test('one lookup of a model\'s write and read price for the fork and the effort line: the prior\'s, else the input price and a tenth of it', () => {
  assert.deepEqual(cachePrices({ priceInputPerM: 4, priceCachedInputPerM: 0.2, priceCacheWritePerM: 8 }, undefined), { write: 8, read: 0.2 });
  assert.deepEqual(cachePrices({ priceInputPerM: 2 }, undefined), { write: 2, read: 0.2 });
  assert.deepEqual(cachePrices(undefined, { price: { inputPerM: 0.25, outputPerM: 2, source: 'feed' } }), { write: 0.25, read: 0.025 });
  assert.deepEqual(cachePrices(undefined, undefined), { write: undefined, read: undefined });
});
