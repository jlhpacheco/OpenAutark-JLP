// SubconsciousImpl: one service around the agents' turns, on the cheap decision model (the Decisions use); the good model
// is the main AI itself. Unterbewusstsein v1 (14.11.2026, measured .local/unterbewusstsein-20261113), v2 (15.11.2026): the job
// before a turn is one call (route-turn.ts routeTurn) – on a person's message, on a colleague's when only colleagues woke the
// turn, else on the turn's task (a task, schedule, retry, review or handoff wake), each with content (the cheap check, wake.ts):
// it sets the turn's effort – not while that is decided already (route-turn.ts requestHolds, which first ends a step the call set
// for an earlier message) – and gives a line for each hit of the word search it picks (Runde „Halb“ 21.11.2026: hints.ts, the
// turn's "## From my memory" – no longer opened entries in the turn's trace).
// 17.11.2026 (measured 15.–17.11.: 1,367 calls held their turns 9.5 s on average, 30 % were cut at the wait and gave the turn
// nothing; the cause is the lane – 3.9 s on Luna through the running Codex app-server, 10.8 s on Haiku through a process per
// call): the turn waits for the call, at most ROUTE_WAIT_MS, only while the recent median of the lane that answers (the last
// RECENT_CALLS calls of that model, kept in process memory) is under FAST_MS; otherwise it starts at once at its settled
// effort, and the call runs beside it only to pick hits – those reach the thread's next turn (hints.ts keepHints). A slow lane is measured again by itself: on every PROBE_TURNS-th turn the call beside it runs even with
// nothing to open, its time is the lane's, and one answer under FAST_MS – a recovered lane, or another model answering –
// ends the slow stretch; no turn waits for a slow lane. The model stays the router's.
// 24.11.2026 (Konrad #390 "Der Fallback darf nicht still auf ein langsames Modell springen": from 13:10 "auto" ran on Haiku, 22 s instead of
// 6 s, because the Codex weekly window stood at 91 %): while the router has put the helper calls past the helper default (the log
// says why, routing/helper-default.ts), the lane is the model it chose, a lane nobody measured is not known fast and runs beside
// the turns (pace()), and each median measured here goes to the router, whose fallback prefers a model measured fast.
// FIXES-3 D2 (real calls 18.11.2026: a line the call voice handed over waited 2.2–5.9 s for the call): a turn of a running
// call (BeforeTurn.callId, agents/turn-prepare.ts – a task's turn too) starts at once the same way, whatever the lane's pace.
// Runde „Halb“ 21.11.2026: the second call beside each turn that condensed its context items went – code sets old output aside
// (context/ledger/window.ts leanText). F26 (16.11.2026): condensePart() – a forked part's first start, on the part's own copy of
// the record, with its brief as what wakes it (route-turn.ts condensePart); that part waits for it (at most LOOK_MS), as it
// starts from what the call leaves (splits/fork.ts).
// Each call leaves one info event with the model that answered and its tokens. Nothing runs after a turn. ask() – the main AI's own call (the subconscious tool):
// the loop (flow.ts), its answer is the tool output. A trace kept in kv – put back by a turn that never reached its engine,
// the timeout decisions a native turn could not take in (agents/native-timeout.ts), or left by runs before v1 – is handed to
// the agent's next turn on that thread by beforeTurn() (a note or hit older than a day goes). Also verify() (a task result
// against its done-condition) and toolTimeout() (the decision hub directly, for a tool call past its deadline). The model
// is the engines' structured runner, one per call, its use booked on the agent it works for (a check of a person's task on
// the subconscious itself) – none while no model is connected.
// Owns: which call happens with which budget, whether a turn waits for it, the kept trace and failure isolation. Never: makes
// a turn wait longer than ROUTE_WAIT_MS (a forked part's first start: LOOK_MS), judges an agent's answer, or turns memory into
// instructions.

