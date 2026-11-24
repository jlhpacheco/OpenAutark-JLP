// Feedback 20031F6D (owner 21.11.2026, "die sachen würde ich gerne selber drag and drop anordnen wie ich will"): the
// order of the main destinations – the desktop rail and, in the same order, the phone tabs – is the person's own. It is
// kept in settings.preferences.navOrder (a list of destination keys; [] = the default order), so it holds across
// restarts and the person's PCs. A saved order only arranges what this version has: keys it no longer knows drop out,
// and a destination the list does not name (one a newer version brought) comes after the named ones, in its default
// place among them – no destination ever disappears through a saved order.
// Owns: the order as data (pure). Never: reads or writes settings, renders (shell/rail-order.ts, Rail.tsx).

/** The destinations of the rail and the phone tabs, in their default order (lib/vocab.ts DESTINATIONS names them). */
export type RailKey = 'tasks' | 'chats' | 'team';

export const DEFAULT_NAV_ORDER: readonly RailKey[] = ['tasks', 'chats', 'team'];

/** `keys` (this version's destinations, default order) in the `saved` order; what `saved` lacks follows in default order. */
export function orderNav<K extends string>(keys: readonly K[], saved: readonly unknown[] | null | undefined): K[] {
  const known = new Set<string>(keys);
  const named: K[] = [];
  if (Array.isArray(saved)) {
    for (const key of saved) if (typeof key === 'string' && known.has(key) && !named.includes(key as K)) named.push(key as K);
  }
  return [...named, ...keys.filter((key) => !named.includes(key))];
}

/** `dragged` dropped on `target`: it takes the target's place (the others close up); null when nothing changes. */
export function dropNav<K extends string>(order: readonly K[], dragged: K, target: K): K[] | null {
  const from = order.indexOf(dragged);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  const next = order.filter((key) => key !== dragged);
  next.splice(to, 0, dragged);
  return next;
}

/** `key` one step up (-1) or down (1); null at the end it would leave. */
export function moveNav<K extends string>(order: readonly K[], key: K, step: -1 | 1): K[] | null {
  const from = order.indexOf(key);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return null;
  return dropNav(order, key, order[to]);
}

/** The order is the default one. */
export function isDefaultNav<K extends string>(keys: readonly K[], order: readonly K[]): boolean {
  return order.length === keys.length && order.every((key, index) => key === keys[index]);
}

/** What settings.preferences.navOrder keeps for `order`: [] for the default (so a later default still applies), else the whole order. */
export function navToSave<K extends string>(keys: readonly K[], order: readonly K[]): K[] {
  return isDefaultNav(keys, order) ? [] : [...order];
}
