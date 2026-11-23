// The candidate pool of one route (router.ts; model-list.ts filters on its own, with this tier preference – preferTier): stage-wise hard filters – connected
// and not excluded → capability needs → not "never" for the category → inside the agent's policy band –, the mode's
// minimum tier as a preference (models below it only when none at or above it is connected), the accounts that can
// run each model now (its provider and listed accounts, healthy for that model – accounts.candidates gets it –, not
// excluded), and pay-per-use API keys only as a spill-over (unless Settings allow them or nothing else is left) – a key
// holding a plan's monthly API credits (B-083 Account.credits) is no pay-per-use key (score.ts isPaid): it competes like a plan,
// and accounts.candidates (accounts/candidates.ts) lists it before the same model's paying keys, whatever their priority.
// Last, the newest version of each model family (models/family.ts) stands for the older ones that can run now (owner
// 14.11.2026: "Warum Fabel Fünf. Eins … 5.2"): an older version leaves the entries while a newer one of its family is in
// them, and entryFor maps a named older version to it. A pin of the older version still runs it (unusable is unchanged).
// 17.11.2026 (the model settles): `runs` answers whether one model can run this turn at all – usable, inside the band, with an
// account under the same spill-over rule –, whatever its tier or version: the model a live session is on stays while it can.
// `whole` is the same pool as if every enabled account were healthy and nothing excluded: what Auto would choose when
// everything runs, so a choice made only because a model cannot run now is known as a stand-in (router.ts).
// Owns: these filters, their order and why a single model is unusable (for pins).
// Never: scores or picks a model, reads the policy itself, or changes state.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { EffectivePolicy } from './policies.ts';
import { NEVER, isPaid, strengthOf, tierRank, unmetNeed, withinTiers, type Tier } from './score.ts';
import { compareVersions, familyOf } from '../models/family.ts';

export interface PoolInput {
  s: RuntimeServices;
  models: readonly ModelInfo[];
  category: string;
  policy: Pick<EffectivePolicy, 'floorTier' | 'ceilingTier' | 'avoid'>;
  needs?: RouteRequest['needs'];
  minTier?: Tier | 'any';
  /** Model and account ids that just failed. */
  exclude?: ReadonlySet<string>;
}

export interface PoolEntry { model: ModelInfo; accounts: Account[] }

export interface Pool {
  /** The filter stages, so the error can say which one left nothing (unfit.ts nothingFits). */
  connected: ModelInfo[];
  capable: ModelInfo[];
  tiered: ModelInfo[];
  suitable: ModelInfo[];
  bounded: ModelInfo[];
  /** Runnable models with their accounts, each family at its newest version among them. */
  entries: PoolEntry[];
  /** The entries as they would be with every enabled account healthy and no model or account excluded. */
  whole(): PoolEntry[];
  /** The entry that runs for a model: its own, else the newest version of its family among the entries. */
  entryFor(model: ModelInfo): PoolEntry | undefined;
  accountsFor(model: ModelInfo): Account[];
  /** The model with the accounts that run it this turn, whatever its tier or version; undefined = it cannot run now. */
  runs(model: ModelInfo): PoolEntry | undefined;
  /** Why the model cannot run at all: 'unavailable', an unmet need or 'never'; undefined = it can. */
  unusable(model: ModelInfo): string | undefined;
  inBand(model: ModelInfo): boolean;
}

/** The accounts that can run `model` now: its engine's healthy, enabled candidates (accounts.candidates) of its provider and – when the catalog names them – its own. */
export function runnableAccounts(s: Pick<RuntimeServices, 'accounts'>, model: ModelInfo): Account[] {
  try {
    return s.accounts.candidates(model.engine, model.model)
      .filter((account) => account.provider === model.provider && (!model.accounts.length || model.accounts.includes(account.id)));
  } catch { return []; }
}

/** Pay-per-use API keys only as a spill-over: while one entry runs on a free account, every entry keeps only its free ones – unless the person allowed paid fallback. */
export function spillOver<T extends { accounts: Account[] }>(entries: readonly T[], allowPaid: boolean): { entries: T[]; unpaidOnly: boolean } {
  const unpaidOnly = !allowPaid && entries.some((entry) => entry.accounts.some((account) => !isPaid(account)));
  if (!unpaidOnly) return { entries: [...entries], unpaidOnly };
  return { entries: entries.map((entry) => ({ ...entry, accounts: entry.accounts.filter((account) => !isPaid(account)) })).filter((entry) => entry.accounts.length > 0), unpaidOnly };
}

