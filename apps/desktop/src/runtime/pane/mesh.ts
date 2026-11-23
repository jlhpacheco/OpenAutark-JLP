// The pane between PCs (shared/model/pane.ts) on the mesh: pane.put (show a tab in this PC's pane), pane.remove (take it
// out again), pane.share (the CEO's own PCs ask the origin of a tab to share it) and pane.relay (the company's PC passes
// an employee's call on to a colleague's PC, relay.ts). Who may put what: my own PCs and – on an employee's PC – the
// company's PC anything; an employee's PC only what runs on that PC itself (its websites and paths as views, or a web
// address that opens here anew), never an agent's browser or a tab of another PC, and it takes out only such tabs. Every
// entry is checked here: a plain object with an id, small, and a website only by an http(s) address.
// Owns: these registrations, the entry check and who may put or remove what. Never: decides what a caller may see of a
// tab (shares.ts reach).

import { browserUrl, type SideEntry } from '../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { PeerHandler } from '../devices/rpc-peer.ts';
import { DevicesRepo } from '../devices/repo.ts';
import { linkOf } from '../devices/sync/home.ts';
import { receive, shareOn, takeBackHere, type PaneBy, type PaneServices, type ShareChange } from './put.ts';
import { RELAY_METHOD, relayHandler } from './relay.ts';

type LinkKind = 'ceo' | 'employer' | 'employee';
const EVERY: readonly LinkKind[] = ['ceo', 'employer', 'employee'];
const MAX_ENTRY = 4000;
const ID = /^[^\u0000-\u001f]{0,700}$/;
const NOT_YOURS = 'A tab of another PC or an agent\'s browser is not that PC\'s to give.';

/** A tab entry from another PC or the window: a plain small object with an id; a website's address must be http(s). */
export function entryOf(value: unknown): SideEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkforceError('bad_request', 'entry must be a tab.', { details: { param: 'entry' } });
  const entry = value as SideEntry;
  if (typeof entry.id !== 'string' || !ID.test(entry.id) || JSON.stringify(entry).length > MAX_ENTRY) throw new WorkforceError('bad_request', 'entry must be a tab.', { details: { param: 'entry' } });
  if (entry.url !== undefined) {
    try { browserUrl(String(entry.url)); } catch { throw new WorkforceError('bad_request', 'A website tab needs an http(s) address.', { details: { param: 'entry.url' } }); }
  }
  return entry;
}

export function byOf(value: unknown): PaneBy | undefined {
  const by = value as Partial<PaneBy> | null | undefined;
  return by && typeof by.id === 'string' && typeof by.name === 'string' ? { id: by.id.slice(0, 80), name: by.name.slice(0, 80) } : undefined;
}

const PEOPLE = /^(?:human|owner|per_[\w-]{1,80})$/;
export const peopleOf = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && PEOPLE.test(id)).slice(0, 200) : undefined);
export const pcsParam = (value: unknown): Record<string, string> | undefined => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : undefined);

/** A share change from params: the whole set, add or remove (each a list of people), the PCs for new people, who asks. */
export function shareChangeOf(p: Record<string, unknown>, by?: PaneBy): ShareChange {
  const people = peopleOf(p.people);
  const add = peopleOf(p.add);
  const remove = peopleOf(p.remove);
  const pcs = pcsParam(p.pcs);
  return { entry: entryOf(p.entry), ...(people ? { people } : {}), ...(add ? { add } : {}), ...(remove ? { remove } : {}), ...(pcs ? { pcs } : {}), ...(by ? { by } : {}) };
}

/** Whether an employee's PC (`from`) names only itself: a view of its own website or path, or a web address to open. */
export function namesOnly(entry: SideEntry, from: string): boolean {
  if (entry.panel === undefined) return !/^web-/.test(entry.id);
  return (entry.panel === 'remote' || entry.panel === 'file' || entry.panel === 'folder' || entry.panel === 'media') && entry.device === from;
}

/** A tab id an employee's PC (`from`) takes out: only a view of its own tab. */
const idNames = (id: string, from: string): boolean => id.startsWith(`remote:${from}:`) || id.includes(`@${from}:`);

/** Registers the four methods once at startup (compose/network.ts). */
export function registerPane(mesh: { register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void }, services: () => RuntimeServices): void {
  const s = (): PaneServices => services();
  const o = (params: unknown) => (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const employee = (from: string) => linkOf(new DevicesRepo(services().db).get(from))?.kind === 'employee';
  mesh.register('pane.put', async (params, from) => {
    const p = o(params);
    const entry = entryOf(p.entry);
    if (employee(from) && !namesOnly(entry, from)) throw new WorkforceError('forbidden', NOT_YOURS);
    const by = byOf(p.by);
    return { id: await receive(s(), { entry, ...(typeof p.space === 'string' ? { space: p.space } : {}), ...(by ? { by } : {}) }) };
  }, EVERY);
  mesh.register('pane.remove', async (params, from) => {
    const p = o(params);
    if (typeof p.id !== 'string' || !ID.test(p.id)) throw new WorkforceError('bad_request', 'id must be a tab id.');
    if (employee(from) && !idNames(p.id, from)) throw new WorkforceError('forbidden', NOT_YOURS);
    return { ok: true, from: takeBackHere(s(), p.id, typeof p.space === 'string' ? p.space : undefined) };
  }, EVERY);
  mesh.register('pane.share', async (params, _from, signal) => {
    const p = o(params);
    return { ok: true, people: await shareOn(s(), shareChangeOf(p, byOf(p.by)), signal) };
  }, ['ceo']);
  mesh.register(RELAY_METHOD, relayHandler(services), ['employee']);
}