import { MAIN_THREAD } from '../../shared/model/origin.ts';
import type { RuntimeServices, Subconscious } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Task, TaskResult } from '../../shared/model/tasks.ts';
import { capTrace, hasTrace, NOTE_CALL, type SubconsciousTrace } from '../../shared/model/subconscious.ts';
import { createEngineRunner, type EngineRunnerDeps } from '../decision/engine-runner.ts';
import { bookTurnCost, priceTurn } from '../agents/turn-cost.ts';
import '../contracts/vectors.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { askContext, type AskContext } from './exchange.ts';
import { runFlow, type FlowInput } from './flow.ts';
import { condensePart, requestHolds, routeTurn, type CallUse } from './route-turn.ts';
import { forgetHints, keepHints, startHints, turnHints, type MemoryHint } from './hints.ts';
import { cachedInput } from '../engines/shared.ts';
import { SUBCONSCIOUS_ID } from './tools.ts';
import { verifyResult, type Verdict } from './verify.ts';
import { hasContent } from './wake.ts';
import { chooseToolTimeout } from './tool-timeout.ts';
import type { ToolTimeoutInput } from '../tools/timeout.ts';
import { KvRepo } from '../store/kv.ts';
import { HELPER_FAST_MS, helperAway, noteHelperTime } from '../routing/helper-default.ts';

/** The time limit of one helper call (a cold CLI start on a loaded 8 GB PC took up to 200 s to its first request, q2m live 02.11.2026). */
const CALL_MS = 180_000;
/** The main AI's own call. Each step of a CLI that starts a process per call took 20–70 s on the 8 GB reference PC (Claude Code, measured 02.11.2026); the steps bound a run, this only catches a hang. */
export const ASK_MS = 300_000;
const ASK_STEPS = 12;
/** How long a turn waits at most for the call before it (one small structured call: 2.7–4.3 s measured on Luna/low, E4 arm NEW 14.11.2026). */
export const ROUTE_WAIT_MS = 12_000;
/**
 * A turn waits for the call before it while the lane's recent median is under this (measured 15.–17.11.2026: on Luna through the
 * running Codex app-server p50 3.9 s and no call cut; on Haiku through a Claude Code process per call p50 10.8 s, 37 % cut at the
 * 12 s wait – 1.5 hours of turns waiting for nothing).
 */
export const FAST_MS = HELPER_FAST_MS;
/** The lane's calls the median is taken over, per model that answers. */
export const RECENT_CALLS = 20;
/**
 * On a slow lane the call beside every PROBE_TURNS-th turn runs even with nothing to open, so the lane is measured by itself:
 * a turn with no hits runs no call at all, so a lane that recovered would otherwise never be measured again (review
 * 17.11.2026). The turn does not wait for it (review 2: a probe that waited cost the lane's full time on every fifth turn).
 * A probe that answers under FAST_MS ends the slow stretch – the lane's earlier times were another lane's speed.
 */
export const PROBE_TURNS = 5;
/** The limit of a call beside a started turn and of a part's condense call (15.11. in codex exec up to ~28 s with 12 items). */
export const LOOK_MS = 60_000;
const PENDING_NS = 'subconscious_trace';
/** A kept note or hit older than this is about something else by now: it is dropped, not shown. */
const KEPT_MS = 24 * 60 * 60_000;
/** F26: what the condense call of a forked part reads before its brief – the piece is all its coming work. */
const PART_WAKE = 'The main AI split itself: this part starts now with the context so far and works on its one piece alone, so an item this piece will not read again has done its job here.';
/** The calls that age: what a run told or found for the main AI, and an entry opened before 21.11.2026 still kept for a turn that never ran. */
const ABOUT_NOW: ReadonlySet<string> = new Set([NOTE_CALL, 'vector.search', 'knowledge.open']);

export interface SubconsciousDeps {
  services: () => RuntimeServices;
  /** The decision model, also of widget fills (tests); false = none; absent = the engines' runner. */
  runner?: StructuredRunner | false;
}

type BeforeTurn = Parameters<NonNullable<Subconscious['beforeTurn']>>[0];

/** What the call before a turn weighs: the person's lines when a person wrote, else a colleague's with content, else the turn's task; undefined without content. */
function wakeOf(input: BeforeTurn): { said: string; from: 'person' | 'colleague' | 'task' } | undefined {
  const wake = input.said ? { said: input.said, from: 'person' as const }
    : input.woke && hasContent(input.woke) ? { said: input.woke, from: 'colleague' as const }
      : { said: input.taskText ?? '', from: 'task' as const };
  return hasContent(wake.said) ? wake : undefined;
}

