// Which part of the chat list a chat belongs to – the one rule shared by the runtime (chats.list
// without includeHidden, unread counts) and the window (ChatList, CommandPalette):
//  - 'system': an app-owned chat (settings.system: the To-do anchor chat, the Customize chat). It
//    is in no list; For you, task links and Settings › Customize lead to it.
//  - 'team': an agent-only room – no active human member (never joined, or the human left), or
//    hidden from the list by the agent that made it. Shown muted under "Team activity"; it never
//    counts unread. A human writing in it joins it and so moves it to 'main'.
//  - 'main': every other chat.
// Owns: the section rule. Never: filters archived chats, orders lists or reads any store.

import type { ConversationSummary } from '../model/chat.ts';

export type ChatSection = 'main' | 'team' | 'system';

/** What the rule looks at: the chat's settings and its members (left members may be included). */
export type SectionInput = Pick<ConversationSummary, 'settings' | 'members'>;

export function chatSection(chat: SectionInput): ChatSection {
  if (chat.settings.system) return 'system';
  if (chat.settings.hiddenFromList) return 'team';
  return hasActiveHuman(chat) ? 'main' : 'team';
}

/** A human member who has not left. */
export function hasActiveHuman(chat: Pick<ConversationSummary, 'members'>): boolean {
  return chat.members.some((member) => member.kind === 'human' && !member.leftAt);
}
