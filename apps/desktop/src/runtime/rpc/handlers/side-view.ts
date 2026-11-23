// RPC handlers: a side-browser tab watched from another PC or from the phone (B-076; shared/model/side-view.ts).
// side.pull / side.pullPart (one state or frame at a time, large frames in parts), side.input (the person's mouse,
// wheel, key and text input; never logged or returned) and side.nav (address, back, forward, reload, the answer to the
// page's dialog). Without `device`, or with this PC's own id, they serve this PC's tabs (runtime/browser/side-view.ts);
// with another PC's id they go to that PC (21.11.2026, runtime/pane/relay.ts callPc: directly over the link, or – an employee's PC
// asking a colleague's – through the company's PC; runtime/devices/side-view.ts checks there what is shared with whom),
// the caller passed on as `via`.
// The owner and the owner's phones on a secure transport reach them, like browser.pull.
// 16.11.2026 (the owner's phone reaches every setting): side.open opens a page in a new tab of this PC's pane (global),
// shown at once (host op sideBrowser 'open', main/side-driver) – a sign-in that returns to this PC's own address (Google
// Calendar, an app's OAuth) runs there and the phone watches and touches it in its pane; 'manage' on a secure transport,
// like the pane's tabs and files. The tab names the person as its opener (HUMAN_ID). 18.11.2026 (owner: "from one device
// you decide that it opens on another device"): side.open's `device` opens it in that PC's pane (mesh side.open).
// The handlers are exported (sideHandlers) for the person variants (people/rpc-pane.ts), which check the tab first.
// Owns: param checks and the choice of PC. Never: casts, maps input or decides who may watch on the other PC.