export class SubconsciousImpl implements Subconscious {
  private readonly deps: SubconsciousDeps;
  /** The calls before a turn in flight (settle waits for them at the app's stop). */
  private readonly routing = new Set<Promise<unknown>>();
  /** How long the last calls before a turn took, newest last, per model that answered (process memory: a new start measures anew). */
  private readonly recent = new Map<string, number[]>();
  /** The model that answered the newest call: the lane whose times decide whether a turn waits. */
  private lane = '';
  /** Turns since the last call on a slow lane, for the probe that measures it again. */
  private waited = 0;
  /** The traces beforeTurn handed to a turn with hints: put back, they carry those hints to the next turn. */
  private readonly withHints = new WeakSet<SubconsciousTrace>();

  constructor(deps: SubconsciousDeps) {
    this.deps = deps;
  }

  /** A task result against its done-condition, on the decision model, its use booked on the agent whose result it is. */
  verify(task: Task, result: TaskResult): Promise<Verdict> {
    const services = this.deps.services();
    const owner = task.assigneeKind === 'agent' && task.assigneeId ? task.assigneeId : SUBCONSCIOUS_ID;
    return verifyResult(services, task, result, this.decisionRunner(services, owner));
  }

  toolTimeout(input: ToolTimeoutInput & { agent: Agent; signal: AbortSignal }) {
    return chooseToolTimeout(this.deps.services(), input);
  }

  /**
   * What the agent's turn gets: the hints of the call before it, with those a call beside my last turn kept for it, as this
   * turn's "## From my memory" (hints.ts – written on every turn, so a turn without any shows none); and the trace kept for
   * this thread. Never throws.
   */
  async beforeTurn(input: BeforeTurn): Promise<SubconsciousTrace | undefined> {
    const hints = await this.lookFirst(input);
    const services = this.deps.services();
    try { startHints(services, input.agent.id, input.thread, hints); } catch (error) { this.log('subconscious hints not kept', error); }
    const kept = this.takeTrace(input.agent.id, input.thread);
    if (!turnHints(services, input.agent.id, input.thread).length) return kept;
    // A turn with hints gets a trace (empty when nothing was kept): a turn that never reaches its engine puts it back
    // (agents/turn.ts, turn-prepare.ts), and putBack then keeps this turn's hints for the next one – the wake is still open.
    const trace = kept ?? { calls: [] };
    this.withHints.add(trace);
    return trace;
  }

  /**
   * How the call before a turn runs: 'wait' while the median of the last RECENT_CALLS calls the answering lane took is under
   * FAST_MS (none measured yet, or a model nobody measured yet: it waits), else 'beside' – on every PROBE_TURNS-th such turn
   * 'probe', a call beside the turn that runs even with nothing to open, so the lane is measured.
   */
  private pace(services: RuntimeServices): 'wait' | 'beside' | 'probe' {
    // 24.11.2026 (Konrad #390): while "auto" runs past the helper default (the router's log line says why) the lane is the model it
    // was put on – a lane nobody measured is not known fast, so the call runs beside the turn until one of its own times shows it is.
    const away = helperAway(services);
    const times = this.recent.get(away ?? this.lane);
    if (!times?.length) {
      if (away === undefined) return 'wait';
      this.waited += 1;
      if (this.waited < PROBE_TURNS) return 'beside';
      this.waited = 0;
      return 'probe';
    }
    const sorted = [...times].sort((a, b) => a - b);
    if (sorted[Math.floor(sorted.length / 2)] < FAST_MS) return 'wait';
    this.waited += 1;
    if (this.waited < PROBE_TURNS) return 'beside';
    this.waited = 0;
    return 'probe';
  }

  /** One more call took `ms` on the lane of the model that answered it (`by`; a cut call: the lane it was sent on). */
  private took(ms: number, by?: string): void {
    this.lane = by ?? this.lane;
    const times = this.recent.get(this.lane) ?? [];
    // A call under FAST_MS on a lane whose median was slow starts its count anew: the times before are not this lane's speed.
    const sorted = [...times].sort((a, b) => a - b);
    const slow = times.length > 0 && sorted[Math.floor(sorted.length / 2)] >= FAST_MS;
    const next = ms < FAST_MS && slow ? [ms] : [...times, ms];
    const kept = next.slice(-RECENT_CALLS);
    this.recent.set(this.lane, kept);
    // the router's fallback prefers a model measured fast (routing/helper-default.ts fastest) – it learns the medians here
    try { noteHelperTime(this.deps.services(), this.lane, [...kept].sort((a, b) => a - b)[Math.floor(kept.length / 2)]); } catch { /* the lane's own times stay */ }
  }

