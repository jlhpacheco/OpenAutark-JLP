// An agent's own browser watched from another of the person's PCs (owner 21.11.2026: "ich kann den Browser von einem
// Agent … nicht anschauen und kann nicht da reingehen"): the browser runs only on the PC the agent runs on, so a view on
// any other of the person's PCs – the agent page, a side pane tab the agent put there (browser.show), the phone of that
// PC – pulls it from there. The mesh methods browser.pull, browser.pullPart, browser.input, browser.navigate and
// browser.takeover serve this PC's agents' browsers to a linked PC passing on its owner's or its phone's calls (`via`:
// the caller there – its own frame gap and part slot here); rpc/handlers/browser.ts sends them here (forwardBrowser).
// The real window stays on its PC (no `window` here).
// 21.11.2026 (pane between people, shared/model/pane.ts): like side.* every linked PC of the company reaches them and
// each call is checked against what is shared (pane/shares.ts reach, key 'agent:<agentId>'): the CEO's own PCs reach
// every agent's browser as before, an employee's or the company's PC (its CEO, or `for` a colleague it passes on) only
// one shared with that person; such a caller's slot names the person too. forwardBrowser goes through pane/relay.ts
// callPc, so an employee's PC reaches a colleague's PC through the company's PC.
// Owns: these five handlers, their share check and the forwarding call. Never: forwards further, or logs what is typed.

import { WorkforceError } from '../../shared/errors.ts';
import { SIDE_PART_BYTES } from '../../shared/model/side-view.ts';
import { PULL_DEFAULT_BYTES, type BrowserPull } from '../../shared/model/browser.ts';
import type { RuntimeServices } from '../contracts.ts';
import { browserViewOf } from '../browser/view.ts';
import { OWNER_CALLER, pullsOf } from '../browser/view-pull.ts';
import { inputOf, pullOf, steerOf, tabOf, takeoverOf } from '../browser/input-wire.ts';
import { reach } from '../pane/shares.ts';
import { callPc } from '../pane/relay.ts';
import { input as paramsOf, onlyKeys, id, num, type Obj } from '../rpc/params.ts';
import { PANE_LINKS, slotOf, type PaneMesh } from './side-view.ts';
import { homeElsewhere } from './sync/home.ts';

export const BROWSER_METHODS = ['browser.pull', 'browser.pullPart', 'browser.input', 'browser.navigate', 'browser.takeover'] as const;
export type BrowserMethod = typeof BROWSER_METHODS[number];
const VIA = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** The caller key here: the linked PC (with the person it calls for, slotOf) and its caller there ('…/owner' keeps the owner's frame gap). */
export function forwardedCaller(from: string, o: Obj): string {
  const via = o.via === undefined || o.via === null ? OWNER_CALLER : o.via;
  if (typeof via !== 'string' || !VIA.test(via)) throw new WorkforceError('bad_request', 'via must be a caller id.', { details: { param: 'via' } });
  return `${from}/${via}`;
}

/** The PC an agent's browser runs on when that is another of the person's PCs; undefined: this one. */
export function browserPc(services: Pick<RuntimeServices, 'db' | 'org'>, agentId: string): string | undefined {
  return homeElsewhere(services, agentId);
}

/** Sends a browser.* call for an agent on PC `device` (through the company's PC when it is no link here), with the caller here as `via`; the reply as it came. */
export async function forwardBrowser(services: Pick<RuntimeServices, 'db' | 'devices'>, device: string, method: BrowserMethod, params: Obj, via: string, signal?: AbortSignal): Promise<unknown> {
  if (method === 'browser.navigate' && params.window !== undefined) throw new WorkforceError('bad_request', 'The window shows on the PC the agent runs on.');
  const sent = method === 'browser.pull' ? { ...params, maxBytes: Math.min(typeof params.maxBytes === 'number' ? params.maxBytes : PULL_DEFAULT_BYTES, SIDE_PART_BYTES) } : params;
  const given = Object.fromEntries(Object.entries(sent).filter(([, value]) => value !== undefined));
  return callPc(services, device, method, { ...given, via }, signal);
}

/** A linked PC's pull reply, as far as the view relies on it. */
export function pullReply(value: unknown): BrowserPull {
  const reply = value as Partial<BrowserPull> | null;
  if (!reply || typeof reply !== 'object' || !reply.state || typeof reply.state.at !== 'number') {
    throw new WorkforceError('unavailable', 'The other PC sent no picture of this browser.');
  }
  return reply as BrowserPull;
}

/** Registers the five methods on the mesh once at startup (compose/network.ts). */
export function registerBrowserView(mesh: PaneMesh, services: () => RuntimeServices): void {
  const checked = (params: unknown, from: string, keys: string[]) => {
    const s = services();
    const o = paramsOf(params);
    onlyKeys(o, ['agentId', 'via', 'for', ...keys]);
    const agentId = id(o, 'agentId');
    const person = reach(s, from, `agent:${agentId}`, o.for);
    return { s, o, agentId, slot: forwardedCaller(slotOf(from, person), o) };
  };
  mesh.register('browser.pull', async (params, from, signal) => {
    const { s, o, slot } = checked(params, from, ['after', 'maxBytes', 'waitMs']);
    const request = pullOf(o, ['via', 'for']);
    request.maxBytes = Math.min(request.maxBytes ?? SIDE_PART_BYTES, SIDE_PART_BYTES); // parts stay small on the link
    return pullsOf(s).pull(slot, browserViewOf(s), request, signal);
  }, PANE_LINKS);
  mesh.register('browser.pullPart', async (params, from) => {
    const { s, o, agentId, slot } = checked(params, from, ['at', 'index']);
    return pullsOf(s).part(slot, { agentId, at: num(o, 'at', { min: 0, max: Number.MAX_SAFE_INTEGER }), index: num(o, 'index', { min: 0, max: 1000 }) });
  }, PANE_LINKS);
  mesh.register('browser.input', async (params, from) => {
    const { s, o, agentId } = checked(params, from, ['tab', 'input']);
    const tab = tabOf(o.tab);
    const event = inputOf(o.input);
    await browserViewOf(s).input(agentId, tab, event);
    return { ok: true };
  }, PANE_LINKS);
  mesh.register('browser.navigate', async (params, from) => {
    const { s, o, agentId } = checked(params, from, ['tab', 'url', 'action']);
    const steer = steerOf(o);
    return browserViewOf(s).steer(agentId, steer);
  }, PANE_LINKS);
  mesh.register('browser.takeover', async (params, from) => {
    const { s, o, agentId } = checked(params, from, ['on', 'url', 'wake']);
    const request = takeoverOf(o);
    return browserViewOf(s).takeover(agentId, request);
  }, PANE_LINKS);
}
