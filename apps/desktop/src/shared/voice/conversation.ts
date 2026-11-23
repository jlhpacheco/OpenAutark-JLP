// Voice conversation ("wie ChatGPT Voice / Siri – wenn man spricht, spricht die KI zurück"), one loop for the
// desktop window and the phone page (ui/chat/composer/pwa-conversation.ts owns the microphone and the speech
// output): an utterance the page cut and uploaded → voice.transcribe → messages.send (marked spoken live, with the
// call's id) → the agent's reply is read aloud → listen again. Each talking chat is a call on this device (calls.start
// when it starts – the call's row in the chat, written by this device's PC – and calls.end when it ends; a page that
// cannot start calls, a person's, talks without one). The first reply is usually the agent's live voice, a fast small
// model (runtime/calls/talker.ts), and the agent's own answer follows when it is done; both are read. The wait for a
// KI-Runde 17.11.2026 (decision 7.3): the agent's live voice writes its line while it speaks, so each finished sentence of
// such a row (meta.call.voice 'talker') is read as it completes and the rest follows when the row is final.
// reply goes on while an agent of the chat works (a row that streams, also one synced from another PC) and ends
// REPLY_TIMEOUT_MS after the line otherwise; an agent that starts working later opens it again. A call is this same
// mode started from the chat header (realtime voice is the other way, ui/chat/call/realtime-call.ts).
// Parallel voice (SM11, simplest form): up to MAX_VOICE_SESSIONS chats talk at once over the one microphone. The
// chat started or focused last hears the next utterance; replies are read one at a time, the listening chat's
// first, another chat's with its title in front. Speech while a reply is awaited goes out at once (that reply is
// then not read; it stays in the chat); speech while the last line is still heard or a reply is read waits and goes out
// as the next line, in the order it was said. The page discards what its microphone picks up while it reads (the echo
// guard), so a take that arrives here during a reading is the person's own words from before it. Talking
// never stops agent work. Besides the agents' lines, a system line of the chat's own call is read (the program says
// that no model can answer, runtime/calls/no-lane.ts).
// B-081: start with a callId takes that call (an agent's ring, or a call on another device): from then on every new
// agent line of the chat is read – the agent's opening line first. When the speaker changes, its name goes in front
// (one reading voice for every agent). A chat whose call row shows another holder (another device took it over) ends
// quietly, without calls.end. add() puts a pin from the browser in as a line of the call. Shapes, helpers: conversation-parts.ts.
// Owner 19.11.2026: several devices of the person can be in one call (calls.start `joined`: this one is in beside the
// holder; it ends quietly when the call ends). Every device's microphone feeds the call, and a reply is read only on the
// device that heard the person's newest line of it: a person's line of my call said on another device makes this one
// quiet until it hears one itself – so two devices in one room never speak at once.
// Owner 21.11.2026 (people in one call): only my own lines ('human' on every device of mine) move the reading; another
// person's line leaves it, so each person's devices read the replies to everybody. While another device reads, a take
// here that repeats what others just said in the call (echoOf) is that device's voice and goes nowhere.
// Owns: the chats, the reading queue and the microphone's view (publish's first argument; every chat is its
// third). Never: touches a microphone, timer or platform global (all injected), or changes what was said.

import { HUMAN_ID } from '../ids.ts';
import { callMember, callRecord, type CallRecord } from '../model/call.ts';
import type { Attachment, Message } from '../model/chat.ts';
import { MAX_VOICE_SESSIONS, REPLY_TIMEOUT_MS, REPEAT_HINT, SESSIONS_FULL, TRANSCRIBE_TIMEOUT_MS, echoOf, languageHint, sentencesDone, speakable, spokenMeta } from './conversation-parts.ts';
import type { TalkingChat as Chat, Reading, VoiceSessionEntry, VoiceSessionView, VoiceSessionsDeps } from './conversation-parts.ts';

export * from './conversation-parts.ts';

const MAX_TEXT = 32_000;

