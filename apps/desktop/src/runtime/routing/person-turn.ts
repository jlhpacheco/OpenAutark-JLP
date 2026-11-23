// A tier's first choice. B-078 (D16, owner 06.11.2026: "2 % smarter at three times the price makes no sense; 20 % smarter at
// 1.5 times, for hard work, does"): the first choice of a tier weighs how capable a model is (its curated smarts) against its
// list price (relCost, not discounted by a plan – a plan's quota runs down at the same ratio), on top of the usual score in
// cost mode 'best'. So on a Claude plan the strongest tier's first choice is Opus 5.5, not the 2.5x pricier Fable
// (routing/kind.ts takes it for an agent that leads).
// Runde „Halb“ 21.11.2026: the effort floor for a person's line (E1, 01.11.2026: "high or above") went – measured 19.–20.11.,
// it lifted every line of a person to high whatever it asked; the subconscious weighs every wake alike, and a turn nobody
// weighed runs at medium, a person's line included (previous.ts UNWEIGHED_EFFORT – the bench's nine days decided it).
// Owns: a tier's first choice. Never: changes state or picks the turn's model.

import type { PoolEntry } from './pool.ts';
import { listPrice, tierRank } from './score.ts';

/** The pool's entries of its highest tier (the strongest kind of model connected for this work). */
export function topTier<T extends Pick<PoolEntry, 'model'>>(pool: readonly T[]): T[] {
  const top = Math.max(-1, ...pool.map((entry) => tierRank(entry.model.tier)));
  return pool.filter((entry) => tierRank(entry.model.tier) === top);
}

/** One smarts point is worth 0.01 of score (a prior strength spans −1…+1). */
const SMARTS_WEIGHT = 0.01;
/** Smarts of a model the priors do not rate. */
const SMARTS_UNKNOWN = 70;
/** What the whole price range (relCost 0 → 1) costs in score: Fable at 2.5x Opus needs 30 smarts points more to win. */
export const PRICE_WEIGHT = 0.5;

type Scored = Pick<PoolEntry, 'model'> & { score?: number };

/** A model's worth as a tier's first choice: its score + smarts − list price (see the header). */
export function personValue(entry: Scored): number {
  const { model } = entry;
  const smarts = typeof model.smarts === 'number' ? model.smarts : SMARTS_UNKNOWN;
  return (entry.score ?? 0) + SMARTS_WEIGHT * smarts - PRICE_WEIGHT * listPrice(model);
}

/** The first choice among `ranked` (one tier, scored in cost mode 'best'): the highest personValue, the ranking's order on a tie. */
export function firstChoice<T extends Scored>(ranked: readonly T[]): T | undefined {
  return ranked.map((entry, index) => ({ entry, index, value: personValue(entry) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)[0]?.entry;
}
