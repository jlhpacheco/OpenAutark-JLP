// Runde "Halb" 21.11.2026 – the two weighings of a native rebuild (agents/rebuild.ts) that keep a context small: what the lean
// view keeps whole (leanKeep: the thread's newest KEEP_STEPS tool steps and the newest runs' reasoning, open work included) and
// whether a warm session's trim pays (trimWeight → compaction-policy.ts trimPays, at the turn model's own prices, writeInReads).
// The provider cache is keyed by content: a session that starts anew with the prompt and tools the replaced one had reads that
// prefix from the cache (measured 21.11.2026 on 16 live first calls: 7 new sessions read 29–36k and wrote 4–7k; the 9 that
// wrote it all had rested past the cache or changed their prompt) – so the trim counts it at the read price, else as written.
// Owns: leanKeep, trimWeight, writeInReads. Never: writes marks or starts a session (rebuild.ts does).

import type { RuntimeServices } from '../contracts.ts';
import type { LedgerViewItem } from '../../shared/model/context-ledger.ts';
import { KEEP_STEPS, trimPays } from './compaction-policy.ts';
import { entryTokens, tokensOf, type LeanKeep, type LeanMark } from '../context/ledger/window.ts';
import { priorFor } from '../models/catalog-merge.ts';
import { cachePrices } from '../models/pricing.ts';
import { Priors } from '../models/priors.ts';

/**
 * What the lean history keeps whole: the tool and file items from the thread's KEEP_STEPS-th newest tool step on – what the
 * next steps build on, whatever run or task they belong to –, the reasoning of this run and of the newest run here (as the fit
 * finds it), and the fit's pins (the closing words, what the main AI brought back).
 */
export function leanKeep(entries: readonly Pick<LedgerViewItem, 'itemId' | 'kind' | 'nested'>[], fit: { newestRun?: string; pinned: Set<string> }, runId: string): Required<LeanKeep> {
  const recent = new Set<string>();
  let steps = 0;
  for (let at = entries.length - 1; at >= 0 && steps < KEEP_STEPS; at--) {
    const entry = entries[at];
    if (entry.nested || (entry.kind !== 'tool' && entry.kind !== 'file')) continue;
    recent.add(entry.itemId);
    if (entry.kind === 'tool') steps++;
  }
  return { runs: new Set([runId, ...(fit.newestRun ? [fit.newestRun] : [])]), pinned: fit.pinned, recent };
}

/** What a trim weighs besides the view: the turn's engine, model and prompt, the replaced session's prompt key, and the prompt and tools in tokens. */
export interface TrimInput {
  revert: boolean;
  modelId: string;
  volatile: string;
  /** The key the replaced session started with and the key the new one gets (sha256 of the stable prompt and the tool names). */
  sessionKey?: string;
  promptKey: string;
  /** The stable prompt, the live block and the native tool definitions, in tokens. */
  overhead: number;
}

export interface TrimWeight { freed: number; rewritten: number; writeInReads: number; samePrefix: boolean; pays: boolean }

/**
 * What a trim frees and what its rebuild writes into the cache, in written tokens: on an engine that reverts, the tail from
 * the first changed item (the view already holds the marks waiting) plus the live block, sent again in full; elsewhere the whole
 * new history and the live block, with the prompt and tools – read from the cache when the new session starts with the same
 * key (samePrefix: then rebuild.ts keeps that start and promotes no learned tools), else written too. `freed` counts against
 * the session as it stands.
 */
export function trimWeight(services: Pick<RuntimeServices, 'catalog' | 'paths'>, input: TrimInput, entries: readonly LedgerViewItem[], lean: readonly LeanMark[], need: { since: number; saves: number } | undefined, leaned: number): TrimWeight {
  const leanSaves = lean.reduce((sum, mark) => sum + mark.saves, 0);
  const freed = leanSaves + Math.max(0, need?.saves ?? 0);
  const ratio = writeInReads(services, input.modelId);
  const live = tokensOf(input.volatile.length);
  const samePrefix = input.sessionKey !== undefined && input.sessionKey === input.promptKey;
  const prefix = Math.max(0, input.overhead - live);
  let rewritten = leaned + live + (samePrefix ? prefix / ratio : prefix);
  if (input.revert) {
    const orders = new Map(entries.map((entry) => [entry.itemId, entry.order]));
    const first = lean.reduce((min, mark) => Math.min(min, orders.get(mark.itemId) ?? min), need?.since ?? Number.POSITIVE_INFINITY);
    const tail = entries.reduce((sum, entry) => sum + (entry.order >= first ? entryTokens(entry) : 0), 0);
    rewritten = Math.max(0, tail - leanSaves) + live;
  }
  rewritten = Math.round(rewritten);
  return { freed, rewritten, writeInReads: ratio, samePrefix, pays: trimPays(freed, rewritten, ratio) };
}

/** What a cache write costs in cached reads where the price table knows no price for the model (Claude Code, measured 15.–17.11.2026). */
const WRITE_IN_READS = 40;

/** One written token of that model in cached read tokens, from the price table (models/pricing.ts cachePrices): Claude about 40, Codex about 10. */
export function writeInReads(services: Pick<RuntimeServices, 'catalog' | 'paths'>, modelId: string): number {
  try {
    const info = services.catalog.get(modelId);
    const prior = priorFor(Priors.shipped(services.paths?.resources), info?.model ?? modelId.slice(modelId.indexOf(':') + 1), modelId);
    const { write, read } = cachePrices(prior, info);
    return write && read ? write / read : WRITE_IN_READS;
  } catch { return WRITE_IN_READS; }
}
