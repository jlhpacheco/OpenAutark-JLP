// The message list's rows (split from MessageList.tsx): consecutive status lines and agents' quiet lines (isQuietLine:
// what an agent wrote on the way, `quiet` – KI-Runde 17.11.2026: a compact row, its first sentence, the whole line on a
// click; a line with files stays a bubble) form one burst, which StatusGroup (MessageItem.tsx) renders under the id of
// its newest line the person sees, in one shape for one line and for many (burstView: earlier lines fold into one row in
// their place, a new line comes below, an opened line keeps its place) – agents' edit and delete notices are hidden
// there (C6). 13.11.2026: only
// real messages – who works shows in the live bar (LiveBar.tsx). A call is one bubble at its row (meta.call with its lines,
// runtime/calls/call-log.ts): the rows its lines name fold into it, wherever they stand, and show there in full
// (callEntries); every other row – an answer that came after the call ended too – stays a row, so nothing is hidden.
// Quests 20.11.2026: a task thread's line that keeps a person's whole line (quoteOf – the line that started the to-do)
// is a row of its own, never folded into a burst.
// Owns: the grouping, what a burst shows, which rendered line a message is found under and a call bubble's entries. Never: renders, scrolls or reads the DOM (MessageList.tsx looks the line up).

import { callRecord, type CallLine } from '../../shared/model/call.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { firstSentence } from '../../shared/text/step-label.ts';

export type Row = { kind: 'message'; message: Message } | { kind: 'status'; messages: Message[] } | { kind: 'call'; callId: string; messages: Message[] };

type CallRow = Extract<Row, { kind: 'call' }>;

/** An agent's quiet line: a text it wrote silent, without files, not said in a call – it stands in the burst, not as a
 *  bubble (a line that carries files is a result and stays a bubble). */
export function isQuietLine(message: Pick<Message, 'authorKind' | 'kind' | 'silent' | 'meta' | 'attachments'>): boolean {
  return message.authorKind === 'agent' && message.kind === 'text' && message.silent && !message.attachments.length && !message.meta.call;
}

/** A quiet line's row text: "<name>: <its first sentence>". */
export function quietLineText(message: Pick<Message, 'body'>, name: string): string {
  return `${name}: ${firstSentence(message.body)}`;
}

/** A person's line kept whole in a task's thread: its words, who wrote it, when, and the line in its chat. */
export interface KeptLine { text: string; authorId: string; at?: number; conversationId?: string; messageId?: string }

/** Lines and characters a kept line shows before it folds ("Show all" opens the rest in place). */
export const KEPT_LINES = 4;
const KEPT_CHARS = 320;

/** The kept line of a thread's status line (its details.quote – runtime tools' keepPersonLine), else undefined. */
export function quoteOf(message: Pick<Message, 'kind' | 'body' | 'meta'>): KeptLine | undefined {
  const status = message.meta.status;
  const quote = status?.details?.quote;
  if (message.kind !== 'status' || !quote || typeof quote !== 'object') return undefined;
  const fields = quote as Record<string, unknown>;
  const word = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const at = typeof fields.at === 'number' ? fields.at : undefined;
  const [conversationId, messageId] = [word(fields.conversationId), word(fields.messageId)];
  return {
    text: status?.text || message.body, authorId: word(fields.authorId) ?? HUMAN_ID,
    ...(at !== undefined ? { at } : {}), ...(conversationId ? { conversationId } : {}), ...(messageId ? { messageId } : {}),
  };
}

/** True when a kept line is longer than its folded block shows (more than KEPT_LINES lines or KEPT_CHARS characters). */
export function keptFolds(text: string): boolean {
  return text.length > KEPT_CHARS || text.split('\n').length > KEPT_LINES;
}

/** A row of a burst: one of its lines, the fold row standing for the `count` lines before them, or the row that folds
 *  those `count` lines again. */
export type BurstItem = { kind: 'line'; id: string } | { kind: 'earlier' | 'hide'; count: number };

/**
 * What a burst (StatusGroup) shows, top to bottom – one shape for one line and for many: its lines from the first one
 * the person opened (`opened`: their ids, kept by the burst), else its newest; the lines before them folded into one
 * 'earlier' row in their place; all of them while the burst is open, with a 'hide' row under them. A line that arrives
 * comes below: nothing above an opened line appears or moves.
 */
export function burstView(list: readonly Pick<Message, 'id'>[], open: boolean, opened: ReadonlySet<string>): BurstItem[] {
  const firstOpened = list.findIndex((message) => opened.has(message.id));
  const folded = firstOpened >= 0 ? firstOpened : Math.max(0, list.length - 1); // the lines a closed burst folds
  const from = open ? 0 : folded;
  return [
    ...(from > 0 ? [{ kind: 'earlier' as const, count: from }] : []),
    ...list.slice(from).map((message) => ({ kind: 'line' as const, id: message.id })),
    ...(open && folded > 0 ? [{ kind: 'hide' as const, count: folded }] : []),
  ];
}

/** Rows in order; a call's row first in its bubble's messages, then the rows its lines name. */
export function groupRows(list: readonly Message[]): Row[] {
  const rows: Row[] = [];
  const calls = new Map<string, CallRow>(); // call row id → its bubble
  const folded = new Map<string, CallRow>(); // a line's message id → the bubble it folds into
  for (const message of list) {
    const call = callRecord(message);
    if (!call) continue;
    const row: CallRow = { kind: 'call', callId: call.id, messages: [message] };
    calls.set(message.id, row);
    for (const line of call.lines) if (line.messageId) folded.set(line.messageId, row);
  }
  for (const message of list) {
    const call = calls.get(message.id);
    if (call) { rows.push(call); continue; }
    const into = folded.get(message.id);
    if (into) { into.messages.push(message); continue; }
    const last = rows[rows.length - 1];
    if ((message.kind === 'status' && !quoteOf(message)) || isQuietLine(message)) {
      if (last?.kind === 'status') last.messages.push(message);
      else rows.push({ kind: 'status', messages: [message] });
    } else rows.push({ kind: 'message', message });
  }
  return rows;
}

/**
 * A call bubble's transcript (CallTranscript.tsx): each of its lines with its row when this device has it loaded – shown
 * as the message itself, in full, with files and markdown – else only the line's stored words (a row not loaded here).
 */
export function callEntries(messages: readonly Message[]): Array<{ line: CallLine; message?: Message }> {
  const call = messages[0] ? callRecord(messages[0]) : undefined;
  const rows = new Map(messages.slice(1).map((message) => [message.id, message]));
  return (call?.lines ?? []).map((line) => {
    const message = line.messageId ? rows.get(line.messageId) : undefined;
    return message ? { line, message } : { line };
  });
}

export function rowHas(row: Row, messageId: string): boolean {
  return row.kind === 'message' ? row.message.id === messageId : row.messages.some((message) => message.id === messageId);
}

/**
 * The line a message of a collapsed status burst is found under: the burst's newest line the
 * person sees (C4 jumps). Undefined when no burst holds the message or the burst shows nothing
 * (only agents' notices).
 */
export function burstLineFor(rows: readonly Row[], messageId: string): string | undefined {
  const call = rows.find(row => row.kind === 'call' && rowHas(row, messageId));
  if (call?.kind === 'call') return call.messages[0]?.id;
  const burst = rows.find((row) => row.kind === 'status' && rowHas(row, messageId));
  if (burst?.kind !== 'status') return undefined;
  const shown = burst.messages.filter((message) => !isAgentNotice(message));
  return shown[shown.length - 1]?.id;
}
