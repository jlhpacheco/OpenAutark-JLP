// A chat as the caller sees it (B-050 K2/K9) – the same for the owner's window, the owner's phones and a
// person's device, where 'human' is always the caller: its title through the shared rule (displayTitle –
// a two-member room is named after the other member; where that knows no name – no stored title and
// nobody else in it, e.g. a default 1:1 whose partner was removed or lost their access – the UI's own
// label "Untitled chat", never a blank), its partner (the one active member besides the caller: the other one of a two-member
// room, or the only member of a room the caller is not in) and its quiet second line (the partner's role
// or title, else how many are in it). Plain data, so `.ts` modules and unit tests use it; the picture is
// lib/chat-face.tsx. A task's own thread (its id is the task's, Quests 20.11.2026) is named by its task – the title as
// the store holds it now (a quest's to-dos too), "Task" while the store holds no copy – as the runtime names it
// (runtime/chat/titles.ts chatTitleFor), never "Untitled chat".
// Owns: these per-viewer views of a chat for the UI. Never: stores or derives stored titles (the runtime does).

import type { ConversationSummary, Member } from '../../shared/model/chat.ts';
import { isTaskThread } from '../../shared/model/chat.ts';
import { everyTask } from '../../shared/model/tasks.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { counterpartId, displayTitle } from '../../shared/text/chat-names.ts';
import { knownAgentMap, settings, tasks, todos } from './store.ts';
import { peopleMap } from './people.ts';
import { selfIdentity } from './self-identity.ts';

type ChatMembers = Pick<ConversationSummary, 'members'>;
type ChatNaming = Pick<ConversationSummary, 'title' | 'titleNamed' | 'settings' | 'members'> & { id?: string };

/** Shown for a chat nobody can name (no stored title, nobody else in it). */
export const UNTITLED_CHAT = 'Untitled chat';
/** A task the store holds no copy of – its thread's title, a live run's task. */
export const UNKNOWN_TASK = 'Task';

/** The title of task `id` as the store holds it (a quest's to-do too), else undefined. */
export function taskTitle(id: string): string | undefined {
  return everyTask(tasks.value, todos.value).get(id)?.title;
}

/** A member's display name, undefined when unknown: the caller as the profile button names them, an agent (an archived one too), a person. */
export function memberName(id: string): string | undefined {
  if (id === HUMAN_ID) return selfIdentity(settings.value?.profile, peopleMap.value.get(HUMAN_ID)).name;
  return knownAgentMap.value.get(id)?.name ?? peopleMap.value.get(id)?.name;
}

function activeMembers(chat: ChatMembers): Member[] {
  return chat.members.filter((member) => !member.leftAt);
}

/** The chat's name for the caller (shared/text/chat-names.ts displayTitle), never empty (see the header). */
export function chatTitle(chat: ChatNaming): string {
  if (chat.id && isTaskThread(chat.id)) return taskTitle(chat.id) || UNKNOWN_TASK;
  return displayTitle(chat, activeMembers(chat), HUMAN_ID, memberName) || UNTITLED_CHAT;
}

/** The one active member besides the caller (two-member room, or a room of one the caller is not in); else undefined. */
export function chatPartner(chat: ChatMembers): Member | undefined {
  const active = activeMembers(chat);
  const other = counterpartId(active, HUMAN_ID);
  if (other !== undefined) return active.find((member) => member.memberId === other);
  return active.length === 1 && active[0].memberId !== HUMAN_ID ? active[0] : undefined;
}

/** The partner's page, when it has one here: an agent's insight or a person's page. */
export function partnerPage(partner: Member | undefined): { kind: 'agent' | 'person'; id: string } | undefined {
  if (!partner) return undefined;
  if (partner.kind === 'agent') return { kind: 'agent', id: partner.memberId };
  return peopleMap.value.has(partner.memberId) ? { kind: 'person', id: partner.memberId } : undefined;
}

/** The quiet line under the chat's name: the partner's role (agent) or title (person), else "N agents" / "N members". */
export function chatSubtitle(chat: ChatMembers): string {
  const partner = chatPartner(chat);
  if (partner) return (knownAgentMap.value.get(partner.memberId)?.role ?? peopleMap.value.get(partner.memberId)?.title ?? '').trim();
  const others = activeMembers(chat).filter((member) => member.memberId !== HUMAN_ID);
  if (!others.length) return '';
  return others.every((member) => member.kind === 'agent') ? `${others.length} agents` : `${others.length} members`;
}

/** The composer's empty-field line: "Message <partner or chat>" ("Scheduled message for …" while scheduling); in a
 *  task's own thread "Write to <its lead> about this…" (the mockup's line; "Write about this…" while it has no lead) –
 *  the thread is about the task, and its lead is who answers there. */
export function composerPlaceholder(chat: ChatNaming & ChatMembers, scheduling = false): string {
  if (chat.id && isTaskThread(chat.id)) {
    const lead = activeMembers(chat).find((member) => member.role === 'lead' && member.memberId !== HUMAN_ID);
    const name = lead && memberName(lead.memberId);
    return name ? `Write to ${name} about this…` : 'Write about this…';
  }
  const partner = chatPartner(chat);
  return `${scheduling ? 'Scheduled message for' : 'Message'} ${(partner && memberName(partner.memberId)) || chatTitle(chat)}`;
}
