// The call voice: where a call has no realtime model (the chat's voice conversation, shared/voice/conversation.ts) a fast
// small model speaks for the agent while the agent keeps working. The device's speech recognition and reading voice stay;
// only the brain in between is new:
//   messages.send stores a live line quiet and hands it here (heard) when the chat has an agent the voice speaks as
//   (B-081: the agent who rang this call, call-log.ts record; else realtime/setup.ts voiceAgent: its one agent, in a
//   default 1:1 with more members the agent of its pair; else the chat's lead). A line that names someone outside the call
//   goes the normal way. Lines that arrive while the voice still writes are answered together (the running ask is
//   cancelled and asked again with all of them).
//   KI-Runde 17.11.2026 (decisions 7 and 8): the voice is ONE kept session for as long as the call runs
//   (decision/engine-runner.ts createChatOpener on the helper lane), opened when the call starts (call-log.ts → started) –
//   its stable part (talker-prompt.ts voiceSystem: who I am, CALL_VOICE and what my main work knows) is sent once, each
//   spoken line is one input (a cut line keeps the session for the next one), and the answer is plain text
//   read aloud sentence by sentence as the model writes it (voice-row.ts: a row 'streaming' until the answer ends).
//   Its tags are never spoken (voice-text.ts): <as name="…"> opens a team call's answer and names who speaks – no tag
//   means nobody does, and what nobody says but passes on still goes on –, <main now> and <main next> are what goes on to
//   the agent's own work, <silent/> is silence (nothing said, nothing passed on). 'now' is steered into the
//   agent's running turn wherever it runs, and only where its engine cannot steer is that turn cut (dispatcher.urgent);
//   'next' goes through the soft steer to the running turn's next model request, an idle agent through its wake – the
//   hand-over is then that wake's note, so the agent reads it as what it is.
//   A run of the agent that ends during the call and a quiet line of its own work to this chat are one input each – at
//   once when the voice is free, else with its next input –, and the voice says of them what fits, or nothing. What the
//   work posts aloud to the call's chat comes with the voice's next input (the person heard it), and its run gives no note.
//   The end of the call (call-log.ts → ended): with the whole call in its session the voice names per agent of the chat
//   whether the call holds something that agent acts on ("<name>: yes – <what>"); those get one wake whose note says what
//   (FIXES-3b F2), and every agent finds the call's lines as one block at its next turn (agents/turn-finish.ts notes). A
//   verdict in the form of silence names nobody; one that cannot be read otherwise wakes the agents who took part in the
//   call. One log line counts the verdict, nothing of the call's content. A call that left this PC another way only closes
//   its session. No per-agent subconscious run.
// A failed or empty answer, or a line that cannot be stored, goes through the normal delivery: the agent answers as it does
// without the voice (with a team: the one who speaks); when no model can run at all, the call also hears that at once
// (no-lane.ts). voice.talker false turns the voice off.
// Owns: when the voice answers, who speaks, its session's life, what it says and what it passes on. Never: tools, a second
// answer to the same lines, a wake for an answer that passes nothing on, or chat text taken as instructions
// (talker-prompt.ts owns the texts).

import type { CallRecord } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import { MAIN_THREAD } from '../../shared/model/origin.ts';
import type { Run } from '../../shared/model/runs.ts';
import type { RuntimeServices } from '../contracts.ts';
import { saveRepairNotes } from '../agents/turn-finish.ts';
import { chatWakeKey } from '../chat/delivery-route.ts';
import type { ChatOpener, KeptChat } from '../decision/engine-runner.ts';
import { actsOn } from './call-verdict.ts';
import { noLane, sayNoLane } from './no-lane.ts';
import { voiceAgent } from './realtime/setup.ts';
import { flat, voiceAloudNote, voiceEndAsk, voiceLine, voiceQuietNote, voiceRunNote, voiceSystem, type TalkTeam } from './talker-prompt.ts';
import { readVoice, sayableSoFar, sentencesDone, type VoiceAnswer } from './voice-text.ts';
import { VoiceRow } from './voice-row.ts';

export { voiceSystem, type TalkTeam } from './talker-prompt.ts';
export { actsOn } from './call-verdict.ts'; // its home; the voice's verdict is read there

