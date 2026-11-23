// 23.11.2026 (Stanislaus, Konrad task_pkzytj9m): "Let the AI set it up" under a Claude plan's monthly API credits (Settings ›
// Models, ui/settings/ApiCredits.tsx) – the person's click becomes a to-do for the personal manager (accounts/relogin.ts
// signInAgent: else any manager, a computer-mode agent, else the first active agent), as if the person had written it to them:
// link the plan's Console organization, make a key there, store it straight into the catalog (browser.save_secret – never seen in
// plain text) and enter it as the plan's key account. Only a step only the person can do becomes their to-do.
// Owns: that to-do and its words; one open per plan. Never: a key's value, a sign-in, a purchase.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Origin } from '../../shared/model/origin.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { cleanLabel } from '../context/setup-facts.ts';
import { signInAgent } from './relogin.ts';

export const CREDITS_ORIGIN: Origin = { source: 'system', label: 'API credits' };
/** The key account's name – the same suffix the settings row looks for (ui/settings/api-credits.ts CREDITS_SUFFIX). */
export const CREDITS_SUFFIX = ' · API credits';
const MONTHLY: ReadonlySet<string> = new Set(['ultra', 'max', 'team']);

export function setupTitle(label: string): string {
  return `Set up the monthly API credits of ${label}`;
}

export function setupNotes(account: { id: string; label: string; plan?: string }): string {
  const monthly = MONTHLY.has(account.plan?.trim().toLowerCase() ?? '');
  const keyName = `${account.label}${CREDITS_SUFFIX}`;
  return [
    monthly
      ? `Please set up the monthly API credits of my Claude plan "${account.label}" in Autark, so the team goes on with them once the plan runs out.`
      : `Please give my Claude plan "${account.label}" an Anthropic API key as reserve in Autark (this plan includes no monthly API credits, so the key is billed per use).`,
    monthly
      ? 'At claude.ai › Settings › Billing › API credits, "Link organization" links a Console organization (once; a change goes through Anthropic support). In that organization at platform.claude.com › API keys, create a key named "Autark".'
      : 'At platform.claude.com › API keys, create a key named "Autark".',
    'Store the key straight from the page into the secrets catalog with browser.save_secret, so its value never appears in plain text, and sign-ins with the stored login and the 2FA code from the authenticator app on my phone.',
    `Then add it: accounts.add {provider: "anthropic", label: "${keyName}", apiKey: "secret://<its id>"}${monthly ? ', and switch on its plan credits (accounts.update {credits: true})' : ''}.`,
    'Only a step only I can do becomes a short to-do for me, with what you already tried.',
  ].join('\n');
}

/** Creates (or finds) the manager's to-do for the account's API credits; the task and its assignee's name. */
export function setupCredits(s: RuntimeServices, accountId: string): { task: TaskView; assignee: string } {
  const account = s.accounts.get(accountId);
  if (!account || account.provider !== 'claude' || account.auth !== 'cli') throw new WorkforceError('bad_request', 'Only a Claude Code plan has monthly API credits to set up.');
  const label = cleanLabel(account.label, account.email);
  const title = setupTitle(label);
  const row = s.db.get<{ id: string }>(`SELECT id FROM tasks WHERE source_label = ? AND title = ? AND status IN ('open', 'waiting')`, [CREDITS_ORIGIN.label, title]);
  const open = row ? s.tasks.get(String(row.id)) : undefined;
  const name = (task: TaskView) => (task.assigneeId ? s.org.get(task.assigneeId)?.name : undefined) ?? 'Your manager';
  if (open) return { task: open, assignee: name(open) };
  const agent = signInAgent(s);
  if (!agent) throw new WorkforceError('bad_request', 'No agent can take this on right now – paste the key yourself.');
  const task = s.tasks.create({
    origin: CREDITS_ORIGIN, title, notes: setupNotes({ id: account.id, label, plan: account.plan }),
    assigneeKind: 'agent', assigneeId: agent.id, priority: 1, createdBy: HUMAN_ID,
  });
  return { task, assignee: agent.name };
}
