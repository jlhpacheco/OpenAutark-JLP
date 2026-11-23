// Putting a tab on a PC of a person and sharing it (shared/model/pane.ts: a tab runs on its origin and shows in the
// panes of the people it is given to). putOn: the PC is the one named, else defaultPc (targets.ts); a person with no
// PC of their own gets it in 'person:<id>' on the company's PCs. 'open' makes that PC the origin where the tab can run
// anywhere (a website loads there anew, with that PC's logins); 'share' keeps the origin and gives the others a view of
// it (a website as a 'remote' panel of this PC, a path with this PC named). receive is the target PC's side: a copy
// naming that PC itself becomes its own tab again, a website address opens there (main's side browser). shareOn runs
// on the origin (a tab of another own PC goes there first) with the whole set of people: it records who sees it
// (shares.ts), puts it in the panes of those who are new and takes it out of the panes of those left out ([] ends it).
// Owns: those rules. Never: decides what a caller from another PC may reach (shares.ts reach does).

import { GLOBAL_SPACE, isSpace, pathTabId, remoteTabId, type SideEntry } from '../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { personSpace, shareKey, type PanePc } from '../../shared/model/pane.ts';
import type { RuntimeServices } from '../contracts.ts';
import { homeElsewhere, links } from '../devices/sync/home.ts';
import { removeHere, showHere } from './place.ts';
import { readSideTabs, sideTabsFile } from '../root/side-tabs.ts';
import { callPc } from './relay.ts';
import { addShare, removeShare, shareOf, type SharePlace } from './shares.ts';
import { defaultPc, pcsOf } from './targets.ts';

export type PaneServices = Pick<RuntimeServices, 'db' | 'devices' | 'paths' | 'host' | 'clock' | 'org'> & Partial<Pick<RuntimeServices, 'people'>>;
/** Who puts it there (a website opened there names them as its opener). */
export interface PaneBy { id: string; name: string }
export type PutMode = 'open' | 'share';

const PATH_PANELS: ReadonlySet<string> = new Set(['file', 'folder', 'media']);
const selfId = (s: Pick<RuntimeServices, 'devices'>): string => s.devices.self().id;

/** The PC a tab's content runs on ('' for app panels that show the same everywhere). */
export function originOf(s: PaneServices, entry: SideEntry): string {
  if (entry.panel === 'remote' || (entry.panel !== undefined && PATH_PANELS.has(entry.panel) && typeof entry.device === 'string')) return String(entry.device);
  if (entry.panel === 'agent' && typeof entry.agentId === 'string') return homeElsewhere(s, entry.agentId) ?? selfId(s);
  if (entry.panel === undefined || (PATH_PANELS.has(entry.panel) && typeof entry.path === 'string')) return selfId(s);
  return '';
}

/** `entry` (this PC's terms) as it travels to PC `target`. */
export function carry(entry: SideEntry, self: string, target: string, mode: PutMode): SideEntry {
  const url = typeof entry.url === 'string' ? entry.url : '';
  if (entry.panel === undefined) {
    if (mode === 'open' || !url) return { id: '', url };
    return { id: remoteTabId(self, entry.id), panel: 'remote', device: self, tab: entry.id, url, ...(typeof entry.title === 'string' ? { title: entry.title } : {}) };
  }
  if (entry.panel === 'remote' && mode === 'open' && entry.device !== target) return { id: '', url };
  if (PATH_PANELS.has(entry.panel) && typeof entry.path === 'string' && entry.device === undefined) {
    return { ...entry, device: self, id: pathTabId(entry.panel, entry.path, self) };
  }
  return entry;
}

/** A copy as this PC (`self`) keeps it: what names this PC is its own tab again. */
export function localForm(entry: SideEntry, self: string): SideEntry {
  if (entry.panel === 'remote' && entry.device === self && typeof entry.tab === 'string') return { id: entry.tab };
  if (entry.panel !== undefined && PATH_PANELS.has(entry.panel) && entry.device === self && typeof entry.path === 'string') {
    const { device: _device, ...rest } = entry;
    return { ...rest, id: pathTabId(entry.panel, entry.path) };
  }
  return entry;
}

