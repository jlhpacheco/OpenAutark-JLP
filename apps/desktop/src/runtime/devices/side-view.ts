// The person's own PCs watch each other's side-browser tabs (B-076): the mesh methods side.pull, side.pullPart,
// side.input and side.nav serve this PC's tabs (runtime/browser/side-view.ts) to a linked PC that passes on its owner's
// or its phone's pulls (`via`: the caller there – its frame gap and its own slot here). They are no open methods
// (mesh.ts). Every param is checked again here: the input is mapped onto this PC's newest frame, never taken as
// DevTools commands.
// 18.11.2026: side.open opens a page in this PC's pane for another PC of the owner's (its "Open on", its phone).
// 21.11.2026 (pane between people, shared/model/pane.ts): every linked PC of the company reaches side.pull / pullPart /
// input / nav, and each call is checked against what is shared (runtime/pane/shares.ts reach, key = the website tab id):
// the CEO's own PCs reach every tab as before, an employee's PC or the company's PC (for its CEO, or with `for` for the
// colleague whose call it passes on, pane/relay.ts) only a tab shared with that person. Such a caller's pull slot names
// its person too. side.open stays with the CEO's own PCs (pane.put shows a tab on anybody else's PC).
// Owns: these five handlers and their link check. Never: forwards a call further, or logs what is typed.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { SIDE_PART_BYTES } from '../../shared/model/side-view.ts';
import type { RuntimeServices } from '../contracts.ts';
import { inputOf } from '../browser/input-wire.ts';
import { sideCaller, sideNavOf, sidePartOf, sidePullOf, sideTab, sideViewOf } from '../browser/side-view.ts';
import { OWNER_CALLER } from '../browser/view-pull.ts';
import { reach } from '../pane/shares.ts';
import { input as paramsOf, onlyKeys, type Obj } from '../rpc/params.ts';
import { openInPane, openUrlOf } from '../rpc/handlers/side-view.ts';
import type { LinkKind } from './mesh.ts';
import type { PeerHandler } from './rpc-peer.ts';
import { isCeoPc } from './sync/home.ts';

export const SIDE_METHODS = ['side.pull', 'side.pullPart', 'side.input', 'side.nav', 'side.open'] as const;
/** Who reaches a tab's view on the mesh: every link; what each one sees is the share check's (pane/shares.ts reach). */
export const PANE_LINKS: readonly LinkKind[] = ['ceo', 'employer', 'employee'];
const VIA = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** A mesh registry that takes the link kinds a method answers. */
export type PaneMesh = { register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void };

/** Throws unless `from` is one of the CEO's own PCs linked here. */
export function ceoOnly(services: Pick<RuntimeServices, 'db'>, from: string): void {
  if (!isCeoPc(services.db, from)) throw new WorkforceError('forbidden', 'Only the owner\'s own PCs see the browser of this PC.');
}

/** The linked PC as a pull slot here: the PC alone for this PC's own person, else the PC and the person it calls for. */
export function slotOf(from: string, person: string): string {
  return person === HUMAN_ID ? from : `${from}/${person}`;
}

/** The caller on the linked PC: its owner ('owner', the default) or its phone's device id. */
function viaOf(o: Obj): string {
  if (o.via === undefined || o.via === null) return OWNER_CALLER;
  if (typeof o.via !== 'string' || !VIA.test(o.via)) throw new WorkforceError('bad_request', 'via must be a caller id.', { details: { param: 'via' } });
  return o.via;
}

/** Registers the five methods on the mesh once at startup (compose/network.ts). */
export function registerSideView(mesh: PaneMesh, services: () => RuntimeServices): void {
  mesh.register('side.pull', async (params, from, signal) => {
    const s = services();
    const { o, request } = sidePullOf(params, ['via', 'for']);
    const person = reach(s, from, request.tab, o.for);
    request.maxBytes = Math.min(request.maxBytes ?? SIDE_PART_BYTES, SIDE_PART_BYTES); // parts stay small on the link
    return sideViewOf(s).pull(sideCaller(slotOf(from, person), viaOf(o)), request, signal);
  }, PANE_LINKS);
  mesh.register('side.pullPart', async (params, from) => {
    const s = services();
    const { o, tab, at, index } = sidePartOf(params, ['via', 'for']);
    const person = reach(s, from, tab, o.for);
    return sideViewOf(s).part(sideCaller(slotOf(from, person), viaOf(o)).caller, tab, at, index);
  }, PANE_LINKS);
  mesh.register('side.input', async (params, from) => {
    const s = services();
    const o = paramsOf(params);
    onlyKeys(o, ['tab', 'input', 'for']);
    const tab = sideTab(o);
    reach(s, from, tab, o.for);
    await sideViewOf(s).input(tab, inputOf(o.input));
    return { ok: true };
  }, PANE_LINKS);
  mesh.register('side.nav', async (params, from) => {
    const s = services();
    const o = paramsOf(params);
    onlyKeys(o, ['tab', 'url', 'action', 'dialog', 'for']);
    const tab = sideTab(o);
    reach(s, from, tab, o.for);
    await sideViewOf(s).nav(tab, sideNavOf(o));
    return { ok: true };
  }, PANE_LINKS);
  mesh.register('side.open', async (params, from) => {
    const s = services();
    ceoOnly(s, from);
    const o = paramsOf(params);
    onlyKeys(o, ['url']);
    const tab = await openInPane(s, openUrlOf(o));
    return { ok: true, ...(tab ? { tab } : {}) };
  });
}
