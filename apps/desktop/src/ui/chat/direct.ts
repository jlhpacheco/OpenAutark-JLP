// The default 1:1 with a member (B-050 K1/K9): "Message" on an agent or a person opens it (the new-chat
// dialog always creates a new chat since 12.11.2026 – new-chat.ts) – chats.direct finds it, adopts an older unnamed chat of exactly
// the two or creates it on first open (the owner's with an agent exists from the hire on – B-050 K1, Nachtrag
// Runde 4 –, so for an agent it is found). Wherever the session lists
// chats.direct this is the one path – the owner, a phone with 'chat', a person's device (its person
// variant, people/rpc-chats.ts); a session without it opens the new-chat dialog with that member chosen
// (20.11.2026: the UI is always served by the runtime it talks to, so there is no "older runtime" path).
// Owns: opening that chat from the UI. Never: names or creates chats itself (the runtime does).

import { rpc } from '../lib/rpc.ts';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { newChatOpen } from '../lib/shell-state.ts';
import { conversations, upsertById } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';

/** True when this connection opens the default 1:1 with a member directly (else the new-chat dialog). */
export function directReachable(): boolean {
  return can('chats.direct');
}

/** Opens the default 1:1 with `memberId`; false when it failed (a notice says why). */
export async function openDirect(memberId: string): Promise<boolean> {
  try {
    const chat = await rpc.call('chats.direct', { memberId });
    upsertById(conversations, chat); // the row exists at once; conversation.upserted keeps it fresh
    go.chat(chat.id);
    return true;
  } catch (error) {
    toastError(error, 'Could not open the chat');
    return false;
  }
}

/** "Message" on an agent or a person: their default 1:1, else the new-chat dialog. */
export function messageMember(memberId: string): void {
  if (directReachable()) void openDirect(memberId);
  else newChatOpen.value = { agentIds: [memberId] };
}
