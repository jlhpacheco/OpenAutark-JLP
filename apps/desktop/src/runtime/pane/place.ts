// A tab put into a space of this PC's <data>/side-tabs.json and shown there, or taken out again (owner 21.11.2026: "in
// die Seitenleiste packen … wieder zurückholen"). Main follows the file within a second (root/side-tabs.ts), with the
// window open or closed; a linked PC of the same person gets the space through the pane sync (devices/sync/tabs.ts).
// An agent's own browser is the panel `{id: 'agent:<agentId>', panel: 'agent', agentId}` (ui BrowserLive.tsx: the live
// view with Take over / Hand back); it shows it, the browser stays the agent's.
// Owns: those two edits of the file and the agent-browser panel's entry. Never: opens a website (main does) or calls a PC.

import { isSpace, type SideEntry, type SideSpaces } from '../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { readSideTabs, sideTabsFile, writeSideTabs } from '../root/side-tabs.ts';

/** The agent-browser panel's tab id – the same one the pane gives it (ui/workspace/browser-model.ts appTabId). */
export const ownTabId = (agentId: string): string => `agent:${agentId}`;
/** An agent's own browser as a pane entry. */
export const ownBrowser = (agentId: string): SideEntry => ({ id: ownTabId(agentId), panel: 'agent', agentId });

/** `spaces` with `entry` in `space`, shown there (once; the spaces passed in stay as they are). */
export function placeEntry(spaces: SideSpaces, space: string, entry: SideEntry): SideSpaces {
  const current = spaces[space] ?? { tabs: [] };
  const tabs = current.tabs.some((item) => item.id === entry.id) ? current.tabs : [...current.tabs, entry];
  return { ...spaces, [space]: { shown: entry.id, tabs } };
}

/** `spaces` without tab `id` in `space` (every space when none is named), and the spaces it left. */
export function takeOut(spaces: SideSpaces, id: string, space?: string): { spaces: SideSpaces; from: string[] } {
  const next: SideSpaces = { ...spaces };
  const from: string[] = [];
  for (const [key, value] of Object.entries(spaces)) {
    if ((space !== undefined && key !== space) || !value.tabs.some((item) => item.id === id)) continue;
    from.push(key);
    const tabs = value.tabs.filter((item) => item.id !== id);
    if (!tabs.length) { delete next[key]; continue; }
    next[key] = { ...(value.shown && value.shown !== id ? { shown: value.shown } : {}), tabs };
  }
  return { spaces: next, from };
}

/** Reads, changes and writes side-tabs.json; a file that is no tab file is left alone. */
export function editSideTabs<T>(dataDir: string, change: (spaces: SideSpaces) => { spaces: SideSpaces; result: T }): T {
  const file = sideTabsFile(dataDir);
  const spaces = readSideTabs(file);
  if (!spaces) throw new WorkforceError('unavailable', 'side-tabs.json cannot be read right now (half written or edited by hand); I try again in a moment.');
  const { spaces: next, result } = change(spaces);
  if (next !== spaces) writeSideTabs(file, next);
  return result;
}

/** Puts `entry` into `space` here and shows it there. */
export function showHere(dataDir: string, space: string, entry: SideEntry): void {
  if (!isSpace(space)) throw new WorkforceError('bad_request', `No such place: ${space}.`);
  editSideTabs(dataDir, (spaces) => ({ spaces: placeEntry(spaces, space, entry), result: undefined }));
}

/** Takes tab `id` out of `space` here (every space when none is named); the spaces it left. */
export function removeHere(dataDir: string, id: string, space?: string): string[] {
  return editSideTabs(dataDir, (spaces) => {
    const out = takeOut(spaces, id, space);
    return { spaces: out.from.length ? out.spaces : spaces, result: out.from };
  });
}
