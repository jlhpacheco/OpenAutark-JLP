// 23.11.2026 (Stanislaus, Konrad task_pkzytj9m): a Claude plan's second way past its limit, under the extra-usage switch – the
// monthly API credits Max and Ultra include (and Team; support.claude.com 17154008: a Console organization linked at claude.ai ›
// Settings › Billing › API credits, spent with that organization's API keys, refilled monthly, lost unused), else honestly an
// API key as reserve. The key becomes an Anthropic key account named "<plan> · API credits" (B-083 `credits` when the plan has
// monthly credits: used like a plan, behind every plan with quota left; else a paying key behind all plans) – the one order the
// router already keeps, no second purse.
// Owns: which plan row offers it, its words, and which key account belongs to which plan. Never: I/O, the key's value.

import type { Account } from '../../shared/model/providers.ts';

/** The key account's name: the plan's own name plus this. */
export const CREDITS_SUFFIX = ' · API credits';
/** Plans whose subscription includes monthly API credits (support.claude.com 17154008, 23.11.2026). */
const MONTHLY: ReadonlySet<string> = new Set(['ultra', 'max', 'team']);

export interface ApiCreditsView {
  /** The block's title. */
  title: string;
  /** The line under it. */
  hint: string;
  /** True: the key holds the plan's monthly credits (Account.credits), else it pays per use. */
  monthly: boolean;
}

type Plan = Pick<Account, 'provider' | 'auth' | 'plan' | 'label'>;

/** A Claude Code plan login (not one signed in with an API key, not the Free plan). */
function claudePlan(account: Plan): boolean {
  const plan = account.plan?.trim().toLowerCase();
  return account.provider === 'claude' && account.auth === 'cli' && plan !== 'api' && plan !== 'free';
}

export function creditsKeyLabel(account: Pick<Account, 'label'>): string {
  return `${account.label}${CREDITS_SUFFIX}`;
}

/** The Anthropic key account that holds this plan's credits (or reserve), if one is stored. */
export function creditsKeyOf(account: Plan, accounts: readonly Account[]): Account | undefined {
  if (!claudePlan(account)) return undefined;
  const label = creditsKeyLabel(account);
  return accounts.find((other) => other.provider === 'anthropic' && other.auth === 'api_key' && other.label === label);
}

/** What the block shows under a plan row; undefined for every row without one. */
export function apiCreditsView(account: Plan, stored: boolean): ApiCreditsView | undefined {
  if (!claudePlan(account)) return undefined;
  const monthly = MONTHLY.has(account.plan?.trim().toLowerCase() ?? '');
  if (monthly) {
    return { monthly, title: 'Monthly API credits of this plan', hint: stored
      ? 'Key stored ✓ – once the plan runs out its monthly API credits run, before any paid key; when they are used up, nothing is billed'
      : 'Your plan includes API credits every month: link a Console organization at claude.ai › Settings › Billing › API credits and paste one of its API keys here' };
  }
  return { monthly, title: 'API key as reserve', hint: stored
    ? 'Key stored ✓ – used only once every plan is used up, billed per use by Anthropic'
    : 'This plan includes no monthly API credits: a Console API key here is used only once every plan is used up, billed per use' };
}

/** The manager's to-do from "Let the AI set it up" (runtime accounts.setupCredits writes it; the words live here for the test). */
export const SETUP_LABEL = 'Let the AI set it up';
