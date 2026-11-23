// The dispatcher: turns due wakes into agent turns. Event-driven only – the scheduler
// announces due agents (onDueWakes: immediate wakes in a microtask batch, future ones from its
// single timer); after every turn the agent is pumped again. No polling.
//   pump(agent): claim due wakes → group by (chat, task) → drop stale message
//   groups → run the most important group, chat groups due beside it riding along (Runde „Halb“ 21.11.2026,
//   dispatch-groups.ts ridersOf), release the others → TurnExecutor.execute →
//   wakes done (released instead on shutdown/urgent abort) → idle → pump again → nothing ran: quiet pickup (K4).
// Guarantees: at most ONE running turn per agent on its main lane. One capacity rule (07.11.2026, B-080 for splits): every
// turn starts at once – an agent's own and each of its splits; no global limit for any lane, no slot FIFO, no RAM
// admission; an agent runs at most SPLIT_LIMITS.runningPerAgent (4) of its parts at a time.
// B-057 S12 (dispatch-lanes.ts): an agent's splits run on lanes of their own beside its main lane (startSplit – started at
// once, or 'busy' at its own four, dispatch-lanes.ts); every lane's end fires the waiting splits (onLaneFree); haltAll and stop() cover the lanes; interrupt() never stops a
// split (the person's Stop in a chat ends them through the split service – rpc/handlers/chats.ts messages.stop), but every
// person's Stop of a turn stops the groups it split that have not started, at once (split-stop.ts);
// urgent/steer/relay and the quiet pickup address the main lane only; B-083: tell() and continueNow() reach split lanes too (dispatch-lanes.ts).
// Lines for an agent whose main turn runs – urgent(), steer(), hear(), relay(): dispatch-incoming.ts.
// B-048 E4.2: continueNow() – the agent's model.set now: its turn is cut at the next tool boundary the urgent way and its chat
// (task) runs again at once with a note, on the new route. B-080: a model on the turn's engine and account is switched inside the
// running turn instead (Engine.setModel) – no cut; another engine or account cuts as before; wave 3: a target it already runs on changes nothing.
// Task groups carry their task's priority and due state into the order (taskFacts). The running
// turns, their abort kinds (human / urgent / shutdown) and wake settling: dispatch-runs.ts. stop() names
// the runs it cuts off in the journal (runs/journal.ts recordShutdownRuns), so the next start
// names their unknown effects (RC1); start() clears that list (a cancelled restart).
// The person's emergency stop (agents/work-stop.ts) halts: haltAll() aborts every running turn as the
// person's Stop and setHalted(true) starts no turn until it is lifted (independent of setPaused).
// B-050 K4: the idle moment – a turn ended and the hand-over started no other turn of that agent (nothing due) – lets the
// agent pick up a person's quiet lines it has not seen, and a colleague's quiet answer to its @question in a group
// (chat/quiet-pickup.ts: one 'review' wake per chat; B-080 wave 3: in a room of two agents an agent's quiet line is nobody's
// to pick up). Round 3: an agent with no turn running picks them up QUIET_DELAY_MS later too – when such a
// line arrives (quietArrived, from chat/delivery.ts), after start() and when it is un-paused – so a quiet line
// never waits for unrelated work; round 4: a colleague's quiet answer within seconds (pickUpQuiet's QUIET_ANSWER_DELAY_MS). Never after the person's Stop of that turn (until its next turn ends), while
// the dispatcher is paused or halted, for a paused (its lines wait for the un-pause) or archived agent.
// B-050 group cost: a group that only answers colleagues' still running turns (dispatch-groups.ts waitsFor: their
// lines, their tasks' results) goes back to the queue and the agent waits for those turns – when one ended,
// handOver() pumps it (event-driven, `awaiting`); an urgent pick never waits. A hand-over or follow-up group (handoff, retry or review
// only) of a finished task is settled without a turn, and a hand-over the agent already answered in its chat without it carries answeredNote.
// KI-Runde 17.11.2026 (the context fold, agents/context-fold.ts): a main-lane turn that ended done and whose session calls for a
// fold (RunEntry.fold) is followed by the fold's turn, before the agent's own queued work – it waits only for a wake a person
// caused or a call the agent takes part in (foldWaitsFor), for its parts and for the person's Stop of that turn (foldAfter); a
// fold that cannot start now is not kept, the next turn's end asks again. While a fold's turn runs it takes no line: a person's
// line for the agent cuts it at its next tool boundary and runs as its own turn (nothing is marked then); a person's line for
// someone else, a colleague's line (a push line too) and an urgent task wait the one turn it takes, and no live voice is
// relayed into it.
// Linked PCs (owner 31.10.2026): an agent runs on its home PC – one whose home is another CEO PC starts no turn and no
// quiet pickup here; its due wakes go there (devices/sync/home.ts homeElsewhere, rows.ts hands them over). Umzug 21.11.2026:
// leave() ends what an agent runs here once it moved to another PC (agents/move.ts); one that just came here starts no
// turn while it waits for the hand-over from the PC it came from (isArriving).
// Owns: when and what runs – pump gates, interrupt/stop, held (paused) agents, the idle moment.
// Never: runs two main-lane turns for one agent, drops wakes of a paused agent, or polls.

