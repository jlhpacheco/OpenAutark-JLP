// RPC handlers: the person's live view of agents' own browsers (Team › agent, a browser to-do). browser.subscribe
// holds a watch for this connection and joins it to the topic browser:<agentId> (state and frames, owner only);
// browser.unsubscribe, or the connection closing, releases it. browser.input (the person's mouse, wheel, key and
// text input on the shown tab; typed text is never logged or returned) and browser.takeover (Take over – opens a
// closed browser at `url` – and Hand back). Phones: browser.list, browser.pull / browser.pullPart (frames are pulled,
// never pushed to a device – browser/view-pull.ts), browser.navigate, browser.input and browser.takeover are open to
// 'todo' devices on a secure transport; Show window stays with the owner. Also the named pointers' RPC
// (pointers.point / pointers.list, runtime/pointers/rpc.ts).
// 21.11.2026 (owner: "den Browser von einem Agent … anschauen … reingehen"): an agent that runs on another of the
// person's PCs has its browser there – pull, pullPart, navigate, input and takeover go to that PC
// (devices/browser-view.ts forwardBrowser, the caller passed on as `via`; pane between people: through pane/relay.ts
// callPc, and that PC checks what is shared with whom), so its view works on every PC of the person's and their
// phones; a desktop view of such an agent pulls (ui BrowserLive.tsx). The handlers are exported (browserHandlers) for the
// person variants (people/rpc-pane.ts), which check first that the agent put its browser in an area the person reads.
// Owns: param checks, the per-connection watches and topics, the choice of PC. Never: screencast, steering or input
// (browser/view.ts).

import type { Topic } from '../../../shared/api/protocol.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { browserViewOf } from '../../browser/view.ts';
import { browserTarget, inputOf, pullOf, steerOf, tabOf, takeoverOf } from '../../browser/input-wire.ts';
import { OWNER_CALLER, pullsOf } from '../../browser/view-pull.ts';
import { num } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { registerPointers } from '../../pointers/rpc.ts';
import { browserPc, forwardBrowser, pullReply, type BrowserMethod } from '../../devices/browser-view.ts';

/** Browsers one connection may watch at once. */
const MAX_WATCHES = 8;
/** What devices may call: a 'todo' device on a secure transport. */
const DEVICE = { capability: 'todo', secure: true } as const;
const MAX_AT = Number.MAX_SAFE_INTEGER;

/** Watches per connection (its abort signal is the same object for every call on it). */
const connections = new WeakMap<AbortSignal, Map<string, () => void>>();


function watchesOf(ctx: HandlerContext): Map<string, () => void> {
  let mine = connections.get(ctx.signal);
  if (!mine) {
    const created = new Map<string, () => void>();
    connections.set(ctx.signal, created);
    ctx.signal.addEventListener('abort', () => { for (const release of created.values()) release(); created.clear(); }, { once: true });
    mine = created;
  }
  return mine;
}

const topic = (agentId: string): Topic => `browser:${agentId}`;
/** The pull caller: the owner, or the device's own id (an owner's phone or a person's device). */
const callerOf = (ctx: HandlerContext): string => (ctx.scope.kind === 'device' || ctx.scope.kind === 'person' ? ctx.scope.deviceId : OWNER_CALLER);

type BrowserHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown> | unknown;

/** Sends the call to the PC the agent runs on, when that is another of the person's PCs; undefined: it runs here. */
async function elsewhere(method: BrowserMethod, agentId: string, o: Record<string, unknown>, ctx: HandlerContext): Promise<{ reply: unknown } | undefined> {
  const pc = browserPc(ctx.services, agentId);
  if (!pc) return undefined;
  return { reply: await forwardBrowser(ctx.services, pc, method, ctx.scope.kind === 'person' ? { ...o, for: ctx.scope.personId } : o, callerOf(ctx), ctx.signal) };
}

/** browser.pull, pullPart, navigate, input and takeover – the agent's browser here, or on the PC it runs on. */
export const browserHandlers: Record<BrowserMethod, BrowserHandler> = {
  // Phones and views of an agent on another PC: one state or frame at a time; a large frame in parts.
  'browser.pull': async (params, ctx) => {
    const request = pullOf(params);
    const away = await elsewhere('browser.pull', request.agentId, { ...request }, ctx);
    if (away) return pullReply(away.reply);
    return pullsOf(ctx.services).pull(callerOf(ctx), browserViewOf(ctx.services), request, ctx.signal);
  },
  'browser.pullPart': async (params, ctx) => {
    const { agentId, o } = browserTarget(params, ['at', 'index']);
    const request = { agentId, at: num(o, 'at', { min: 0, max: MAX_AT }), index: num(o, 'index', { min: 0, max: 1000 }) };
    const away = await elsewhere('browser.pullPart', agentId, request, ctx);
    if (away) {
      const data = (away.reply as { data?: unknown } | null)?.data;
      if (typeof data !== 'string') throw new WorkforceError('not_found', 'That picture is gone. Look again.');
      return { data };
    }
    return pullsOf(ctx.services).part(callerOf(ctx), request);
  },
  'browser.navigate': async (params, ctx) => {
    const { agentId, o } = browserTarget(params, ['tab', 'url', 'action', 'window']);
    if (ctx.scope.kind !== 'owner' && o.window !== undefined) throw new WorkforceError('bad_request', 'The window can only be shown on the PC.');
    const steer = steerOf(o);
    const away = await elsewhere('browser.navigate', agentId, { agentId, ...steer }, ctx);
    return away ? away.reply : browserViewOf(ctx.services).steer(agentId, steer);
  },
  'browser.input': async (params, ctx) => {
    const { agentId, o } = browserTarget(params, ['tab', 'input']);
    const tab = tabOf(o.tab);
    const event = inputOf(o.input);
    if (!(await elsewhere('browser.input', agentId, { agentId, tab, input: event }, ctx))) await browserViewOf(ctx.services).input(agentId, tab, event);
    return { ok: true as const };
  },
  'browser.takeover': async (params, ctx) => {
    const { agentId, o } = browserTarget(params, ['on', 'url', 'wake']);
    const request = takeoverOf(o);
    const away = await elsewhere('browser.takeover', agentId, { agentId, ...request }, ctx);
    return away ? away.reply : browserViewOf(ctx.services).takeover(agentId, request);
  },
};

export function register(table: HandlerTable): void {
  table.add('browser.list', (_params, ctx) => browserViewOf(ctx.services).list(), DEVICE);

  table.add('browser.subscribe', async (params, ctx) => {
    const { agentId } = browserTarget(params);
    const view = browserViewOf(ctx.services);
    const mine = watchesOf(ctx);
    if (!mine.has(agentId)) {
      if (mine.size >= MAX_WATCHES) throw new WorkforceError('conflict', 'Too many browser views on this connection.');
      mine.set(agentId, view.watch(agentId));
    }
    ctx.topics.add(topic(agentId));
    return await view.current(agentId);
  });

  table.add('browser.unsubscribe', (params, ctx) => {
    const { agentId } = browserTarget(params);
    const mine = watchesOf(ctx);
    mine.get(agentId)?.();
    mine.delete(agentId);
    ctx.topics.delete(topic(agentId));
    return { ok: true as const };
  });

  for (const [method, handler] of Object.entries(browserHandlers)) table.add(method as BrowserMethod, handler as never, DEVICE);

  registerPointers(table); // the person's named pointer
}
