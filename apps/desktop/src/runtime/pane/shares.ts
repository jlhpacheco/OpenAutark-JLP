// What this PC shares with other people (shared/model/pane.ts): per share key (a website tab 'web-…', an agent's
// browser 'agent:<id>', a path 'path:<abs>') the people who see and use it and where it was put – a person's pane on one
// PC, in one space – so ending a share takes it out of exactly their copy. Kept in kv ('pane.shares') on the tab's
// origin – the PC every call for it ends on. reach() is the one check for a call from another PC: the CEO's own PCs reach
// everything of the CEO's (one person) unless they pass on a colleague's device's call (`for`); any other caller only
// what is shared with its person – an employee's PC is that employee, the company's PC calls for the CEO ('owner' here)
// or for the colleague whose call it passes on (`for`). A path share covers what lies inside it (case folded on Windows
// and macOS only).
// Owns: the records, the caller's person and that check. Never: puts or removes tabs (put.ts), or calls another PC.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { OWNER_ALIAS } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { DevicesRepo } from '../devices/repo.ts';
import { linkOf } from '../devices/sync/home.ts';

const NS = 'pane.shares';
const PERSON = /^(?:owner|per_[\w-]{1,80})$/;
type Services = Pick<RuntimeServices, 'db' | 'clock'>;

/** Where a shared thing was put: a person's pane on one PC, in one space (the CEO's own panes too, as 'human'). */
export interface SharePlace { person: string; pc: string; space: string }
/** One shared thing: who sees it (never 'human': the CEO's own PCs reach everything) and where it was put. */
export interface ShareRecord { people: string[]; places: SharePlace[] }

export function shareOf(s: Pick<RuntimeServices, 'db'>, key: string): ShareRecord | undefined {
  return new KvRepo(s.db).get<ShareRecord>(NS, key);
}

export function allShares(s: Pick<RuntimeServices, 'db'>): Record<string, ShareRecord> {
  return Object.fromEntries(new KvRepo(s.db).list<ShareRecord>(NS).map((row) => [row.key, row.value]));
}

const samePlace = (a: SharePlace, b: SharePlace): boolean => a.person === b.person && a.pc === b.pc && a.space === b.space;

/** Adds `people` and where it went to `key`'s share; the record after. */
export function addShare(s: Services, key: string, people: readonly string[], places: readonly SharePlace[] = []): ShareRecord {
  const before = shareOf(s, key) ?? { people: [], places: [] };
  const kept = before.places.filter((place) => !places.some((other) => samePlace(place, other)));
  const record = { people: [...new Set([...before.people, ...people.filter((id) => id !== HUMAN_ID)])], places: [...kept, ...places] };
  new KvRepo(s.db).set(NS, key, record, s.clock.now());
  return record;
}

/** Ends `key`'s share for `people` (for everyone and every place when none are named); the places it leaves. */
export function removeShare(s: Services, key: string, people?: readonly string[]): SharePlace[] {
  const before = shareOf(s, key);
  if (!before) return [];
  const gone = people ? before.places.filter((place) => people.includes(place.person)) : before.places;
  const record = { people: people ? before.people.filter((id) => !people.includes(id)) : [], places: before.places.filter((place) => !gone.includes(place)) };
  const kv = new KvRepo(s.db);
  if (record.people.length || record.places.length) kv.set(NS, key, record, s.clock.now());
  else kv.delete(NS, key);
  return gone;
}

/** The person a call from linked PC `from` is for, in this PC's terms; undefined: no person (unknown or no link). */
export function callerPerson(s: Pick<RuntimeServices, 'db'>, from: string, forPerson?: unknown): string | undefined {
  const link = linkOf(new DevicesRepo(s.db).get(from));
  if (!link) return undefined;
  const named = typeof forPerson === 'string' && PERSON.test(forPerson) ? forPerson : undefined;
  if (link.kind === 'ceo') return named ?? HUMAN_ID; // my own PC passing on a colleague's device's call names them
  if (link.kind === 'employee') return link.personId;
  return named ?? OWNER_ALIAS;
}

/** A path as compared here: one separator; case folded only where the file system ignores it. */
function fold(value: string): string {
  const plain = value.replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin' ? plain.toLowerCase() : plain;
}

/** Whether `person` sees `key` here: shared with them, or (a path) inside a shared path. */
export function sharedWith(s: Pick<RuntimeServices, 'db'>, key: string, person: string): boolean {
  if (person === HUMAN_ID) return true;
  if (shareOf(s, key)?.people.includes(person)) return true;
  if (!key.startsWith('path:')) return false;
  const path = fold(key.slice(5));
  return Object.entries(allShares(s)).some(([other, record]) => {
    if (!other.startsWith('path:') || !record.people.includes(person)) return false;
    const base = fold(other.slice(5)).replace(/\/+$/, '');
    return path === base || path.startsWith(`${base}/`);
  });
}

/** Throws 'forbidden' unless the call from `from` (for `forPerson`, when one is passed on) reaches `key`. */
export function reach(s: Pick<RuntimeServices, 'db'>, from: string, key: string, forPerson?: unknown): string {
  const person = callerPerson(s, from, forPerson);
  if (!person || !sharedWith(s, key, person)) throw new WorkforceError('forbidden', 'That is not shared with you.');
  return person;
}
