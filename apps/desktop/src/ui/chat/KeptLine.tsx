// A person's line kept whole in a task's thread (Quests 20.11.2026 – the runtime keeps the line that started a to-do as
// the first entry of its thread, message-rows.ts quoteOf): a quoted block with who wrote it and when, folded after a few
// lines ("Show all" opens the rest in place – nothing above it moves), and "In <chat>" back to the line where it was
// written when the person can open that chat. The words are shown as written (plain text, line breaks kept).
// Owns: that block. Never: changes the line or decides which lines are kept (the runtime does).

import { useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { chatTitle, memberName } from '../lib/chat-naming.ts';
import { conversationMap } from '../lib/store.ts';
import { canOpenChat, jumpToMessage } from '../tasks/jump.ts';
import { time } from '../lib/format.ts';
import { keptFolds, type KeptLine as Kept } from './message-rows.ts';

export function KeptLine(props: { message: Message; quote: Kept }) {
  const { message, quote } = props;
  const [open, setOpen] = useState(false);
  const folds = keptFolds(quote.text);
  const who = quote.authorId === HUMAN_ID ? 'You' : memberName(quote.authorId) ?? 'Someone';
  const chat = quote.conversationId && canOpenChat(quote.conversationId) ? conversationMap.value.get(quote.conversationId) : undefined;
  return (
    <figure class="kept-line" data-message-id={message.id}>
      <figcaption class="kept-line-head">
        <span>{who} wrote</span>
        <time class="tabular">{time(quote.at ?? message.createdAt)}</time>
        {chat && quote.messageId && (
          <button type="button" class="text-button kept-line-link" onClick={() => void jumpToMessage(chat.id, quote.messageId!)}>In {chatTitle(chat)}</button>
        )}
      </figcaption>
      <blockquote class={`kept-line-text${folds && !open ? ' folded' : ''}`}>{quote.text}</blockquote>
      {folds && (
        <button type="button" class="text-button kept-line-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </figure>
  );
}
