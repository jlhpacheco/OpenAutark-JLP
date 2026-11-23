// The cost of one finished turn (PR9): only real charges reach the agent's budget.
// A turn of two attempts (a session renewal or a failover) is priced per attempt: turn.ts mergeAttempts keeps the final
// attempt's own usage as `lastUsage`, the difference is the earlier attempts', and a run's 'failover' note names that
// attempt's account and model (none: a renewal, on the turn's own). Each attempt is priced on its own account and model
// (models/pricing.ts with the shipped priors' curated prices and the daily list's prices on the catalog's models; the cached and the written input an attempt reported at their own prices); the paid amount is
// booked as the agent's 'tokens' spend, the cost basis and a plan's notional list-price cost are stored on the run (store/run-cost.ts).
// B-089 (11.11.2026: what a run costs, written down): runTokens gives the finish the run's cached input and model calls;
// package C (17.11.2026) its cache writes too. An engine that reports a session's running total (Claude Code) gets the
// turn's own cost from turnOwnCost (agents/attempt-cost.ts ownCost applies it); notionalOf prices tokens alone at list price (the
// one-time repair of bridge/cost-1117.ts).
// Owns: the attempt split, the price lookups, the turn's own share of a running total and the booking.
// Never: books a plan's or a local model's cost, invents a price, or fails the turn (a lookup or
// write that fails is logged; without the failover note the whole turn counts on its account).

import type { RuntimeServices } from '../contracts.ts';
import { priorFor } from '../models/catalog-merge.ts';
import { Priors } from '../models/priors.ts';
import { attemptCost, combineCosts, type AttemptCost, type RunCost, type TokenUsage } from '../models/pricing.ts';
import { addCache, cachedInput } from '../engines/shared.ts';
import { RunCostRepo } from '../store/run-cost.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { AttemptResult, RoutedTurn } from './turn-types.ts';

export interface TurnCost {
  /** The whole run: the real charge (`costUsd`), the basis and the notional plan cost. */
  run: RunCost;
  /** The final attempt alone (its model's outcome statistics). */
  last: AttemptCost;
}

/** Prices the turn's attempts (see the header); a lookup that throws prices the whole turn on its account without list prices. */
export function priceTurn(services: RuntimeServices, turn: Pick<RoutedTurn, 'account' | 'route'>, attempt: Pick<AttemptResult, 'usage' | 'lastUsage'>, runId: string): TurnCost {
  try {
    return priceAttempts(services, turn, attempt, runId);
  } catch (error) {
    services.log.warn('pricing the turn failed', { runId, error: String(error) });
    const last = attemptCost({ account: turn.account, usage: attempt.usage });
    return { run: combineCosts([last]), last };
  }
}

function priceAttempts(services: RuntimeServices, turn: Pick<RoutedTurn, 'account' | 'route'>, attempt: Pick<AttemptResult, 'usage' | 'lastUsage'>, runId: string): TurnCost {
  const priors = Priors.shipped(services.paths?.resources, (error) => services.log.warn('model priors not loaded for pricing', { error: String(error) }));
  const last = priceAttempt(services, priors, turn.account, turn.route.modelId, attempt.lastUsage ?? attempt.usage);
  const parts = [last];
  const first = attempt.lastUsage ? firstUsage(attempt.usage, attempt.lastUsage) : undefined;
  if (first) {
    const from = failoverFrom(services, runId);
    const account = from ? services.accounts.get(from.account) : turn.account; // a removed account is no charge
    parts.unshift(priceAttempt(services, priors, account, from?.model ?? turn.route.modelId, first));
  }
  return { run: combineCosts(parts), last };
}

/**
 * B-089: the run's cached input (a part of its inputTokens, over its attempts – cachedInput of the merged usage) and its
 * model calls, each only where the engine reported it. After a failover the count stays out (mergeAttempts keeps only the
 * final attempt's) – a part is no count.
 */
