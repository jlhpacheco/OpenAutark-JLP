// chat.update (20.11.2026: one tool for what eight did – add/remove members, rename, lead, parent, archive, reply mode, leave):
// an agent shapes a chat it is in. Every write goes through ChatService with the agent as `by`, so the quiet lines say who
// did it. The changes run in one order – title, add, lead, remove, parentId, replyMode, archive, leave (the lead before
// remove, so a lead hands the chat on and then takes itself out) –; a refused one stops the rest and the answer says what
// was already done. The rules per change (C2, F-28, B-050 K3/K10, B-078 D7):
//  - add: agents and people of the organisation (per_…, checked like chat/members-change.ts – active, not revoked; they
//    read from their join on), by id or name (chat-joins.ts); never "human" – the owner is reached in the agent's 1:1
//    with him or a group with him (chat.create), so an internal room never pings him – and never into a 1:1
//    (DIRECT_STAYS_TWO); colleagues only by the chat's starter and only with agents they may work with (chat-joins.ts).
//  - remove: the chat's lead or creator, or a manager in a removed agent's chain; the person only from a chat an agent
//    started (never one they own or the runtime opened for them, e.g. 'From <PC>' by SYSTEM_ID), by its lead or creator;
//    external members only by the lead. Another agent that still owns open work in the chat stays until that work is
//    handed on (its turns could not post there). Removing yourself is leaving.
//  - title: the lead or the creator – never a name the person gave (settings.namedBy, else a title given at creation by
//    the person).
//  - lead: only the current lead hands the lead to another agent member.
//  - parentId: under another chat the agent is in (one level, chat/children.ts), "" back on top.
//  - replyMode: how the agent answers group lines that @mention nobody (chat/reply-modes.ts), with one quiet line.
//  - archive: out of the person's list (C2: its agents keep working there; an important message or an @mention of the
//    person brings it back) – a room of agents only, or one the agent started where the person is the only one besides
//    agents; never a default 1:1 (K1: the one chat of its pair, the person's to hide) or a chat with colleagues or outside
//    members (they could not write there any more); one quiet line names the agent.
//  - leave: the agent goes; the chat's lines no longer reach it.
// Owns: these rules and the tool's wording. Never: changes members, name, lead or archive of app-owned chats (To-do,
// Customize), acts in a chat the agent is not a member of, or brings the person into a room.

import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { CHAT_ID_PROPERTY, failure, json, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { REPLY_MODES, type Conversation, type Member, type ReplyMode } from '../../../shared/model/chat.ts';
import type { TaskStatus } from '../../../shared/model/tasks.ts';
import { DIRECT_STAYS_TWO } from '../../chat/members-change.ts';
import { setParent } from '../../chat/children.ts';
import { replyModeOf, setReplyMode } from '../../chat/reply-modes.ts';
import { colleagueRefusal, namedMembers, scopeRefusal } from './chat-joins.ts';
import { authorName, defineTool, internal, memberIds, resolveChat } from './util.ts';

const IDS = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 30 };
const APP_CHAT = 'This chat belongs to the app: its members, name, lead and place in the list stay as they are.';
const OPEN: TaskStatus[] = ['open', 'waiting'];
const ANSWERS: Record<ReplyMode, string> = { auto: 'when the lead or a pick decides', mentions: 'only when @mentioned', all: 'to every message' };

/** D7: the person is reached where they talk with me, never by joining a room of ours. */
export const NO_OWNER_INVITE = 'The person is not added to rooms: what they should know I tell them in my 1:1 with them, and a discussion with them I open as a group with chat.create (members: ["human", …]).';

/** The person named the chat: they renamed it, or gave its title when they started it. */
export function personNamed(chat: Pick<Conversation, 'titleNamed' | 'createdBy' | 'settings'>): boolean {
  const by = chat.settings.namedBy;
  return by !== undefined ? by === HUMAN_ID : chat.titleNamed && chat.createdBy === HUMAN_ID;
}

