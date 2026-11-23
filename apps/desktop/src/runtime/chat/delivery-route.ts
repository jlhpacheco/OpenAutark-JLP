// Routing of a committed text message for chat/delivery.ts (split out of it in B-050 round 4; the rules are in its
// header): which agents it wakes, steers or reaches in their running turn, the responder pick with the lead's
// crash-safe provisional wake, the loop guards and the hand-over of a paused chat to its lead.
// Round 4 (owner: "kein Unterschied, ob der CEO da dabei ist oder nicht. Das ist halt einfach wie wenn eine KI dabei
// ist oder nicht."): waking is author-neutral. An agent's (or an external agent's) normal line in a room of three or
// more that @mentions nobody goes through the same responder pick as a person's – the author is never an option,
// reply modes apply ('all' agents hear it, only 'auto' ones are picked) – and the pick may answer that nobody needs
// to reply, for every author (chat/responders.ts NOBODY). The one asymmetry is the safety fallback: without a decision
// model, or when it is unsure or fails, a person's line wakes the lead (a person waits for an answer; a provisional
// wake keeps that across a crash), an agent's line wakes nobody (an agent's statement mostly needs no reply; no
// provisional wake). So an agent's line is asked about even when only one colleague could answer: the alternative is
// nobody, not that colleague. 13.11.2026 (owner): an agent's push line (priority 'important', agents/chat-out.ts) reaches
// every agent of the chat at once – their running turn at its next step, else a wake; an agent's @mention reaches exactly
// that colleague, in a quiet line too (into its running turn as well). A discussion of agents without a person's line, task progress or work between the lines ends in the loop guard
// (chat/loop-guard.ts: two alternating, or many changes of speaker in a group). B-080: a line that @mentions a colleague
// always wakes them and ends such a pause, and so does a line from a turn that did work (chat/worked.ts); the rate cap
// counts every line and lifts itself once the minute has room.
// B-078 D8: a person's line wakes one responder – the pick names one, else the lead – never several at once; the
// others read it in their context on their next turn. An agent's line may still reach two (maxResponders).
// B-080 (owner 08.11.2026: a line goes into the running turn "mittendrin", as in Codex and Claude Code; live 07.11. his
// "Ihr sollt jetzt autonom versenden" in Kernteam reached three agents 6.3 h later): every un-quiet line that wakes an
// agent – a colleague's too – reaches its running turn at the next step (wakeAll → dispatcher.steer), an important one
// through dispatcher.urgent, which inserts it the same way and cuts only for a line the turn cannot take; a person's
// un-quiet line in a group also reaches every agent there that works right now, wherever it works (hearAll →
// dispatcher.hear) – the pick still names the one who answers; an agent that answers only when @mentioned hears only its mentions.
// 07.11.2026: a message's wake handed over from another PC is delivered here like a local line (deliverHandedOver).
// Owns: those routing steps, the guards' counters and the decisions in flight. Never: notifies the person, decides
// what counts as important (delivery does), or writes messages other than the guard's status lines. A line of the one a
// task waits on wakes its owner with that task; a colleague's line opens it, a person's leaves the wait to its owner.
// Quests 20.11.2026: a task's thread (tasks/thread.ts) – every wake from it carries its task, and a person's line there
// that @mentions nobody is the task owner's to answer (an agent owner, else the thread's lead): no pick.

import type { RuntimeServices } from '../contracts.ts';
import { isTaskThread, messageLevel, type Member, type Message } from '../../shared/model/chat.ts';
import { isExternalAgent } from '../bridges/external-agents.ts';
import { externalAgentName } from '../../shared/model/external-agents.ts';
import { waitIn } from '../tasks/transitions.ts';
import { markAddressed } from './addressed.ts'; // privacy fix 15.11.2026: which person's lines reached whom
import { isDirect } from './direct.ts';
import { LoopGuard, type LoopGuardOptions } from './loop-guard.ts';
import { isPersonMention } from './mentions.ts';
import { PICKED_NOTE, pickResponders } from './responders.ts'; // C4-live: a picked agent's wake says the line is its to answer
import { replyModeOf, replyModeSplit } from './reply-modes.ts';
import { runWorked } from './worked.ts';

export type DeliveryDeps = Pick<RuntimeServices, 'chats' | 'wakes' | 'clock'>
  & Partial<Pick<RuntimeServices, 'org' | 'decisions' | 'dispatcher' | 'notifications' | 'log' | 'tasks' | 'runs' | 'tools' | 'db' | 'bus' | 'people'>>; // people (F-52): colleagues' names; runs/tools (B-080): chat/worked.ts