export function runTokens(attempt: Pick<AttemptResult, 'usage' | 'lastUsage' | 'modelCalls'>): { cachedTokens?: number; cacheWriteTokens?: number; modelCalls?: number } {
  const { usage } = attempt;
  const cached = usage.cachedInputTokens !== undefined || usage.cacheReadTokens !== undefined;
  return {
    ...(cached ? { cachedTokens: cachedInput(usage) } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}), // package C
    ...(attempt.modelCalls !== undefined && !attempt.lastUsage ? { modelCalls: attempt.modelCalls } : {}),
  };
}

/**
 * Package C: a turn's own cost from the running total its engine reported for the session and the total kept from the
 * session's turn before (none: a new count; a total below the kept one: the engine started counting anew).
 */
export function turnOwnCost(total: number, kept: number | undefined): number {
  return kept !== undefined && total >= kept ? Math.round((total - kept) * 1e6) / 1e6 : total;
}

/** Package C: the list-price cost of `usage` on `modelId`, as a plan turn's notional cost (undefined: no price known). */
export function notionalOf(services: Pick<RuntimeServices, 'catalog'>, priors: Priors, modelId: string, usage: TokenUsage): number | undefined {
  return priceAttempt(services, priors, undefined, modelId, usage).notionalUsd;
}

/** Stores the basis and notional cost on the run (before runs.finish, so its event can carry them). */
export function saveRunCost(services: RuntimeServices, runId: string, cost: RunCost): void {
  try { new RunCostRepo(services.db).save(runId, { basis: cost.basis, notionalUsd: cost.notionalUsd }); } catch (error) {
    services.log.warn('storing the run cost failed', { runId, error: String(error) });
  }
}

/** Books the real charge as the agent's model usage (nothing for plans, local models or 0). */
export function bookTurnCost(services: RuntimeServices, agentId: string, runId: string, cost: RunCost): void {
  if (!cost.costUsd || cost.costUsd <= 0) return;
  try { services.spend.record({ agentId, amount: cost.costUsd, currency: 'USD', kind: 'tokens', ref: runId }); } catch (error) {
    services.log.warn('recordSpend failed', { error: String(error) });
  }
}

function priceAttempt(services: Pick<RuntimeServices, 'catalog'>, priors: Priors, account: Account | undefined, modelId: string, usage: TokenUsage): AttemptCost {
  let model: ModelInfo | undefined;
  try { model = services.catalog.get(modelId); } catch { model = undefined; }
  const providerModel = model?.model ?? modelId.slice(modelId.indexOf(':') + 1);
  return attemptCost({ account, usage, model, prior: priorFor(priors, providerModel, modelId) });
}

/** The first attempt's usage: the merged total minus the final attempt's own (its cached input too, when reported). */
export function firstUsage(total: TokenUsage, last: TokenUsage): TokenUsage | undefined {
  const inputTokens = Math.max(0, total.inputTokens - last.inputTokens);
  const outputTokens = Math.max(0, total.outputTokens - last.outputTokens);
  let costUsd: number | undefined;
  if (total.costUsd !== undefined) {
    const rest = total.costUsd - (last.costUsd ?? 0);
    // Both reported and nothing is left: the first attempt reported none (mergeAttempts adds a missing cost as 0).
    costUsd = last.costUsd === undefined ? total.costUsd : rest > 1e-9 ? rest : undefined;
  }
  if (!inputTokens && !outputTokens && costUsd === undefined) return undefined;
  const cache = addCache(total, last, -1);
  return costUsd === undefined ? { inputTokens, outputTokens, ...cache } : { inputTokens, outputTokens, costUsd, ...cache };
}

/** The account and model of the attempt before the failover (turn.ts journals them as a note). */
function failoverFrom(services: RuntimeServices, runId: string): { account: string; model: string } | undefined {
  try {
    const items = services.runs.items(runId);
    for (let index = items.length - 1; index >= 0; index--) {
      const failover = items[index].kind === 'note' ? items[index].data.failover : undefined;
      if (!failover || typeof failover !== 'object') continue;
      const { from, fromAccount } = failover as { from?: unknown; fromAccount?: unknown };
      if (typeof from === 'string' && typeof fromAccount === 'string') return { account: fromAccount, model: from };
    }
  } catch { /* no journal to read (tests): the whole turn counts on its account */ }
  return undefined;
}