import type { Dispatcher, RuntimeServices, SplitLane } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { SPLIT_LIMITS } from '../../shared/model/splits.ts';
import {
  addPick, answeredNote, groupWakes, isStaleHandOver, isStaleMessageGroup, isUrgent, nextGroup, ridersOf, settleWithin, taskFacts,
  waitsFor, wakeIds, type UrgentPick, type WakeGroup,
} from './dispatch-groups.ts';
import { hasPerson, type SteerResult } from './dispatch-steer.ts';
import { FoldRetries } from './dispatch-fold.ts'; // B-080
import { IncomingLines, SETTLE_MS, taskOf } from './dispatch-incoming.ts';
import { LiveStatus } from './dispatch-live.ts';
import { abortTurn, RunningTurns, setModelInTurn, type RunEntry, type TurnDeps } from './dispatch-runs.ts';
import type { Effort } from '../../shared/model/providers.ts';
import { SplitLanes, switchLane, tellRun, type LaneStart } from './dispatch-lanes.ts'; // B-057
import { stopPendingSplits } from './split-stop.ts'; // B-057 S13
import { recordShutdownRuns } from '../runs/journal.ts';
import { pickUpQuiet, QUIET_DELAY_MS } from '../chat/quiet-pickup.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { fromEmployer } from '../devices/sync/employee.ts';
import { noteAway } from './dispatch-wait-lines.ts'; // B-079: why a line waits, in its chat
import { isArriving } from './move.ts'; // Umzug 21.11.2026
import type { FoldWhy } from './compaction-policy.ts';
import { foldWaitsFor } from './context-fold.ts'; // KI-Runde 17.11.2026: what holds a context fold back

export class DispatcherImpl implements Dispatcher {
  private readonly deps: TurnDeps;
  private readonly runs: RunningTurns; // at most one running turn per agent on its main lane (B-057: plus its split lanes)
  private readonly lanes: SplitLanes; // B-057: the split lanes
  private readonly held = new Set<string>(); // paused agents whose wakes (and quiet lines) wait for un-pause
  private readonly urgentPick = new Map<string, UrgentPick[]>(); // agent → chats (or tasks) that run next, in order
  private readonly stopped = new Set<string>(); // agents whose running turn the person stopped: no quiet pickup after it
  private readonly awaiting = new Map<string, Set<string>>(); // B-050: colleague → agents whose wakes wait for its running turn to end
  /** B-079: chats told that the agent's home PC is out of reach, per offline phase (noteAway). */
  private readonly awayTold = new Set<string>();
  private readonly folds = new FoldRetries(); // B-080: refused folds, tried again while their turn runs
  private told = 0; // B-083: each note its own fold (a retry re-sends that note only)
  private readonly live: LiveStatus;
  private readonly lines: IncomingLines; // urgent/steer/hear/relay into a running turn (dispatch-incoming.ts)
  private readonly unsubscribe: Array<() => void> = [];
  private started = false;
  private paused = false;
  private halted = false; // the person's emergency stop (work-stop.ts)

