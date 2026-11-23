// What an agent writes into chats (13.11.2026, owner: "nur was die KI adressiert"): everything an agent writes is its
// thinking and stays in its run log; a block `<chat to="ID [ID…]" [push|quiet] [files="a, b"]>text</chat>` in any of its
// texts – mid-turn (a text stream or a commentary segment) or the final text – is posted into each chat it names, the moment
// its closing tag arrives. Level: none = a normal message (unread, in-app), `push` = priority 'important' (a notification
// on phone and PC; in a chat with other agents it reaches every agent's running turn – chat/delivery-route.ts), `quiet` =
// silent (history only, no unread, wakes nobody) – one that @mentions a person is a normal line (chat/service.ts
// quietUnlessPerson). @Name in the text reaches exactly that member (chat/mentions.ts,
// chat/delivery.ts). Ask blocks and ```app todo blocks in a posted text become to-dos as before (tasks.ingestBlocks).
// A block to a chat the agent is no member of is not posted; the run log notes it in one line and the agent's next turn
// reads it (its repair notes). A block posts once per run (by its addresses and text), however often it is seen again.
// Owns: the block format (chatBlocks), the outbox of one run (ChatOutbox) and what it posted. Never: decides who is woken
// or notified (delivery does), posts a block before its closing tag (but the final text's last open block, at the end).
// 17.11.2026 (runtime fixes, BEFUND-RUNTIME-JAN §1): a whole text – a commentary segment before a tool call, or the final
// text – ends its blocks: an open last block closes at its end, a block left open before the next opener closes there
// (models often do not close a block right before a tool call). The stream buffer is emptied at every whole text and every
// attempt (attach), and a stale opener in it never pairs with a later block's closing tag. `<chat>` without to= or right
// after a backtick is prose. files= splits at , ; and line breaks. A block of a mid-turn text that was not posted (no
// member, missing files, a failed post) is told to the running turn at once (attach: engine.steer), besides the repair note.
// A call turn's blocks to the call's chat are not posted here: the outbox keeps them (held), mid-turn ones too, and the
// turn's end joins them to its call line (agents/turn-finish.ts).
// Quests 20.11.2026: `to="task_…"` is that task's own thread (tasks/thread.ts) – made, or joined, when I write there; an
// unknown task gets the repair note instead.

import type { RuntimeServices } from '../contracts.ts';
import { isTaskThread, type Message } from '../../shared/model/chat.ts';
import { appTodosOf, uiBlocksOf } from '../../shared/blocks/parse.ts';
import { importFiles } from '../media/outputs.ts';
import { imitatedCall } from '../engines/rebuild-text.ts';
import { threadOf } from '../tasks/thread.ts';

export type ChatLevel = 'normal' | 'push' | 'quiet';

/** One addressed block: its chats, level, files (workspace paths, file ids or stored-at paths) and text. */
export interface ChatBlock { to: string[]; level: ChatLevel; files: string[]; body: string }

const OPEN = /<chat\b([^>]*)>/g;
const CLOSE = '</chat>';