/** How long the lead's provisional wake waits for the decision model before it answers itself. */
export const PROVISIONAL_WAKE_MS = 15_000;

/** Coalesce keys: the normal message wake of a chat, and the lead's provisional one. */
export const chatWakeKey = (conversationId: string) => `chat:${conversationId}`;
export const provisionalWakeKey = (conversationId: string) => `pick:${conversationId}`;

export interface RouteOptions extends LoopGuardOptions { maxResponders?: number; maxExternalPerMinute?: number }

/** How a routed message reaches agents: steer them (important), and who was steered already. */
interface Urgency { urgent?: boolean; steered?: string[] }

export class DeliveryRouter {
  private readonly s: DeliveryDeps;
  private readonly guard: LoopGuard;
  /** Rate cap for external (bridged) authors; ping-pong and discussion detection are effectively off (people chat back and forth). */
  private readonly externalGuard: LoopGuard;
  private readonly maxResponders: number;
  /** Decisions in flight per `<chat>\0<lead>`: the provisional wake stays until the last one returned. */
  private readonly deciding = new Map<string, number>();

  constructor(deps: DeliveryDeps, options: RouteOptions = {}) {
    this.s = deps;
    this.guard = new LoopGuard(options);
    this.externalGuard = new LoopGuard({ maxPerMinute: options.maxExternalPerMinute ?? 10, pingPongTurns: 1000, discussionTurns: Infinity });
    this.maxResponders = options.maxResponders ?? 2;
  }

  /** Real task progress breaks agent ping-pong. */
  progress(conversationId: string): void {
    this.guard.reset(conversationId);
  }

  /**
   * Counts an agent-like line in the loop guard; false (after the guard's status line) when agents' wakes are paused in
   * that chat. B-080: a line that @mentions a colleague (`addressed`) or carries work (chat/worked.ts) counts for the
   * rate and ends a back-and-forth pause (loop-guard.ts).
   */
  agentLine(message: Message, addressed = false): boolean {
    const verdict = this.guard.agentMessage(message.conversationId, message.authorId, message.createdAt, addressed || this.worked(message));
    if (verdict === 'ok') return true;
    this.pauseLine(message, verdict);
    return false;
  }

  route(message: Message, members: Member[], important: boolean, external: string[]): void {
    if (message.kind !== 'text') return; // task anchors and answer receipts wake explicitly
    const agents = members.filter(m => m.kind === 'agent' && m.memberId !== message.authorId).map(m => m.memberId);
    // whoever has a task waiting on the writer hears this line with that task, whatever the routing below decides
    const waiters = agents.filter(agentId => this.waitingTask(message.conversationId, agentId, message.authorId));
    if (waiters.length) this.wakeAll(message, waiters, { fold: true });
    const agentLike = message.authorKind === 'agent' || isExternalAgent(message.authorId); // C8
    const mentioned = message.mentions.filter(id => agents.includes(id));
    // B-080: our agent's @mention of a colleague is addressed; an external agent's (C8) still counts as back-and-forth.
    const toColleague = message.authorKind === 'agent' && mentioned.length > 0;
    if (agentLike && (agents.length || members.some(m => isExternalAgent(m.memberId) && m.memberId !== message.authorId)) && !this.agentLine(message, toColleague)) return;
    if (!agents.length) return;

    if (agentLike) {
      // 13.11.2026: a push line reaches every agent here at once (their running turn at its next step).
      if (important) { this.wakeAll(message, agents, { urgent: true }); return; }
      // K3: in a room of two the other member (an agent here) is addressed; an @mention reaches exactly that colleague – also
      // from a quiet line, into its running turn too (B-080: live 07.11. a colleague's "stop" reached a turn an hour later).
      const pair = !message.silent && members.length === 2 && members.some(m => m.memberId === message.authorId);
      if (pair || mentioned.length || message.silent) { this.wakeAll(message, pair ? agents : mentioned, { fold: true }); return; }
    } else {
      if (message.authorKind === 'external') {
        const verdict = this.externalGuard.agentMessage(message.conversationId, message.authorId, message.createdAt);
        if (verdict !== 'ok') { this.pauseLine(message, verdict); return; }
      }
      if (message.authorKind === 'human') { this.guard.reset(message.conversationId); this.externalGuard.reset(message.conversationId); }
    }
    if (!mentioned.length && external.length) return; // C8: only external agents are addressed – they hear external.mention
    // K3: addressed only to people (the owner, a colleague, a bridged contact) – no agent is woken or steered.
    if (!mentioned.length && message.mentions.some(id => id !== message.authorId && isPersonMention(id))) return;
    if (message.authorKind === 'human' && !message.silent && agents.length > 1) this.hearAll(message, agents, mentioned); // B-080

    // Round 4: from here on every author is routed alike – only an agent's line falls back to nobody and is never urgent.
    const urgent = important && !agentLike;
    // The person's important message also steers whoever already works in this chat (T10) – before
    // a decision is made, else after the addressed agents were woken.
    const steer = important && message.authorKind === 'human';
    // Reply modes (chat/reply-modes.ts): 'all' agents hear it; only 'auto' ones are picked; none → nobody else.
    const split = mentioned.length ? undefined : replyModeSplit(this.s.chats, message.conversationId, agents);
    if (split) this.wakeAll(message, split.always, { urgent });
    const pickable = split?.pickable ?? agents;
    const always = split?.always ?? []; // already woken (urgent when important): never steered twice
    if (!pickable.length) { if (steer) this.steerRunning(message, agents, always); return; }
    const thread = !agentLike && isTaskThread(message.conversationId); // a person's line in a task's thread: its owner answers
    const lead = agentLike ? undefined : (thread ? this.taskOwner(message.conversationId, pickable) : undefined) ?? this.fallback(message.conversationId, pickable);
    if (!thread && !mentioned.length && (agentLike || pickable.length > 1) && this.s.decisions?.available()) {
      const steered = steer ? this.steerRunning(message, agents, always) : [];
      this.decide(message, pickable, lead, { urgent, steered });
      return;
    }
    const addressed = mentioned.length ? mentioned : lead !== undefined ? [lead] : []; // no decision model: an agent's line wakes nobody
    this.wakeAll(message, addressed, { urgent });
    if (steer) this.steerRunning(message, agents, [...addressed, ...always]);
  }

