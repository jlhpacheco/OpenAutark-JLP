// Helper default for runtime text calls (SG, wishes 21.10. 17:55/17:57): subconscious, decision
// fallback, verification and widget fills run as the SYSTEM agent (decision/engine-runner.ts). This is
// what the Decisions use's "auto" means (shared/model/models-uses.ts): a connected Codex subscription
// (plan login, not an API key) with quota left (≥ HELPER_MIN_HEADROOM %) and a small model – the newest
// "Luna" the account lists, else the smallest it lists – at low effort; a caller may ask for more (an
// effort-only request, e.g. the LLM decision fallback's one retry at medium after an unsure answer,
// decision/llm-fallback.ts). A Decisions model chosen in
// Settings wins first (router.ts, routing/pins.ts settingsPin), then this default.
// Transport: the per-account `codex app-server` the agents use (engines/codex) – often already
// running, our own short instructions, structured output, limit pushes; no extra `codex exec`
// process per call (decision and probe numbers: concept card model-execution-providers, 23.10.).
// The pick names the model AND the accounts that may run it (`accountIds`, the qualifying plan
// logins): the router takes only those (router.ts), so a primary API-key login or a low primary
// plan never runs the default even when it lists the same model; with none left it falls through.
// B-044 (integration): this default serves SYSTEM calls only – an agent's turn,
// plain conversation included, is routed by the model choice and the work plan (router.ts).
// helperModel reads that pick without a route, else names the router's fallback (API keys only as its spill-over).
// 24.11.2026 (Konrad #390 "Der Fallback darf nicht still auf ein langsames Modell springen"; live: from 13:10 the Codex weekly window stood
// at 91 % used, "auto" fell through to Claude Haiku – 22 s median instead of 6 s – and no log said so): when SYSTEM calls of "auto"
// leave the helper default the runtime log says so once (noteHelperRoute: the reason – plan headroom, no plan – the model before and
// after, each plan's quota left, whether the subconscious waits for that lane or runs beside the turns) and once again when they are
// back. The fallback prefers a model the subconscious measured fast (its medians arrive by noteHelperTime; fastest()): under
// HELPER_FAST_MS on an account with HELPER_MIN_HEADROOM left, never a pay-per-use key the score would not take. None known fast →
// the subconscious runs beside the turns knowingly (subconscious/service.ts pace()) – it is never a turn that waits.
// Owns: these choices and the helper lane's transition note. Never: reads token or auth files; the default never takes a pay-per-use
// login, a used-up or low plan, or a model a hard filter (needs, exclusions, the helper band) keeps out.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Account, Effort, ModelInfo, RouteDecision } from '../../shared/model/providers.ts';
import { isChatModel } from '../../shared/model/models-uses.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { headroom, selectCandidates } from '../accounts/candidates.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import type { Pool } from './pool.ts';
import { PIN_TEXT, settingsPin } from './pins.ts';
import { isPaid, tierRank } from './score.ts';

/** A plan with less quota left than this (percent) is kept for agent work. */
export const HELPER_MIN_HEADROOM = 20;
/** A lane is fast under this median (ms): the subconscious lets a turn wait only for such a lane (subconscious/service.ts FAST_MS is this). */
export const HELPER_FAST_MS = 5_000;
const LUNA = /luna/i;

export interface HelperPick {
  modelId: string;
  source: 'helper';
  effort: Effort;
  /** Only these accounts may run it (plan logins with quota left). */
  accountIds: ReadonlySet<string>;
}

/** Codex plan logins that may serve helper calls now (not an API-key login, quota left). */
export function helperPlans(s: RuntimeServices): Set<string> {
  const now = s.clock.now();
  let accounts;
  try { accounts = s.accounts.candidates('codex'); } catch { return new Set(); }
  return new Set(accounts.filter((account) => account.provider === 'codex' && accountCharge(account) === 'plan'
    && (headroom(account, now) ?? 100) >= HELPER_MIN_HEADROOM).map((account) => account.id));
}

/** Smallest tier first, then the cheaper. */
const byCost = (a: ModelInfo, b: ModelInfo) => tierRank(a.tier) - tierRank(b.tier) || (a.relCost ?? 1) - (b.relCost ?? 1) || a.id.localeCompare(b.id);

/** The newest Luna, else the smallest and cheapest model. */
function smallest(models: readonly ModelInfo[]): ModelInfo | undefined {
  const luna = models.filter((model) => LUNA.test(model.model)).sort((a, b) => b.model.localeCompare(a.model, 'en', { numeric: true }));
  return luna[0] ?? [...models].sort(byCost)[0];
}