function attributes(raw: string): Pick<ChatBlock, 'to' | 'level' | 'files'> {
  const value = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(raw)?.[1] ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(raw)?.[1];
  const bare = raw.replace(/\b\w+\s*=\s*("[^"]*"|'[^']*')/g, ' ');
  const level: ChatLevel = /\bpush\b/.test(bare) ? 'push' : /\bquiet\b/.test(bare) ? 'quiet' : 'normal';
  const to = [...new Set((value('to') ?? '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))];
  const files = (value('files') ?? '').split(/[,;\n]/).map((file) => file.trim()).filter(Boolean);
  return { to, level, files };
}

/** An opener that addresses chats: it names to= and is no quote in prose (`<chat …>` right after a backtick). */
const addressing = (text: string, match: RegExpMatchArray): boolean => /\bto\s*=/.test(match[1] ?? '') && text[(match.index ?? 0) - 1] !== '`';

/**
 * The complete blocks in `text`, in order, and `rest` – the text outside them. `final`: `text` is a whole text (a
 * commentary segment or the final text) – an open block ends where the next opener begins, or at the end of the text.
 * Otherwise (a stream buffer) the last open block stays out of `blocks` (`open` is true), and an opener left open before
 * the next one is skipped: its own whole text posts it, it never takes a later block's closing tag.
 */
export function chatBlocks(text: string, options: { final?: boolean } = {}): { blocks: ChatBlock[]; rest: string; open: boolean } {
  const blocks: ChatBlock[] = [];
  const outside: string[] = [];
  const openers = [...text.matchAll(OPEN)].filter((match) => addressing(text, match));
  let at = 0;
  let open = false;
  for (const [index, match] of openers.entries()) {
    const from = match.index ?? 0;
    if (from < at) continue; // inside an earlier block
    const start = from + match[0].length;
    const close = text.indexOf(CLOSE, start);
    const next = openers.slice(index + 1).find((later) => (later.index ?? 0) >= start)?.index ?? -1;
    const closed = close >= 0 && (next < 0 || close < next);
    if (!closed && !options.final) {
      if (next < 0) { open = true; break; }
      continue; // a stale opener in a stream buffer: its whole text posts it
    }
    const end = closed ? close : next >= 0 ? next : text.length;
    outside.push(text.slice(at, from));
    blocks.push({ ...attributes(match[1] ?? ''), body: text.slice(start, end).trim() });
    at = closed ? close + CLOSE.length : end;
  }
  outside.push(text.slice(at));
  return { blocks, rest: outside.join('').replace(/\n{3,}/g, '\n\n').trim(), open };
}

/** The repair note of a block to a chat I am no member of (the agent's next turn reads it). */
export const notMemberNote = (id: string) => `My <chat to="${id}"> block was not posted: I am no member of a chat ${id} (chat.list shows mine).`;

/** One block as the outbox knows it: posted once per run. */
const blockKey = (block: ChatBlock) => `${block.level}|${block.to.join(',')}|${block.body}`;

/** The outbox of one run: posts each block once, as soon as it is complete. */
export class ChatOutbox {
  /** Chats this run posted into, in order (the safety net and the run log read it). */
  readonly posted: string[] = [];
  /** One-line notes about blocks that were not posted. */
  readonly notes: string[] = [];
  /** The blocks to the call's chat (`skip`) it left out, in order – also those of a mid-turn text; the turn's end joins them to its call line. */
  readonly held: ChatBlock[] = [];
  private readonly seen = new Set<string>();
  /** The ids of the messages each block (blockKey) became. */
  private readonly sent = new Map<string, string[]>();
  private buffer = '';
  private queue: Promise<void> = Promise.resolve();
  private readonly services: RuntimeServices;
  private readonly agentId: string;
  private readonly runId: string;
  /** A call's chat: its blocks are spoken with the call's answer at the end, never posted on their own. */
  private readonly skip?: string;
  /** Tells the running turn about a mid-turn block that was not posted (engine.steer); absent: the repair note only. */
  private tell?: (line: string) => void;

  constructor(services: RuntimeServices, input: { agentId: string; runId: string; skip?: string }) {
    this.services = services;
    this.agentId = input.agentId;
    this.runId = input.runId;
    this.skip = input.skip;
  }

  /** Whether the run addressed any chat (posted, or tried to). */
  get addressed(): boolean {
    return this.posted.length > 0 || this.notes.length > 0;
  }

  /** A new attempt (runAttempt): its engine's steer, and a stream buffer without the last attempt's leftovers. */
  attach(tell?: (line: string) => void): void {
    this.tell = tell;
    this.buffer = '';
  }

  /** A streamed text delta: complete blocks post now, an open one waits for its closing tag (or its whole text). */
  text(delta: string): void {
    this.buffer += delta;
    const end = this.buffer.lastIndexOf(CLOSE);
    if (end < 0) return;
    this.take(this.buffer.slice(0, end + CLOSE.length), false, true);
    this.buffer = this.buffer.slice(end + CLOSE.length);
  }

  /**
   * A whole text – a commentary segment before a tool call, or the `final` text: its blocks post, an open last one closed
   * at its end (nothing more of this text comes). The stream buffer starts over after it.
   */
  segment(text: string, final = false, noteId?: string): ChatBlock[] {
    this.buffer = '';
    const blocks = this.take(text, true, !final);
    // The run note `noteId` (a commentary segment's 'Update') names the messages its blocks became – also those its stream
    // posted already –, so the ledger keeps those words in view through a fold like my closing text (context/ledger/store.ts postedItems).
    if (noteId) this.queue = this.queue.then(() => {
      const messageIds = blocks.flatMap((block) => this.sent.get(blockKey(block)) ?? []);
      if (messageIds.length) this.services.runs.updateItem(noteId, { data: { messageIds } });
    }).catch(() => { /* the note only stays unnamed */ });
    return blocks;
  }

  /** Waits for every post started so far. */
  async done(): Promise<void> {
    await this.queue;
  }

  private take(text: string, whole: boolean, live: boolean): ChatBlock[] {
    const { blocks } = chatBlocks(text, { final: whole });
    for (const block of blocks) {
      const key = blockKey(block);
      if (!block.body || !block.to.length || this.seen.has(key)) continue;
      this.seen.add(key);
      // 20.11.2026 (feedback 33b2e3af): a block that only imitates a call ("[ran …]") never reaches a chat, like a final text.
      if (imitatedCall(block.body)) { this.note(`My <chat to="${block.to.join(' ')}"> block only imitated a tool call ("[ran …]") and was not posted: nothing of it ran; a tool runs only as a real tool call.`, live); continue; }
      if (this.skip && block.to.includes(this.skip)) this.held.push(block);
      this.queue = this.queue.then(() => this.post(block, live, key)).catch((error) => {
        this.services.log.warn('chat block not posted', { runId: this.runId, error: String(error) });
        this.note(`My <chat to="${block.to.join(' ')}"> block failed to post (${String(error).slice(0, 200)}); it did not arrive.`, live);
      });
    }
    return blocks;
  }

  private member(conversationId: string): boolean {
    try { return this.services.chats.members(conversationId).some((member) => member.memberId === this.agentId && !member.leftAt); } catch { return false; }
  }

  /** A task's thread: made or joined now (tasks/thread.ts); why not, in my words, when there is no such task. */
  private joinThread(taskId: string): string | undefined {
    try { threadOf(this.services, taskId, this.agentId); return undefined; } catch (error) {
      return `My <chat to="${taskId}"> block was not posted: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async post(block: ChatBlock, live: boolean, key: string): Promise<void> {
    for (const conversationId of block.to) {
      if (conversationId === this.skip) continue;
      const refused = isTaskThread(conversationId) && !this.member(conversationId) ? this.joinThread(conversationId) : undefined;
      if (refused) { this.note(refused, live); continue; }
      if (!this.member(conversationId)) { this.note(notMemberNote(conversationId), live); continue; }
      const files = block.files.length ? await importFiles(this.services, this.agentId, block.files, conversationId) : undefined;
      if (files?.errors.length) this.note(`Files of my block to ${conversationId}: ${files.errors.join(' ')} The text went out without them.`, live);
      const message = this.services.chats.send({
        conversationId, body: block.body, authorId: this.agentId, authorKind: 'agent', runId: this.runId,
        priority: block.level === 'push' ? 'important' : 'normal', silent: block.level === 'quiet',
        ...(files?.attachments.length ? { attachments: files.attachments } : {}),
      });
      this.posted.push(conversationId);
      this.sent.set(key, [...(this.sent.get(key) ?? []), message.id]);
      todos(this.services, message);
    }
  }

  private note(line: string, live = false): void {
    this.notes.push(line);
    if (live && this.tell) { try { this.tell(`[chat delivery] ${line}`); } catch { /* the repair note stays */ } }
    try { this.services.runs.item(this.runId, { kind: 'note', data: { chatOut: line }, effectStatus: 'none' }); } catch { /* the log line below stays */ }
    this.services.log.info('chat block not posted', { runId: this.runId, note: line });
  }
}

/** Ask blocks and ```app todo blocks of a posted message become the person's to-dos, in their own savepoint (a failing one is logged). */
export function todos(services: RuntimeServices, message: Message): void {
  const blocks = uiBlocksOf(message.body);
  if (!blocks.length && !appTodosOf(message.body).length) return;
  try {
    services.db.tx(() => services.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index)));
  } catch (error) {
    services.log?.warn('chat block to-dos failed', { messageId: message.id, error: String(error) });
  }
}
