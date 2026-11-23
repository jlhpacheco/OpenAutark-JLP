// Routing limits shared by router.ts and model-list.ts (moved out of router.ts unchanged, RT4):
// the error that says why no model fits a turn (no model, a missing capability, "never" priors, the policy band,
// or every account limited – with the earliest moment one is back; D8 (B-080): "paused" while they only cool for a few
// minutes after a provider error), and D1 (B-083): why a model I named – or the one my live session is on (cannotRun,
// 17.11.2026) – cannot run now: the lead of my route's reason.
// F28/F02 (16.11.2026): when every fitting account is out, the reason names the accounts – which is used up or paused
// until when, which is signed out, failing or switched off ("Codex used up until 18 Nov 08:26 · Claude Code, Claude Code 2,
// Claude Code 3 switched off"); the fixed sentence read as wrong while plans with quota left were switched off.
// Owns: these texts and when a model's accounts are back (backAt). Never: routes, or changes state.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { engineFor } from '../accounts/candidates.ts';
import { holdOf } from '../accounts/plan-hold.ts';
import { LIMIT_COOLDOWN_MS } from '../accounts/failure.ts';
import { profileZone, stampText } from '../context/time.ts';
import { categoryLabel } from './categories.ts';
import { pinProblem } from './pins.ts';
import type { Pool } from './pool.ts';
import type { Need } from './score.ts';

export const NO_MODEL_MESSAGE = 'No model is connected. Add an account in Settings → Models.';
/** Models fit, but every account that could run them is limited: an outage (B-059: a chat-free run waits for it, tasks/outages.ts). */
export const LIMITED_MESSAGE = 'Every account that can run a suitable model is limited right now.';
/** D8 (B-080): every fitting account only cools for a few minutes after a provider error – no used-up window. */
export const PAUSED_MESSAGE = 'Every account that can run a suitable model is paused for a few minutes after a provider error.';
const NEED_TEXT: Record<Need, string> = {
  vision: 'No connected model can read images.',
  computerUse: 'No connected model supports computer use.',
  structured: 'No connected model supports structured answers.',
};

/**
 * When the models' accounts are back: the earliest blockedUntil (cooling or a used-up window) of the enabled ones – every
 * signed-in plan takes turns since 09.11.2026 (accounts/candidates.ts selectCandidates); `limited` = the account back first
 * waits for a used-up window, not only a cooling.
 */
export function backAt(s: Pick<RuntimeServices, 'accounts'>, models: readonly ModelInfo[], now: number): { until?: number; limited: boolean } {
  let accounts: Account[] = [];
  try { accounts = s.accounts.list().filter((account) => account.enabled); } catch { /* accounts that cannot be read: no time known */ }
  const byId = new Map(accounts.map((account) => [account.id, account]));
  let until: number | undefined;
  let limited = false;
  for (const model of models) {
    for (const id of model.accounts) {
      const account = byId.get(id);
      if (!account) continue;
      const hold = holdOf(account, now, model.model);
      if (!hold || (until !== undefined && hold.until >= until)) continue;
      ({ until, limited } = hold);
    }
  }
  return { ...(until !== undefined ? { until } : {}), limited };
}

/** D8: only a short cooling after a provider error – "a few minutes" stays true (a 402 cools 6 h and reads "limited"). */
export function pausedOnly(back: { until?: number; limited: boolean }, now: number): boolean {
  return !back.limited && back.until !== undefined && back.until - now <= LIMIT_COOLDOWN_MS;
}

/** The first filter stage that left nothing, as the error the turn reports. */
export function nothingFits(input: {
  s: RuntimeServices; request: RouteRequest; connected: ModelInfo[]; capable: ModelInfo[]; suitable: ModelInfo[];
  bounded: ModelInfo[]; category: string; now: number;
}): WorkforceError {
  const { request, connected, capable, suitable, bounded } = input;
  if (!connected.length) return new WorkforceError('unavailable', request.exclude?.length ? 'No other model is available right now.' : NO_MODEL_MESSAGE);
  if (!capable.length) {
    const need = (['vision', 'computerUse', 'structured'] as Need[]).find((item) => request.needs?.[item]) ?? 'vision';
    return new WorkforceError('unavailable', NEED_TEXT[need], { details: { need, setup: true } });
  }
  // setup: true – the person (or the manager) has to change the setup; no outage that heals itself.
  if (!suitable.length) return new WorkforceError('unavailable', `No connected model is suitable for ${categoryLabel(input.category)}.`, { details: { setup: true } });
  if (!bounded.length) return new WorkforceError('unavailable', `No connected model fits the model policy of ${request.agent.name}.`, { details: { setup: true } });
  // Models fit, but every account that could run them is limited, excluded or unhealthy right now:
  // the earliest moment one of them is back (cooling or a used-up window of that model).
  const back = backAt(input.s, bounded, input.now);
  const reason = accountsReason(input.s, bounded, input.now) ?? (pausedOnly(back, input.now) ? PAUSED_MESSAGE : LIMITED_MESSAGE);
  return new WorkforceError('unavailable', reason, back.until ? { retryAfterMs: back.until - input.now } : {});
}

