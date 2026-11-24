// The same quota windows drive runtime eligibility and the UI's read-only limit display.
// Owns: reported quota reset times and model scopes. Never: reads the clock or changes an account.
import { accountCharge } from './charge.ts';
import type { Account, AccountLimits } from './providers.ts';

/** The model a suffixed window binds ("weekly-opus" → "opus"); undefined for account-wide windows ("5h", "weekly"). */
export function windowScope(name: string): string | undefined {
  return /^(?:weekly|\d+[dhm])-(.+)$/.exec(name)?.[1];
}

/**
 * True when a window limits turns on `model`: account-wide windows always; a model window only
 * when the model id contains its scope as whole words ("claude-opus-5-5" ↔ "opus",
 * "gpt-5.3-codex-spark" ↔ "gpt-5-3-codex-spark"). Without a model only account-wide windows bind;
 * scopes that name no model ("oauth-apps") never exclude anything.
 */
export function windowApplies(name: string, model?: string): boolean {
  const scope = windowScope(name);
  if (!scope) return true;
  if (!model) return false;
  return `-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`.includes(`-${scope}-`);
}

export function extraUsageAllowed(account: Account): boolean {
  return account.extraUsage === true && accountCharge(account) === 'plan';
}

/** Latest reset among exhausted windows that apply. Without a model, only account-wide limits count. */
export function quotaResetAt(limits: AccountLimits | undefined, now: number, model?: string): number | undefined {
  let reset: number | undefined;
  for (const reading of limits?.windows ?? []) {
    if (reading.usedPercent >= 100 && reading.resetsAt !== undefined && reading.resetsAt > now && windowApplies(reading.name, model)) {
      reset = Math.max(reset ?? 0, reading.resetsAt);
    }
  }
  return reset;
}