type Args = { chatId?: string; title?: string; add?: string[]; remove?: string[]; lead?: string; parentId?: string; replyMode?: ReplyMode; archive?: boolean; leave?: boolean };
/** One change: what it did (merged into the answer), a note when nothing needed doing, or why it was refused. */
type Step = { done: Record<string, unknown> } | { note: string } | { refused: string };

const activeIds = (members: Member[]) => members.filter((member) => !member.leftAt).map((member) => member.memberId);
const nothing = (why: string): Step => ({ refused: `Nothing was changed. ${why}` });

function managerOf(ctx: ToolContext, managerId: string, agentId: string): boolean {
  try { return ctx.services.org.managers(agentId).some((agent) => agent.id === managerId); } catch { return false; }
}

/** Open tasks and steps `agentId` owns in the chat (their turns could not post there once it is out). */
function openWork(ctx: ToolContext, chatId: string, agentId: string): number {
  try {
    return ctx.services.tasks.list({ conversationId: chatId, assigneeKind: 'agent', assigneeId: agentId, status: OPEN, includeSteps: true, limit: 100 }).length;
  } catch { return 0; }
}

/** Why the caller may not remove `member`; undefined when it may. */
function removeRefusal(ctx: ToolContext, chat: Conversation, member: Member, lead: string | undefined): string | undefined {
  const me = ctx.agent.id;
  if (member.memberId === me) return undefined;
  const leadOrCreator = lead === me || chat.createdBy === me;
  if (member.kind === 'human') { // the owner or a colleague (per_…)
    const who = member.memberId === HUMAN_ID ? 'the person' : authorName(ctx, member.memberId);
    const agentStarted = chat.createdBy !== HUMAN_ID && ctx.services.org.get(chat.createdBy) !== undefined;
    if (!agentStarted || member.role === 'owner') return `${who[0].toUpperCase()}${who.slice(1)} stays in this chat: only a chat an agent started can lose them.`;
    return leadOrCreator ? undefined : `Only this chat's lead or creator can take ${who} out.`;
  }
  if (member.kind === 'external') return lead === me ? undefined : "Only this chat's lead removes external members.";
  const name = authorName(ctx, member.memberId);
  if (!leadOrCreator && !managerOf(ctx, me, member.memberId)) return `Only this chat's lead or creator, or a manager of ${name}, can remove them.`;
  const open = openWork(ctx, chat.id, member.memberId);
  return open ? `${name} still owns ${open === 1 ? 'an open task' : `${open} open tasks`} here – hand ${open === 1 ? 'it' : 'them'} on first (tasks.update for).` : undefined;
}

/** Why the agent may not archive the chat; undefined when it may. The lead counts for nothing here: the one agent of a
 *  person's chat leads it without having started it. */
function archiveRefusal(ctx: ToolContext, chat: Conversation): string | undefined {
  if (chat.settings.direct) return 'A default 1:1 stays: it is the one chat of its pair.';
  const people = ctx.services.chats.members(chat.id).filter((member) => !member.leftAt && member.kind !== 'agent');
  if (people.some((member) => member.memberId !== HUMAN_ID)) return 'Colleagues or outside members are in this chat (they could not write here any more): only the person archives it.';
  return people.length && chat.createdBy !== ctx.agent.id ? 'The person is in this chat and I did not start it: only they archive it.' : undefined;
}

function rename(ctx: ToolContext, chat: Conversation, given: string): Step {
  const me = ctx.agent.id;
  if (ctx.services.chats.lead(chat.id) !== me && chat.createdBy !== me) return { refused: "Only this chat's lead or creator can rename it." };
  if (personNamed(chat)) return { refused: 'The person named this chat; only they rename it.' };
  const title = given.trim();
  if (!title) return { refused: 'Give the chat a name.' };
  if (title === chat.title) return { note: 'The chat already has this name.' };
  return { done: { title: ctx.services.chats.update(chat.id, { title }, me).title } };
}