  constructor(deps: TurnDeps) {
    this.deps = deps;
    this.live = new LiveStatus(deps.services, () => this.activity());
    this.runs = new RunningTurns(deps, this.live, (agentId, split, ended) => this.handOver(agentId, split, ended));
    this.lanes = new SplitLanes({
      services: deps.services, runs: this.runs,
      gate: () => (this.halted ? 'refused' : !this.started || this.paused ? 'busy' : 'ok'),
      hold: (agentId) => { this.held.add(agentId); },
    });
    this.lines = new IncomingLines(deps, this.runs, this.folds, this.urgentPick);
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    const services = this.deps.services();
    this.shutdownRuns(services, []); // running again here: nothing is cut off any more
    this.live.attach();
    // Immediate wakes (delivery → wakes.wake, due now) reach us through the scheduler's
    // wakes.onChange subscription in a microtask batch; future ones through its single timer.
    this.unsubscribe.push(services.scheduler.onDueWakes((agentIds) => { for (const id of agentIds) this.pump(id); }));
    this.unsubscribe.push(services.bus.on('agent.upserted', (agent) => this.onAgentChanged(agent)));
    for (const id of services.wakes.dueAgents()) this.pump(id);
    // K4 round 3: quiet lines still open from before the start – every agent not working now picks them up a little later.
    for (const agent of services.org.list()) if (!this.runs.has(agent.id)) this.idle(agent.id, QUIET_DELAY_MS);
    this.lanes.fire(); // B-057: splits that waited for the start (split service reconcile)
  }

  /** Stops pumping, interrupts running turns (their wakes go back to the queue), waits ≤ 5 s. */
  async stop(): Promise<void> {
    this.started = false;
    this.folds.stop(); // B-080
    for (const off of this.unsubscribe.splice(0)) off();
    this.held.clear();
    this.awaiting.clear(); // their wakes stay queued: start() pumps every agent with due wakes
    const entries = this.runs.entries();
    if (entries.length) this.shutdownRuns(this.deps.services(), entries.map((entry) => entry.runId));
    for (const entry of entries) abortTurn(entry, 'The runtime is shutting down.', 'shutdown', 'release');
    await settleWithin(entries.map((entry) => entry.finished), SETTLE_MS);
  }

  private shutdownRuns(services: RuntimeServices, runIds: string[]): void {
    try { recordShutdownRuns(services, runIds); } catch (error) {
      services.log.warn('cut-off runs not recorded', { runs: runIds.length, error: String(error) });
    }
  }

  /** Holds new turns (e.g. before an update restart); running turns continue. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.resumeQueue();
  }

  /** The person's emergency stop: no new turn while halted; lifting it runs what waited (work-stop.ts). */
  setHalted(halted: boolean): void {
    this.halted = halted;
    if (!halted) this.resumeQueue();
  }

  /** Aborts every running turn at once as the person's Stop; its runs, and when they ended (≤ 5 s). */
  haltAll(reason: string): { runIds: string[]; settled: Promise<void> } {
    const entries = this.runs.entries();
    for (const entry of entries) this.personStop(entry, reason);
    return { runIds: entries.map((entry) => entry.runId), settled: settleWithin(entries.map((entry) => entry.finished), SETTLE_MS) };
  }

  private resumeQueue(): void {
    if (!this.started || this.paused || this.halted) return;
    for (const id of this.deps.services().wakes.dueAgents()) this.pump(id);
    this.lanes.fire(); // B-057: then the splits that waited
  }

  // ------------------------------------------------------------------ control

  /** Stops the agent's main-lane turn (in that chat). B-057: never its splits – the person's Stop in a chat ends those itself (messages.stop). */
  async interrupt(agentId: string, conversationId?: string): Promise<void> {
    const entry = this.runs.get(agentId);
    if (!entry || (conversationId && entry.conversationId !== conversationId)) return;
    this.personStop(entry, 'The turn was stopped.');
    await settleWithin([entry.finished], SETTLE_MS);
  }

  /** Stops one run by id (RPC runs.cancel); false when it is not running here. */
  async cancelRun(runId: string): Promise<boolean> {
    const entry = this.runs.byRunId(runId);
    if (!entry) return false;
    this.personStop(entry, 'The turn was stopped.');
    await settleWithin([entry.finished], SETTLE_MS);
    return true;
  }

  /** The person's Stop of a running turn; its end is no idle moment for the quiet pickup. */
  private personStop(entry: RunEntry, reason: string): void {
    if (this.runs.get(entry.agentId) === entry) this.stopped.add(entry.agentId);
    abortTurn(entry, reason, 'human');
    stopPendingSplits(this.deps.services(), entry); // B-057 S13: the groups this turn split never start (split-stop.ts)
  }

  // ------------------------------------------------------------------ lines for a running turn (dispatch-incoming.ts)

