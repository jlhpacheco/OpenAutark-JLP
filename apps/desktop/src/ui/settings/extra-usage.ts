// Texts of the account row's two 17.11.2026 additions (Konrad task_bgykyzcx), pure so a unit test holds them: a plan's
// "When the plan is empty: use extra usage" switch (Account.extraUsage – the provider's Claude "usage credits" / ChatGPT "credits",
// billed by the provider; shared/model/charge.ts extraUsageOf says where there is none) and the offer for a plan login this PC
// found ("Found: Codex (…) – use in this company?", DetectionReport.found) – its e-mail address masked (24.11.2026, ui/lib/email-mask.ts).
// Owns: these words and which row shows what. Never: I/O, a price or a balance (no provider offers one to read).

import { extraUsageOf } from '../../shared/model/charge.ts';
import type { Account, DetectionReport, FoundLogin } from '../../shared/model/providers.ts';
import { maskEmail } from '../lib/email-mask.ts';
import { PROVIDER_NAMES } from './providers.ts';

export interface ExtraUsageView {
  /** The switch's name beside it. */
  label: string;
  /** The line under it: the cost and where to enable it at the provider – or, where there is none, why not. */
  hint: string;
  /** False: the switch stays off and says why in `hint`. */
  possible: boolean;
}

const LABELS: Partial<Record<Account['provider'], string>> = {
  claude: 'When the plan runs out: continue with paid extra usage',
  codex: 'When the plan runs out: continue with ChatGPT credits',
};

/** What a plan login's extra-usage switch shows; undefined for a row without one (an API key, a local server). */
export function extraUsageView(account: Pick<Account, 'auth' | 'provider' | 'plan' | 'extraUsage'>): ExtraUsageView | undefined {
  if (account.auth !== 'cli') return undefined;
  const label = LABELS[account.provider] ?? 'When the plan runs out: continue with paid extra usage';
  const can = extraUsageOf(account);
  if (!can.ok) return { label, hint: can.why, possible: false };
  const on = account.extraUsage === true;
  if (account.provider === 'claude') {
    return { label, possible: true, hint: on
      ? 'On: costs money once the plan is used up – billed by Claude at API rates from your usage credits. Plans with quota left run first.'
      : 'Billed by Claude at API rates ("usage credits"), up to the monthly limit you set at claude.ai › Settings › Usage – enable it there too. Off: the plan waits for its reset.' };
  }
  return { label, possible: true, hint: on
    ? 'On: costs money once the plan is used up – billed by OpenAI from your ChatGPT credits. Plans with quota left run first.'
    : 'Uses the credits of your ChatGPT account (Codex Settings › Usage › Credits), which you buy there. Off: the plan waits for its reset.' };
}

type Cli = DetectionReport['clis'][number];

/** One offered plan login: the row's name and its one quiet line; `mask`: how the screen shows its e-mail address. */
export function foundText(found: FoundLogin, cli?: Pick<Cli, 'method'>, mask: (email: string) => string = maskEmail): { label: string; hint: string } {
  const name = PROVIDER_NAMES[found.provider] ?? found.provider;
  const who = (found.email ? mask(found.email) : undefined) ?? (found.where === 'this-pc' ? (cli?.method ? `${cli.method} login` : 'signed in on this PC') : 'signed in in another company on this PC');
  if (found.declined) {
    return { label: `Not used here: ${name} (${who})`, hint: 'You chose not to use this sign-in in this company. It stays on this PC.' };
  }
  return {
    label: `Found: ${name} (${who}) – use in this company?`,
    hint: 'Not used, and not shared with this company\'s other PCs, until you say Use.',
  };
}
