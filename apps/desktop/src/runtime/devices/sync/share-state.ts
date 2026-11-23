// Umzug 21.11.2026, part 2: the plain rules for an agent's browser state between its home PCs (share-browser.ts). A
// state is Playwright's storage state plus `removed`: the cookies (name, domain, path, partition) and the sites'
// localStorage keys that were in the state this PC last had and are gone from the profile now – a sign-out –, each
// with a hash of the value it had. Putting a state in (putIn) uses no clock, only three states: `mine` (the profile
// now), `base` (what this profile held when it last shared or took a state) and the incoming one.
// - What the incoming state's `removed` names goes from the profile when its copy still has that very value.
// - A cookie or a site's storage that is unchanged here since `base` takes the incoming one; one I changed here since
//   stays (it travels with my next state). Without a `base` (the first state this PC ever takes) the incoming one wins.
// - A cookie or key I signed out of here (in base's `removed`) does not come back with the value that went.
// Removals are carried on with every later state until the cookie or key is there again, so a home PC that was off for
// several states still hears them. A site's storage is only in a state when the site was open since the profile
// started – a site missing from a state says nothing about its keys.
// Owns: these rules. Never: reads a profile, keeps or sends anything.

import { createHash } from 'node:crypto';
import type { StorageStateLike } from '../../browser/page.ts';

/** What `removed` holds: `k` a cookie's key, `o`/`n` a site and its storage key, `h` the hash of the value that went. */
export interface Removed { cookies: Array<{ k: string; h: string }>; keys: Array<{ o: string; n: string; h: string }> }
/** A state as it is kept and travels. */
export type SharedState = StorageStateLike & { removed?: Removed };

/** At most this many removals are carried on (the oldest go first). */
const MAX_REMOVED = 2000;

const hashOf = (value: unknown) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
/** A cookie is one per name, domain, path and – for a partitioned one – the top-level site it belongs to. */
const cookieKey = (cookie: Record<string, unknown>) => `${String(cookie.name)}\n${String(cookie.domain)}\n${String(cookie.path)}${cookie.partitionKey === undefined ? '' : `\n${JSON.stringify(cookie.partitionKey)}`}`;
type Item = { name?: unknown; value?: unknown };
const itemsOf = (origin: Record<string, unknown> | undefined): Item[] => (Array.isArray(origin?.localStorage) ? origin.localStorage as Item[] : []);
const siteKey = (origin: string, name: unknown) => `${origin}\n${String(name)}`;
/** What a site's localStorage holds, to compare two. */
const siteHash = (origin: Record<string, unknown> | undefined) => (origin ? hashOf(JSON.stringify(itemsOf(origin).map((item) => [String(item.name), String(item.value)]).sort())) : '');

/** A storage state whose every cookie has a name and every site an origin. */
export const isState = (value: unknown): value is SharedState => {
  const state = value as StorageStateLike | undefined;
  return Boolean(state) && Array.isArray(state!.cookies) && Array.isArray(state!.origins)
    && state!.cookies.every((cookie) => Boolean(cookie) && typeof cookie.name === 'string' && typeof cookie.value === 'string')
    && state!.origins.every((origin) => Boolean(origin) && typeof origin.origin === 'string');
};

/** The removals of a state, as far as they are well-formed. */
function removedOf(removed: Removed | undefined): Removed {
  const raw = removed as Partial<Removed> | undefined;
  return {
    cookies: (Array.isArray(raw?.cookies) ? raw.cookies : []).filter((entry) => typeof entry?.k === 'string' && typeof entry.h === 'string'),
    keys: (Array.isArray(raw?.keys) ? raw.keys : []).filter((entry) => typeof entry?.o === 'string' && typeof entry.n === 'string' && typeof entry.h === 'string'),
  };
}

/** Two lists of removals as one. */
export function joinRemoved(a: Removed | undefined, b: Removed | undefined): Removed {
  const [x, y] = [removedOf(a), removedOf(b)];
  return { cookies: [...x.cookies, ...y.cookies], keys: [...x.keys, ...y.keys] };
}

/**
 * What went from the profile since `before` (the state it last had): the removals `before` carried that are still
 * gone, plus every cookie of `before` that `now` lacks and every storage key that a site of both lacks now.
 */