export class VoiceSessions {
  private readonly deps: VoiceSessionsDeps;
  private chats: Chat[] = []; // the listening chat first
  private micId: string | null = null;
  private queue: Reading[] = [];
  private reading: Reading | null = null;
  private transcribing = false;
  private held: string[] = []; // utterances said while the one before is heard or a reply is read, in order
  private hint: string | undefined;

  constructor(deps: VoiceSessionsDeps) {
    this.deps = deps;
    deps.rpc.on('message.created', (message) => this.observe(message));
    deps.rpc.on('message.updated', (message) => this.observe(message));
  }

  get active(): boolean { return this.chats.length > 0; }

  /** The microphone's view; null when no chat talks. */
  view(): VoiceSessionView | null {
    const listening = this.chats[0];
    if (!listening || !this.micId) return null;
    const status = listening.starting ? 'starting' : this.reading ? 'speaking' : this.transcribing ? 'transcribing' : 'listening';
    return { id: this.micId, conversationId: listening.conversationId, status, ...(this.hint ? { hint: this.hint } : {}) };
  }

  /** Every talking chat, the listening one first. */
  sessions(): VoiceSessionEntry[] {
    return this.chats.map((chat, index) => {
      const status: VoiceSessionView['status'] = chat.starting ? 'starting'
        : this.reading?.chat === chat ? 'speaking'
          : index === 0 && this.transcribing ? 'transcribing'
            : chat.awaiting || chat.sending ? 'responding' : 'listening';
      const queued = this.queue.filter((reading) => reading.chat === chat).length;
      return { id: chat.id, conversationId: chat.conversationId, status, listening: index === 0, ...(queued ? { queued } : {}) };
    });
  }

  /** Talk in `conversationId`: a new chat that listens, or the one already talking there listens now; `callId` takes that call. */
  async start(conversationId: string, callId?: string): Promise<VoiceSessionView> {
    const running = this.chats.find((chat) => chat.conversationId === conversationId);
    if (running) { this.focus(running); return this.current(); }
    if (this.chats.length >= MAX_VOICE_SESSIONS) throw new Error(SESSIONS_FULL);
    // A call it takes: every new agent line is read from now on, the opening line first (it comes as an event).
    const chat: Chat = { id: this.deps.newId(), conversationId, title: '', starting: true, sentSeq: callId ? 0 : null, awaiting: false, sending: false, pending: '', spoken: new Set() };
    this.chats.unshift(chat);
    this.micId ??= this.deps.newId();
    this.hint = undefined;
    this.publish();
    try {
      const summary = await this.deps.rpc.call('chats.get', { id: conversationId }); // not_found for an unknown chat
      chat.title = summary.title ?? '';
      const release = await this.deps.rpc.subscribe(`chat:${conversationId}`);
      if (!this.chats.includes(chat)) { release(); throw new Error('Voice conversation was cancelled.'); }
      chat.release = release;
      const taking = callId ? { conversationId, callId } : { conversationId };
      const call = await this.deps.rpc.call('calls.start', taking).catch((error: unknown) => { if (callId) throw error; return undefined; }); // a person's page talks without a call row
      if (!this.chats.includes(chat)) { this.endCall(call?.callId); throw new Error('Voice conversation was cancelled.'); }
      chat.callId = call?.callId;
      chat.holder = call?.holder;
      chat.joined = call?.joined === true;
      chat.starting = false;
      this.publish();
      return this.current();
    } catch (error) {
      if (this.chats.includes(chat)) this.end(chat);
      throw error;
    }
  }

  /** Ends the chat's conversation – without one the listening chat's. */
  stop(conversationId?: string): void {
    const chat = conversationId === undefined ? this.chats[0] : this.chats.find((other) => other.conversationId === conversationId);
    if (chat) this.end(chat);
  }

  /** Ends every chat (the page hid, the microphone failed, a dictation takes the microphone). */
  stopAll(error?: string): void {
    if (!this.chats.length) return;
    for (const chat of [...this.chats]) this.end(chat, undefined, false);
    this.publish(error);
  }