/** The space here that holds tab `id`, if any. */
function spaceHolding(dataDir: string, id: string): string | undefined {
  const spaces = readSideTabs(sideTabsFile(dataDir)) ?? {};
  return Object.entries(spaces).find(([, space]) => space.tabs.some((tab) => tab.id === id))?.[0];
}

/** The target PC's side: shows `entry` in `space` here (a website address opens here); the tab id here. */
export async function receive(s: PaneServices, input: { entry: SideEntry; space?: string; by?: PaneBy }): Promise<string> {
  const space = input.space ?? GLOBAL_SPACE;
  if (!isSpace(space) || !(space === GLOBAL_SPACE || space.startsWith('person:'))) throw new WorkforceError('bad_request', 'A tab goes into a person\'s pane.');
  // A person without a PC sees this PC's own tabs as remote ones (their device pulls them), so only the own pane takes it back.
  const entry = space === GLOBAL_SPACE ? localForm(input.entry, selfId(s)) : input.entry;
  if (entry.panel === undefined && /^web-/.test(entry.id)) {
    const holding = spaceHolding(s.paths.data, entry.id); // a website lives in one space: it is shown where it is
    if (holding) { showHere(s.paths.data, holding, { id: entry.id }); return entry.id; }
  }
  if (entry.panel === undefined) {
    const url = typeof input.entry.url === 'string' ? input.entry.url : '';
    if (!url) throw new WorkforceError('not_found', 'That page is not open here any more.');
    if (!s.host.sideBrowser) throw new WorkforceError('unavailable', 'This PC has no browser pane open (it lives in Autark\'s window).');
    const result = await s.host.sideBrowser({ action: 'open', url, newTab: true, show: true, space, agent: input.by ?? { id: HUMAN_ID, name: 'You' } });
    if (!result?.ok || !result.tab) throw new WorkforceError('unavailable', result?.error?.slice(0, 400) || 'The page did not open there.');
    return result.tab;
  }
  showHere(s.paths.data, space, entry);
  return entry.id;
}

/** The PC and space a tab for `person` goes to: the PC named, else defaultPc; with no PC, 'person:<id>' on the company's PCs. */
export function placeFor(s: PaneServices, person: string, pc: string | undefined, origin: string): { pc: PanePc; space: string } {
  const pcs = pcsOf(s, person);
  if (!pcs.length) {
    const employer = links(s.db).find(({ link }) => link.kind === 'employer');
    const company = employer ? { id: employer.record.id, name: employer.record.name, online: true } : { id: selfId(s), name: 'This PC', online: true, self: true as const };
    return { pc: company, space: personSpace(person) };
  }
  const chosen = pc ? pcs.find((item) => item.id === pc || item.name.toLowerCase() === pc.toLowerCase()) : defaultPc(pcs, origin || selfId(s));
  if (!chosen) throw new WorkforceError('bad_request', `${pc} is no PC of ${person}. Their PCs: ${pcs.map((item) => `${item.name} (${item.id})`).join(', ')}.`);
  return { pc: chosen, space: GLOBAL_SPACE };
}

/** Whether PC `pc` is this one or another of my own (a page that runs there is mine to share). */
export function minePc(s: PaneServices, pc: string): boolean {
  return pc === selfId(s) || links(s.db).some(({ record, link }) => record.id === pc && link.kind === 'ceo');
}