  urgent(agentId: string, conversationId: string, taskId?: string): Promise<void> { return this.lines.urgent(agentId, conversationId, taskId); }
  steer(agentId: string, conversationId: string): Promise<boolean> { return this.lines.steer(agentId, conversationId); }
  hear(agentId: string, conversationId: string): Promise<boolean> { return this.lines.hear(agentId, conversationId); }
  relay(agentId: string, conversationId: string, text: string, mode: 'now' | 'next'): Promise<boolean> { return this.lines.relay(agentId, conversationId, text, mode); }

  /**
   * B-048 E4.2 – model.set now: the run ends at its next tool boundary like an urgent interrupt (its wakes
   * are kept) and its chat (task) runs next with `note`, on the route the request set. Called by a tool
   * of that very turn, so it never waits for the cut; a turn that ends first drops it (nothing is woken).
   * B-080: with `target` on the turn's engine and account the turn first switches inside itself (dispatch-runs.ts
   * setModelInTurn: no cut, the run goes on); only when that cannot be does the cut-and-continue follow.
   */
  continueNow(agentId: string, runId: string, note: string, target?: { modelId: string; effort?: Effort }): boolean {
    const lane = this.runs.byRunId(runId);
    if (lane?.split) return lane.agentId === agentId && !lane.controller.signal.aborted && target !== undefined // B-083: inside its turn or not at all
      && switchLane(this.deps.services(), lane, target, (text) => { void this.tell(agentId, runId, text); });
    const entry = this.runs.get(agentId);
    if (!entry || entry.runId !== runId || entry.controller.signal.aborted || !entry.conversationId || entry.reason === 'fold') return false; // a context fold's turn stays on its session's model: nothing continues it elsewhere
    if (target && entry.route?.model === target.modelId && (target.effort === undefined || target.effort === entry.route.effort)) return true; // B-080 wave 3: already on it – no switch, no cut; the stored request stays
    const conversationId = entry.conversationId;
    const cut = () => entry.boundary.at(() => {
      if (entry.controller.signal.aborted || this.runs.get(agentId) !== entry) return;
      const services = this.deps.services();
      this.urgentPick.set(agentId, addPick(this.urgentPick.get(agentId), entry.taskId ? { conversationId, taskId: entry.taskId } : { conversationId, person: hasPerson(services, conversationId) }));
      services.wakes.wake({ agentId, reason: entry.reason, conversationId, taskId: entry.taskId, note, coalesceKey: `model-now:${conversationId}:${entry.taskId ?? ''}` });
      abortTurn(entry, 'Continuing on the requested model.', 'urgent', 'release');
    });
    if (!target) cut();
    else void setModelInTurn(this.deps.services(), entry, target).then((inTurn) => { if (!inTurn) cut(); }, () => cut());
    return true;
  }

  /**
   * Umzug 21.11.2026 (agents/move.ts): the agent now runs on another PC – its work here stops at once like the person's Stop
   * (review M5: the call in flight is cut through its signal), its wakes back in the queue with a continue-wake carrying
   * `note`, so they follow it there; its running parts stop. `ownRun`: the turn whose own agents.update call moved it – it ends
   * right after that call returns (its result is kept). Resolves once all of them ended; false when none ran.
   */
  async leave(agentId: string, note: string, ownRun?: string): Promise<boolean> {
    const parts = this.runs.lanes(agentId);
    for (const part of parts) this.lanes.stop(part.split!.splitId, 'human');
    const entry = this.runs.get(agentId);
    const cut = () => {
      if (!entry || entry.controller.signal.aborted || this.runs.get(agentId) !== entry) return;
      const { conversationId, taskId } = entry;
      if (entry.reason !== 'fold') this.deps.services().wakes.wake({ agentId, reason: entry.reason, conversationId, taskId, note, coalesceKey: `moved:${conversationId ?? ''}:${taskId ?? ''}` });
      abortTurn(entry, 'I moved to another PC.', 'urgent', 'release');
    };
    if (entry && entry.runId === ownRun) entry.boundary.at(cut);
    else cut();
    const ended = [...parts, ...(entry ? [entry] : [])];
    await Promise.allSettled(ended.map((item) => item.finished));
    return ended.length > 0;
  }

  /** B-083: a note of the agent to itself into its running turn `runId` (main or split lane; dispatch-lanes.ts tellRun – a refused one is tried again, `onLost` when that turn ends without it). */
  tell(agentId: string, runId: string, text: string, onLost?: () => void): Promise<SteerResult> {
    return tellRun({ services: this.deps.services(), runs: this.runs, folds: this.folds }, `${agentId}:note:${++this.told}`, { agentId, runId, text }, onLost);
  }