  /** One utterance the page cut and uploaded: transcribed, then sent in the listening chat; one said while the last is heard or a reply is read is the next line. */
  async utterance(micId: string, fileId: string): Promise<void> {
    if (micId !== this.micId || !this.chats[0]) return;
    if (this.transcribing || this.reading) { this.held.push(fileId); return; } // KI-Runde 17.11.: words said while the last line is heard or a reply is read are kept
    await this.hear(micId, fileId);
    await this.drainHeld(micId);
  }

  /** The takes that waited, in the order they were said, until a reply is read again (then the reading's end drains them). */
  private async drainHeld(micId: string): Promise<void> {
    while (micId === this.micId && !this.reading && this.held.length) await this.hear(micId, this.held.shift()!); // looked at before a take leaves the list
  }

  private async hear(micId: string, fileId: string): Promise<void> {
    const chat = this.chats[0];
    if (!chat) return;
    this.transcribing = true;
    this.hint = undefined;
    this.publish();
    try {
      const language = languageHint(this.deps.language?.());
      const heard = await this.deps.rpc.call('voice.transcribe', { fileId, live: true, ...(language ? { language } : {}) }, TRANSCRIBE_TIMEOUT_MS);
      if (micId !== this.micId) return;
      const text = typeof heard?.text === 'string' ? heard.text.trim() : '';
      this.transcribing = false;
      const target = this.chats.includes(chat) ? chat : this.chats[0];
      if (!text || !target) { this.hint = REPEAT_HINT; this.publish(); return; } // no words heard: say it again
      if (this.otherReads(target) && echoOf(text, target.lately?.values() ?? [])) { this.publish(); return; } // another device of the call speaking
      this.submit(target, text);
    } catch {
      if (micId !== this.micId) return;
      this.transcribing = false;
      const target = this.chats.includes(chat) ? chat : this.chats[0];
      if (target) void this.sendAudio(target, fileId); // not heard here: the line goes as its recording, the call goes on
    } finally {
      if (micId === this.micId && this.transcribing) { this.transcribing = false; this.publish(); }
    }
  }

  /** B-082: a line this device could not hear goes out as its recording – the runtime hears it (with a retry beside it). */
  private async sendAudio(chat: Chat, fileId: string): Promise<void> {
    chat.awaiting = false;
    this.clearTimer(chat);
    this.publish();
    chat.out = (chat.out ?? 0) + 1;
    try {
      const speech = { ...spokenMeta(true), ...(chat.callId ? { call: chat.callId } : {}) };
      const attachments = [{ fileId, name: 'Utterance.wav', mime: 'audio/wav', size: 0 }, ...(this.deps.shown ? await this.shown(chat) : [])]; // the runtime takes mime and size from the stored file
      if (!this.chats.includes(chat)) return; // it ended meanwhile: a late line would bring this device back into the call
      const message = await this.deps.rpc.call('messages.send', { conversationId: chat.conversationId, body: '', attachments, clientId: this.deps.newId(), speech });
      if (!this.chats.includes(chat)) return;
      if (message.meta?.call?.id) chat.callId = message.meta.call.id;
      chat.sentSeq = Math.max(chat.sentSeq ?? 0, message.seq);
      this.awaitReply(chat);
    } catch {
      this.hint = REPEAT_HINT; // not even sent: say it again
    } finally {
      chat.out = (chat.out ?? 1) - 1;
    }
    if (this.chats.includes(chat)) this.publish();
  }

  /** The page finished reading aloud: the next reply, or listen again. */
  spokenDone(micId: string): void {
    if (micId !== this.micId || !this.reading) return;
    this.reading = null;
    if (!this.readNext()) this.publish();
    if (!this.reading && !this.transcribing && this.held.length) void this.drainHeld(micId);
  }