/** One spoken line's answer must be there by then; afterwards the agent's own turn answers. */
export const TALKER_TIMEOUT_MS = 12_000;
/** The voice's last act after the call – the per-agent verdict – has its own budget; nobody waits for it. */
export const CALL_END_MS = 30_000;
/** The note of the wake an agent gets when the ended call holds something it acts on (callWake adds what, when the voice named it). */
export const CALL_WAKE = 'The call in this chat has ended, and it holds something I act on.';
const WORDS_MAX = 1200;
const WHAT_MAX = 300;
const BLOCK_LINES = 120;
const BLOCK_CHARS = 12_000;

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

export interface CallTalkerDeps {
  services: () => RuntimeServices;
  /** Opens one call's kept conversation (decision/engine-runner.ts createChatOpener). */
  voice: ChatOpener;
  timeoutMs?: number;
  /** B-081: the call rows (call-log.ts): who rang a call, its lines, an agent joining it; owner 19.11.2026: whether this PC holds it (holder). */
  calls?: { record(conversationId: string, callId: string): CallRecord | undefined; join(conversationId: string, callId: string, agentId: string): void; holder?(callId: string): string | undefined };
}

/** One call's voice: its session, who it speaks as and the lines it has not answered yet. */
interface Live {
  conversationId: string;
  callId: string;
  agentId: string;
  team?: TalkTeam;
  chat: KeptChat;
  lines: Message[];
  /** What the voice takes in besides the person's lines – a run of the agent that ended, a quiet line of its work – until it answered them. */
  notes: string[];
  /** What the agents' work said aloud in the call's chat: it comes with the voice's next input and starts no answer itself. */
  aloud: string[];
  /** The runs and lines already told (a run is announced more than once as it settles; a run whose answer was read aloud is told). */
  told: Set<string>;
  seq: number;
  controller?: AbortController;
}

/** Who speaks an answer; `known` false while the opening tag is still being written. */
interface Speaker { known: boolean; id: string }

export class CallTalker {
  private readonly deps: CallTalkerDeps;
  private readonly calls = new Map<string, Live>(); // conversation → the voice of its call
  private readonly listening: Array<() => void>;
  private stopped = false;

  constructor(deps: CallTalkerDeps) {
    this.deps = deps;
    const bus = quiet(() => this.s.bus, undefined);
    this.listening = bus
      ? [bus.on('run.upserted', (run) => this.runEnded(run)), bus.on('message.created', (message) => { this.ownLine(message); this.relayed(message); }), bus.on('message.updated', (message) => this.ownLine(message))]
      : [];
  }

  private get s(): RuntimeServices { return this.deps.services(); }

  /** Whether the voice answers the live lines of this chat's call: voice.talker not off, this PC holds the call (owner 19.11.2026: else that PC's voice answers – relay), an agent in the chat it speaks as. */
  serves(conversationId: string, callId?: string): boolean {
    if (this.stopped || quiet(() => this.s.settings.get().voice?.talker, undefined) === false || (callId && this.deps.calls?.holder && this.deps.calls.holder(callId) === undefined)) return false;
    return this.voiceOf(conversationId, callId).agentId !== undefined;
  }

  /** A live line messages.send stored quiet: answered soon (never throws). One that names someone outside the call goes the normal way. */
  heard(message: Message): void {
    const { agentId, team } = this.voiceOf(message.conversationId, message.meta.call?.id);
    const speakers = team ? [...team.inCall, ...team.listening].map((agent) => agent.id) : [agentId];
    if (this.stopped || !agentId || message.mentions.some((id) => !speakers.includes(id) && id !== message.authorId)) { this.deliver(message); return; }
    const entry = this.open(message.conversationId, message.meta.call?.id ?? '', agentId, team);
    entry.lines.push(message);
    entry.controller?.abort(); // a newer line: asked again with every unanswered one
    void this.answer(entry, ++entry.seq).catch((error: unknown) => this.s.log.warn('call voice failed', { conversationId: entry.conversationId, error: String(error) }));
  }

  /** Owner 19.11.2026: a line said on a device joined from another PC (meta.call.relay) reaches the PC that holds the call: its voice answers, else the agent. */
  private relayed(message: Message): void {
    if (message.meta.call?.relay && message.authorKind === 'human' && this.deps.calls?.holder?.(message.meta.call.id) !== undefined) { if (this.serves(message.conversationId, message.meta.call.id)) this.heard(message); else this.deliver(message); }
  }

