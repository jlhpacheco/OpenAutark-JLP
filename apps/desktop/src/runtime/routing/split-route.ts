// B-057 S10 – how a split's turn routes (router.ts applies it for RouteRequest.split). The part's own choice
// (agents/split-turn.ts turns 'cheap' | 'strong' | a needs word | a model id – or none named – into RouteRequest.previous,
// needs.tier and split.fresh / split.needs) beats the agent's pin, and – when it names an effort – the agent's fixed effort.
// Halb 21.11.2026 (live 19.–20.11.: 0 of 23 parts with no model named started below the strong tier): a fresh part says what
// its hardest step asks – check, chain or judgment (SPLIT_NEED) – and that is an effort and the cost mode the router's own
// kind default picks with inside its pool (routing/kind.ts kindTier for a part: economy = the tier below strong, balanced =
// strong, best = the top tier): check → the small tier's best value at medium (its floor 'small' keeps local runtimes out),
// chain → the strong tier's best value at high, judgment → the top tier's first choice at high. A tier with no model that
// can run on this PC's accounts is not in the pool, so the kind default lands on the next tier up.
// Owns: those adjustments and the needs table. Never: picks a model, changes state, or touches a route that is not a split's.

import type { RouteRequest } from '../contracts.ts';
import type { Effort, ModelInfo } from '../../shared/model/providers.ts';
import type { SplitNeeds } from '../../shared/model/splits.ts';
import type { EffectivePolicy } from './policies.ts';
import type { CostMode } from './score.ts';

/** What each needs word asks of the router. */
export const SPLIT_NEED: Record<SplitNeeds, { effort: Effort; costMode: CostMode; floor?: ModelInfo['tier'] }> = {
  check: { effort: 'medium', costMode: 'economy', floor: 'small' },
  chain: { effort: 'high', costMode: 'balanced' },
  judgment: { effort: 'high', costMode: 'best' },
};

/** The needs word a part's stored model holds; undefined for a model id, 'cheap', 'strong' or none. */
export function needsOfModel(model: string | undefined): SplitNeeds | undefined {
  return model && Object.prototype.hasOwnProperty.call(SPLIT_NEED, model) ? model as SplitNeeds : undefined;
}

/**
 * The policy of a split's route: no agent pin (the Work use still applies, router.ts), no fixed effort when the split names
 * one, and the cost mode of its needs.
 */
export function splitPolicy(policy: EffectivePolicy, request: Pick<RouteRequest, 'split' | 'previous'>): EffectivePolicy {
  if (!request.split) return policy;
  const effortNamed = request.previous?.explicit === true && request.previous.asked !== 'model';
  const needs = request.split.needs;
  return {
    ...policy,
    pin: undefined,
    ...(effortNamed ? { agentEffort: undefined } : {}),
    ...(needs ? { costMode: SPLIT_NEED[needs].costMode } : {}),
  };
}
