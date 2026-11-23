// bridge 0.3.16 of the KI-Runde 17.11.2026 (package C, cost is the turn's own): runs priced before it carry a wrong notional cost –
// a Claude turn stored Claude Code's running total of its whole session, a Codex turn its cached input at the full input
// price. Once per company, at runtime start (runtime/main.ts), every plan run whose tokens say how much of its input was
// cached gets its notional cost anew from its own tokens at today's prices (models/pricing.ts: the cached input at the read
// price, the rest of the input as written into the cache at the write price, else the input price, and the output) – for
// every user, Claude and Codex alike; a model the catalog no longer holds takes the stored daily price list
// (models/price-feed.ts), as the catalog would. A Claude plan run from before the cached count (migration 100, 11.11.2026) has only
// its session's running total: its own share is the difference to the previous Claude run of the same agent, chat and split
// in time order, the stored figure itself when that one is lower (agents/turn-cost.ts turnOwnCost). The figures and the kv
// mark are written in one transaction, so the repair runs exactly once. One log line says how many runs changed. This file
// is deleted in the version after the bridge.
// Owns: that repair (repriceRuns) and its kv mark. Never: touches a paid run's real charge (cost_usd, cost_basis) or the
// agents' spend, or reprices a Codex run without its cached count.

import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { Priors } from '../models/priors.ts';
import { notionalOf, turnOwnCost } from '../agents/turn-cost.ts';
import { feedKey, storedFeed } from '../models/price-feed.ts';
import type { ModelInfo } from '../../shared/model/providers.ts';

const KV = 'bridge.cost-1117';

interface RunRow {
  id: string; model: string | null; engine: string | null; chain: string; cost_basis: string | null; input_tokens: number | null; output_tokens: number | null;
  cached_tokens: number | null; cache_write_tokens: number | null; notional_usd: number | null; cost_usd: number | null;
}

/** The plan runs' notional cost from their tokens, or from their session's running total before the cached count; returns how many figures changed. */
export function repriceRuns(s: Pick<RuntimeServices, 'db' | 'catalog'>, priors: Priors): number {
  const rows = s.db.all<RunRow>(`SELECT id, model, engine, agent_id || '/' || IFNULL(conversation_id, '') || '/' || IFNULL(split_id, '') AS chain,
    cost_basis, input_tokens, output_tokens, cached_tokens, cache_write_tokens, notional_usd, cost_usd FROM runs
    WHERE cost_basis IS NOT NULL ORDER BY started_at, rowid`);
  const totals = new Map<string, number>(); // chain → the running total its previous Claude run stored
  const figures = new Map<string, number>();
  const feed = storedFeed(s.db);
  const catalog = {
    get: (id: string): ModelInfo | undefined => {
      const known = s.catalog.get(id);
      if (known) return known;
      const model = id.slice(id.indexOf(':') + 1);
      const fed = feed.get(feedKey(model));
      return fed ? { model, price: { inputPerM: fed.inputPerM, outputPerM: fed.outputPerM, source: 'feed' } } as ModelInfo : undefined;
    },
  };
  for (const row of rows) {
    const plan = row.cost_basis === 'plan';
    if (plan && row.model && row.cached_tokens !== null) {
      const inputTokens = Math.max(0, row.input_tokens ?? 0);
      const cached = Math.min(inputTokens, Math.max(0, row.cached_tokens));
      const usd = notionalOf({ catalog } as Pick<RuntimeServices, 'catalog'>, priors, row.model, {
        inputTokens, outputTokens: Math.max(0, row.output_tokens ?? 0),
        cacheReadTokens: cached, cacheWriteTokens: row.cache_write_tokens ?? inputTokens - cached,
      });
      if (usd !== undefined) figures.set(row.id, usd);
    }
    if (row.engine !== 'claude' || row.cached_tokens !== null) continue;
    const total = plan ? row.notional_usd : row.cost_usd;
    if (total === null) continue;
    if (plan) figures.set(row.id, turnOwnCost(total, totals.get(row.chain)));
    totals.set(row.chain, total);
  }
  let changed = 0;
  s.db.tx(() => {
    for (const row of rows) {
      const usd = figures.get(row.id);
      if (usd === undefined || usd === row.notional_usd) continue;
      s.db.run('UPDATE runs SET notional_usd = ? WHERE id = ?', [usd, row.id]);
      changed++;
    }
  });
  return changed;
}

/** Runs the repair once per company, its figures and its mark in one transaction; a failure is logged and tried again at the next start. */
export function runCost1117(s: RuntimeServices): void {
  const kv = new KvRepo(s.db);
  if (kv.get<unknown>(KV, 'repriced')) return;
  try {
    const priors = Priors.shipped(s.paths?.resources, (error) => s.log.warn('model priors not loaded for the cost repair', { error: String(error) }));
    const runs = s.db.tx(() => {
      const count = repriceRuns(s, priors);
      kv.set(KV, 'repriced', { runs: count }, s.clock.now());
      return count;
    });
    s.log.info('cost-1117 bridge: notional cost of earlier runs repriced', { runs });
  } catch (error) {
    s.log.warn('cost-1117 bridge failed', { error: String((error as Error)?.message ?? error) });
  }
}
