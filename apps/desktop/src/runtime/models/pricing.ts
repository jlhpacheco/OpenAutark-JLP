// What an agent turn costs in real money (PR9). Budgets and the daily cap count only real charges:
// a subscription plan (a Codex or Claude Code login …) costs nothing per turn, whatever price the
// engine reports – that stays on the run as the notional list-price cost ("plan, no charge").
// Rules:
// * Paid, plan or free is the account's charge – shared/model/charge.ts accountCharge, the one rule routing, booking and the UI
//   read (an API key or environment key, or a CLI signed in with an API key, pays per use; plan credits count as a plan).
// * The price of one attempt's tokens, first source that knows it: the cost the provider or
//   engine reported for this attempt (OpenRouter usage.cost; Claude Code's total_cost_usd made the turn's own by
//   agents/turn-attempt.ts) → tokens × the curated price in model-priors.json → tokens × the daily keyless OpenRouter
//   list price (B-078, price-feed.ts) → none: a paid attempt is booked with amount 0 and flagged 'unpriced'. A list price
//   is used only when it covers every kind of token the attempt used (output tokens need an output price).
// * A failover turn is priced per attempt (each on its own account and model) and combined: the
//   paid amounts add up, the plan attempts' notional costs add up, and the weakest paid basis
//   names the run (one unpriced attempt flags the whole run).
// Package C (17.11.2026): the input has three parts on every path (list, prior, feed). The cached input the engine
// reported (Codex's cached input, Claude's cache reads) counts at the cached price – the prior's priceCachedInputPerM, else
// a tenth of the input price (CACHED_SHARE, Anthropic's and OpenAI's discount); the input the turn wrote into the cache
// (Claude's cache writes) counts at the write price – the prior's priceCacheWritePerM, else the input price; the rest at
// the input price.
// Owns: tokenPrice, cachePrices (the write and read price of one model – splits/fork.ts, subconscious/route-turn.ts),
// listPrice, attemptCost, combineCosts. Never: I/O, books spend (agents/turn-cost.ts does).

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { CostBasis } from '../../shared/model/runs.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import type { CacheTokens } from '../engines/types.ts';
import { cachedInput } from '../engines/shared.ts';
import type { PriorEntry } from './priors.ts';

export interface TokenUsage extends CacheTokens {
  /** All input, the cached part included. */
  inputTokens: number;
  outputTokens: number;
  /** What the provider or engine reported for these tokens. */
  costUsd?: number;
}

export interface AttemptCost {
  basis: CostBasis;
  /** The real charge (paid attempts only; 0 when unpriced). */
  usd?: number;
  /** A plan attempt's list-price equivalent, when known. */
  notionalUsd?: number;
}

