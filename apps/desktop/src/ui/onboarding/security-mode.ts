// The company's security mode changed after the first run (owner 19.11.2026: "später umstellbar"), from Settings ›
// Security once the person confirmed it twice. One app line goes to the Manager's first chat as the person's message,
// so the Manager knows the mode changed (what is open and what the app asks first stands in the security part of every
// agent's instructions, runtime/context/prompt-stable.ts – no agent rewrites anything for it); then settings.json
// `security` is written (settings/security-model.ts switchMode). The line goes first: when it fails, the setting stays
// as it was and the person tries again; one clientId per direction until a try went through, so a double click or a
// retry after a failed settings write posts the line once.
// Owns: those lines and that settings write. Never: edits SYSTEM.md, writes a line anywhere else, or decides the switches.

import { newId } from '../../shared/ids.ts';
import type { SecurityMode } from '../../shared/model/security-settings.ts';
import { securityOf } from '../../shared/model/system.ts';
import { managerAgent, managerFirstChat } from '../../shared/text/manager-chat.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { agents, conversations, settings, updateSettings } from '../lib/store.ts';
import { switchMode } from '../settings/security-model.ts';

/** The lines the Manager receives, in the person's voice like the start text. */
export const TRUST_MODE_LINE = 'Automatic message from the app, not typed by me: I switched this company to Trust AI mode. The security part of your instructions now says what that means for the team.';
export const SECURE_MODE_LINE = 'Automatic message from the app, not typed by me: I switched this company to Secure mode. The security part of your instructions now says what is open and what the app asks me first.';
const LINES: Readonly<Record<SecurityMode, string>> = { trust: TRUST_MODE_LINE, secure: SECURE_MODE_LINE };

/** The double-send guard of each line (chat service: one message per clientId); a new one once a try went through. */
const clientIds: Record<SecurityMode, string> = { trust: newId('req'), secure: newId('req') };

/** The mode from now on: its line to the Manager (its first chat, else its default 1:1), then the setting. */
export async function setSecurityMode(to: SecurityMode): Promise<void> {
  const current = securityOf(settings.value ?? undefined);
  if (current.mode === to) return;
  const manager = managerAgent(agents.value);
  if (manager && can('messages.send')) {
    const chatId = managerFirstChat(conversations.value, manager.id)?.id ?? (await rpc.call('chats.direct', { memberId: manager.id })).id;
    await rpc.call('messages.send', { conversationId: chatId, body: LINES[to], mentions: [manager.id], clientId: clientIds[to] });
  }
  await updateSettings({ security: switchMode(current, to) });
  clientIds[to] = newId('req');
}