  /**
   * The call before a turn (route-turn.ts routeTurn), with the effort left out while it is decided already. While the lane
   * answers fast (pace()) the turn waits for it: the turn's stop or ROUTE_WAIT_MS ends the wait and the call, and a late answer
   * sets and hands over nothing. While it is slow the turn starts at once at its settled effort and the call runs beside it
   * (LOOK_MS, the turn's stop ends it) only to pick hits – those reach the thread's next turn (hints.ts keepHints); on the
   * probe turn it runs with nothing to pick too, and its time measures the lane. Each call leaves one info event: agent, what
   * woke the turn, the effort it set (or 'same effort', 'held by request', 'beside', cut / failed) with how many hints it gave,
   * the model that answered with its tokens, and its time in ms (runtime.log). Returns the hints for this turn. Never throws.
   */
  private async lookFirst(input: BeforeTurn): Promise<MemoryHint[]> {
    try {
      const services = this.deps.services();
      if (input.signal?.aborted) return [];
      const held = requestHolds(services, input.agent, input.taskId); // first on every turn: it ends a step set for an earlier message
      const wake = wakeOf(input);
      if (!wake) return []; // re-review 14.11.: no wait on a tool call in the chat – the main lane runs one turn at a time, only my parts' calls showed there
      const runner = this.decisionRunner(services, input.agent.id);
      if (!runner) return [];
      const started = Date.now();
      const asked = { agent: input.agent, conversationId: input.conversationId, thread: input.thread, ...wake, ...(input.mode ? { mode: input.mode } : {}), ...(held ? { held: true } : {}) };
      const pace = input.callId ? 'beside' : this.pace(services); // FIXES-3 D2: a turn a running call hands over starts at once, as on a slow lane
      if (pace !== 'wait') {
        const beside = routeTurn(services, runner, { ...asked, beside: true, ...(pace === 'probe' ? { probe: true } : {}), ...(input.signal ? { signal: input.signal } : {}), deadlineMs: LOOK_MS });
        this.track(beside);
        void beside.then((look) => {
          if (!look) return; // nothing to pick, or it failed
          const ms = Date.now() - started;
          this.took(ms, look.by);
          if (!input.signal?.aborted) keepHints(services, input.agent.id, input.thread, look.hints);
          this.logRoute(input.agent.id, wake.from, 'beside', ms, { hints: look.hints.length }, look);
        });
        return [];
      }
      const wait = new AbortController();
      const timer = setTimeout(() => wait.abort(), ROUTE_WAIT_MS);
      (timer as { unref?: () => void }).unref?.();
      const signal = input.signal ? AbortSignal.any([input.signal, wait.signal]) : wait.signal;
      const call = routeTurn(services, runner, { ...asked, signal, deadlineMs: ROUTE_WAIT_MS });
      this.track(call);
      const cut = new Promise<'cut'>((resolve) => signal.addEventListener('abort', () => resolve('cut'), { once: true }));
      const look = await Promise.race([call.then((done) => done ?? (signal.aborted ? 'cut' as const : held ? 'held by request' as const : 'failed' as const)), cut]).finally(() => clearTimeout(timer));
      const ms = Date.now() - started;
      if (typeof look !== 'string' || (look === 'cut' && wait.signal.aborted)) this.took(ms, typeof look === 'string' ? undefined : look.by); // an answer, or a call the wait cut: how the lane runs now
      const outcome = typeof look === 'string' ? look : look.line ?? (held ? 'held by request' : 'same effort');
      this.logRoute(input.agent.id, wake.from, outcome, ms, typeof look === 'string' ? {} : { hints: look.hints.length }, typeof look === 'string' ? {} : look);
      return typeof look === 'string' ? [] : look.hints;
    } catch (error) {
      this.log('subconscious look failed', error);
      return [];
    }
  }