export interface RunCost {
  basis: CostBasis;
  /** The real charge of the turn: booked as the agent's spend (undefined: no paid attempt). */
  costUsd?: number;
  notionalUsd?: number;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A cached input token's share of the input price where no cached price is known (Anthropic and OpenAI: a tenth). */
export const CACHED_SHARE = 0.1;

/** The prices a prior may carry (pricing reads these). */
export type PriorPrices = Pick<PriorEntry, 'priceInputPerM' | 'priceOutputPerM' | 'priceCachedInputPerM' | 'priceCacheWritePerM'>;

/** One model's price for a token written into the cache and one read from it: the prior's, else the input price (the prior's,
 *  else the model's list price) for a write and a tenth of it for a read; undefined where no price is known. */
export function cachePrices(prior: PriorPrices | undefined, model: Pick<ModelInfo, 'price'> | undefined): { write?: number; read?: number } {
  const input = prior?.priceInputPerM ?? model?.price?.inputPerM;
  return { write: prior?.priceCacheWritePerM ?? input, read: prior?.priceCachedInputPerM ?? (input !== undefined ? input * CACHED_SHARE : undefined) };
}

/**
 * Tokens × prices per 1M: the cached input at `cachedInputPerM` (else a tenth of the input price), the written input at
 * `cacheWritePerM` (else the input price), the rest at the input price; undefined when a needed price is missing.
 */
export function tokenPrice(usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | keyof CacheTokens>, prices: { inputPerM?: number; outputPerM?: number; cachedInputPerM?: number; cacheWritePerM?: number }): number | undefined {
  const input = Math.max(0, usage.inputTokens || 0);
  const output = Math.max(0, usage.outputTokens || 0);
  if ((input > 0 && prices.inputPerM === undefined) || (output > 0 && prices.outputPerM === undefined)) return undefined;
  if (prices.inputPerM === undefined && prices.outputPerM === undefined) return undefined;
  const inputPerM = prices.inputPerM ?? 0;
  const cached = Math.min(input, cachedInput(usage));
  const written = Math.min(input - cached, Math.max(0, usage.cacheWriteTokens ?? 0));
  const usd = (input - cached - written) * inputPerM + cached * (prices.cachedInputPerM ?? inputPerM * CACHED_SHARE)
    + written * (prices.cacheWritePerM ?? inputPerM) + output * (prices.outputPerM ?? 0);
  return round(usd / 1_000_000);
}

/**
 * The list price of the tokens: the curated prior (with its cached and write prices, when it has them), else the daily
 * keyless list's price on the model (B-078, models/price-feed.ts).
 */
export function listPrice(usage: TokenUsage, model?: Pick<ModelInfo, 'price'>, prior?: PriorPrices): { usd: number; basis: 'list-price' | 'prior-price' } | undefined {
  const curated = prior ? tokenPrice(usage, {
    inputPerM: valid(prior.priceInputPerM), outputPerM: valid(prior.priceOutputPerM),
    cachedInputPerM: valid(prior.priceCachedInputPerM), cacheWritePerM: valid(prior.priceCacheWritePerM),
  }) : undefined;
  if (curated !== undefined) return { usd: curated, basis: 'prior-price' };
  const fed = model?.price?.source === 'feed' ? tokenPrice(usage, { inputPerM: valid(model.price.inputPerM), outputPerM: valid(model.price.outputPerM) }) : undefined;
  return fed !== undefined ? { usd: fed, basis: 'list-price' } : undefined;
}

function valid(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reported(usage: TokenUsage): number | undefined {
  const cost = usage.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? round(cost) : undefined;
}

/** The cost of one attempt on its account and model (see the header). */
export function attemptCost(input: { account?: Pick<Account, 'auth' | 'provider' | 'plan'>; usage: TokenUsage; model?: Pick<ModelInfo, 'price'>; prior?: PriorPrices }): AttemptCost {
  const charge = accountCharge(input.account);
  if (charge === 'free') return { basis: 'free' };
  const own = reported(input.usage);
  if (charge === 'plan') {
    const notional = own ?? listPrice(input.usage, input.model, input.prior)?.usd;
    return notional !== undefined ? { basis: 'plan', notionalUsd: notional } : { basis: 'plan' };
  }
  if (own !== undefined) return { basis: 'provider', usd: own };
  const list = listPrice(input.usage, input.model, input.prior);
  return list ? { basis: list.basis, usd: list.usd } : { basis: 'unpriced', usd: 0 };
}

/** Paid bases from the most to the least certain: the weakest one names a combined run. */
const PAID_ORDER: readonly CostBasis[] = ['provider', 'list-price', 'prior-price', 'unpriced'];

/** The run's cost from its attempts (one, or two after a failover). */
export function combineCosts(parts: readonly AttemptCost[]): RunCost {
  const paid = parts.filter((part) => part.usd !== undefined);
  const notional = parts.filter((part) => part.notionalUsd !== undefined);
  const out: RunCost = { basis: 'free' };
  if (paid.length) {
    out.basis = paid.map((part) => part.basis).reduce((worst, basis) => (PAID_ORDER.indexOf(basis) > PAID_ORDER.indexOf(worst) ? basis : worst), 'provider');
    out.costUsd = round(paid.reduce((sum, part) => sum + (part.usd ?? 0), 0));
  } else if (parts.some((part) => part.basis === 'plan')) out.basis = 'plan';
  if (notional.length) out.notionalUsd = round(notional.reduce((sum, part) => sum + (part.notionalUsd ?? 0), 0));
  return out;
}