  /** The person talks over the reading (the page's echo-cancelled microphone): it stops, the queued replies go. */
  bargeIn(micId: string): boolean {
    if (micId !== this.micId || !this.reading) return false;
    const over = this.reading.chat;
    if (over.said) { over.spoken.add(over.said.id); over.said = undefined; } // the rest of a line still being written is not read either
    this.reading = null;
    this.queue = [];
    this.deps.silence();
    this.publish();
    if (!this.transcribing && this.held.length) void this.drainHeld(micId);
    return true;
  }

  /** B-081: a pin (not speech) as a line of `conversationId`'s call, sent like an utterance; false when that chat does not talk here. */
  add(conversationId: string, text: string): boolean {
    const chat = text.trim() ? this.chats.find((entry) => entry.conversationId === conversationId && !entry.starting) : undefined;
    if (chat) this.submit(chat, text.trim());
    return Boolean(chat);
  }

  // ------------------------------------------------------------------ internals

  /** Owner 19.11.2026: the picture this device shows on the chat's call goes with the line; one that fails stays behind, the line goes. */
  private async shown(chat: Chat): Promise<Attachment[]> {
    try { return (await this.deps.shown?.(chat.conversationId)) ?? []; } catch { return []; }
  }

  private submit(chat: Chat, text: string): void {
    chat.pending = [chat.pending, text].filter(Boolean).join('\n');
    if (chat.pending.length > MAX_TEXT) { this.end(chat, 'The spoken message is too long. Start another conversation.'); return; }
    // New speech supersedes the reply still awaited and what of this chat waits to be read.
    chat.awaiting = false;
    this.clearTimer(chat);
    this.queue = this.queue.filter((reading) => reading.chat !== chat);
    void this.drain(chat);
  }

  private async drain(chat: Chat): Promise<void> {
    if (chat.sending || !chat.pending || chat.awaiting || !this.chats.includes(chat)) return;
    const body = chat.pending;
    chat.pending = '';
    chat.sending = true;
    chat.out = (chat.out ?? 0) + 1;
    this.publish();
    try {
      const speech = { ...spokenMeta(true), ...(chat.callId ? { call: chat.callId } : {}) };
      const attachments = this.deps.shown ? await this.shown(chat) : []; // no extra wait where nothing can be shown
      if (!this.chats.includes(chat)) return; // it ended meanwhile: a late line would bring this device back into the call
      const message = await this.deps.rpc.call('messages.send', { conversationId: chat.conversationId, body, clientId: this.deps.newId(), speech, ...(attachments.length ? { attachments } : {}) });
      if (!this.chats.includes(chat)) return;
      const call = message.meta?.call?.id;
      if (call) chat.callId = call; // the runtime's call for this line – a new one when the device's connection had closed meanwhile or calls.start failed – so the end reaches it
      chat.sentSeq = message.seq;
      this.awaitReply(chat);
    } catch (error) {
      if (this.chats.includes(chat)) this.end(chat, (error as Error).message);
    } finally {
      chat.sending = false;
      chat.out = (chat.out ?? 1) - 1;
      if (chat.pending) { chat.awaiting = false; this.clearTimer(chat); void this.drain(chat); } // said meanwhile: out at once
      else if (this.chats.includes(chat)) this.publish();
    }
  }