export function removals(before: SharedState | undefined, now: StorageStateLike): Removed {
  const cookies = new Set(now.cookies.map(cookieKey));
  const sites = new Map(now.origins.map((origin) => [String(origin.origin), new Set(itemsOf(origin).map((item) => String(item.name)))]));
  const carried = removedOf(before?.removed);
  const goneCookies = new Map<string, string>();
  for (const entry of carried.cookies) if (!cookies.has(entry.k)) goneCookies.set(entry.k, entry.h);
  for (const cookie of before?.cookies ?? []) if (!cookies.has(cookieKey(cookie))) goneCookies.set(cookieKey(cookie), hashOf(cookie.value));
  const goneKeys = new Map<string, { o: string; n: string; h: string }>();
  for (const entry of carried.keys) if (!sites.get(entry.o)?.has(entry.n)) goneKeys.set(siteKey(entry.o, entry.n), entry);
  for (const origin of before?.origins ?? []) {
    const names = sites.get(String(origin.origin));
    if (!names) continue; // the site was not open since: nothing is known about its keys
    for (const item of itemsOf(origin)) if (!names.has(String(item.name))) goneKeys.set(siteKey(String(origin.origin), item.name), { o: String(origin.origin), n: String(item.name), h: hashOf(item.value) });
  }
  return { cookies: [...goneCookies].map(([k, h]) => ({ k, h })).slice(-MAX_REMOVED), keys: [...goneKeys.values()].slice(-MAX_REMOVED) };
}

/** `mine` without what `removed` names, where this profile's copy still has the value that went. */
export function without(mine: StorageStateLike, removed: Removed | undefined): StorageStateLike {
  const { cookies, keys } = removedOf(removed);
  if (!cookies.length && !keys.length) return mine;
  const goneCookies = new Map(cookies.map((entry) => [entry.k, entry.h]));
  const goneKeys = new Map(keys.map((entry) => [siteKey(entry.o, entry.n), entry.h]));
  return {
    cookies: mine.cookies.filter((cookie) => goneCookies.get(cookieKey(cookie)) !== hashOf(cookie.value)),
    origins: mine.origins.map((origin) => (Array.isArray(origin.localStorage)
      ? { ...origin, localStorage: itemsOf(origin).filter((item) => goneKeys.get(siteKey(String(origin.origin), item.name)) !== hashOf(item.value)) }
      : origin)),
  };
}

/** `mine` with `theirs` on top: a cookie or a site both hold is theirs, the rest of mine stays. */
export function mergeStates(mine: StorageStateLike, theirs: StorageStateLike): StorageStateLike {
  const cookies = new Map(mine.cookies.map((cookie) => [cookieKey(cookie), cookie]));
  for (const cookie of theirs.cookies) cookies.set(cookieKey(cookie), cookie);
  const origins = new Map(mine.origins.map((origin) => [String(origin.origin), origin]));
  for (const origin of theirs.origins) origins.set(String(origin.origin), origin);
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

/**
 * What the profile holds after `incoming` is put in. `base`: what this profile held when it last shared or took a state
 * (undefined: never – the incoming state goes on top). With it, only what is unchanged here since takes the incoming one.
 */
export function putIn(mine: StorageStateLike, incoming: SharedState, base?: SharedState): StorageStateLike {
  const cleaned = without(mine, incoming.removed);
  if (!base) return mergeStates(cleaned, incoming);
  const outHere = removedOf(base.removed);
  const signedOut = new Map(outHere.cookies.map((entry) => [entry.k, entry.h]));
  const keysOut = new Map(outHere.keys.map((entry) => [siteKey(entry.o, entry.n), entry.h]));
  const baseCookies = new Map(base.cookies.map((cookie) => [cookieKey(cookie), hashOf(cookie.value)]));
  const cookies = new Map(cleaned.cookies.map((cookie) => [cookieKey(cookie), cookie]));
  for (const cookie of incoming.cookies) {
    const key = cookieKey(cookie);
    const here = cookies.get(key);
    if ((here ? hashOf(here.value) : '') !== (baseCookies.get(key) ?? '')) continue; // changed here since: mine stays
    if (signedOut.get(key) === hashOf(cookie.value)) continue; // I signed out of it here
    cookies.set(key, cookie);
  }
  const baseSites = new Map(base.origins.map((origin) => [String(origin.origin), origin]));
  const origins = new Map(cleaned.origins.map((origin) => [String(origin.origin), origin]));
  for (const origin of incoming.origins) {
    const name = String(origin.origin);
    const here = origins.get(name); // absent: the site was not open here since the profile started – nothing changed here
    if (here && siteHash(here) !== siteHash(baseSites.get(name))) continue;
    origins.set(name, Array.isArray(origin.localStorage)
      ? { ...origin, localStorage: itemsOf(origin).filter((item) => keysOut.get(siteKey(name, item.name)) !== hashOf(item.value)) }
      : origin);
  }
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}
