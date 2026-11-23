// browser.show: an agent puts something in front of people (owner 21.11.2026: "er wählt einen User und deren PC …
// wenn er nichts angibt, auf dem einzigen PC oder dem, wo er gerade ist … und kann es mit anderen teilen"). A tab runs
// on one PC and shows in the panes of the people it is given to (shared/model/pane.ts). By default it goes into the pane
// of the person I work for (my manager when that is a person, else the CEO) on their PC (runtime/pane/targets.ts
// defaultPc) – it shows on their other PCs and phones too; `person` and `pc` say otherwise, `share` gives other people a
// view they can use as well (runtime/pane/put.ts shareOn). A web page opens on that PC with its logins; without a url it
// is my OWN browser – the live view they watch, take over and hand back (it runs where I run). `where: 'chat'` puts it
// in a chat's area instead (this chat or `chatId`: everyone in it sees it), `where: 'agent'` a page in my area on my
// agent page. `back` takes my own browser out of every pane and ends its shares.
// Owns: the tool and its texts. Never: reads the page (browser.open does) or decides who may reach a tab (shares.ts).

import type { ToolContext, ToolDef } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool, resolveChat } from '../tools/builtin/util.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { browserUrl, chatSpace, remoteTabId, type SideEntry } from '../../shared/api/workspace-browser.ts';
import { sideCall } from './side.ts';
import { sideOn } from './place.ts';
import { ownBrowser, ownTabId, removeHere, showHere } from '../pane/place.ts';
import { minePc, placeFor, putOn, removeAt, shareOn, type PaneBy } from '../pane/put.ts';
import { addShare, removeShare } from '../pane/shares.ts';
import { paneTargets } from '../pane/targets.ts';

export const BROWSER_SHOW_TOOL = 'browser.show';

const SHOW_NO_CHAT = "This run has no chat, so there is no chat area: I give it to a person (person, pc) or put a page in my area (where: 'agent').";
const OWN_ON_MY_PAGE = 'My agent page shows my own browser already; I give it to a person or put it in a chat\'s area.';

/** The address as the person's browser opens it; a bad one fails with the reason. */
export function showUrl(input: string): string {
  try { return new URL(browserUrl(input)).href; } catch (error) {
    throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'Use an HTTP or HTTPS address.', { details: { param: 'url' } });
  }
}

interface ShowArgs { url?: string; person?: string; pc?: string; share?: string[]; where?: 'chat' | 'agent'; chatId?: string; newTab?: boolean; back?: boolean }

/** The person I work for: my manager when that is a person, else the CEO. */
export function myPerson(ctx: ToolContext): string {
  let manager: string | undefined;
  try { manager = ctx.services.org.get(ctx.agent.id)?.managerId; } catch { manager = undefined; }
  return manager && isPersonId(manager) ? manager : HUMAN_ID;
}

const nameOf = (ctx: ToolContext, person: string): string => (person === HUMAN_ID ? 'the CEO' : ctx.services.people?.nameOf(person) ?? person);

/** `share` with 'all' as every person but me and those already given it. */
function sharePeople(ctx: ToolContext, share: readonly string[] | undefined, given: string): string[] {
  if (!share?.length) return [];
  const all = share.includes('all') ? paneTargets(ctx.services).map((person) => person.id) : share;
  return [...new Set(all)].filter((id) => id !== given);
}

/** Takes my own browser out of every pane here and on the PCs it was put on, and ends its shares; how many places. */
async function takeBack(ctx: ToolContext): Promise<number> {
  const key = ownTabId(ctx.agent.id);
  let places = removeHere(ctx.services.paths.data, key).length;
  for (const place of removeShare(ctx.services, key)) {
    if (place.pc !== ctx.services.devices.self().id && await removeAt(ctx.services, place, key, ctx.signal)) places++;
  }
  return places;
}