/** Puts `entry` on `pc` of `person` (default: see placeFor) and shows it there; where it went and its id there. */
export async function putOn(s: PaneServices, input: { person?: string; pc?: string; entry: SideEntry; mode: PutMode; by?: PaneBy }, signal?: AbortSignal): Promise<{ pc: PanePc; id: string; space: string }> {
  const self = selfId(s);
  const place = placeFor(s, input.person ?? HUMAN_ID, input.pc, originOf(s, input.entry));
  const entry = carry(input.entry, self, place.pc.id, input.mode);
  const by = input.by ? { by: input.by } : {};
  const space = place.space === GLOBAL_SPACE ? {} : { space: place.space };
  if (place.pc.id === self) return { pc: place.pc, id: await receive(s, { entry, ...space, ...by }), space: place.space };
  const reply = await callPc(s, place.pc.id, 'pane.put', { entry, ...space, ...by }, signal) as { id?: unknown } | null;
  return { pc: place.pc, id: typeof reply?.id === 'string' ? reply.id : entry.id, space: place.space };
}

/** A share change: the whole set (`people`, [] ends it), or `add` / `remove`; none of them only reads who has it. */
export interface ShareChange { entry: SideEntry; people?: string[]; add?: string[]; remove?: string[]; pcs?: Record<string, string>; by?: PaneBy }

/**
 * On the tab's origin: who sees and uses `entry` after `change` (a new one on their default PC, or `pcs[person]`). Those
 * left out lose their copy; a person whose PC cannot be reached now is left out and named in the error after the others
 * got it.
 */
export async function shareOn(s: PaneServices, change: ShareChange, signal?: AbortSignal): Promise<string[]> {
  const key = shareKey(change.entry);
  if (!key) throw new WorkforceError('bad_request', 'This tab shows the same for everyone; I open it on their PC instead (Open on).');
  const origin = originOf(s, change.entry);
  if (origin && origin !== selfId(s)) {
    const reply = await callPc(s, origin, 'pane.share', { ...change, entry: localForm(change.entry, origin) }, signal) as { people?: unknown } | null;
    return Array.isArray(reply?.people) ? reply.people.filter((id): id is string => typeof id === 'string') : [];
  }
  const before = shareOf(s, key);
  const had = before?.people ?? [];
  if (change.people === undefined && change.add === undefined && change.remove === undefined) return had;
  const targets = [...new Set(change.people ?? [...had, ...(change.add ?? [])].filter((id) => !(change.remove ?? []).includes(id)))];
  const id = carry(change.entry, selfId(s), '', 'share').id;
  const leaving = had.filter((person) => !targets.includes(person));
  const gone = targets.length ? removeShare(s, key, leaving) : removeShare(s, key);
  for (const place of gone) if (place.person !== HUMAN_ID) await removeAt(s, place, id, signal); // the CEO's own pane keeps its tab
  const places: SharePlace[] = [];
  const missed: string[] = [];
  for (const person of targets.filter((target) => !had.includes(target))) {
    try {
      const put = await putOn(s, { person, ...(change.pcs?.[person] ? { pc: change.pcs[person] } : {}), entry: change.entry, mode: 'share', ...(change.by ? { by: change.by } : {}) }, signal);
      places.push({ person, pc: put.pc.id, space: put.space });
    } catch (error) {
      missed.push(`${s.people?.nameOf(person) ?? person} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const reached = targets.filter((person) => had.includes(person) || places.some((place) => place.person === person));
  const people = places.length ? addShare(s, key, reached, places).people : shareOf(s, key)?.people ?? [];
  if (missed.length) throw new WorkforceError('unavailable', `Not reached now: ${missed.join('; ')}. The others see it.`);
  return people;
}

/** Takes tab `id` out of `place`'s pane (this PC or another); a PC that is off keeps its copy until it is closed there. */
export async function removeAt(s: PaneServices, place: Pick<SharePlace, 'pc' | 'space'>, id: string, signal?: AbortSignal): Promise<boolean> {
  if (place.pc === selfId(s)) return takeBackHere(s, id, place.space).length > 0;
  try { await callPc(s, place.pc, 'pane.remove', { id, space: place.space }, signal); return true; } catch { return false; }
}

/** Takes tab `id` out of this PC's pane (`space`, else every space); the spaces it left. */
export function takeBackHere(s: Pick<RuntimeServices, 'paths'>, id: string, space?: string): string[] {
  return removeHere(s.paths.data, id, space);
}