  private observe(message: Message): void {
    const chat = this.chats.find((entry) => entry.conversationId === message.conversationId);
    const record = chat?.callId ? callRecord(message) : undefined;
    if (chat && record && record.id === chat.callId && chat.holder && this.outOf(chat, record)) { chat.callId = undefined; this.end(chat); return; } // taken over, or over
    if (chat?.callId !== undefined && message.authorKind === 'human' && message.authorId === HUMAN_ID && message.kind !== 'status' && message.meta.call?.id === chat.callId) { this.personSaid(chat, message); return; }
    if (chat?.callId !== undefined && message.authorKind === 'human' && message.kind !== 'status' && message.meta.call?.id === chat.callId) this.remember(chat, message.id, message.body); // another person's line: its sound may reach my microphone (echoOf)
    const voice = message.authorKind === 'agent' || (message.authorKind === 'system' && chat?.callId !== undefined && message.meta.call?.id === chat.callId); // a system line of my call: the program speaks (runtime/calls/no-lane.ts)
    if (chat && voice && message.kind !== 'status' && !message.silent) this.remember(chat, message.id, message.body);
    if (!chat || chat.sentSeq === null || !voice || message.seq <= chat.sentSeq || message.kind === 'status' || message.silent || this.otherReads(chat)) return;
    if (message.state === 'streaming') { this.piece(chat, message); this.working(chat); return; }
    if (chat.spoken.has(message.id)) return;
    chat.spoken.add(message.id);
    if (chat.spoken.size > 200) chat.spoken = new Set([...chat.spoken].slice(-100));
    chat.awaiting = false;
    this.clearTimer(chat);
    if (message.state === 'failed') { this.end(chat, message.meta.error ?? 'The voice reply failed.'); return; }
    if (chat.pending) { chat.said = undefined; void this.drain(chat); return; } // the person already spoke again
    const whole = message.state === 'final' ? speakable(message.body) : '';
    const text = this.rest(chat, message, whole); // KI-Runde 17.11.: what of this answer was not already read while it was written
    if (text) this.read(chat, message, text); else this.publish();
  }

  /** B-081 / owner 19.11.2026: this device is out of the call – another device took it (the holder), or it is over (joined). */
  private outOf(chat: Chat, record: CallRecord): boolean {
    return chat.joined ? record.endedAt !== undefined : !callMember(record, chat.holder!);
  }

  /** Owner 19.11.2026: another device of the call reads the replies – it heard the person's newest line (or this one joined and heard none yet). */
  private otherReads(chat: Chat): boolean {
    if (chat.heard === undefined) return chat.joined === true && chat.sentSeq === null;
    return chat.sentSeq === null || chat.heard > chat.sentSeq;
  }

  /** Owner 19.11.2026: a person's line of my call, here or on another device; said there, this device goes quiet: the other one reads. */
  private personSaid(chat: Chat, message: Message): void {
    if (message.seq <= (chat.heard ?? -1)) return;
    chat.heard = message.seq;
    if (chat.out || !this.otherReads(chat)) return; // a line of mine on its way
    this.remember(chat, message.id, message.body);
    this.queue = this.queue.filter((reading) => reading.chat !== chat);
    chat.said = undefined;
    chat.awaiting = false;
    this.clearTimer(chat);
    if (this.reading?.chat === chat) { this.reading = null; this.deps.silence(); this.readNext(); }
    this.publish();
    if (this.micId && !this.reading && !this.transcribing && this.held.length) void this.drainHeld(this.micId);
  }

  /** The newest words said in the call by others, by row (the echo check). */
  private remember(chat: Chat, id: string, body: string): void {
    const lately = chat.lately ??= new Map();
    lately.delete(id);
    lately.set(id, speakable(body));
    if (lately.size > 4) lately.delete(lately.keys().next().value!);
  }

  /** A line of this device went out: its reply is awaited – unless another device heard a newer line meanwhile. */
  private awaitReply(chat: Chat): void {
    chat.awaiting = !this.otherReads(chat);
    if (chat.awaiting) this.armTimer(chat);
  }

  /**
   * KI-Runde 17.11.2026 (decision 7.3): the call voice writes its line while it speaks, so each finished sentence of such
   * a row goes to the reader at once; the rest follows when the row is final.
   */
  private piece(chat: Chat, message: Message): void {
    if (message.meta.call?.voice !== 'talker' || chat.callId === undefined || message.meta.call.id !== chat.callId || chat.pending) return;
    const done = sentencesDone(speakable(message.body));
    const already = chat.said?.id === message.id ? chat.said.text : '';
    if (!done || done.length <= already.length) return;
    chat.said = { id: message.id, text: done };
    this.read(chat, message, already && done.startsWith(already) ? done.slice(already.length).trim() : done);
  }

  /** The part of a finished answer that was not read while it was being written. */
  private rest(chat: Chat, message: Message, whole: string): string {
    const already = chat.said?.id === message.id ? chat.said.text : '';
    chat.said = undefined;
    if (!already || !whole) return whole;
    return whole.startsWith(already) ? whole.slice(already.length).trim() : whole;
  }