function add(ctx: ToolContext, chat: Conversation, given: string[]): Step {
  const ids = namedMembers(ctx, memberIds({ members: given }));
  if (typeof ids === 'string') return { refused: ids };
  if (!ids.length) return { refused: 'Name the members to add.' };
  const present = activeIds(ctx.services.chats.members(chat.id));
  const joining = ids.filter((id) => !present.includes(id));
  if (joining.includes(HUMAN_ID)) return nothing(NO_OWNER_INVITE);
  if (joining.length && chat.settings.direct) return nothing(DIRECT_STAYS_TWO);
  const why = colleagueRefusal(ctx, chat, joining) ?? scopeRefusal(ctx, present, joining);
  if (why) return nothing(why);
  return { done: { members: activeIds(ctx.services.chats.setMembers(chat.id, { add: ids }, ctx.agent.id)) } };
}

function remove(ctx: ToolContext, chat: Conversation, given: string[]): Step {
  const ids = memberIds({ members: given });
  if (!ids.length) return { refused: 'Name the members to remove.' };
  const members = ctx.services.chats.members(chat.id);
  const lead = ctx.services.chats.lead(chat.id);
  for (const id of ids) {
    const member = members.find((item) => item.memberId === id && !item.leftAt);
    if (!member) return nothing(`${id} is not a member of this chat.`);
    const why = removeRefusal(ctx, chat, member, lead);
    if (why) return nothing(why);
  }
  return { done: { members: activeIds(ctx.services.chats.setMembers(chat.id, { remove: ids }, ctx.agent.id)) } };
}

function handLead(ctx: ToolContext, chat: Conversation, agentId: string): Step {
  const me = ctx.agent.id;
  if (ctx.services.chats.lead(chat.id) !== me) return { refused: "Only this chat's current lead can hand the lead on." };
  if (agentId === me) return { note: 'I lead this chat already.' };
  if (!ctx.services.chats.members(chat.id).some((m) => m.memberId === agentId && m.kind === 'agent' && !m.leftAt)) {
    return { refused: `${agentId} is not an agent in this chat. I add them first (add).` };
  }
  ctx.services.chats.setMembers(chat.id, { lead: agentId }, me);
  return { done: { lead: agentId } };
}

function place(ctx: ToolContext, chat: Conversation, parentId: string): Step {
  const moved = setParent(ctx.services, chat.id, parentId.trim() || null, ctx.agent.id);
  return { done: { parentId: moved.settings.parentId ?? null } };
}

function answerMode(ctx: ToolContext, chat: Conversation, mode: ReplyMode): Step {
  if (replyModeOf(ctx.services.chats, chat.id, ctx.agent.id) === mode) return { note: `My reply mode here is "${mode}" already.` };
  setReplyMode(ctx.services, chat.id, ctx.agent.id, mode, ctx.agent.id);
  ctx.services.chats.status(chat.id, { type: 'note', text: `${ctx.agent.name} answers here ${ANSWERS[mode]}`, details: { replyMode: mode, by: ctx.agent.id } }, { authorId: ctx.agent.id });
  return { done: { replyMode: mode } };
}

function archive(ctx: ToolContext, chat: Conversation): Step {
  const why = archiveRefusal(ctx, chat);
  if (why) return nothing(why);
  if (ctx.services.chats.get(chat.id)!.archivedAt !== undefined) return { note: 'This chat is archived already.' };
  ctx.services.chats.status(chat.id, { type: 'note', text: `Archived by ${ctx.agent.name}`, details: { archived: true, by: ctx.agent.id } }, { authorId: ctx.agent.id });
  ctx.services.chats.archive(chat.id);
  return { done: { archived: true } };
}

function leave(ctx: ToolContext, chat: Conversation): Step {
  ctx.services.chats.setMembers(chat.id, { remove: [ctx.agent.id] }, ctx.agent.id);
  return { done: { left: true } };
}

