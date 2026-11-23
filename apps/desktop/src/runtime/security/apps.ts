// The apps with a window on this PC right now, for Settings › Security's computer-use list (security.apps): the computer
// service registers its window list here when it is built (computer/service.ts), so the names are the ones its helper's
// guard compares (process names, lower case, without .exe).
// Owns: that registration per runtime and the sorted, unique names. Never: starts a helper on a PC that cannot be controlled.

import { appName } from './policy.ts';

type Lister = () => Promise<ReadonlyArray<{ process: string; app?: boolean }>>;

const listers = new WeakMap<object, Lister>();

/** The computer service of `services` lists windows with `lister`. */
export function registerWindowApps(services: object, lister: Lister): void {
  listers.set(services, lister);
}

/** The apps with a window now (Autark's own left out); [] where windows cannot be listed. */
export async function windowApps(services: object): Promise<string[]> {
  const lister = listers.get(services);
  if (!lister) return [];
  let windows: ReadonlyArray<{ process: string; app?: boolean }>;
  try { windows = await lister(); } catch { return []; }
  return [...new Set(windows.filter((window) => !window.app && window.process).map((window) => appName(window.process)))].sort();
}