  activity(): AgentActivity[] { return this.runs.activity(); }

  /** B-080: how many of its parts an agent runs at once – the one bound on parallel turns (system.resources shows it). */
  capacity(): number { return SPLIT_LIMITS.runningPerAgent; }

  /** K4 round 3: a person's quiet line (or a colleague's quiet answer to an @question in a group) reached chats of these agents (chat/delivery.ts) – one with no turn running picks it up QUIET_DELAY_MS later (an answer: QUIET_ANSWER_DELAY_MS, chat/quiet-pickup.ts). */
  quietArrived(agentIds: readonly string[]): void {
    for (const id of agentIds) if (!this.runs.has(id)) this.idle(id, QUIET_DELAY_MS); // a running turn's end is the idle moment
  }

  /** Hook for ToolRegistryOptions: a call of that run started or ended (by call id, dispatch-boundary.ts). */
  setCall(ctx: { agentId: string; runId: string; callId: string }, running: boolean): void { this.runs.setCall(ctx, running); }

  // ------------------------------------------------------------------ B-057 split lanes (dispatch-lanes.ts)

  startSplit(input: { agentId: string; splitId: string }): LaneStart { return this.lanes.start(input); }
  splitLanes(agentId?: string): SplitLane[] { return this.lanes.list(agentId); }
  stopSplit(splitId: string, why: 'human' | 'shutdown'): boolean { return this.lanes.stop(splitId, why); }
  onLaneFree(listener: () => void): () => void { return this.lanes.onFree(listener); }

  // ------------------------------------------------------------------ pump

  /** Starts the next turn of an agent when it has due wakes (07.11.2026: at once – no slot to wait for); true when started. */
  pump(agentId: string): boolean {
    if (!this.started || this.paused || this.halted || this.runs.has(agentId)) return false;
    const services = this.deps.services();
    try {
      const home = homeElsewhere(services, agentId);
      if (home && fromEmployer(services.db, agentId)) { services.wakes.done(services.wakes.claim(agentId).map((wake) => wake.id)); return false; } // 21.11.2026: my employer's agent – the company delivers the line itself
      if (home) { noteAway(services, agentId, home, this.awayTold); return false; } // its home PC runs it: the wakes stay unclaimed for the hand-over
      if (isArriving(services, agentId)) return false; // Umzug 21.11.2026: it just came here – its first turn waits for the PC it came from (agents/move.ts)
      return this.pumpNow(services, agentId);
    } catch (error) {
      services.log.error('dispatcher pump failed', { agentId, error: String(error) });
      return false;
    }
  }

  private pumpNow(services: RuntimeServices, agentId: string): boolean {
    let agent = services.org.get(agentId);
    if (!agent || agent.archivedAt) {
      const dropped = services.wakes.claim(agentId);
      if (dropped.length) {
        services.wakes.done(dropped.map((wake) => wake.id));
        services.log.info('wakes dropped', { agentId, count: dropped.length, reason: agent ? 'archived' : 'missing' });
      }
      return false;
    }
    if (agent.status === 'paused') {
      this.held.add(agentId); // paused by the human or a manager: wakes wait (onAgentChanged)
      return false;
    }

    const wakes = services.wakes.claim(agentId);
    if (!wakes.length) return false;
    const groups = groupWakes(wakes);
    const stale = groups.filter((group) => isStaleMessageGroup(services.chats, agentId, group) || isStaleHandOver(group, (id) => taskOf(services, id)?.status));
    if (stale.length) services.wakes.done(wakeIds(stale));
    const picks = this.urgentPick.get(agentId);
    // B-050: what only answers colleagues' running turns goes back unannounced (release without a due time) until they end.
    const waiting = groups.filter((group) => !stale.includes(group) && this.waitsForColleagues(services, agentId, group, picks));
    if (waiting.length) services.wakes.release(wakeIds(waiting), undefined, true);
    const live = groups.filter((group) => !stale.includes(group) && !waiting.includes(group));
    taskFacts(live, (id) => taskOf(services, id), services.clock.now());
    const { group, left: named } = nextGroup(live, picks);
    // Runde „Halb“ 21.11.2026: the chat groups due beside it ride along in its turn (dispatch-groups.ts ridersOf); their picks end with it.
    const riders = group ? ridersOf(services.chats, agentId, group, live.filter((item) => item !== group)) : [];
    const rest = live.filter((item) => item !== group && !riders.includes(item));
    const left = named.filter((pick) => rest.some((other) => isUrgent(other, pick)));
    if (left.length) this.urgentPick.set(agentId, left);
    else this.urgentPick.delete(agentId);
    if (!group) return false;
    if (rest.length) services.wakes.release(wakeIds(rest), undefined, true);
    const answered = answeredNote(services.chats, agentId, group);
    if (answered) group.aware = { text: answered, at: services.clock.now() };
    this.runs.start(services, agent, group, riders);
    return true;
  }