  /**
   * F26 (owner 16.11.2026: "das Unterbewusstsein vom neuen Agent … komprimiert alles weg, dann braucht er nur das, was er wirklich
   * braucht"): a forked part's first start – route-turn.ts condensePart on the part's own copy of its record (`thread`, splits/fork.ts), with its
   * brief as what wakes it. The part starts from what this call leaves, so it waits for it: at most LOOK_MS, its turn's stop ends it.
   * One info event, like the calls before a turn. Returns how many items it condensed. Never throws.
   */
  async condensePart(input: { agent: Agent; thread: string; conversationId?: string; brief: string; signal?: AbortSignal }): Promise<number> {
    try {
      const services = this.deps.services();
      if (input.signal?.aborted || !hasContent(input.brief)) return 0;
      const runner = this.decisionRunner(services, input.agent.id);
      if (!runner) return 0;
      const started = Date.now();
      const wait = new AbortController();
      const timer = setTimeout(() => wait.abort(), LOOK_MS);
      (timer as { unref?: () => void }).unref?.();
      const signal = input.signal ? AbortSignal.any([input.signal, wait.signal]) : wait.signal;
      const call = condensePart(services, runner, {
        agent: input.agent, ...(input.conversationId ? { conversationId: input.conversationId } : {}), thread: input.thread,
        said: `${PART_WAKE}\n${input.brief}`, from: 'task', signal, deadlineMs: LOOK_MS,
      });
      this.track(call);
      const done = await call.finally(() => clearTimeout(timer));
      this.logRoute(input.agent.id, 'part', 'condensed', Date.now() - started, { condensed: done.condensed }, done);
      return done.condensed;
    } catch (error) {
      this.log('subconscious part condense failed', error);
      return 0;
    }
  }

  /** A call in flight until it settles (settle waits for them at the app's stop). */
  private track(call: Promise<unknown>): void {
    this.routing.add(call);
    void call.finally(() => this.routing.delete(call));
  }

  /**
   * One info event of a call: what it did, the model that answered and its tokens (all input, the cached part of it, output), its time.
   * The counts sit under `use` with keys the log's safety net leaves alone: a key with "token" in its name is written as
   * '[redacted]' (system/log.ts SECRET_KEY) – measured 18.11.2026 on the first real run, every count of this line was.
   */
  private logRoute(agentId: string, wake: string, outcome: string, ms: number, did: { hints?: number; condensed?: number }, use: Partial<CallUse>): void {
    const tokens = use.usage ? { use: { input: use.usage.inputTokens, cached: cachedInput(use.usage), output: use.usage.outputTokens } } : {};
    try { this.deps.services().log.info('subconscious route', { agentId, wake, outcome, ...did, ...(use.by ? { model: use.by } : {}), ...tokens, ms }); } catch { /* nothing to report to */ }
  }

  /** A turn that never reached its engine: its trace waits for the next turn on the thread, and so do the hints beforeTurn gave it. Never throws. */
  putBack(agentId: string, thread: string, trace: SubconsciousTrace): void {
    if (this.withHints.delete(trace)) {
      try { const services = this.deps.services(); keepHints(services, agentId, thread, turnHints(services, agentId, thread)); } catch (error) { this.log('subconscious hints not kept', error); }
    }
    if (trace.calls.length) this.keepTrace(agentId, thread, trace);
  }

  /** The person's Forget: a kept trace that mentions it never reaches the main AI. Never throws. */
  forget(match: (text: string) => boolean): void {
    try {
      forgetHints(this.deps.services(), match);
      const kv = new KvRepo(this.deps.services().db);
      for (const row of kv.list<SubconsciousTrace>(PENDING_NS)) if (match(JSON.stringify(row.value))) kv.delete(PENDING_NS, row.key);
    } catch (error) {
      this.log('subconscious trace not cleared', error);
    }
  }

