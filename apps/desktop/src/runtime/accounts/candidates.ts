// Pure account selection rules for one engine (and model).
// Owns: engine → provider mapping; the health filter – state, cooling and used-up limit windows
// (a window at 100 % with a future reset counts as cooling until then; model windows such as
// weekly-opus only for matching models; a plan whose owner switched on its extra usage – Account.extraUsage – is not
// held by a used-up window, only by cooling, and ranks behind every plan with quota left, like a paying key); ordering (B-083: accounts that pay per use – shared/model/charge.ts accountCharge 'paid' –
// behind plans, keys holding a plan's monthly API credits and free ones, whatever their priority; then the plan whose
// current weekly reading resets first – `weeklyReset` –, then priority, then the smallest remaining share of the windows
// that apply). Every signed-in plan of a provider takes turns (owner 09.11.2026: "Die müssen einspringen können …
// es springt das ein, was … Reset früher hat. Auch wenn zwischendurch ein 5-Stunden-Limit erreicht ist, dann, wenn es
// wieder frei ist, dann wird wieder das genommen." – no opt-in, no primary that holds the others back): a 5h limit only
// pauses a plan, a used-up week until its reset. Spill-over to other providers is the router's job
// (across plans the router compares scores). The ACP engine runs the plan CLIs Gemini CLI, Copilot CLI (PR8) and
// Kimi Code (B-044) under the same plan rule. B-058: media-only accounts (ElevenLabs, fal.ai) have no engine
// (engineFor → undefined); their catalog models carry MEDIA_ENGINE as a placeholder, and the candidates of
// that engine include their accounts, so the function resolver finds them (every caller filters by the
// model's provider, so they never serve another provider's model).
// Never: touches the DB or the clock (callers pass `now`).

import { MEDIA_ONLY_PROVIDERS, type Account, type EngineId, type LimitWindow, type ProviderId } from '../../shared/model/providers.ts';
import { extraUsageAllowed, quotaResetAt } from '../../shared/model/plan-quota.ts';
import { isUsableState } from '../../shared/model/plan-roles.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import { weeklyWindow, windowApplies, windowScope } from './limits.ts';

export const ENGINE_PROVIDERS: Record<EngineId, ProviderId[]> = {
  codex: ['codex'],
  claude: ['claude'],
  openai: ['openai'],
  anthropic: ['anthropic'],
  compatible: ['openrouter', 'google', 'xai', 'deepseek', 'groq', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'compatible'], // B-058: groq; elevenlabs/fal have no chat engine (media adapters only)
  fake: ['compatible'],
  acp: ['gemini-cli', 'copilot', 'kimi-cli'], // plan CLIs on the generic ACP engine (engines/acp/providers.ts)
};

/** B-058: the engine id the catalog models of media-only accounts carry (no turn ever runs on it for them). */
export const MEDIA_ENGINE: EngineId = 'compatible';

/** Which engine runs an account. */
export function engineFor(provider: ProviderId): EngineId | undefined {
  for (const [engine, providers] of Object.entries(ENGINE_PROVIDERS) as Array<[EngineId, ProviderId[]]>) {
    if (engine !== 'fake' && providers.includes(provider)) return engine;
  }
  return undefined;
}

export function isCooling(account: Account, now: number): boolean {
  return account.coolingUntil !== undefined && account.coolingUntil > now;
}

const usedUp = (window: LimitWindow, now: number) => window.usedPercent >= 100 && window.resetsAt !== undefined && window.resetsAt > now;

/** Current readings that limit a turn on `model` (expired readings are unknown, not 0 %). */
export function applicableWindows(account: Account, now: number, model?: string): LimitWindow[] {
  return (account.limits?.windows ?? []).filter((window) => (window.resetsAt === undefined || window.resetsAt > now) && windowApplies(window.name, model));
}

/** The account's turn on `model` runs on extra usage now: a plan allowed to, with a used-up window that applies. */
export function inOverage(account: Account, now: number, model?: string): boolean {
  return extraUsageAllowed(account) && quotaResetAt(account.limits, now, model) !== undefined;
}

/** When the account can run `model` again (cooling or a used-up window); undefined = now. */
export function blockedUntil(account: Account, now: number, model?: string): number | undefined {
  const cooling = isCooling(account, now) ? account.coolingUntil : undefined;
  const reset = extraUsageAllowed(account) ? undefined : quotaResetAt(account.limits, now, model);
  return cooling === undefined ? reset : Math.max(cooling, reset ?? cooling);
}

export function isHealthy(account: Account, now: number, model?: string): boolean {
  // 'cooling' with an expired coolingUntil is healthy again; 'unknown' = not yet checked (try it).
  return isUsableState(account) && blockedUntil(account, now, model) === undefined;
}

/** Smallest remaining percent of the windows that apply (5h, weekly, the model's own window); undefined when unknown. */
export function headroom(account: Account, now: number, model?: string): number | undefined {
  const windows = applicableWindows(account, now, model);
  return windows.length ? Math.max(0, 100 - Math.max(...windows.map((window) => window.usedPercent))) : undefined;
}

/**
 * The limit a turn on `model` just hit is the model's own (its window, e.g. weekly-opus, is used
 * up and no account-wide one is): only that model waits; the account keeps serving others.
 */
export function modelOnlyLimit(account: Account, now: number, model: string): boolean {
  const used = (account.limits?.windows ?? []).filter((window) => usedUp(window, now));
  return used.some((window) => windowScope(window.name) !== undefined && windowApplies(window.name, model))
    && !used.some((window) => windowScope(window.name) === undefined);
}

// ------------------------------------------------------------------ the plan whose week resets first

/**
 * When a plan's current weekly reading resets – its quota left by then is lost, so the plan that resets first runs first
 * (owner 09.11.2026). Infinity for keys, local runtimes and plans without a current weekly reading (never read, or the
 * reading's reset has passed and the monitor has not read the new week yet): those rank behind, by priority.
 */
export function weeklyReset(account: Account, now: number): number {
  if (accountCharge(account) !== 'plan') return Infinity; // a key paying per use or a local runtime has no week to lose
  return weeklyWindow(account.limits, now)?.resetsAt ?? Infinity;
}

export function selectCandidates(accounts: Account[], engine: EngineId, now: number, model?: string): Account[] {
  const providers = [...(ENGINE_PROVIDERS[engine] ?? []), ...(engine === MEDIA_ENGINE ? MEDIA_ONLY_PROVIDERS : [])];
  const out: Account[] = [];
  for (const provider of providers) {
    // Every enabled account that is signed in (or not checked yet) and not limited for `model` – plans included: one
    // that needs sign-in, cools or has a used-up window steps aside and is back the moment it is free again.
    out.push(...accounts.filter((a) => a.provider === provider && a.enabled && isHealthy(a, now, model)));
  }
  return out.sort((a, b) => {
    // B-083: credits and plans before paying keys; 17.11.2026: a plan running on its extra usage counts as paying (behind every plan with quota left)
    const paid = Number(accountCharge(a) === 'paid' || inOverage(a, now, model)) - Number(accountCharge(b) === 'paid' || inOverage(b, now, model));
    if (paid) return paid;
    const ra = weeklyReset(a, now); // the plan whose week resets first goes first
    const rb = weeklyReset(b, now);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ha = headroom(a, now, model) ?? 50; // unknown ranks in the middle
    const hb = headroom(b, now, model) ?? 50;
    if (ha !== hb) return hb - ha;
    if (a.state !== b.state) return a.state === 'ok' ? -1 : b.state === 'ok' ? 1 : 0;
    return a.createdAt - b.createdAt;
  });
}
