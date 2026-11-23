// Plan accounts (Codex, Claude Code subscriptions): which providers are plans, when an account counts as usable, and the
// account order of Settings › Models. Every signed-in plan of a provider takes turns (runtime/accounts/candidates.ts:
// the plan whose week resets first runs first – owner 09.11.2026).
// Owns: the plan providers, the usable state and the order.
// Never: limits or cooling (the runtime's candidates decide those) and display text.

import type { Account, ProviderId } from './providers.ts';

export function isPlanProvider(provider: ProviderId): boolean {
  return provider === 'codex' || provider === 'claude';
}

/** Switched on and signed in (or not checked yet). Limits and cooling are the candidates' part. */
export function isUsableState(account: Account): boolean {
  return account.enabled && (account.state === 'ok' || account.state === 'unknown' || account.state === 'cooling');
}