  /** The call started (call-log.ts start or take): its voice's session opens now, so the first line does not wait for it. Never throws. */
  started(conversationId: string, callId: string): void {
    try {
      if (!this.serves(conversationId, callId)) return;
      const { agentId, team } = this.voiceOf(conversationId, callId);
      const held = this.calls.get(conversationId);
      if (!agentId || held?.callId === callId) return;
      this.open(conversationId, callId, agentId, team).chat.open();
    } catch (error) {
      this.s.log.warn('call voice did not open', { conversationId, error: String(error) });
    }
  }

  /**
   * The call ended (call-log.ts): the voice's last act. With the whole call in its session it names per agent of the chat
   * whether the call holds something that agent acts on; those get one wake with the call's lines as one block, the others
   * find the same block at their next turn. A call that left this PC another way (`handOver` false: another PC took it, or
   * its row was deleted) only closes its session. Never throws.
   */
  ended(conversationId: string, callId: string, handOver = true): void {
    const entry = this.calls.get(conversationId);
    if (!entry || (entry.callId && entry.callId !== callId)) return;
    this.calls.delete(conversationId);
    entry.controller?.abort();
    if (!handOver) { entry.chat.close(); return; }
    void this.handOver(entry)
      .catch((error: unknown) => this.s.log.warn('call hand-over failed', { conversationId, error: String(error) }))
      .finally(() => entry.chat.close());
  }

  /** Shutdown: running asks are cancelled, the sessions let go; their lines get the agent's durable wake. */
  stop(): void {
    this.stopped = true;
    for (const off of this.listening.splice(0)) { try { off(); } catch { /* already off */ } }
    for (const entry of this.calls.values()) {
      entry.controller?.abort();
      entry.chat.close();
      const last = entry.lines.at(-1);
      if (last) this.deliver(last, entry.team ? entry.agentId : undefined);
    }
    this.calls.clear();
  }

  /**
   * Who the voice speaks as: the agent who rang the call, else voiceAgent, else the chat's lead (KI-Runde 17.11.: every
   * call has a voice) – an agent whose work is paused only when every agent of the chat is. A call in a chat with more
   * agents has a team: that speaker first, every other agent listening.
   */
  private voiceOf(conversationId: string, callId: string | undefined): { agentId?: string; team?: TalkTeam } {
    const s = this.s;
    const record = callId ? quiet(() => this.deps.calls?.record(conversationId, callId), undefined) : undefined;
    const active = this.agentsOf(conversationId);
    const atWork = active.filter((agent) => !agent.paused);
    const known = (id: string | undefined) => (id && (atWork.length ? atWork : active).some((agent) => agent.id === id) ? id : undefined);
    const speaker = known(record?.ring?.by) ?? known(quiet(() => voiceAgent(s, conversationId), undefined)) ?? known(quiet(() => s.chats.lead(conversationId), undefined)) ?? active[0]?.id;
    if (!speaker || active.length < 2 || !callId) return { agentId: speaker };
    const inCall = [speaker, ...(record?.agents ?? []).filter((id) => id !== speaker)].flatMap((id) => active.filter((agent) => agent.id === id));
    const ringBy = active.find((agent) => agent.id === record?.ring?.by)?.name;
    return { agentId: speaker, team: { callId, inCall, listening: active.filter((agent) => !inCall.includes(agent)), why: record?.ring?.why, ...(ringBy ? { ringBy } : {}) } };
  }

  /** The chat's agents that are in it now, the ones at work first. */
  private agentsOf(conversationId: string): Array<{ id: string; name: string; paused: boolean }> {
    const s = this.s;
    return quiet(() => s.chats.members(conversationId), []).filter((member) => member.kind === 'agent' && member.leftAt === undefined)
      .map((member) => s.org.get(member.memberId)).filter((agent) => agent && agent.archivedAt === undefined)
      .sort((a, b) => Number(a!.status === 'paused') - Number(b!.status === 'paused'))
      .map((agent) => ({ id: agent!.id, name: agent!.name, paused: agent!.status === 'paused' }));
  }

  /** The call's voice, opened with its stable part at the first line; a new call in that chat opens a new session. */
  private open(conversationId: string, callId: string, agentId: string, team: TalkTeam | undefined): Live {
    const held = this.calls.get(conversationId);
    if (held && held.callId === callId) { held.agentId = agentId; held.team = team; return held; }
    if (held) { held.controller?.abort(); held.chat.close(); }
    const entry: Live = {
      conversationId, callId, agentId, team, lines: [], notes: [], aloud: [], told: new Set(), seq: 0,
      chat: this.deps.voice({ purpose: 'call voice', system: voiceSystem(this.s, agentId, conversationId, team), effort: 'low' }), // decision 7.5; TALK 19.11.2026: Luna thinks 0 tokens on a line at low – 'none' and the fast tier measured no sooner first word
    };
    this.calls.set(conversationId, entry);
    return entry;
  }

