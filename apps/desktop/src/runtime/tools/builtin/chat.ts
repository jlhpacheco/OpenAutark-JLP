// Chat tools: agents read the WhatsApp-like channels they are members of and manage them. 13.11.2026 (owner: output
// only where addressed): there is no write tool – an agent writes into chats with <chat to="…"> blocks in its own text
// (agents/chat-out.ts); every line it receives names its chat, and its prompt lists its chats (context/chat-overview.ts).
// Owns: chat.read (B-050 round 4: a complete read of the turn's own chat counts as seen when the turn ends done –
// chat/turn-reads.ts; 13.11.2026, owner: "ein kleines Limit von wie viel Kontext und ein Limit von wie alt … dahinter nicht mehr,
// nur wenn sie praktisch genau nach Datum sucht": without a place it shows the lines of the last CHAT_DAYS before the newest,
// at most READ_CHARS; older ones by date (`from`), by seq or page), chat.search (B-050 K5: the lines of the agent's context – chat-lines.ts over context/render.ts),
// chat.list (archived chats included and marked: archive only hides a chat from the person's list, C2; the title the
// agent sees, B-050 K2); making chats (chat.create, chat.direct) is in chat-rooms.ts, changing one (members, name, lead,
// place, reply mode, archive, leaving) is chat.update in chat-update.ts (whom a call names and who may join by an agent:
// chat-joins.ts), the agent's own messages (edit, delete) in chat-messages.ts.
// Never: reads chats the agent is not a member of.

import type { ToolContext, ToolDef } from '../types.ts';
import { CHAT_ID_PROPERTY, json, text } from '../types.ts';
import { noteTurnRead, readThrough } from '../../chat/turn-reads.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { directPair, type Message } from '../../../shared/model/chat.ts';
import { authorName, clip, defineTool, internal, resolveChat, viewTitle } from './util.ts';
import { chatUpdateTools } from './chat-update.ts';
import { chatRoomTools } from './chat-rooms.ts';
import { chatMessageTools } from './chat-messages.ts';
import { hitLines, readLines } from './chat-lines.ts';
import { whole } from '../outputs.ts';
import { CHAT_DAYS } from '../../context/ledger/window.ts';

/** What one read shows at most; the rest is named with where it goes on. */
export const READ_CHARS = 12_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The seq of the first message at or after `at` (ms), undefined when none is that new – a binary search over the seqs. */
function firstFrom(ctx: ToolContext, conversationId: string, at: number): number | undefined {
  const newest = ctx.services.chats.messages(conversationId, { limit: 1 })[0];
  if (!newest || newest.createdAt < at) return undefined;
  let low = 1;
  let high = newest.seq;
  while (low < high) { // the answer is the first message with seq >= low
    const mid = Math.floor((low + high) / 2);
    const found = ctx.services.chats.messages(conversationId, { afterSeq: mid - 1, limit: 1 })[0];
    if (found && found.createdAt >= at) high = mid;
    else low = (found?.seq ?? mid) + 1;
  }
  return ctx.services.chats.messages(conversationId, { afterSeq: low - 1, limit: 1 })[0]?.seq;
}