/** The changes asked for, in their fixed order; app chats keep everything but my leaving. */
function steps(args: Args, system: boolean): Array<[string, (ctx: ToolContext, chat: Conversation) => Step]> {
  const app = (run: (ctx: ToolContext, chat: Conversation) => Step) => (system ? () => ({ refused: APP_CHAT }) : run);
  const out: Array<[string, (ctx: ToolContext, chat: Conversation) => Step]> = [];
  if (args.title !== undefined) out.push(['renamed', app((ctx, chat) => rename(ctx, chat, args.title!))]);
  if (args.add !== undefined) out.push(['added', app((ctx, chat) => add(ctx, chat, args.add!))]);
  if (args.lead !== undefined) out.push(['lead handed on', app((ctx, chat) => handLead(ctx, chat, args.lead!))]); // before remove: a lead hands on, then steps out
  if (args.remove !== undefined) out.push(['removed', app((ctx, chat) => remove(ctx, chat, args.remove!))]);
  if (args.parentId !== undefined) out.push(['moved', (ctx, chat) => place(ctx, chat, args.parentId!)]);
  if (args.replyMode !== undefined) out.push(['reply mode set', app((ctx, chat) => answerMode(ctx, chat, args.replyMode!))]);
  if (args.archive) out.push(['archived', app(archive)]);
  if (args.leave) out.push(['left', leave]);
  return out;
}

const update = defineTool<Args>({
  name: 'chat.update',
  description: 'Changes a chat I am in: its name, who is in it, its lead, the chat it sits under, how I answer there, whether it shows in the person\'s list – or I leave it. I name only what changes; the answer says what was done.',
  inputSchema: {
    type: 'object',
    properties: {
      chatId: CHAT_ID_PROPERTY,
      title: { type: 'string', minLength: 1, maxLength: 120, description: 'A new name, for a chat I lead or started.' },
      add: { ...IDS, description: 'Agents or colleagues (ids or names) who read along from now on. A 1:1 stays two: for more of us I open a group with chat.create; the person I reach in my 1:1 or a group with them.' },
      remove: { ...IDS, description: 'Members who go: agent ids, "human", per_… or external member ids.' },
      lead: { type: 'string', minLength: 1, description: 'The agent in this chat who leads it from now on: it answers lines addressed to nobody and picks owners for its team tasks.' },
      parentId: { type: 'string', maxLength: 64, description: 'Another chat of mine this one sits under (one level), so the special chats of a topic sit under its main chat; "" puts it back on top.' },
      replyMode: { type: 'string', enum: REPLY_MODES, description: 'How I answer group lines that @mention nobody: auto – the lead or a pick decides; mentions – only when @mentioned; all – every one. A 1:1 always reaches me.' },
      archive: { type: 'boolean', description: "true takes a chat I started out of the person's list; work there goes on, and an important line or an @mention of the person brings it back." },
      leave: { type: 'boolean', description: 'true: I leave the chat; its lines no longer reach me.' },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`Update chat${args.leave ? ' (leave)' : ''}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx): Promise<ToolOutput> {
    const chatId = resolveChat(ctx, args.chatId);
    const chat = ctx.services.chats.get(chatId)!;
    const todo = steps(args, Boolean(chat.settings.system));
    if (!todo.length) return failure('Name what changes: title, add, remove, lead, parentId, replyMode, archive or leave.');
    const done: Record<string, unknown> = {};
    const said: string[] = [];
    const notes: string[] = [];
    for (const [name, run] of todo) {
      let step: Step;
      try { step = run(ctx, ctx.services.chats.get(chatId)!); } catch (error) {
        if (!(error instanceof WorkforceError)) throw error;
        step = { refused: `Nothing was changed. ${error.message}` };
      }
      if ('refused' in step) return failure(said.length ? `Done: ${said.join(', ')}. Then refused: ${step.refused}` : step.refused);
      if ('note' in step) notes.push(step.note);
      else { Object.assign(done, step.done); said.push(name); }
    }
    if (!said.length) return text(notes.join(' '));
    return json({ ok: true, chatId, ...done, ...(notes.length ? { note: notes.join(' ') } : {}) });
  },
});

export const chatUpdateTools: ToolDef[] = [update];