  /** The lead of the chat when it is one of `agents`, else the first of them. */
  private fallback(conversationId: string, agents: string[]): string {
    const lead = this.s.chats.lead(conversationId);
    return lead && agents.includes(lead) ? lead : agents[0];
  }

  /** The agent that owns the task of thread `taskId`, when it is one of `agents`. */
  private taskOwner(taskId: string, agents: string[]): string | undefined {
    try {
      const task = this.s.tasks?.get(taskId);
      return task?.assigneeKind === 'agent' && task.assigneeId && agents.includes(task.assigneeId) ? task.assigneeId : undefined;
    } catch (error) {
      this.s.log?.warn('the owner of a task thread is unknown', { taskId, error: String(error) });
      return undefined;
    }
  }

  /** B-080: the person's line into the running turn of every agent of the group at work (dispatcher.hear); 'mentions' agents only when named. */
  private hearAll(message: Message, agents: string[], mentioned: string[]): void {
    const dispatcher = this.s.dispatcher;
    if (typeof dispatcher?.hear !== 'function') return;
    for (const agentId of agents) {
      if (!mentioned.includes(agentId) && replyModeOf(this.s.chats, message.conversationId, agentId) === 'mentions') continue;
      dispatcher.hear(agentId, message.conversationId).catch(error => this.s.log?.warn('group line not heard', { agentId, error: String(error) }));
    }
  }

  /** Steers (dispatcher.urgent) the chat's agents – except `asked` – whose running turn is in this chat; returns them. */
  private steerRunning(message: Message, agents: string[], asked: string[]): string[] {
    const dispatcher = this.s.dispatcher;
    if (typeof dispatcher?.activity !== 'function') return [];
    let running: string[];
    try {
      running = dispatcher.activity()
        .filter(run => !run.split && run.conversationId === message.conversationId && agents.includes(run.agentId) && !asked.includes(run.agentId)) // B-057: never a split's lane
        .map(run => run.agentId);
    } catch (error) {
      this.s.log?.warn('running turns unknown', { conversationId: message.conversationId, error: String(error) });
      return [];
    }
    markAddressed(this.s, message, running);
    for (const agentId of running) this.urge(agentId, message.conversationId);
    return running;
  }