/** F28: names shown per group of the reason; the rest as "+N" (old keys nobody uses stay out of the way). */
const MAX_NAMES = 3;
/** F28: groups in the reason; accounts in further groups count as "+N more". */
const MAX_GROUPS = 4;
const STATE_GROUPS = ['signed out', 'failing', 'switched off'] as const;

/**
 * F28/F02: why nothing runs, from the accounts – soonest first: the enabled accounts of the fitting `models` that wait for
 * a used-up window or a long cooling ("used up until") or a short cooling after a provider error ("paused until", D8),
 * then every account with a chat engine that is signed out, failing its check or switched off (their models are not
 * available, so they never reach `models`). An account free for one of the models (left out in this turn) explains
 * nothing. Undefined when no account explains it.
 */
export function accountsReason(s: Pick<RuntimeServices, 'accounts' | 'settings'>, models: readonly ModelInfo[], now: number): string | undefined {
  let accounts: Account[] = [];
  try { accounts = s.accounts.list(); } catch { return undefined; }
  const zone = profileZone(s);
  const timed = new Map<string, { at: number; labels: string[] }>();
  const states = new Map<string, string[]>(STATE_GROUPS.map((state) => [state, []]));
  for (const account of accounts) {
    if (!engineFor(account.provider)) continue; // media-only accounts run no turn
    const label = excerpt(account.label?.trim() || account.provider, 32);
    const state = !account.enabled || account.state === 'disabled' ? 'switched off' : account.state === 'needs_login' ? 'signed out' : account.state === 'error' ? 'failing' : undefined;
    if (state) { states.get(state)!.push(label); continue; }
    const wait = waitOf(account, models, now);
    if (!wait) continue;
    const key = `${wait.used ? 'used up' : 'paused'} until ${stampText(wait.at, zone, now)}`;
    const group = timed.get(key) ?? { at: wait.at, labels: [] };
    group.labels.push(label);
    timed.set(key, group);
  }
  const groups = [
    ...[...timed].sort((a, b) => a[1].at - b[1].at).map(([what, group]) => ({ what, labels: group.labels })),
    ...[...states].filter(([, labels]) => labels.length).map(([what, labels]) => ({ what, labels })),
  ];
  if (!groups.length) return undefined;
  const names = (labels: string[]) => `${labels.slice(0, MAX_NAMES).join(', ')}${labels.length > MAX_NAMES ? ` +${labels.length - MAX_NAMES}` : ''}`;
  const shown = groups.slice(0, MAX_GROUPS).map((group) => `${names(group.labels)} ${group.what}`);
  const more = groups.slice(MAX_GROUPS).reduce((sum, group) => sum + group.labels.length, 0);
  return [...shown, ...(more ? [`+${more} more`] : [])].join(' · ');
}

/** When `account` runs one of `models` again and whether it waits for a limit (used up) or a short cooling; undefined = it is free for one now, or runs none of them. */
function waitOf(account: Account, models: readonly ModelInfo[], now: number): { at: number; used: boolean } | undefined {
  let wait: { at: number; used: boolean } | undefined;
  for (const model of models) {
    if (model.provider !== account.provider || (model.accounts.length && !model.accounts.includes(account.id))) continue;
    const hold = holdOf(account, now, model.model);
    if (!hold) return undefined;
    if (wait && hold.until >= wait.at) continue;
    wait = { at: hold.until, used: !pausedOnly(hold, now) };
  }
  return wait;
}

/**
 * D1: "asked for <name> – <why it cannot run now>", the lead of the reason of my route when the model I named does not
 * run. No " · " inside: a route line shows the reason's first part.
 */
export function askedMiss(input: AskedInput): string {
  return `asked for ${input.named?.name ?? input.request.previous?.modelId ?? 'a model'} – ${missWhy(input)}`;
}

/**
 * 17.11.2026 (the model settles): "<name> cannot run now – <why>", the lead of the reason of a route that leaves the model
 * its live session is on – the one thing besides my own model.set with now that moves a model there. The mode's tier is a
 * wish for a new start, never a reason to leave (`settled`).
 */
export function cannotRun(input: AskedInput): string {
  return `${input.named?.name ?? 'my model'} cannot run now – ${missWhy({ ...input, settled: true })}`;
}

interface AskedInput { s: RuntimeServices; request: RouteRequest; pool: Pool; named?: ModelInfo; category: string; now: number; settled?: boolean }

function missWhy({ s, request, pool, named, category, now, settled }: AskedInput): string {
  if (!named || !named.available) return 'no account of it is connected';
  const exclude = new Set(request.exclude ?? []);
  if (exclude.has(named.id) || named.accounts.some((id) => exclude.has(id))) return 'it just failed in this turn';
  const why = pool.unusable(named) ?? (pool.inBand(named) ? undefined : 'policy');
  if (why) return pinProblem(why, category);
  if (!settled && !pool.tiered.some((model) => model.id === named.id)) return 'below the tier this mode asks for';
  if (pool.accountsFor(named).length) return 'only a pay-per-use key runs it';
  const back = backAt(s, [named], now);
  const when = back.until !== undefined ? ` (${pausedOnly(back, now) ? 'paused' : 'limited'} until ${stampText(back.until, profileZone(s), now)})` : '';
  return `no account of it can run now${when}`;
}
