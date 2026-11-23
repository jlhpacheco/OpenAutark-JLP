// What the dispatcher does with a line for an agent whose main-lane turn runs – urgent(), steer(), hear() and relay() of
// dispatcher.ts, on its running turns, fold retries and urgent picks (the same objects, handed over at its construction):
// Important messages steer a running turn in that chat when the engine can, otherwise the
// running turn is interrupted (its wakes are kept) and that chat runs next. Such an interrupt waits
// for the turn's next tool boundary (dispatch-boundary.ts: no call doing work; one quiet line says so) – a call in flight, maybe an outside effect, is never cut mid-way;
// only the person's own Stop aborts at once. A normal message of the person in the chat of a running turn is folded into it
// when the engine can steer (steer(); else its queued wake runs the next turn). 07.11.2026: a line in ANOTHER chat while
// the agent's turn runs elsewhere (or chat-free) is folded the same way, framed as another chat's (dispatch-steer.ts
// steerOther; the waiting chat's read cursor stays), that chat runs first after this turn (an urgent pick, no cut).
// B-080: a fold the engine refused
// (its turn had not started yet) is tried again while that turn runs (dispatch-fold.ts); hear() folds a person's line
// in a group chat into every member's running turn (no pick); an important line from another chat
// is folded too before anything is cut. urgent() with a task id (continueNow() sends one for a task's turn; no task tool
// does since tasks/urgent.ts went) runs that task next and interrupts the agent's turn on less urgent work; a turn on that
// or another priority-2 task, or one serving the person's answer, finishes first. Picks run in the order named
// (dispatch-groups.ts nextGroup) – B-080 wave 3: a chat where a person waits before those of agents only (addPick).
// D15: relay() hands a call's live-voice text to the agent's running turn (dispatch-steer.ts steerRelay) – KI-Runde
// 17.11.2026: wherever that turn runs; the call's chat then runs next. Decision 10: a person's line, an important line or
// a 'now' relay first ends that turn's waiting agents.split call (endWait), so the turn reaches its next step and reads it.
// Owns: a line into a running turn (folded, or that turn cut for its chat or task) and the pick that chat (task) gets.
// Never: starts a turn (the dispatcher's pump does), cuts a tool call in flight, or polls.

import type { RuntimeServices } from '../contracts.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { addPick, settleWithin, type UrgentPick } from './dispatch-groups.ts';
import { hasPerson, steerOther, steerRelay, steerTurn, type SteerResult } from './dispatch-steer.ts';
import type { FoldRetries } from './dispatch-fold.ts';
import { noteDeferred } from './dispatch-boundary.ts';
import { abortTurn, type RunEntry, type RunningTurns, type TurnDeps } from './dispatch-runs.ts';
import { personLine } from './context-fold.ts';

export const SETTLE_MS = 5000;

/** The dispatcher's lines for a running turn (dispatcher.ts hands its calls here). */
export class IncomingLines {
  private readonly deps: TurnDeps;
  private readonly runs: RunningTurns;
  private readonly folds: FoldRetries;
  private readonly urgentPick: Map<string, UrgentPick[]>;

  constructor(deps: TurnDeps, runs: RunningTurns, folds: FoldRetries, urgentPick: Map<string, UrgentPick[]>) {
    this.deps = deps;
    this.runs = runs;
    this.folds = folds;
    this.urgentPick = urgentPick;
  }