  /**
   * The decision path: the picked agents are woken when the pick returns, nobody when it says no reply is needed. A
   * person's line (`lead` set) gives the lead a provisional wake now and falls back to it; an agent's line to nobody.
   */
  private decide(message: Message, agents: string[], lead: string | undefined, urgency: Urgency): void {
    const key = lead === undefined ? undefined : `${message.conversationId}\u0000${lead}`;
    if (lead !== undefined && key !== undefined) {
      this.wakeAll(message, [lead], { dueAt: this.s.clock.now() + PROVISIONAL_WAKE_MS, coalesceKey: provisionalWakeKey(message.conversationId) });
      this.deciding.set(key, (this.deciding.get(key) ?? 0) + 1);
    }
    const settle = (picked: string[] | 'nobody') => {
      let left = 0;
      if (key !== undefined) {
        left = (this.deciding.get(key) ?? 1) - 1;
        if (left > 0) this.deciding.set(key, left);
        else this.deciding.delete(key);
      }
      try {
        this.wakeAll(message, picked === 'nobody' ? [] : picked.length ? picked : lead !== undefined ? [lead] : [], { ...urgency, ...(picked !== 'nobody' && picked.length ? { note: PICKED_NOTE } : {}) });
      } finally {
        if (lead !== undefined && left <= 0) this.s.wakes.cancelKey?.(lead, provisionalWakeKey(message.conversationId));
      }
    };
    pickResponders(this.s, message, agents, lead !== undefined ? 1 : this.maxResponders) // D8: a person's line: one
      .then(settle, () => settle([]))
      .catch((error: unknown) => this.s.log?.warn('responder delivery failed', { messageId: message.id, error: String(error) }));
  }

  private wakeAll(message: Message, agentIds: string[], options: Urgency & { dueAt?: number; coalesceKey?: string; note?: string; fold?: boolean } = {}): void {
    const thread = isTaskThread(message.conversationId) ? message.conversationId : undefined; // its wakes carry the task
    for (const agentId of agentIds) {
      const waiting = message.authorId !== agentId ? this.waitingTask(message.conversationId, agentId, message.authorId) : undefined;
      this.s.wakes.wake({
        agentId, reason: 'message', conversationId: message.conversationId, coalesceKey: options.coalesceKey ?? chatWakeKey(message.conversationId),
        ...(options.dueAt !== undefined ? { dueAt: options.dueAt } : {}),
        ...(waiting ? { taskId: waiting } : { ...(thread ? { taskId: thread } : {}), ...(options.note ? { note: options.note } : {}) }),
      });
      if (waiting && message.authorKind !== 'human') this.opened(waiting, message.authorId); // a wait on a person stays until its owner moves it
    }
    // A person's line is the woken agents' own – a provisional wake's not yet: the pick may choose another (settle marks).
    if (options.dueAt === undefined) markAddressed(this.s, message, agentIds);
    // A provisional wake never interrupts; external authors do only when trusted (else never important); a steered agent was asked already.
    if (options.dueAt !== undefined) return;
    if (!options.urgent) {
      if (!message.silent || options.fold) for (const agentId of agentIds) this.fold(agentId, message.conversationId); // B-080: every un-quiet line that wakes an agent, a colleague's too; an @mention always
      return;
    }
    for (const agentId of agentIds) if (!options.steered?.includes(agentId)) this.urge(agentId, message.conversationId);
  }

  /** The person's normal message reaches the agent's running turn in this chat at its next step (dispatcher.steer). */
  private fold(agentId: string, conversationId: string): void {
    const dispatcher = this.s.dispatcher;
    if (typeof dispatcher?.steer !== 'function') return;
    dispatcher.steer(agentId, conversationId).catch(error => {
      this.s.log?.warn('message fold failed', { agentId, error: String(error) });
    });
  }

  private urge(agentId: string, conversationId: string): void {
    this.s.dispatcher?.urgent(agentId, conversationId).catch(error => {
      this.s.log?.warn('urgent delivery failed', { agentId, error: String(error) });
    });
  }

  /**
   * The agent's one task waiting on the writer (a person or an agent) – here, or anywhere when this is our 1:1; nobody's
   * words settle a wait on someone else. Its wake carries it; a colleague's line opens it, a person's leaves it waiting
   * until its owner changes it (KI-Runde 17.11.2026: every line of the person re-opened an umbrella task that its owner
   * then parked again – two status lines per line of theirs).
   */
  private waitingTask(conversationId: string, agentId: string, authorId: string): string | undefined {
    if (!this.s.tasks) return undefined;
    try {
      const chat = this.s.chats.get(conversationId);
      return waitIn(this.s.tasks, conversationId, agentId, authorId, Boolean(chat && isDirect(chat)))?.id;
    } catch (error) {
      this.s.log?.warn('looking up the waiting task failed', { conversationId, agentId, error: String(error) });
      return undefined;
    }
  }