/** The lines within READ_CHARS – the newest when reading back, the oldest when reading forward – and the note where the rest goes on. */
function within(lines: string[], forward: boolean, rest: (left: number) => string): string[] {
  const kept: string[] = [];
  let used = 0;
  const order = forward ? lines : [...lines].reverse();
  for (const line of order) {
    if (kept.length && used + line.length + 1 > READ_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  const left = lines.length - kept.length;
  const out = forward ? kept : kept.reverse();
  return left > 0 ? (forward ? [...out, rest(left)] : [rest(left), ...out]) : out;
}

const readChat = defineTool<{ chatId?: string; beforeSeq?: number; afterSeq?: number; from?: string; limit?: number; seq?: number }>({
  name: 'chat.read',
  description: `Reads a chat's messages as lines, newest last. Without arguments I get the last ${CHAT_DAYS} days, up to about ${READ_CHARS.toLocaleString('en-US')} characters.`,
  inputSchema: {
    type: 'object',
    properties: {
      chatId: CHAT_ID_PROPERTY, beforeSeq: { type: 'integer', minimum: 0, description: 'Page back from this number.' }, afterSeq: { type: 'integer', minimum: 0 },
      from: { type: 'string', minLength: 4, description: 'From this date or time on, e.g. "2026-11-10" or "2026-11-10T14:00".' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, seq: { type: 'integer', minimum: 1, description: 'One message whole.' },
    },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args, ctx) => internal('Read chat', args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const conversationId = resolveChat(ctx, args.chatId, { read: true });
    const limit = args.limit ?? 30;
    if (args.seq !== undefined) {
      const one = ctx.services.chats.messages(conversationId, { afterSeq: args.seq - 1, limit: 1 }).filter((message) => message.seq === args.seq);
      const lines = readLines(ctx, one, { full: true });
      return lines.length ? whole(text(lines.join('\n'))) : text(`No message #${args.seq} in this chat.`); // one line comes whole
    }
    let afterSeq = args.afterSeq;
    if (args.from !== undefined) {
      const at = Date.parse(args.from);
      if (Number.isNaN(at)) return text(`"${args.from}" is no date I can read – e.g. "2026-11-10" or "2026-11-10T14:00".`);
      const first = firstFrom(ctx, conversationId, at);
      if (first === undefined) return text(`No messages from ${args.from} on.`);
      afterSeq = first - 1;
    }
    let messages: Message[] = ctx.services.chats.messages(conversationId, { beforeSeq: args.beforeSeq, afterSeq, limit });
    const placed = args.beforeSeq !== undefined || afterSeq !== undefined;
    let older = '';
    if (!placed && messages.length) { // the reach: the last CHAT_DAYS before the newest line
      const reach = messages.at(-1)!.createdAt - CHAT_DAYS * DAY_MS;
      const inReach = messages.filter((message) => message.createdAt >= reach);
      if (inReach.length < messages.length) older = `(older lines before #${inReach[0]?.seq ?? messages.at(-1)!.seq} are past ${CHAT_DAYS} days: chat.read with from (a date) or beforeSeq)`;
      messages = inReach;
    }
    if (args.beforeSeq === undefined && args.from === undefined && conversationId === ctx.conversationId) {
      // B-050 round 4: what this read showed of the turn's own chat is seen when the turn ends done (no second turn for it).
      const cursor = ctx.services.chats.members(conversationId).find((member) => member.memberId === ctx.agent.id && !member.leftAt)?.readSeq ?? 0;
      noteTurnRead(ctx.services, ctx.runId, conversationId, readThrough(messages, { cursor, limit, afterSeq: args.afterSeq }));
    }
    const forward = afterSeq !== undefined && args.beforeSeq === undefined;
    const lines = within(readLines(ctx, messages), forward, (left) => (forward
      ? `(${left} more lines after these: chat.read with afterSeq = the last #seq shown)`
      : `(${left} older lines left out for space: chat.read with beforeSeq or from)`));
    const all = older && !forward ? [older, ...lines] : lines;
    return text(all.length ? all.join('\n') : 'No messages.');
  },
});

const listChats = defineTool<{ search?: string }>({
  name: 'chat.list',
  description: "Lists the chats I am in with id, title, members and open tasks. archived: off the person's list, work goes on; direct: my default 1:1; parentId: the chat above; thread: it answers one message.",
  inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Words of the title.' } }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List chats'),
  async run(args, ctx) {
    const chats = ctx.services.chats.list({ forMember: ctx.agent.id, search: args.search, includeHidden: true });
    return json(chats.slice(0, 100).map((chat) => ({
      id: chat.id, title: viewTitle(ctx, chat, chat.members), lastSeq: chat.lastSeq, openTasks: chat.openTasks,
      // B-078: the chat tree I build with chat.update parentId and chat.thread.
      ...(chat.settings.parentId ? { parentId: chat.settings.parentId } : {}), ...(chat.settings.anchorId ? { thread: true } : {}),
      // K1: "direct" only for the agent's own default 1:1 – one others' default it joined is not.
      ...(chat.archivedAt !== undefined ? { archived: true } : {}), ...(directPair(chat.settings, chat.members.filter((member) => !member.leftAt))?.includes(ctx.agent.id) ? { direct: true } : {}),
      members: chat.members.filter((member) => !member.leftAt).map((member) => (member.memberId === HUMAN_ID ? 'human' : `${authorName(ctx, member.memberId)} (${member.memberId})`)),
    })));
  },
});

const searchChats = defineTool<{ query: string; chatId?: string; limit?: number }>({
  name: 'chat.search',
  description: 'Searches the messages of all my chats; each hit comes back as its chat line.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, chatId: { type: 'string', description: 'One chat; default all of mine.' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Search chats for "${clip(args.query, 60)}"`),
  async run(args, ctx) {
    if (args.chatId) resolveChat(ctx, args.chatId, { read: true });
    const hits = ctx.services.chats.search(args.query, { conversationId: args.chatId, memberId: ctx.agent.id, limit: args.limit ?? 10 });
    if (!hits.length) return text('No matches.');
    return text(hitLines(ctx, hits).join('\n'));
  },
});

export const chatTools: ToolDef[] = [readChat, listChats, searchChats, ...chatRoomTools, ...chatUpdateTools, ...chatMessageTools];