/** The helper default of a SYSTEM route, or undefined (agents, no fitting subscription). */
export function helperDefault(s: RuntimeServices, request: RouteRequest, pool: Pool, models: readonly ModelInfo[]): HelperPick | undefined {
  if (request.agent.id !== SYSTEM_ID) return undefined;
  const asked = request.previous?.explicit && request.previous.asked === 'effort' ? request.previous.effort : undefined;
  const effort: Effort = asked ?? 'low';
  const plan = planSmallModel(s, pool, models);
  return plan ? { modelId: plan.model.id, source: 'helper', effort, accountIds: plan.accountIds } : undefined;
}

/**
 * The model SYSTEM helper calls run on now, read without a route (the live line, context/setup-facts.ts): this default's
 * pick on its plan, else the smallest chat model an account can run now, pay-per-use keys only as the pool's spill-over
 * (routing/pool.ts) – close to the router's best-value pick, which can differ for a moment (quota, scores, the band).
 * `accountId`: the account it is shown on.
 */
export function helperModel(s: RuntimeServices): { model: ModelInfo; accountId?: string } | undefined {
  let models: ModelInfo[];
  try { models = s.catalog.list().filter((model) => model.available && isChatModel(model)); } catch { return undefined; }
  const plans = helperPlans(s);
  const plan = (model: ModelInfo) => (model.accounts.length ? model.accounts : [...plans]).find((id) => plans.has(id));
  const onPlan = smallest(models.filter((model) => model.provider === 'codex' && plan(model)));
  if (onPlan) return { model: onPlan, accountId: plan(onPlan) };
  let allowPaid = false;
  try { allowPaid = s.settings.get().routing.allowPaidFallback === true; } catch { /* off */ }
  const runners = (model: ModelInfo): Account[] => { // accounts.candidates, read from the list (any services stub has one)
    try {
      return selectCandidates(s.accounts.list(), model.engine, s.clock.now(), model.model).filter((account) => account.provider === model.provider
        && (!model.accounts.length || model.accounts.includes(account.id)));
    } catch { return []; }
  };
  const runnable = models.map((model) => ({ model, accounts: runners(model) })).filter((entry) => entry.accounts.length);
  const free = runnable.map((entry) => ({ model: entry.model, accounts: entry.accounts.filter((account) => !isPaid(account)) })).filter((entry) => entry.accounts.length);
  const pick = (allowPaid || !free.length ? runnable : free).sort((a, b) => byCost(a.model, b.model))[0];
  return pick ? { model: pick.model, accountId: pick.accounts[0].id } : undefined;
}

// ------------------------------------------------------------------ 24.11.2026 (Konrad #390): the helper lane's switch is never silent

/** What one runtime keeps about its helper lane, per logger (a company's runtime has one): the subconscious's medians and where SYSTEM calls of "auto" run now. */
interface HelperLane {
  /** Median ms of the subconscious's recent calls, per model that answered (subconscious/service.ts took()). */
  medians: Map<string, number>;
  /** The model the helper default last ran on – the "before" of a switch. */
  last?: string;
  /** Set while "auto" runs past the helper default: the model the calls were routed to (the one the transition line named). */
  away?: string;
}
const lanes = new WeakMap<object, HelperLane>();
function laneOf(s: Pick<RuntimeServices, 'log'>): HelperLane {
  let lane = lanes.get(s.log);
  if (!lane) { lane = { medians: new Map() }; lanes.set(s.log, lane); }
  return lane;
}

/** The subconscious's measured median of the model's recent calls: where the fallback learns which model is fast. */
export function noteHelperTime(s: Pick<RuntimeServices, 'log'>, modelId: string, medianMs: number): void {
  laneOf(s).medians.set(modelId, medianMs);
}

/** The model SYSTEM calls of "auto" were routed to while they are off the helper default; undefined on the default or a Settings pin. */
export function helperAway(s: Pick<RuntimeServices, 'log'>): string | undefined {
  return laneOf(s).away;
}

/** Each Codex plan login's quota left, as the log shows it: "work 9 %, private 14 %". */
function quotaText(s: RuntimeServices): string {
  const now = s.clock.now();
  let accounts: Account[] = [];
  try { accounts = s.accounts.list().filter((account) => account.provider === 'codex' && account.enabled && accountCharge(account) === 'plan'); } catch { /* none */ }
  // A label that is an e-mail address shows masked ("s…@gmail.com"): the log goes along with feedback diagnostics.
  const name = (label: string) => label.replace(/([^\s@])[^\s@]*@/g, '$1…@');
  return accounts.map((account) => { const left = headroom(account, now); return `${name(account.label)} ${left === undefined ? '? %' : `${Math.round(left)} %`}`; }).join(', ') || 'no Codex plan login';
}