  /** The line of the one a task waits on opens it: their line is the news its owner reads (the wake above carries the task). */
  private opened(taskId: string, by: string): void {
    try { this.s.tasks?.update(taskId, { status: 'open' }, by); } catch (error) {
      this.s.log?.warn('opening the waiting task failed', { taskId, error: String(error) });
    }
  }

  /** B-080: whether the line's run did work (chat/worked.ts); false without a run or when its journal cannot say. */
  private worked(message: Message): boolean {
    if (!message.runId) return false;
    try {
      return runWorked(this.s, message.runId);
    } catch (error) {
      this.s.log?.warn('run work unknown for the loop guard', { messageId: message.id, error: String(error) });
      return false;
    }
  }

  private pauseLine(message: Message, verdict: 'rate' | 'ping_pong' | 'paused'): void {
    if (verdict === 'paused') return; // status line was posted when the pause began
    const text = verdict === 'rate' ? 'Agent replies paused: message rate limit' : 'Agent replies paused: back-and-forth without work in between';
    this.s.log?.warn('loop guard paused chat', { conversationId: message.conversationId, verdict });
    this.s.chats.status(message.conversationId, { type: 'note', text, details: { guard: verdict } });
    // A loop (two alternating, or a group discussion): hand the situation to the lead, unless the lead took part in it.
    if (verdict !== 'ping_pong') return;
    const lead = this.s.chats.lead(message.conversationId);
    const loop = this.guard.pair(message.conversationId);
    if (lead && !loop.includes(lead)) {
      // B-080: the lead's wake note is read by its AI – in its own voice.
      const names = nameList(loop.map((id) => (isExternalAgent(id) ? externalAgentName(id) : this.s.org?.get(id)?.name ?? id)));
      const note = `${names} answered each other here again and again with no work between the lines – I see what they are missing and settle it in this chat.`;
      this.s.wakes.wake({ agentId: lead, reason: 'review', conversationId: message.conversationId, note, coalesceKey: `guard:${message.conversationId}` });
    }
  }
}

/** "Mira", "Mira and Tom", "Mira, Tom and Ada". */
function nameList(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * 07.11.2026 (Befund qa-2026-11-07: the importance got lost between PCs): a message's wake handed over from another PC
 * (devices/sync/rows.ts wakeHere) for an agent that runs here. The writer's PC could not reach the turn running here, so
 * this PC reads the agent's unseen text lines of others in that chat and acts as a local delivery would: a person's
 * important one → dispatcher.urgent (into the running turn at its next step, that chat next), else any other author's
 * un-quiet one → dispatcher.steer (folded at the next step, from another chat too – B-080: a colleague's line as well, as
 * wakeAll folds it locally; 'important' stays for people's lines), only quiet ones → the wake alone.
 */
export function deliverHandedOver(s: Pick<RuntimeServices, 'chats' | 'dispatcher' | 'log'> & Partial<Pick<RuntimeServices, 'db' | 'clock'>>, agentId: string, conversationId: string): void {
  let level: 'important' | 'normal' | undefined;
  try {
    const members = s.chats.members(conversationId);
    const member = members.find(m => m.memberId === agentId && !m.leftAt);
    if (!member) return;
    const pair = members.filter(m => !m.leftAt).length === 2;
    for (const line of s.chats.messages(conversationId, { afterSeq: member.readSeq, limit: 200 })) {
      if (line.kind !== 'text' || line.authorId === agentId) continue;
      // The writer's PC picked this agent; here only what is sure is its own: our 1:1 or its @mention (privacy fix 15.11.).
      if (line.silent !== true && (pair || line.mentions.includes(agentId))) markAddressed(s, line, [agentId]);
      const lineLevel = messageLevel(line);
      if (lineLevel === 'important' && line.authorKind === 'human') level = 'important';
      else if (lineLevel !== 'silent' && !level) level = 'normal';
    }
  } catch (error) {
    s.log.warn('handed-over line unread', { agentId, conversationId, error: String(error) });
    return;
  }
  const failed = (error: unknown) => s.log.warn('handed-over delivery failed', { agentId, error: String(error) });
  if (level === 'important') s.dispatcher.urgent(agentId, conversationId).catch(failed);
  else if (level === 'normal') s.dispatcher.steer?.(agentId, conversationId).catch(failed);
}