  /** B-050 group cost: true when the group only answers colleagues' running turns – the agent then waits for their hand-over (never an urgent pick). */
  private waitsForColleagues(services: RuntimeServices, agentId: string, group: WakeGroup, picks: UrgentPick[] | undefined): boolean {
    if (picks?.some((pick) => isUrgent(group, pick))) return false;
    const colleagues = waitsFor(services.chats, agentId, group, this.runs.entries());
    for (const id of colleagues) this.awaiting.set(id, (this.awaiting.get(id) ?? new Set<string>()).add(agentId));
    return colleagues.length > 0;
  }

  /** A turn of `agentId` ended and its wakes are settled (dispatch-runs.ts): its next turn and the colleagues it answered; every lane's end starts waiting splits (there are no global places; a split whose start failed is tried again). */
  private handOver(agentId: string, split: boolean, ended: RunEntry): void {
    if (split) { this.lanes.fire(); return; }
    const stopped = this.stopped.delete(agentId);
    const answering = this.awaiting.get(agentId); // B-050: the colleagues its turn wrote to answer now
    this.awaiting.delete(agentId);
    // The fold runs before the agent's own background work: that work then reads the small context (KI-Runde 17.11.2026).
    if (stopped || ended.fold === undefined || !this.foldAfter(ended, ended.fold)) this.pump(agentId);
    for (const id of answering ?? []) this.pump(id);
    if (!stopped && !this.runs.has(agentId)) this.idle(agentId);
    this.lanes.fire(); // B-080 review: also the retry for a split whose start failed with 'busy' (no other lane may end soon)
  }

  /**
   * KI-Runde 17.11.2026: the context fold after a turn whose session calls for one – it runs before the agent's own queued
   * work, and waits only for a wake a person caused or a call the agent takes part in (context-fold.ts foldWaitsFor) and for
   * its parts. True when it started; else nothing is kept and the next turn's end asks again.
   */
  private foldAfter(ended: RunEntry, why: FoldWhy): boolean {
    const agentId = ended.agentId;
    if (!this.started || this.paused || this.halted || this.runs.has(agentId) || this.runs.lanes(agentId).length) return false;
    const services = this.deps.services();
    try {
      const agent = services.org.get(agentId);
      if (!agent || agent.archivedAt || agent.status === 'paused' || homeElsewhere(services, agentId)) return false;
      const waits = foldWaitsFor(services, agentId);
      if (waits) return false; // a person's line, answer or approval, or a live call: that goes first
      this.runs.fold(services, ended, why);
      return true;
    } catch (error) {
      services.log.warn('the context fold did not start', { agentId, error: String(error) });
      return false;
    }
  }

  /** K4: the agent finished and nothing is due for it – the person's quiet lines it has not seen get a review wake (chat/quiet-pickup.ts), `delayMs` later. */
  private idle(agentId: string, delayMs = 0): void {
    if (!this.started || this.paused || this.halted || this.held.has(agentId)) return;
    const services = this.deps.services();
    try {
      const agent = services.org.get(agentId);
      if (homeElsewhere(services, agentId)) return; // its home PC picks up its quiet lines
      if (agent && !agent.archivedAt && agent.status !== 'paused') pickUpQuiet(services, agentId, delayMs);
      else if (agent && !agent.archivedAt) this.held.add(agentId); // paused: its quiet lines wait for the un-pause (onAgentChanged)
    } catch (error) {
      services.log.warn('quiet pickup failed', { agentId, error: String(error) });
    }
  }

  // ------------------------------------------------------------------ events

  /** Un-paused agents get their held wakes. */
  private onAgentChanged(agent: Agent): void {
    if (!this.started) return;
    const id = agent.id;
    if (this.held.has(id) && (agent.status !== 'paused' || agent.archivedAt)) {
      this.held.delete(id);
      queueMicrotask(() => { if (!this.pump(id) && !this.runs.has(id)) this.idle(id, QUIET_DELAY_MS); this.lanes.fire(); }); // B-057: its waiting splits too
    }
  }
}