  private async answer(entry: Live, run: number): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    const lines = [...entry.lines];
    const notes = [...entry.notes];
    const aloud = [...entry.aloud];
    const row = new VoiceRow(this.deps.services, { conversationId: entry.conversationId, callId: entry.callId, agentId: entry.agentId, name: this.nameOf(entry.agentId) });
    let raw = '';
    let spoken = '';
    let nobody = false;
    const onText = (delta: string) => {
      raw += delta;
      if (nobody || this.stopped || entry.seq !== run) return;
      const who = this.speakerOf(entry, raw);
      if (!who.known) return;
      if (!who.id) { nobody = true; return; } // no opening tag: nobody speaks
      const piece = sentencesDone(sayableSoFar(raw));
      if (piece.length <= spoken.length) return;
      spoken = piece;
      row.speaks(who.id, this.nameOf(who.id));
      this.keep(row, piece); // decision 7.3: each finished sentence goes to the reader at once
    };
    // The line runs once more (its session was gone, another account): its text starts anew; what the reader already has
    // stays, so the new text is read on only past it and the opening is never heard twice.
    const onRestart = () => { raw = ''; nobody = false; };
    let failed: unknown;
    const input = [...aloud, ...notes, ...(lines.length ? [voiceLine(this.s, lines)] : [])].join('\n\n');
    const said = await entry.chat.say({ input, signal: controller.signal, deadlineMs: this.deps.timeoutMs ?? TALKER_TIMEOUT_MS, onText, onRestart })
      .catch((error: unknown) => { failed = error; return undefined; });
    if (this.stopped || entry.seq !== run) { this.keep(row, spoken, true); return; } // a newer line asked again: that run answers these too
    // The call ended while the voice wrote: what it said stands, and the end's hand-over carries the call's lines.
    if (this.calls.get(entry.conversationId) !== entry) { this.keep(row, spoken, true); return; }
    entry.controller = undefined;
    entry.lines = [];
    entry.notes = entry.notes.slice(notes.length);
    if (said) entry.aloud = entry.aloud.slice(aloud.length); // the voice knows it now
    if (entry.notes.length) void this.answer(entry, ++entry.seq).catch(() => undefined); // a note that came while it wrote
    const last = lines.at(-1);
    if (!said) {
      if (noLane(failed)) sayNoLane(this.s, entry.conversationId, entry.callId || undefined); // no model can run: the call hears it at once
      this.keep(row, spoken, true);
      if (last) this.deliver(last, entry.team ? entry.agentId : undefined);
      return;
    }
    const text = said.text || raw;
    const who = this.speakerOf(entry, text);
    const answer = readVoice(text);
    if (!who.id) { // nobody speaks: the lines stay quiet in the chat, the agents read them next turn – and what the voice passes on goes on
      this.keep(row, spoken, true);
      if (answer.now || answer.next) await this.passOn(entry, lines, { ...answer, say: '' }, entry.agentId);
      return;
    }
    if (entry.team && !entry.team.inCall.some((agent) => agent.id === who.id)) quiet(() => this.deps.calls?.join(entry.conversationId, entry.team!.callId, who.id), undefined);
    row.speaks(who.id, this.nameOf(who.id));
    // FIXES-3 E1 (review R1): silence written out before its tag – the row goes; what the reader already read cannot be taken back
    const stored = this.keep(row, answer.silent ? '' : answer.say || spoken, true, said.by);
    if (answer.say && !stored) { if (last) this.deliver(last, entry.team ? entry.agentId : undefined); return; }
    await this.passOn(entry, lines, answer, who.id);
  }

  /** The words into the voice's row – growing while it writes, final when the answer ends; false when the row could not be stored. */
  private keep(row: VoiceRow, text: string, done = false, model?: string): boolean {
    try {
      if (done) row.close(text, model); else row.write(text);
      return true;
    } catch (error) {
      this.s.log.warn('call voice line not stored', { error: String(error) });
      return false;
    }
  }

  /** Without a team the agent speaks; with one the `<as …>` tag names who does, and words without that tag are nobody. */
  private speakerOf(entry: Live, text: string): Speaker {
    if (!entry.team) return { known: true, id: entry.agentId };
    const as = readVoice(text).as;
    if (as !== undefined) {
      const wanted = as.trim().toLowerCase();
      const who = [...entry.team.inCall, ...entry.team.listening].find((agent) => agent.id.toLowerCase() === wanted || agent.name.toLowerCase() === wanted);
      return { known: true, id: who?.id ?? (wanted ? entry.team.inCall[0]?.id ?? '' : '') };
    }
    return sayableSoFar(text).trim() ? { known: true, id: '' } : { known: false, id: '' };
  }

  private nameOf(agentId: string): string {
    return quiet(() => this.s.org.get(agentId)?.name, undefined) ?? 'Agent';
  }

  /**
   * What the voice passes on (decision 8.1): 'now' into the agent's running turn wherever it runs, 'next' to that turn's
   * next model request. Where it is not steered – an idle agent, an engine that cannot steer – the hand-over is the note
   * of the agent's wake in the call's chat, and 'now' cuts a running turn.
   */
  private async passOn(entry: Live, lines: Message[], answer: VoiceAnswer, agentId: string): Promise<void> {
    const mode = answer.now ? 'now' : answer.next ? 'next' : undefined;
    const pass = answer.now ?? answer.next;
    if (!mode || !pass) return;
    const s = this.s;
    const last = lines.at(-1);
    const to = entry.team ? agentId : undefined; // with a team the line goes to the one who spoke
    const text = handOver(mode, entry.conversationId, lines, answer.say, pass);
    const steered = await Promise.resolve(s.dispatcher.relay?.(agentId, entry.conversationId, text, mode)).catch(() => false);
    if (steered) return;
    if (last) this.deliver(last, to);
    try { s.wakes.wake({ agentId, reason: 'message', conversationId: entry.conversationId, note: text, coalesceKey: chatWakeKey(entry.conversationId) }); } catch (error) {
      s.log.warn('call voice: hand-over wake failed', { conversationId: entry.conversationId, error: String(error) });
    }
    if (mode === 'now') await s.dispatcher.urgent(agentId, entry.conversationId).catch((error: unknown) => s.log.warn('call voice: urgent failed', { conversationId: entry.conversationId, error: String(error) }));
  }

  /** The line goes the normal way after all: the delivery's wake (with a task that waits on the person); `to`: that agent only. */
  private deliver(line: Message, to?: string): void {
    try { this.s.delivery.onMessage({ ...line, silent: false, ...(to ? { mentions: [to] } : {}) }); } catch (error) {
      this.s.log.warn('call voice: delivery failed', { conversationId: line.conversationId, error: String(error) });
    }
  }

  /**
   * A run of the agent that ended while the call runs: one short input for the voice (decision 7.2). A run that ended
   * without words tells it nothing (real run 18.11.2026: the voice filled such a note with an answer the person had heard).
   */
  private runEnded(run: Run): void {
    if (this.stopped || run.endedAt === undefined || run.splitId || !run.summary?.trim()) return;
    for (const entry of [...this.calls.values()]) {
      if (entry.told.has(run.id) || !this.speaksFor(entry, run.agentId)) continue;
      entry.told.add(run.id);
      this.take(entry, voiceRunNote(this.s, run.agentId, run.summary));
    }
  }

  /**
   * A finished line of an agent's own work in the call's chat (not the voice's). A quiet one is the voice's next input, said in
   * its own words when it fits (decision 8.2). One the device reads aloud comes with the voice's next input, so the voice
   * knows what the person heard and says nothing twice; the run that wrote it gives no run note. A call turn's answer carries
   * the call in its meta and is such a line; only the voice's own rows (meta.call.voice) are not.
   */
  private ownLine(message: Message): void {
    if (this.stopped || message.authorKind !== 'agent' || message.kind !== 'text' || message.state !== 'final' || message.meta.call?.voice !== undefined || !message.body.trim()) return;
    const entry = this.calls.get(message.conversationId);
    if (!entry || entry.told.has(message.id)) return;
    if (!message.silent) {
      entry.told.add(message.id);
      if (message.runId) entry.told.add(message.runId);
      entry.aloud.push(voiceAloudNote(this.s, message.authorId, message.body));
      return;
    }
    if (!this.speaksFor(entry, message.authorId)) return;
    entry.told.add(message.id);
    this.take(entry, voiceQuietNote(this.s, message.authorId, message.body));
  }

  /** Whether the call's voice speaks for that agent. */
  private speaksFor(entry: Live, agentId: string): boolean {
    return entry.team ? entry.team.inCall.some((agent) => agent.id === agentId) : entry.agentId === agentId;
  }

  /** One input of the agent's own work: answered at once when the voice is free, else with what it answers next – said in its words, or nothing. */
  private take(entry: Live, note: string): void {
    entry.notes.push(note);
    if (entry.controller) return;
    void this.answer(entry, ++entry.seq).catch((error: unknown) => this.s.log.warn('call voice failed', { conversationId: entry.conversationId, error: String(error) }));
  }

  /** Decision 8.4: the voice's per-agent verdict of the ended call, the wakes it causes and the block every agent gets. */
  private async handOver(entry: Live): Promise<void> {
    const s = this.s;
    const agents = this.agentsOf(entry.conversationId);
    const block = this.callBlock(entry);
    if (!agents.length || !block) return;
    const verdict = await entry.chat.say({ input: voiceEndAsk(agents), deadlineMs: CALL_END_MS }).catch((error: unknown) => {
      s.log.info('call voice gave no end verdict', { conversationId: entry.conversationId, error: String(error) });
      return undefined;
    });
    // FIXES-3b F2: the form of silence names nobody to act; a verdict that cannot be read otherwise (none came, or it names
    // nobody): the agents who took part in the call look for themselves.
    const read = verdict ? actsOn(verdict.text, agents) : undefined;
    const silent = !read && verdict !== undefined && readVoice(verdict.text).silent === true;
    const acts = read ?? new Map((silent ? [] : entry.team ? entry.team.inCall.map((agent) => agent.id) : [entry.agentId]).map((id) => [id, '']));
    s.log.info('call end verdict', { conversationId: entry.conversationId, callId: entry.callId, agents: agents.length, act: acts.size, read: read !== undefined, silent });
    for (const agent of agents) {
      try { saveRepairNotes(s, agent.id, MAIN_THREAD, [block]); } catch (error) { s.log.warn('call block not kept', { agentId: agent.id, error: String(error) }); }
      if (!acts.has(agent.id)) continue;
      try { s.wakes.wake({ agentId: agent.id, reason: 'message', conversationId: entry.conversationId, note: callWake(acts.get(agent.id)), coalesceKey: `call:${entry.callId}` }); } catch (error) {
        s.log.warn('call wake failed', { agentId: agent.id, error: String(error) });
      }
    }
  }

  /** The call's lines as one block, as the agents read it. */
  private callBlock(entry: Live): string | undefined {
    const record = entry.callId ? quiet(() => this.deps.calls?.record(entry.conversationId, entry.callId), undefined) : undefined;
    const lines = (record?.lines ?? []).slice(-BLOCK_LINES).map((line) => `${line.name}: ${line.text}`).join('\n');
    if (!lines.trim()) return undefined;
    return `The call in this chat has ended. What was said in it, in order:\n${lines.slice(0, BLOCK_CHARS)}`;
  }
}