  /** One piece of an agent's answer into the reading queue, with the speaker's name when it changed. */
  private read(chat: Chat, message: Message, text: string): void {
    const changed = chat.speaker !== undefined && chat.speaker !== message.authorId;
    chat.speaker = message.authorId;
    const name = changed ? speakable(this.deps.nameOf?.(message.authorId) ?? message.meta.call?.name ?? '', 60) : '';
    this.enqueue({ chat, text, ...(name ? { name } : {}) });
  }

  /** The listening chat's replies go before other chats' waiting ones (never before the one being read). */
  private enqueue(reading: Reading): void {
    const at = reading.chat === this.chats[0] ? this.queue.findIndex((other) => other.chat !== reading.chat) : -1;
    if (at < 0) this.queue.push(reading); else this.queue.splice(at, 0, reading);
    if (!this.readNext()) this.publish();
  }

  private readNext(): boolean {
    if (this.reading || !this.micId) return false;
    const next = this.queue.shift();
    if (!next) return false;
    this.reading = next;
    const other = this.chats.length > 1 && this.chats[0] !== next.chat;
    const name = [other ? speakable(next.chat.title, 80) || 'Another chat' : '', next.name ?? ''].filter(Boolean).join(', ');
    this.publish();
    this.deps.speak(this.micId, name ? `${name}: ${next.text}` : next.text);
    return true;
  }

  private focus(chat: Chat): void {
    if (this.chats[0] === chat) return;
    this.chats = [chat, ...this.chats.filter((other) => other !== chat)];
    this.hint = undefined;
    this.publish();
  }

  /** An agent started its answer after the line: the chat waits for it (again). */
  private working(chat: Chat): void {
    if (chat.awaiting || chat.sending || chat.pending) return;
    chat.awaiting = true;
    this.armTimer(chat);
    this.publish();
  }

  /** The wait ends after the reply time – unless an agent of the chat still works (its row streams): then it goes on. */
  private armTimer(chat: Chat): void {
    this.clearTimer(chat);
    chat.cancelTimer = this.deps.after(this.deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS, () => {
      chat.cancelTimer = undefined;
      if (chat.awaiting) void this.waitOn(chat);
    });
  }

  private async waitOn(chat: Chat): Promise<void> {
    const working = await this.deps.rpc.call('chats.get', { id: chat.conversationId }).then((summary) => (summary.working?.length ?? 0) > 0, () => false);
    if (!chat.awaiting || chat.cancelTimer || !this.chats.includes(chat)) return;
    if (working) { this.armTimer(chat); return; }
    chat.awaiting = false; // no reply at all (nobody was addressed): listen again
    this.publish();
  }

  private endCall(callId: string | undefined): void {
    if (callId) void this.deps.rpc.call('calls.end', { callId }).catch(() => undefined);
  }

  private clearTimer(chat: Chat): void {
    const cancel = chat.cancelTimer;
    chat.cancelTimer = undefined;
    cancel?.();
  }

  private end(chat: Chat, error?: string, publish = true): void {
    this.chats = this.chats.filter((other) => other !== chat);
    this.queue = this.queue.filter((reading) => reading.chat !== chat);
    this.clearTimer(chat);
    this.endCall(chat.callId);
    try { chat.release?.(); } catch { /* already released */ }
    if (this.reading?.chat === chat) { this.reading = null; this.deps.silence(); }
    if (!this.chats.length) {
      this.micId = null;
      this.queue = [];
      this.held = [];
      this.transcribing = false;
      this.hint = undefined;
    } else if (!this.reading) this.readNext();
    if (publish) this.publish(error);
  }

  private current(): VoiceSessionView {
    const view = this.view();
    if (!view) throw new Error('Voice conversation was cancelled.');
    return view;
  }

  private publish(error?: string): void { this.deps.publish(this.view(), error, this.sessions()); }
}
