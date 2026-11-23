// What a person's device may call, part 5: the tabs shared with them (owner 18.11.2026: people who are not in the same
// profile share tabs when they want the other one to see them). A tab is shared by being in a chat's area – the space
// 'chat:<id>' of <data>/side-tabs.json, "shared by everyone in that chat". tabs.get returns the websites of the areas
// of the chats the person reads (access.ts chatAccess), as the owner's phone sees them ('remote' panels naming the PC
// they run on); tabs.changed reaches them in the same form (events.ts, sharedPane). side.pull / side.pullPart /
// side.input / side.nav serve only such a tab: a person looks at it and works in it like the owner's phone does (they
// are trusted colleagues); the work itself is the owner's handlers (rpc/handlers/side-view.ts sideHandlers).
// 21.11.2026 (owner: the agent gives its browser "dem jeweiligen in die Seitenleiste"): an agent's own browser it put in
// such an area (browser.show without a url – an 'agent' panel) is shared the same way: browser.pull / pullPart / input /
// navigate / takeover serve that agent's browser to the person while it lies there (rpc/handlers/browser.ts
// browserHandlers, on the PC the agent runs on); taken back, it is theirs no more.
// 21.11.2026 (pane between people, shared/model/pane.ts): a person without a PC of their own keeps their pane here in
// the space 'person:<id>' – they get it whole as their 'global' pane (every panel in it), next to their chats' areas;
// side.* and browser.* also serve a tab of this PC or an agent's browser shared with them (pane/shares.ts sharedWith).
// Owns: which tabs are a person's and these variants. Never: the owner's other spaces, their files or app panels.

import type { PaneTabs } from '../../shared/api/methods-tabs.ts';
import { GLOBAL_SPACE, chatSpace, type SideSpaces } from '../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { personSpace } from '../../shared/model/pane.ts';
import type { RuntimeServices } from '../contracts.ts';
import { paneTabs } from '../devices/sync/tabs.ts';
import { sideTab } from '../browser/side-view.ts';
import { sharedWith } from '../pane/shares.ts';
import { remoteOf, sideHandlers } from '../rpc/handlers/side-view.ts';
import { browserHandlers } from '../rpc/handlers/browser.ts';
import { browserTarget } from '../browser/input-wire.ts';
import { input } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { chatAccess } from './access.ts';
import { caller } from './rpc-base.ts';

type Services = Pick<RuntimeServices, 'db' | 'chats'>;

/** `pane` (the PC's spaces as its phone sees them) as person `personId` sees it: their own space as 'global', the websites of their chats' areas. */
export function sharedPane(s: Services, personId: string, pane: PaneTabs): PaneTabs {
  const spaces: SideSpaces = {};
  const own = pane.spaces[personSpace(personId)];
  if (own) spaces[GLOBAL_SPACE] = own;
  for (const [key, space] of Object.entries(pane.spaces)) {
    const match = /^chat:(.+)$/.exec(key);
    const chat = match ? s.chats.get(match[1]) : undefined;
    if (!chat || !chatAccess(s.db, personId, chat)) continue;
    const tabs = space.tabs.filter((tab) => tab.panel === 'remote' || tab.panel === 'agent');
    if (!tabs.length) continue;
    spaces[chatSpace(chat.id)] = { ...(space.shown !== undefined && tabs.some((tab) => tab.id === space.shown) ? { shown: space.shown } : {}), tabs };
  }
  return { device: pane.device, spaces };
}

/** Throws 'not found' unless the call's tab (on its `device`, else this PC) is in the person's pane or, here, shared with them. */
function sharedTab(params: unknown, ctx: HandlerContext): void {
  const person = caller(ctx);
  const o = input(params);
  const tab = sideTab(o);
  const pane = sharedPane(ctx.services, person.id, paneTabs(ctx.services));
  const device = remoteOf(o, ctx) ?? pane.device;
  const listed = Object.values(pane.spaces).some((space) => space.tabs.some((entry) => entry.tab === tab && entry.device === device));
  if (!listed && !(device === pane.device && sharedWith(ctx.services, tab, person.id))) {
    throw new WorkforceError('not_found', 'That tab is not shared with you.', { details: { tab } });
  }
}

/** Throws 'not found' unless the call's agent put its browser in the person's pane or shared it with them. */
function sharedAgent(params: unknown, ctx: HandlerContext): void {
  const person = caller(ctx);
  const agentId = browserTarget(params, Object.keys(input(params)).filter((key) => key !== 'agentId')).agentId;
  const pane = sharedPane(ctx.services, person.id, paneTabs(ctx.services));
  const listed = Object.values(pane.spaces).some((space) => space.tabs.some((entry) => entry.panel === 'agent' && entry.agentId === agentId));
  if (!listed && !sharedWith(ctx.services, `agent:${agentId}`, person.id)) {
    throw new WorkforceError('not_found', "That agent's browser is not shared with you.", { details: { agentId } });
  }
}

export function registerPersonPane(table: HandlerTable): void {
  table.addPerson('tabs.get', (_params, ctx) => sharedPane(ctx.services, caller(ctx).id, paneTabs(ctx.services)));
  for (const [method, handler] of Object.entries(browserHandlers)) {
    table.addPerson(method as keyof typeof browserHandlers, (async (params: unknown, ctx: HandlerContext) => {
      sharedAgent(params, ctx);
      return handler(params, ctx);
    }) as never);
  }
  for (const [method, handler] of Object.entries(sideHandlers)) {
    table.addPerson(method as keyof typeof sideHandlers, (async (params: unknown, ctx: HandlerContext) => {
      sharedTab(params, ctx);
      return handler(params, ctx);
    }) as never);
  }
}
