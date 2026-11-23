// B-078 threads for agents (runtime/chat/children.ts holds the rules): chat.thread finds or opens the thread on one message
// (with that chat's members) – a small side space for one piece of work, so the main chat stays readable. Answers its chat
// id; I write there with a <chat to="its id"> block. Where a chat sits in the tree is chat.update's parentId (chat-update.ts).
// Owns: this tool and its wording. Never: changes members (runtime/chat/members-change.ts).

import type { ToolDef } from '../types.ts';
import { CHAT_ID_PROPERTY, failure, json, SEQ_PROPERTY } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { openThread } from '../../chat/children.ts';
import { defineTool, internal, resolveChat, viewTitle } from './util.ts';

const refused = (error: unknown) => (error instanceof WorkforceError ? failure(`Nothing was changed. ${error.message}`) : failure(String(error)));

const threadTool = defineTool<{ chatId?: string; seq?: number; messageId?: string; title?: string }>({
  name: 'chat.thread',
  description: 'Finds or opens the thread on one message and returns its chat id. It holds a piece of work that needs its own lines, so the main chat stays readable; I write there with <chat to="its id">.',
  inputSchema: {
    type: 'object',
    properties: {
      chatId: CHAT_ID_PROPERTY, seq: SEQ_PROPERTY, messageId: { type: 'string', minLength: 1, maxLength: 64 }, title: { type: 'string', maxLength: 120 },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`Thread on ${args.messageId ?? `#${args.seq ?? '?'}`}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    let messageId = args.messageId;
    if (!messageId && args.seq !== undefined) {
      const chatId = resolveChat(ctx, args.chatId);
      messageId = ctx.services.chats.messages(chatId, { afterSeq: args.seq - 1, limit: 1 }).find((message) => message.seq === args.seq)?.id;
      if (!messageId) return failure(`No message #${args.seq} in this chat.`);
    }
    if (!messageId) return failure('Name the message: its #seq (with chatId when it is another chat) or its messageId.');
    try {
      const thread = openThread(ctx.services, messageId, ctx.agent.id, args.title);
      return json({ ok: true, chatId: thread.id, title: viewTitle(ctx, thread, ctx.services.chats.members(thread.id)), parentId: thread.settings.parentId });
    } catch (error) {
      return refused(error);
    }
  },
});

export const chatTreeTools: ToolDef[] = [threadTool];