/** The hand-over as the agent's own history reads it: my call voice passed this on, with the words on both sides. */
export function handOver(mode: 'now' | 'next', chat: string, lines: Message[], said: string, pass: string): string {
  const words = flat(lines.map((line) => line.body).join(' / '), WORDS_MAX).replace(/"/g, "'");
  const heard = `What I post to the call's chat ${chat} while the call runs is read aloud to the person; a quiet line there goes to my voice, which says it in its own words.`;
  return [
    mode === 'now'
      ? `[Live call: my live voice passes this on now] I take it into account in this work now. ${heard}`
      : `[Live call: my live voice passes this on for my next step] It reaches this work at its next step; nothing of it has to stop. ${heard}`,
    words ? `The person said: "${words}"` : '',
    said ? `My voice told them: "${said.replace(/"/g, "'")}"` : 'My voice said nothing to them.',
    `What my voice passes on: "${pass.replace(/"/g, "'")}"`,
  ].filter(Boolean).join('\n');
}

/** The note of the wake the end of a call gives: CALL_WAKE with what I act on (flat, cut), so the turn starts from its reason. */
export function callWake(what?: string): string {
  const reason = flat(what ?? '', WHAT_MAX).replace(/[\s.]+$/, '');
  return reason ? `${CALL_WAKE.slice(0, -1)}: ${reason}.` : CALL_WAKE;
}
