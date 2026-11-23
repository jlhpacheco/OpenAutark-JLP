// Team-Call 21.11.2026 (owner: "wenn man bei einem Agenten ist, … direkt einen neuen Chat mit dem starten"): on an agent's
// and a person's page, "New chat" opens an empty chat with them at once – no dialog, no name: the first exchange names
// it (runtime chat/service.ts deriveTitle) or the person renames it from the chat's menu (chat-actions.ts Rename…). Under
// it every chat the viewer shares with them (member-chats.ts), as the chat list's own rows (chat/ChatRow.tsx); a row
// opens its chat. The list comes from the store's chats, so it is there with the page and nothing moves later.
// Owns: that section. Never: creates chats itself (NewChatDialog.tsx startChat, the one path) or names them.

import { useState } from 'preact/hooks';
import { Icon } from '../lib/ui.tsx';
import { agentMap, conversations } from '../lib/store.ts';
import { ChatRow } from '../chat/ChatRow.tsx';
import { newChatPlan } from '../chat/new-chat.ts';
import { startChat } from '../chat/NewChatDialog.tsx';
import { sharedChats } from './member-chats.ts';

/** `canStart`: this viewer can open a chat with them now (else only the shared chats show). */
export function MemberChats(props: { memberId: string; canStart: boolean }) {
  const [busy, setBusy] = useState(false);
  const chats = sharedChats(conversations.value, props.memberId);
  const start = async () => {
    const plan = newChatPlan([props.memberId], '', (id) => agentMap.value.has(id));
    if (!plan || busy) return;
    setBusy(true);
    await startChat(plan);
    setBusy(false);
  };
  if (!props.canStart && !chats.length) return null;
  return (
    <section class="member-chats" aria-label="Chats">
      {props.canStart && (
        <button type="button" class="member-new-chat" aria-busy={busy} onClick={() => void start()}>
          <span class="member-new-chat-icon" aria-hidden="true"><Icon name="plus" size={16} /></span>
          <span class="row-title">New chat</span>
        </button>
      )}
      {chats.map((chat) => <ChatRow key={chat.id} chat={chat} active={false} />)}
    </section>
  );
}