  /** The main AI's own call: the loop with `ask` as the task; the answer is its tool output. Never throws. */
  async ask(input: { agent: Agent; conversationId?: string; thread?: string; taskId?: string; mode?: string; ask: string; context?: AskContext; signal?: AbortSignal }): Promise<string> {
    try {
      const services = this.deps.services();
      const result = await this.flow({
        agent: input.agent, conversationId: input.conversationId, thread: input.thread ?? MAIN_THREAD, taskId: input.taskId, ...(input.mode ? { mode: input.mode } : {}),
        task: input.ask, context: askContext(services, { agentId: input.agent.id, conversationId: input.conversationId, context: input.context }),
        maxSteps: ASK_STEPS, budgetMs: ASK_MS, signal: input.signal,
      });
      if (result.answer) return result.answer;
      if (result.end === 'no-model' || result.end === 'no-prompt') return 'The subconscious cannot answer: no model is connected for it.';
      if (result.end === 'failed' || result.end === 'budget') return 'The subconscious could not answer in time.';
      return 'The subconscious has nothing to add.';
    } catch (error) {
      this.log('subconscious ask failed', error);
      return 'The subconscious could not answer.';
    }
  }

  /** Resolves when the calls before a turn in flight ended – at once when none runs (the app's stop, compose/lifecycle.ts; tests). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.routing]);
  }

  private flow(input: FlowInput) {
    const services = this.deps.services();
    return runFlow(services, this.decisionRunner(services, input.agent.id), input);
  }

  private keepTrace(agentId: string, thread: string, trace: SubconsciousTrace): void {
    try {
      const { db, clock } = this.deps.services();
      const kv = new KvRepo(db);
      const key = `${agentId}:${thread}`;
      const now = clock.now();
      const before = kv.get<SubconsciousTrace>(PENDING_NS, key)?.calls ?? [];
      kv.set(PENDING_NS, key, capTrace({ calls: [...before, ...trace.calls.map((call) => ({ ...call, at: call.at ?? now }))] }), now);
    } catch (error) {
      this.log('subconscious trace not kept', error);
    }
  }

  private takeTrace(agentId: string, thread: string): SubconsciousTrace | undefined {
    try {
      const { db, clock } = this.deps.services();
      const kv = new KvRepo(db);
      const key = `${agentId}:${thread}`;
      const held = kv.get<SubconsciousTrace>(PENDING_NS, key);
      if (!held) return undefined;
      kv.delete(PENDING_NS, key);
      const oldest = clock.now() - KEPT_MS;
      const trace = { calls: held.calls.filter((call) => !ABOUT_NOW.has(call.tool) || (call.at ?? 0) >= oldest) };
      return hasTrace(trace) ? trace : undefined;
    } catch (error) {
      this.log('subconscious trace not read', error);
      return undefined;
    }
  }

  private connected(services: RuntimeServices): boolean {
    try { return services.catalog.list().some((model) => model.available); } catch { return false; }
  }

  private runnerDeps(services: () => RuntimeServices, agentId: string) {
    return {
      get engines() { return services().engines; },
      get router() { return services().router; },
      get accounts() { return services().accounts; },
      get catalog() { return services().catalog; },
      get paths() { return services().paths; },
      get clock() { return services().clock; },
      get notifications() { return services().notifications; },
      get log() { return services().log; }, // 24.11.2026: "helper call answered by another way" reaches the log for these calls too
      timeoutMs: CALL_MS, // the widget fill brings its own shorter signal (widget.ts WIDGET_FILL_MS)
      onUsage: (entry: Parameters<NonNullable<EngineRunnerDeps['onUsage']>>[0]) => this.bookUse(entry, agentId),
    };
  }

  /** The model's use on a pay-per-use account, like an agent turn's, on the agent the call works for (nothing for a plan or a local model). */
  private bookUse(entry: Parameters<NonNullable<EngineRunnerDeps['onUsage']>>[0], agentId: string): void {
    const services = this.deps.services();
    const cost = priceTurn(services, entry, { usage: entry.usage }, '').run;
    bookTurnCost(services, agentId, 'subconscious', cost);
  }

  /** The decision model (the Decisions use), one runner per call so its use is booked on `agentId`: none when nothing is connected. */
  private decisionRunner(services: RuntimeServices, agentId: string): StructuredRunner | undefined {
    if (this.deps.runner === false) return undefined;
    if (this.deps.runner) return this.deps.runner;
    if (!this.connected(services)) return undefined;
    return createEngineRunner(this.runnerDeps(this.deps.services, agentId));
  }

  private log(message: string, error: unknown): void {
    try { this.deps.services().log.debug(message, { error: String(error) }); } catch { /* nothing to report to */ }
  }
}
