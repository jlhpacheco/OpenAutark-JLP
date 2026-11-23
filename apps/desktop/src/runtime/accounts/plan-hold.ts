// B-080: what holds an account back, as a fact – "at its limit until 12 Nov 07:00" (a used-up window of its plan) or
// "cooling until 10:05" (a short pause after a provider error). Since 09.11.2026 every signed-in plan of a provider takes
// turns (accounts/candidates.ts selectCandidates), so each account names its own hold; there is no primary that holds the
// others back and no plan that stands outside.
// Read by context/setup-facts.ts (app.status, the manager's team facts); holdOf also by routing/unfit.ts (when models are back).
// Also cleanLabel – an account label without e-mail addresses (moved here from context/setup-facts.ts, which re-exports it).
// Owns: this reading and its words. Never: routing or an account.

import type { Account } from '../../shared/model/providers.ts';
import { blockedUntil } from './candidates.ts';
import { stampText } from '../context/time.ts';
import { excerpt } from '../../shared/text/chat-names.ts';

const EMAIL = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi;

/** An account label without e-mail addresses (a label is free text; the email stays private). Also context/environment.ts. */
export function cleanLabel(label: string, email?: string): string {
  let out = label;
  if (email?.trim()) out = out.split(email.trim()).join('');
  out = out.replace(EMAIL, '').replace(/\s*[·(]\s*\)?\s*$/, '').trim();
  return excerpt(out, 40) || 'unnamed';
}

/**
 * What holds a switched-on account back from `model`: "at its limit until 12 Nov 07:00" (a used-up window) or "cooling until
 * 10:05" (only a cooling after a provider error); undefined when it runs now or is switched off. `zone`: the person's time
 * zone (context/time.ts), else this PC's.
 */
export function holdState(account: Account, now: number, zone?: string, model?: string): string | undefined {
  const hold = account.enabled ? holdOf(account, now, model) : undefined;
  return hold && `${hold.limited ? 'at its limit' : 'cooling'} until ${stampText(hold.until, zone, now)}`;
}

/** What holds `account` back from `model` now: until when, and whether a used-up window does (`limited`) or only a cooling; undefined when it runs. */
export function holdOf(account: Account, now: number, model?: string): { until: number; limited: boolean } | undefined {
  const until = blockedUntil(account, now, model);
  return until === undefined ? undefined : { until, limited: blockedUntil({ ...account, coolingUntil: undefined }, now, model) !== undefined };
}
