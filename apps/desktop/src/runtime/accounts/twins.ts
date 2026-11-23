// One login, one plan (21.11.2026, owner: "Hier werden die Accounts doppelt angezeigt"): two plan rows of one provider and one
// e-mail whose homes do not name different logins (as cli-homes.ts oneLogin – two workspaces of one e-mail stay two) are the
// same login twice. That happens when a shared plan's row reaches a PC after the person signed in there again (its login
// had not come), or when a row came before its e-mail was known (devices/sync/tables.ts takes a row of a login the PC has
// only by its e-mail). One row stays: a shared one before one kept on this PC, then the older, then the lower id – the same
// choice on every PC –, on the home that holds the newest login of them. The other rows go on this PC only (`twinOf` on
// account.removed: devices/sync/rows.ts sends no removal, so no linked PC loses its own row of that login – a row that comes
// again finds its login here and is not taken, tables.ts).
// Owns: which rows are twins and which one stays. Never: deletes a home or a login file, reads a token.

import type { Account } from '../../shared/model/providers.ts';
import { ownHomes } from './cli-homes.ts';

/** What a row's home holds: whose login (undefined: the file does not say) and the login's own time (0: none). */
export interface HomeLogin { who?: string; at: number }

export interface TwinMerge {
  keep: Account;
  /** The home the kept row runs on now (undefined: the CLI's default home); equal to keep.home when nothing moves. */
  home: string | undefined;
  drop: Account[];
}

const rank = (a: Account, b: Account) => Number(Boolean(a.thisPcOnly)) - Number(Boolean(b.thisPcOnly)) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The merges `accounts` need (none for most PCs); `held` reads what a row's home holds. */
export function twinMerges(accounts: readonly Account[], held: (account: Account) => HomeLogin): TwinMerge[] {
  const groups = new Map<string, Account[]>();
  for (const account of accounts) {
    const email = account.email?.trim().toLowerCase();
    if (account.auth !== 'cli' || !email || !ownHomes(account.provider)) continue;
    const key = `${account.provider}\n${email}`;
    groups.set(key, [...(groups.get(key) ?? []), account]);
  }
  const out: TwinMerge[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const logins = new Map(group.map((account) => [account.id, held(account)]));
    const whose = new Set(group.map((account) => logins.get(account.id)!.who).filter(Boolean));
    if (whose.size > 1) continue; // the homes name different logins: two plans of one e-mail
    const [keep, ...drop] = [...group].sort(rank);
    const newest = [...group].sort((a, b) => logins.get(b.id)!.at - logins.get(a.id)!.at)[0];
    const home = logins.get(newest.id)!.at > logins.get(keep.id)!.at ? newest.home : keep.home;
    out.push({ keep, home, drop });
  }
  return out;
}