  /** Important message – or, with `taskId`, a task made urgent (T10): that chat (task) runs next. */
  async urgent(agentId: string, conversationId: string, taskId?: string): Promise<void> {
    const services = this.deps.services();
    const entry = this.runs.get(agentId);
    const live = entry && !entry.controller.signal.aborted ? entry : undefined;
    if (taskId && live?.taskId === taskId) return; // already working on it
    if (!taskId && live) this.endWait(live);
    // B-080: an important line goes into the running turn like a normal one ("mittendrin", not cut) – also from another chat
    // (that chat still runs next) and while the turn's engine is not ready yet (the fold is tried again); only a line the
    // turn cannot take (a live-call line, a recording, an engine that never steers) is cut for.
    if (!taskId && live && (await this.fold(live, conversationId)) !== 'held') {
      if (live.conversationId !== conversationId) {
        this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), { conversationId, person: hasPerson(services, conversationId) }));
        services.wakes.wake({ agentId, reason: 'message', conversationId, coalesceKey: `chat:${conversationId}` });
      }
      return;
    }
    // No steer: this chat (task) runs next, after the ones named before; an interrupted turn keeps its
    // wakes for later. The task's own wake comes from the task service, a message needs the chat's wake.
    this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), taskId ? { conversationId, taskId } : { conversationId, person: hasPerson(services, conversationId) }));
    if (!taskId) services.wakes.wake({ agentId, reason: 'message', conversationId, coalesceKey: `chat:${conversationId}` });
    // A context fold's turn is cut only by a person's line for me (fold() above did that); this chat (task) runs right after it.
    if (live?.reason === 'fold') return;
    const current = this.runs.get(agentId);
    // Interrupt other work: a turn that started in this chat while we tried to steer already reads
    // the new message; urgent task work cuts off only less urgent work (yields).
    const overtaken = taskId ? current !== undefined && this.yields(services, current, taskId) : current === entry || current?.conversationId !== conversationId;
    if (current && overtaken && !current.controller.signal.aborted) {
      // At the turn's next tool boundary: a call in flight is never cut mid-way (dispatch-boundary.ts).
      const reason = taskId ? 'Interrupted by urgent work.' : 'Interrupted by an important message.';
      const before = current.boundary.deferred;
      // Never after the person's Stop or a shutdown (abortTurn also drops it): that turn's work must not come back.
      if (current.boundary.at(() => { if (!current.controller.signal.aborted) abortTurn(current, reason, 'urgent', 'release'); })) await settleWithin([current.finished], SETTLE_MS);
      else if (!taskId && !before) noteDeferred(services, agentId, conversationId);
    }
  }

  /**
   * A normal line for the agent while its main turn runs: steered in when its engine can (read at its next step); false =
   * the queued wake runs next turn. 07.11.2026: from another chat too – framed as that chat's (steerOther), that chat runs
   * first after this turn. No turn running: the wake starts one now.
   */
  async steer(agentId: string, conversationId: string): Promise<boolean> {
    const entry = this.runs.get(agentId);
    if (!entry || entry.controller.signal.aborted) return false;
    const services = this.deps.services();
    if (entry.conversationId === conversationId) return (await this.fold(entry, conversationId)) === 'all';
    this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), { conversationId, person: hasPerson(services, conversationId) })); // right after, before other work
    return (await this.fold(entry, conversationId)) === 'all';
  }

  /**
   * B-080: a person's line in a group chat for an agent the pick may not choose – folded into its running main turn here or
   * in another chat, with no pick of that chat; nothing when no turn runs.
   */
  async hear(agentId: string, conversationId: string): Promise<boolean> {
    const entry = this.runs.get(agentId);
    // A line for someone else never cuts a context fold's turn: I would get no turn after it, and the fold would be lost.
    if (!entry || entry.controller.signal.aborted || entry.reason === 'fold') return false;
    return (await this.fold(entry, conversationId)) === 'all';
  }

  /**
   * Decision 10: a person's line, an important line or a call voice's 'now' for the running main turn ends its waiting
   * agents.split call – it answers with what is there, the parts go on, and the turn reads the line at its next step.
   */
  private endWait(entry: RunEntry): void {
    try { this.deps.services().splits?.endWait?.(entry.runId); } catch (error) {
      this.deps.services().log.warn('the waiting split call did not end; it ends at its bound', { runId: entry.runId, error: String(error) });
    }
  }

  /** B-080: the unseen lines of `conversationId` into `entry`'s running turn – its own chat or another – one fold at a time per chat, a refused one tried again (dispatch-fold.ts). */
  private fold(entry: RunEntry, conversationId: string): Promise<SteerResult> {
    if (entry.reason === 'fold') {
      // A context fold's turn takes no line. A person's line for me goes first: it cuts the fold at its next tool boundary
      // (nothing is marked then) and runs as its own turn; a colleague's line, also a push line, waits the one turn the fold
      // takes. hear() never comes here with a fold: a line for someone else leaves it running.
      // Only a person's line since the fold started counts: an older one (a quiet line) was weighed before it began.
      if (personLine(this.deps.services(), entry.agentId, conversationId, { since: entry.startedAt })) {
        entry.boundary.at(() => { if (!entry.controller.signal.aborted) abortTurn(entry, 'Interrupted by a line of the person.', 'urgent', 'release'); });
      }
      return Promise.resolve('held');
    }
    const services = this.deps.services();
    // Only a person's line after what this turn already took (its input, its steered lines, its folds of another chat):
    // the line that started the turn never ends its wait again.
    const taken = entry.conversationId === conversationId
      ? Math.max(entry.control.lastSeq, entry.control.steeredSeq)
      : entry.control.others?.get(conversationId)?.seq ?? 0;
    if (personLine(services, entry.agentId, conversationId, { seq: taken })) this.endWait(entry);
    const stillRunning = () => this.runs.get(entry.agentId) === entry && !entry.controller.signal.aborted;
    const attempt = () => (entry.conversationId === conversationId
      ? steerTurn(services, entry, conversationId, stillRunning)
      : steerOther(services, entry, conversationId, stillRunning));
    return this.folds.fold(`${entry.agentId}:${conversationId}`, attempt, stillRunning);
  }

  /**
   * D15: a live voice's relay text into the agent's running turn (calls/talker.ts, dispatch-steer.ts steerRelay); false =
   * not steered. KI-Runde 17.11.2026 (decision 8.1): it reaches the agent wherever its turn runs, not only in the call's
   * chat – one agent has one context, so its turn elsewhere is the same work; the chat the call runs in then runs next.
   */
  async relay(agentId: string, conversationId: string, text: string, mode: 'now' | 'next'): Promise<boolean> {
    const entry = this.runs.get(agentId);
    if (!entry || entry.controller.signal.aborted || entry.reason === 'fold') return false;
    const services = this.deps.services();
    if (mode === 'now') this.endWait(entry);
    const steered = await steerRelay(services, entry, text, mode, () => this.runs.get(agentId) === entry && !entry.controller.signal.aborted);
    if (steered && entry.conversationId !== conversationId) {
      this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), { conversationId, person: hasPerson(services, conversationId) }));
      services.wakes.wake({ agentId, reason: 'message', conversationId, coalesceKey: `chat:${conversationId}` }); // the pick needs the chat's wake, as urgent() gives it
    }
    return steered;
  }

  /** Whether a running turn gives way to urgent task work: not one on that or another priority-2 task, or serving the person's answer. */
  private yields(services: RuntimeServices, entry: RunEntry, taskId: string): boolean {
    if (entry.taskId === taskId || entry.reason === 'answer') return false;
    return !entry.taskId || taskOf(services, entry.taskId)?.priority !== 2;
  }
}

/** The task a group works on, for its priority, due state and – stale hand-overs – status (a failed read counts as normal work). */
export function taskOf(services: RuntimeServices, id: string): Pick<Task, 'priority' | 'at' | 'status'> | undefined {
  try { return services.tasks.get(id); } catch { return undefined; }
}