const show = defineTool<ShowArgs>({
  name: BROWSER_SHOW_TOOL,
  description: "Puts something in front of a person as a tab in their side pane: the person I work for unless I name one (person: an id from my people), on their PC (pc: one of theirs; else the one I am on or their only one) – it shows on their other PCs and phones too. A web page – a site, background, a page I am building – opens there with that PC's logins, so they see it for themselves rather than only read my description. Without url it is my own browser, live: whoever sees it watches me work and can take it over – sign in, type what I lack – and hands it back to me; back: true takes it away again. share gives other people (ids, or 'all') the same view to use. where: 'chat' puts it in a chat's area instead (this chat or chatId: everyone in that chat), where: 'agent' a page in my area on my agent page. To read or work in a page myself I use browser.open.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 4000, description: 'Leave out to show my own browser.' },
      person: { type: 'string', maxLength: 90, description: 'Whose pane (default: the person I work for).' },
      pc: { type: 'string', maxLength: 128, description: 'Which of their PCs, by id or name.' },
      share: { type: 'array', items: { type: 'string', maxLength: 90 }, maxItems: 50, description: "Other people who see and use it too, or ['all']." },
      where: { type: 'string', enum: ['chat', 'agent'], description: "chat: a chat's area instead of a person's pane; agent: my area on my agent page (pages only)." },
      chatId: { type: 'string', maxLength: 128, description: "With where: 'chat', another chat of mine." },
      newTab: { type: 'boolean', description: "In a chat's area or mine: else my preview tab, which my next page replaces." },
      back: { type: 'boolean', description: 'Takes my own browser out of every pane and ends its shares.' },
    },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => ({
    summary: args.back ? 'Take my browser back out of the side panes' : args.url ? `Show ${String(args.url).slice(0, 200)} in a side pane` : 'Show my own browser in a side pane',
    reversible: true, external: false,
  }),
  async run(args, ctx) {
    if (args.back) {
      const places = await takeBack(ctx);
      return text(places ? `Took my browser back (${places} ${places === 1 ? 'place' : 'places'}).` : 'My browser was in no side pane.');
    }
    const by: PaneBy = { id: ctx.agent.id, name: ctx.agent.name };
    if (args.where === 'chat' || args.where === 'agent') {
      const chat = args.where === 'chat' ? (args.chatId ? resolveChat(ctx, args.chatId) : ctx.conversationId) : undefined;
      if (args.where === 'chat' && !chat) throw new WorkforceError('bad_request', SHOW_NO_CHAT);
      const on = sideOn({ agent: ctx.agent, conversationId: chat }, args.where === 'agent' ? 'own' : 'chat', {});
      const place = args.where === 'agent' ? 'my area on my agent page' : chat === ctx.conversationId ? "this chat's area" : `the area of chat ${chat}`;
      if (args.url === undefined) {
        if (args.where === 'agent') throw new WorkforceError('bad_request', OWN_ON_MY_PAGE);
        showHere(ctx.services.paths.data, chatSpace(chat!), ownBrowser(ctx.agent.id));
        addShare(ctx.services, ownTabId(ctx.agent.id), [], [{ person: HUMAN_ID, pc: ctx.services.devices.self().id, space: chatSpace(chat!) }]);
        return text(`My browser is now in ${place}: everyone there watches it live and can take it over; when they hand it back I am woken in the chat of my last browser step.`);
      }
      const url = showUrl(args.url);
      const result = await sideCall(ctx, { action: 'open', url, ...(args.newTab === undefined ? {} : { newTab: args.newTab }), show: true, ...on });
      return { ...text(`Opened ${url} in ${place} (tab ${result.tab ?? ''}).`), structured: { url, tab: result.tab } };
    }
    const person = args.person ?? myPerson(ctx);
    const others = sharePeople(ctx, args.share, person);
    if (args.url === undefined) {
      const entry = ownBrowser(ctx.agent.id);
      const put = await putOn(ctx.services, { person, ...(args.pc ? { pc: args.pc } : {}), entry, mode: 'share', by }, ctx.signal);
      addShare(ctx.services, entry.id, [person], [{ person, pc: put.pc.id, space: put.space }]);
      if (others.length) await shareOn(ctx.services, { entry, add: others, by }, ctx.signal);
      const also = others.length ? ` Also shared with ${others.map((id) => nameOf(ctx, id)).join(', ')}.` : '';
      return { ...text(`My browser is now in ${nameOf(ctx, person)}'s pane on ${put.pc.name} (and their other PCs and phones): they watch it live and can take it over; when they hand it back I am woken in the chat of my last browser step.${also}`), structured: { person, pc: put.pc.id } };
    }
    const url = showUrl(args.url);
    if (others.length && !minePc(ctx.services, placeFor(ctx.services, person, args.pc, ctx.services.devices.self().id).pc.id)) {
      throw new WorkforceError('bad_request', `A page I open on ${nameOf(ctx, person)}'s PC runs there with their logins and is theirs to share; I give it to each person on their own PC instead, or share it from one of the CEO's PCs.`);
    }
    const put = await putOn(ctx.services, { person, ...(args.pc ? { pc: args.pc } : {}), entry: { id: '', url }, mode: 'open', by }, ctx.signal);
    let also = '';
    if (others.length) {
      const self = ctx.services.devices.self().id;
      const entry: SideEntry = put.pc.id === self ? { id: put.id, url } : { id: remoteTabId(put.pc.id, put.id), panel: 'remote', device: put.pc.id, tab: put.id, url };
      await shareOn(ctx.services, { entry, add: others, by }, ctx.signal);
      also = ` Also shared with ${others.map((id) => nameOf(ctx, id)).join(', ')}.`;
    }
    return { ...text(`Opened ${url} in ${nameOf(ctx, person)}'s pane on ${put.pc.name} (tab ${put.id}).${also}`), structured: { url, tab: put.id, person, pc: put.pc.id } };
  },
});

export const browserShowTools: ToolDef[] = [show];