import { HUMAN_ID } from '../../../shared/ids.ts';
import { GLOBAL_SPACE, browserUrl } from '../../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { SideBrowserResult } from '../../../shared/model/side-browser.ts';
import { SIDE_PART_BYTES, type SidePull } from '../../../shared/model/side-view.ts';
import { inputOf } from '../../browser/input-wire.ts';
import { sideCaller, sideNavOf, sidePartOf, sidePullOf, sideTab, sideViewOf } from '../../browser/side-view.ts';
import { OWNER_CALLER } from '../../browser/view-pull.ts';
import { callPc } from '../../pane/relay.ts';
import { bad, input, onlyKeys, optId, text, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

/** The owner, and a device holding 'todo' on a secure transport (a phone of the owner). */
const DEVICE = { capability: 'todo', secure: true } as const;
/** side.open: the owner, and the owner's phone holding 'manage' on a secure transport (the pane's tabs and files are its). */
const PANE = { capability: 'manage', secure: true } as const;
/** side.open's answer when this PC has no pane to open it in. */
export const PANE_MISSING = "The PC's browser pane is not available – it lives in Autark's window on the PC.";

/** Opens `url` in a new tab of this PC's global pane, shown at once; its tab id. */
export async function openInPane(services: Pick<HandlerContext['services'], 'host'>, url: string): Promise<string | undefined> {
  const host = services.host;
  if (!host.sideBrowser) throw new WorkforceError('unavailable', PANE_MISSING);
  let result: SideBrowserResult;
  try {
    result = await host.sideBrowser({ action: 'open', url, newTab: true, show: true, space: GLOBAL_SPACE, agent: { id: HUMAN_ID, name: 'You' } });
  } catch (error) {
    if (error instanceof WorkforceError && error.code === 'unavailable') throw new WorkforceError('unavailable', PANE_MISSING);
    throw error;
  }
  if (!result?.ok) throw new WorkforceError('unavailable', result?.error?.slice(0, 400) || PANE_MISSING);
  return result.tab;
}

/** A colleague's device names its person to the PC the tab runs on, which checks what is shared with them (pane/shares.ts). */
export const forOf = (ctx: HandlerContext): { for?: string } => (ctx.scope.kind === 'person' ? { for: ctx.scope.personId } : {});

/** The caller here: the owner, or the device's own id (an owner's phone or a person's device). */
const callerOf = (ctx: HandlerContext): string => (ctx.scope.kind === 'device' || ctx.scope.kind === 'person' ? ctx.scope.deviceId : OWNER_CALLER);

/** side.open's `url`: an http(s) address without credentials, normalised. */
export function openUrlOf(o: Obj): string {
  try { return new URL(browserUrl(text(o, 'url', { max: 4000 }))).href; } catch (error) {
    if (error instanceof WorkforceError) throw error;
    return bad('url', 'an http(s) address without credentials');
  }
}

/** The linked PC a call goes to; undefined = this PC (no device, or this PC's own id). */
export function remoteOf(o: Obj, ctx: Pick<HandlerContext, 'services'>): string | undefined {
  const device = optId(o, 'device');
  if (!device) return undefined;
  let self = '';
  try { self = ctx.services.devices.self().id; } catch { self = ''; }
  return device === self ? undefined : device;
}

/** A linked PC's pull reply, as far as the UI relies on it. */
function pullReply(value: unknown): SidePull {
  const reply = value as Partial<SidePull> | null;
  if (!reply || typeof reply !== 'object' || !reply.state || typeof reply.state.at !== 'number' || typeof reply.state.tab !== 'string') {
    throw new WorkforceError('unavailable', 'The other PC sent no picture of this tab.');
  }
  return reply as SidePull;
}

type SideHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

/** side.pull, side.pullPart, side.input and side.nav – this PC's tab, or (device) a linked PC's. */
export const sideHandlers: Record<'side.pull' | 'side.pullPart' | 'side.input' | 'side.nav', SideHandler> = {
  'side.pull': async (params, ctx) => {
    const { o, request } = sidePullOf(params, ['device']);
    const device = remoteOf(o, ctx);
    if (!device) return sideViewOf(ctx.services).pull(sideCaller(callerOf(ctx)), request, ctx.signal);
    const maxBytes = Math.min(request.maxBytes ?? SIDE_PART_BYTES, SIDE_PART_BYTES);
    return pullReply(await callPc(ctx.services, device, 'side.pull', { ...request, maxBytes, via: callerOf(ctx), ...forOf(ctx) }, ctx.signal));
  },
  'side.pullPart': async (params, ctx) => {
    const { o, tab, at, index } = sidePartOf(params, ['device']);
    const device = remoteOf(o, ctx);
    if (!device) return sideViewOf(ctx.services).part(sideCaller(callerOf(ctx)).caller, tab, at, index);
    const reply = await callPc(ctx.services, device, 'side.pullPart', { tab, at, index, via: callerOf(ctx), ...forOf(ctx) }, ctx.signal) as { data?: unknown } | null;
    if (typeof reply?.data !== 'string') throw new WorkforceError('not_found', 'That picture is gone. Look again.');
    return { data: reply.data };
  },
  'side.input': async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['device', 'tab', 'input']);
    const tab = sideTab(o);
    const event = inputOf(o.input);
    const device = remoteOf(o, ctx);
    if (device) await callPc(ctx.services, device, 'side.input', { tab, input: event, ...forOf(ctx) }, ctx.signal);
    else await sideViewOf(ctx.services).input(tab, event);
    return { ok: true as const };
  },
  'side.nav': async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['device', 'tab', 'url', 'action', 'dialog']);
    const tab = sideTab(o);
    const nav = sideNavOf(o);
    const device = remoteOf(o, ctx);
    if (device) await callPc(ctx.services, device, 'side.nav', { tab, ...nav, ...forOf(ctx) }, ctx.signal);
    else await sideViewOf(ctx.services).nav(tab, nav);
    return { ok: true as const };
  },
};

export function register(table: HandlerTable): void {
  for (const [method, handler] of Object.entries(sideHandlers)) table.add(method as keyof typeof sideHandlers, handler as never, DEVICE);

  table.add('side.open', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['url', 'device']);
    const url = openUrlOf(o);
    const device = remoteOf(o, ctx);
    if (device) {
      const reply = await callPc(ctx.services, device, 'side.open', { url }, ctx.signal) as { tab?: unknown } | null;
      return { ok: true as const, ...(typeof reply?.tab === 'string' ? { tab: reply.tab } : {}) };
    }
    const tab = await openInPane(ctx.services, url);
    return { ok: true as const, ...(tab ? { tab } : {}) };
  }, PANE);
}