/** Why the helper default is not in use: the plan's headroom against the minimum, else what else keeps it out. */
function whyNotDefault(s: RuntimeServices): string {
  const now = s.clock.now();
  let accounts: Account[] = [];
  try { accounts = s.accounts.list().filter((account) => account.provider === 'codex' && account.enabled && accountCharge(account) === 'plan'); } catch { /* none */ }
  if (!accounts.length) return 'no Codex plan login connected';
  const best = Math.max(...accounts.map((account) => headroom(account, now) ?? 100));
  if (best < HELPER_MIN_HEADROOM) return `codex plan headroom ${Math.round(best)} % < ${HELPER_MIN_HEADROOM} %`;
  if (!helperPlans(s).size) return 'no Codex plan login can run now (signed out or cooling)';
  return 'no small Codex model usable on a plan with quota left (not listed, excluded or outside the helper band)';
}

/**
 * A SYSTEM route's decision, noted for the log: "auto" leaving the helper default writes one warning – reason, model before and
 * after, each plan's quota, and whether the subconscious waits for the new lane or runs beside the turns – and "auto" coming
 * back writes one line; every other call of either state is silent. A Settings Decisions pin is the person's choice (no line,
 * the state starts anew); a failover's route (`exclude`) is no switch. Never throws.
 */
export function noteHelperRoute(s: RuntimeServices, request: RouteRequest, decision: RouteDecision): void {
  try {
    if (request.agent.id !== SYSTEM_ID || request.exclude?.length) return;
    const lane = laneOf(s);
    const pinned = settingsPin(s.settings.get().routing, request) !== undefined;
    const onDefault = !pinned && decision.by === 'pin' && decision.reason.includes(PIN_TEXT.helper);
    if (pinned || onDefault) {
      const was = lane.away;
      if (onDefault) lane.last = decision.modelId;
      lane.away = undefined;
      if (onDefault && was !== undefined) s.log.info('helper calls are back on the helper default', { reason: 'codex plan quota is enough again', from: was, to: decision.modelId, quota: quotaText(s) });
      return;
    }
    if (lane.away === decision.modelId) return;
    const median = lane.medians.get(decision.modelId);
    const fast = median !== undefined && median < HELPER_FAST_MS;
    s.log.warn('helper calls left the helper default', {
      reason: whyNotDefault(s), from: lane.away ?? lane.last ?? 'helper default (not used since start)', to: decision.modelId, quota: quotaText(s),
      speed: median === undefined ? 'not measured yet' : `median ${(median / 1000).toFixed(1)} s`,
      subconscious: fast ? 'waits for it' : 'runs beside the turns (no model known fast)',
    });
    lane.away = decision.modelId;
  } catch { /* log only */ }
}

/**
 * The fallback's pick for a runtime call the helper default did not answer: the best-scored entry whose measured helper median is
 * under HELPER_FAST_MS on an account with HELPER_MIN_HEADROOM left (and no pay-per-use key unless the best score is one), else the
 * best score as before. `median`: the pick's measured median, if any.
 */
export function fastest<T extends { model: ModelInfo; accounts: Account[] }>(s: RuntimeServices, ranked: readonly T[]): { entry: T; median?: number } | undefined {
  const first = ranked[0];
  if (!first) return undefined;
  const lane = laneOf(s);
  const now = s.clock.now();
  const fast = ranked.find((entry) => {
    const ms = lane.medians.get(entry.model.id);
    return ms !== undefined && ms < HELPER_FAST_MS && (headroom(entry.accounts[0], now, entry.model.model) ?? 100) >= HELPER_MIN_HEADROOM
      && (!isPaid(entry.accounts[0]) || isPaid(first.accounts[0]));
  });
  const entry = fast ?? first;
  return { entry, median: lane.medians.get(entry.model.id) };
}

/** The newest Luna (else the smallest model) a Codex plan login with quota left can run inside the pool's filters and band. */
function planSmallModel(s: RuntimeServices, pool: Pool, models: readonly ModelInfo[]): { model: ModelInfo; accountIds: ReadonlySet<string> } | undefined {
  const plans = helperPlans(s);
  if (!plans.size) return undefined;
  const usable = models.filter((model) => model.provider === 'codex' && !model.functions?.length
    && !pool.unusable(model) && pool.inBand(model) && pool.accountsFor(model).some((account) => plans.has(account.id)));
  const pick = smallest(usable);
  return pick ? { model: pick, accountIds: plans } : undefined;
}