export function buildPool(input: PoolInput): Pool {
  const { s, category, policy, needs, minTier } = input;
  const exclude = input.exclude ?? new Set<string>();
  const allowPaid = s.settings.get().routing.allowPaidFallback;
  const memo = new Map<string, Account[]>();
  const accountsFor = (model: ModelInfo): Account[] => {
    let list = memo.get(model.id);
    if (!list) {
      list = runnableAccounts(s, model).filter((account) => !exclude.has(account.id));
      memo.set(model.id, list);
    }
    return list;
  };
  const structured = (model: ModelInfo) => { try { return s.engines.get(model.engine).caps.structured; } catch { return false; } };
  const inBand = (model: ModelInfo) => withinTiers(model.tier, policy.floorTier, policy.ceilingTier) && !policy.avoid.includes(model.id);
  const unusable = (model: ModelInfo): string | undefined => {
    if (!model.available || exclude.has(model.id)) return 'unavailable';
    const need = unmetNeed(model, needs, structured(model));
    if (need) return need;
    if (strengthOf(model, category) <= NEVER) return 'never';
    return undefined;
  };

  // Stage-wise filtering keeps the reason when nothing is left.
  const stages = (connected: ModelInfo[]) => {
    const capable = connected.filter((model) => !unmetNeed(model, needs, structured(model)));
    const tiered = preferTier(capable, minTier);
    const suitable = tiered.filter((model) => strengthOf(model, category) > NEVER);
    return { connected, capable, tiered, suitable, bounded: suitable.filter(inBand) };
  };
  /** The runnable entries of `bounded` with `accounts`, paid keys as the spill-over. */
  const entriesOf = (bounded: ModelInfo[], accounts: (model: ModelInfo) => Account[]) => {
    const kept = spillOver(bounded.map((model) => ({ model, accounts: accounts(model) })).filter((entry) => entry.accounts.length > 0), allowPaid);
    return { entries: newestOnly(kept.entries), unpaidOnly: kept.unpaidOnly };
  };
  const { connected, capable, tiered, suitable, bounded } = stages(input.models.filter((model) => model.available && !exclude.has(model.id)));
  const { entries, unpaidOnly } = entriesOf(bounded, accountsFor);
  const whole = () => entriesOf(stages(input.models.filter((model) => model.available)).bounded, (model) => s.accounts.list()
    .filter((account) => account.provider === model.provider && account.enabled && (!model.accounts.length || model.accounts.includes(account.id)))).entries;
  const runs = (model: ModelInfo): PoolEntry | undefined => {
    if (unusable(model) || !inBand(model)) return undefined;
    const accounts = accountsFor(model).filter((account) => !unpaidOnly || !isPaid(account));
    return accounts.length ? { model, accounts } : undefined;
  };
  const entryFor = (model: ModelInfo): PoolEntry | undefined => {
    const own = entries.find((entry) => entry.model.id === model.id);
    if (own) return own;
    const named = familyOf(model.model);
    const newer = entries.filter((entry) => {
      const { family, version } = familyOf(entry.model.model);
      return family === named.family && compareVersions(version, named.version) > 0;
    });
    return newer.find((entry) => entry.model.provider === model.provider) ?? newer[0];
  };
  return { connected, capable, tiered, suitable, bounded, entries, whole, entryFor, accountsFor, runs, unusable, inBand };
}

/**
 * The mode's minimum tier as a preference, never a refusal: the models at or above it while a connected one is among them,
 * else all of them (models.list follows the same rule, model-list.ts).
 */
export function preferTier<T extends Pick<ModelInfo, 'tier' | 'available'>>(models: readonly T[], minTier: Tier | 'any' | undefined): T[] {
  const atTier = models.filter((model) => !minTier || tierRank(model.tier) >= tierRank(minTier));
  return atTier.some((model) => model.available) ? atTier : [...models];
}

/** The entries without a model whose family has a newer version among them (models/family.ts reads both from the id). */
export function newestOnly<T extends { model: ModelInfo }>(entries: readonly T[]): T[] {
  const top = new Map<string, number[]>();
  for (const { model } of entries) {
    const { family, version } = familyOf(model.model);
    const best = top.get(family);
    if (!best || compareVersions(version, best) > 0) top.set(family, version);
  }
  return entries.filter(({ model }) => {
    const { family, version } = familyOf(model.model);
    return compareVersions(version, top.get(family)!) === 0;
  });
}
