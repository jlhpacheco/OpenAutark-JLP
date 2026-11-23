// Team-Call 21.11.2026 (owner: "unter dem neuer Chat alle Chats … wo die Person drin ist mit einem gemeinsam"): the
// chats the viewer shares with one agent or person – both still members, a chat of the list (no thread, no app-owned or
// agent-only work chat, not archived) – newest first, in the chat list's own order rule (list-order.ts byActivity).
// Owns: that selection. Never: calls RPC, reads the store or renders (MemberChats.tsx does).

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';
import { byActivity } from '../chat/list-order.ts';

type Shared = Pick<ConversationSummary, 'members' | 'settings' | 'archivedAt' | 'lastMessageAt' | 'createdAt'>;

/** `selfId`: the viewer's member id ('human' on every connection – the runtime shows each viewer as 'human'). */
export function sharedChats<C extends Shared>(chats: readonly C[], memberId: string, selfId = 'human'): C[] {
  const inChat = (chat: C, id: string) => chat.members.some((member) => member.memberId === id && !member.leftAt);
  return chats
    .filter((chat) => chat.archivedAt === undefined && !chat.settings.anchorId && chatSection(chat) === 'main' && inChat(chat, memberId) && inChat(chat, selfId))
    .sort(byActivity);
}
