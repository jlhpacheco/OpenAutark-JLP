// The agent's own messages (B-050 K10), through ChatService with the agent as `by`: chat.edit / chat.delete change only
// the agent's own finished messages (by seq, as chat.read shows them, or by id); the service refuses anyone else's
// (chat/message-edits.ts, chat/lifecycle.ts removeMessage). Of its status lines only its older work updates go: the others
// (members, name, lead, tasks, calendar …) record what happened in the chat and stand in for an approval of these calls,
// so they stay. A chat's own settings change with chat.update (chat-update.ts).
// Owns: these tool definitions and the delete rule. Never: changes another member's message.

import type { ToolContext, ToolDef } from '../types.ts';
import { CHAT_ID_PROPERTY, failure, json, SEQ_PROPERTY } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { defineTool, internal, resolveChat } from './util.ts';

const WHICH = { chatId: CHAT_ID_PROPERTY, seq: SEQ_PROPERTY, messageId: { type: 'string', minLength: 1, maxLength: 100 } };

/** A work-update line the agent posted before 13.11.2026 (B-047 D4: details.by 'agent'). */
const workUpdate = (message: Message): boolean => message.meta.status?.type === 'note' && message.meta.status.details?.by === 'agent';

/** The agent's own finished message named by id or by seq (in a chat it is a member of), or why not. */
function ownMessage(ctx: ToolContext, args: { chatId?: string; seq?: number; messageId?: string }): Message | string {
  let message: Message | undefined;
  if (args.messageId) {
    message = ctx.services.chats.message(args.messageId);
    if (message) resolveChat(ctx, message.conversationId);
  } else if (args.seq !== undefined) {
    const chatId = resolveChat(ctx, args.chatId);
    message = ctx.services.chats.messages(chatId, { afterSeq: args.seq - 1, limit: 1 }).find((item) => item.seq === args.seq);
  } else {
    return 'Name the message: seq (as chat.read shows it) or messageId.';
  }
  if (!message) return 'No such message.';
  if (message.authorId !== ctx.agent.id) return 'Only my own messages can be changed.';
  if (message.state === 'streaming') return 'This message is still being written.';
  if (message.kind !== 'text' && message.kind !== 'status') return 'Only my own text messages and status lines can be changed.';
  if (message.kind === 'status' && !workUpdate(message)) return 'This line records what happened in the chat: it stays.';
  return message;
}

/** A refusal of the service as a tool result (its message is meant for the agent). */
function refused(error: unknown) {
  if (error instanceof WorkforceError && ['forbidden', 'conflict', 'bad_request', 'not_found'].includes(error.code)) return failure(error.message);
  throw error;
}

const editMessage = defineTool<{ chatId?: string; seq?: number; messageId?: string; text: string }>({
  name: 'chat.edit',
  description: 'Changes the text of one of my own messages; the chat marks it edited.',
  inputSchema: { type: 'object', properties: { ...WHICH, text: { type: 'string', minLength: 1, maxLength: 60_000 } }, required: ['text'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Edit message ${args.messageId ?? `#${args.seq ?? '?'}`}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const message = ownMessage(ctx, args);
    if (typeof message === 'string') return failure(message);
    if (message.kind !== 'text') return failure('Only my own text messages can be edited.');
    try {
      const edited = ctx.services.chats.edit(message.id, args.text, ctx.agent.id);
      return json({ ok: true, messageId: edited.id, seq: edited.seq, chatId: edited.conversationId });
    } catch (error) { return refused(error); }
  },
});

const deleteMessage = defineTool<{ chatId?: string; seq?: number; messageId?: string }>({
  name: 'chat.delete',
  description: 'Deletes one of my own messages or work updates.',
  inputSchema: { type: 'object', properties: WHICH, additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Delete message ${args.messageId ?? `#${args.seq ?? '?'}`}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const message = ownMessage(ctx, args);
    if (typeof message === 'string') return failure(message);
    try {
      ctx.services.chats.removeMessage(message.id, ctx.agent.id);
      return json({ ok: true, deleted: message.id, seq: message.seq, chatId: message.conversationId });
    } catch (error) { return refused(error); }
  },
});

export const chatMessageTools: ToolDef[] = [editMessage, deleteMessage];
