// Which linked PCs share a plan with this PC (owner 22.11.2026: "Pläne, wenn die für alle in der Firma aktiviert sind …
// sollen auf jedem PC verwendet werden können – für die Agenten, die da drauf laufen, und fürs Transkribieren"). A plan
// "on all PCs of this company" (Account.thisPcOnly not set) goes to every PC of the company: the CEO's own PCs and every
// employee's PC. On an employee's PC, a plan that came from its company goes back only to the company's PCs (its refreshed
// login and its readings: the CLI there rotates the token like a second process here); the person's own plans never do.
// Only a CLI plan with a login home of its own (Codex, Claude Code) reaches an employee's PC: a CLI with one sign-in per PC
// (Gemini CLI) would read the person's own login there as the company's, and an API key or an environment variable is
// no plan the person's PC could run (review 22.11.2026).
// One runtime is one seat at one company, so every 'employer' link is that company's PC (the origin a row names is the
// PC that sent it last – any of them).
// Owns: that one rule. Never: sends, reads a login or decides anything else about a link.

import type { RuntimeServices } from '../../contracts.ts';
import type { Account } from '../../../shared/model/providers.ts';
import { isPlanProvider } from '../../../shared/model/plan-roles.ts';
import { ownHomes } from '../../accounts/cli-homes.ts';
import { DevicesRepo } from '../repo.ts';
import { planFrom } from './employee.ts';
import { linkOf, links, type Link } from './home.ts';

type PlanFacts = Pick<Account, 'id' | 'provider' | 'auth' | 'thisPcOnly'>;

/** Whether a plan can be another person's PC's too: a CLI plan with a login home of its own. */
export function personPlan(account: Pick<Account, 'provider' | 'auth'>): boolean {
  return account.auth === 'cli' && isPlanProvider(account.provider) && ownHomes(account.provider);
}

/** Whether the link `link` to `peer` shares the plan `account` – a plan kept on this PC is no one's. */
export function sharesPlan(db: RuntimeServices['db'], link: Link | undefined, account: PlanFacts): boolean {
  if (!link || account.thisPcOnly) return false;
  if (link.kind === 'ceo') return true; // my own PCs
  if (!personPlan(account)) return false;
  const from = planFrom(db, account.id);
  // the company's plan goes back to the company's PCs, the person's own stays here; to an employee only this company's own
  return link.kind === 'employer' ? from !== undefined : from === undefined;
}

/** The link to `peer` when it shares `account`, else undefined. */
export function planLink(db: RuntimeServices['db'], peer: string, account: PlanFacts): Link | undefined {
  const link = linkOf(new DevicesRepo(db).get(peer));
  return sharesPlan(db, link, account) ? link : undefined;
}

/** Every linked PC (but `except`) – what a send goes to; each send filters per plan (planLink). */
export function planPeers(db: RuntimeServices['db'], except?: string): string[] {
  return links(db).filter(({ record }) => record.id !== except).map(({ record }) => record.id);
}
