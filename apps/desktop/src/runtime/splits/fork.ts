// Seeding a split's native session (B-057 S4): a 'fork' part starts as its parent with the context the parent had at the
// split, tried in this order – the first that works wins, a failure falls to the next and is recorded:
// (0) F26 (owner 16.11.2026: "das Unterbewusstsein vom neuen Agent … komprimiert alles weg"): the part's record starts as a copy of
//     mine up to the splitting run (ledger.fork – never my record itself); at that first start its subconscious condenses there, with
//     its brief as what wakes it, what this piece will not read again (subconscious/service.ts condensePart; the stamp brings each
//     original back). With items condensed the part starts from that record as text ('ledger') – unless my native fork costs less:
//     on the same engine, account and model while my cache is warm it re-reads my session cached on each call (forkPays);
// (a) a native engine fork – the worker's routed engine has caps.fork, the parent's splitting run ran on that engine and
//     account, and the session my main self's splitting turn ended with (B-080: recorded when the group started –
//     recordedParent, SplitGroup.parentSession – so a later turn of the parent that renews or moves its binding changes
//     nothing; FIXES-3 B1: for a splitting turn that still runs – agents.split with wait, on Claude Code only, FORKS_IN_TURN –
//     the session it runs on, which Claude Code forks as its transcript stands, the running turn up to the split's call
//     included; its size and model are those before the turn) is of that engine and account and fits the worker's model
//     window (pastFit; B-080: the window the engine reported for that model, else the catalog's – windowOf): engine.fork (Codex
//     thread/fork through that turn – lastTurn, Claude --resume --fork-session) – also with another model or effort of
//     that account; a recorded ref the parent replaced since stays forkable (the session sweep keeps it ≥ 24 h);
// (b) else a text fallback – the checkpoint of the parent's task (context.checkpoint: goal, done, open, constraints,
//     artifacts – no "next step": the part is the worker's next step) and my own record as text (agents/history-text.ts, the
//     part's copy of it, else the parent thread's context ledger, marks applied – 13.11.2026: never a chat's history), within half the worker model's
//     fit, returned as `inputPrefix`; nothing to carry → fresh.
// A 'brief' part starts fresh. The turn pipeline (agents/session-choice.ts chooseSession) calls this for a split's first turn
// when its thread `split:<id>` has no binding yet, binds `ref` under (agent, split thread, engine) with the current
// promptKey and puts `inputPrefix` in front of the turn's input. The choice is noted on the worker's run
// ({splitSeed: how, condensed?, parentRef?, fellBack?} – not for a brief), recorded as the split's `fork` (services.splits.markFork)
// and returned.
// Owns: that choice, the seeding, the note, the record and the parent session's record at the group's start. Never:
// touches the parent's native session, binding or record, or binds the result itself.

import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Engine } from '../engines/types.ts';
import type { TurnPlan } from '../agents/turn-types.ts';
import type { ToolSpec } from '../tools/types.ts';
import type { Account, Effort, EngineId, RouteDecision } from '../../shared/model/providers.ts';
import type { Handoff } from '../../shared/model/knowledge.ts';
import type { Run } from '../../shared/model/runs.ts';
import { PAST_WINDOW, splitThread, type SplitFork, type SplitGroup, type SplitParentSession, type SplitTurn } from '../../shared/model/splits.ts';
import { canContinueManaged, LEGACY_SESSION } from '../engines/managed-session.ts';
import { SessionStore } from '../agents/sessions.ts';
import { turnsOn } from '../agents/native-turns.ts';
import { CACHE_COLD_MS, fitLimit, pastFit } from '../agents/compaction-policy.ts';
import { historyText } from '../agents/history-text.ts';
import { priorFor } from '../models/catalog-merge.ts';
import { cachePrices } from '../models/pricing.ts';
import { Priors } from '../models/priors.ts';
import { tokensOf } from '../context/ledger/window.ts';
import { engineUnit } from '../../shared/model/context-ledger.ts';
import { turnCwd } from '../git/records.ts';
import { quoteHeaders } from '../context/projection.ts';

/**
 * FIXES-3 B1, measured 18.11.2026 on a 34–46k-token origin: the engines whose fork of a turn that still runs reads that
 * origin's context from its cache. Claude Code: 46,845 of 48,570 input tokens cached, 1,723 written, per part. Codex
 * (thread/fork through the last finished turn): 16,768 and 0 of 34,980 cached – its parts start from the text seed.
 */
const FORKS_IN_TURN: ReadonlySet<EngineId> = new Set(['claude']);

/** The text fallback's checkpoint: at most CHECKPOINT_CHARS (my record follows within half the worker model's fit). */
const CHECKPOINT_CHARS = 2_000;
const TEXT_HEAD = "My origin's context at the split, as text:";

/** The worker turn's route as buildTurn resolved it (RoutedTurn's engine, account and provider model, plus the effort it runs with). */
export interface SeedRoute {
  route: RouteDecision;
  engine: Engine;
  account: Account;
  /** Provider model id of the worker's turn. */
  model: string;
  effort: Effort;
}

export interface SeedArgs {
  /** The worker turn's plan (plan.split === split, plan.thread === `split:<id>`). */
  plan: TurnPlan;
  split: SplitTurn;
  route: SeedRoute;
  /** The turn's native dynamic tools (byte-identical to the parent's offer – S8). */
  tools: ToolSpec[];
  /** Every tool name the turn offers (native and through the hub), sorted – ToolOffer.names. */
  toolNames: string[];
  /** The turn's prompt sections as the engine gets them. */
  system: { stable: string; volatile: string };
  /** The turn's prompt key (session-key.ts promptKey of system.stable + toolNames). */
  promptKey: string;
  /** The worker's folder (its worktree, else the parent's). */
  cwd?: string;
  runId: string;
  /** F26: the part's first input (its brief) – what wakes its subconscious's condense call. */
  brief?: string;
  /** F26: the turn's stop; it ends that call too. */
  signal?: AbortSignal;
}

export interface SeedResult {
  how: SplitFork['how'];
  /** The new native session (native fork); absent: the turn starts a new one. */
  ref?: string;
  generation?: number;
  /** Text put in front of the turn's input (the text fallback). */
  inputPrefix?: string;
  /** B-057 C: the parent's session a native fork copied (SplitFork.parentRef). */
  parentRef?: string;
  /** B-057 C: why the earlier ways did not seed it ("native: …"). */
  fellBack?: string[];
  /** F26: how many items of its copy of my record the part's subconscious condensed before it started. */
  condensed?: number;
}

type Way = (s: RuntimeServices, args: SeedArgs, cwd: string) => Promise<SeedResult | string>;

export async function seedSplitSession(s: RuntimeServices, args: SeedArgs): Promise<SeedResult> {
  if (args.split.context === 'brief') {
    mark(s, args, { how: 'fresh' });
    return { how: 'fresh' };
  }
  const fellBack: string[] = [];
  const cwd = args.cwd ?? args.split.cwd ?? turnCwd(s, args.plan.task, args.plan.agent.id);
  const condensed = await condenseCopy(s, args); // F26 (0)
  const lean = condensed ? textSeed(s, args, fellBack) : undefined;
  let result: SeedResult | undefined = lean?.inputPrefix && !forkPays(s, args, lean.inputPrefix) ? { how: 'ledger', inputPrefix: lean.inputPrefix } : undefined;
  if (!result) for (const [name, way] of [['native', nativeFork]] as Array<[string, Way]>) {
    try {
      const outcome = await way(s, args, cwd);
      if (typeof outcome !== 'string') { result = outcome; break; }
      fellBack.push(`${name}: ${outcome}`);
    } catch (error) {
      fellBack.push(`${name}: ${reason(error)}`);
    }
  }
  result ??= lean ?? textSeed(s, args, fellBack);
  if (condensed) result.condensed = condensed;
  if (fellBack.length) result.fellBack = fellBack;
  note(s, args.runId, result);
  mark(s, args, result);
  return result;
}

/** (a) The native fork of the parent's session on the worker's engine and account; a string says why not. */
async function nativeFork(s: RuntimeServices, args: SeedArgs, cwd: string): Promise<SeedResult | string> {
  const { engine, account } = args.route;
  if (!engine.caps.fork || !engine.fork) return 'the engine cannot fork';
  const agentId = args.plan.agent.id;
  // S4a: only the session the parent's splitting turn ran on – a binding of this engine from an older turn (the agent
  // switched engine or account since) would lack the parent's recent context, the split itself included.
  const ran = s.runs.get(args.split.parentRunId);
  if (ran?.engine && ran.engine !== engine.id) return "the parent's turn ran on another engine";
  if (ran?.accountId && ran.accountId !== account.id) return "the parent's turn ran on another account";
  // B-080: the session the splitting turn ended with, as recorded when the group started – never the live binding, which
  // the parent's next turn may have renewed or moved on by the time this part starts.
  const parent = args.split.parentSession;
  if (!parent || parent.engine !== engine.id) return "the parent's splitting turn left no session on this engine";
  if (parent.accountId !== account.id) return 'the parent session belongs to another account';
  if (!canContinueManaged(engine, account.id, parent.ref)) return LEGACY_SESSION;
  if (pastFit(parent.contextTokens, windowOf(s, args))) return PAST_WINDOW;
  const forked = await engine.fork({ runId: args.runId, agentId, account, parentRef: parent.ref, cwd, model: args.route.model,
    ...(parent.turn ? { lastTurn: parent.turn } : {}) });
  if (!forked.ref || forked.ref === parent.ref) throw new Error('the engine gave no new session');
  return { how: 'native', ref: forked.ref, generation: forked.generation ?? 1, parentRef: parent.ref };
}

/**
 * B-080: the session the parent's splitting turn ended with – its binding on (agent, the group's thread, the run's engine),
 * with that run's native turn on it (agents/native-turns.ts; Codex names its turns) – recorded when the group starts
 * (splits/runner.ts startGroup; turn-finish saved the binding before it started the group). FIXES-3 B1: a splitting turn
 * that still runs (agents.split with wait) – `live`, what the dispatcher says it runs on – has the session it runs on: the
 * binding saved before the run started (a session bound during the turn is new in it), on the engines of FORKS_IN_TURN only.
 * Claude Code forks it as its transcript stands, the running turn up to the split's call included; `contextTokens` – what
 * the window and cost checks weigh – is its size before the turn (measured 18.11.2026: 46,464 recorded, 48,570 read).
 * Undefined: no engine named or no such session (its 'fork' parts start from the text seed).
 */
export function recordedParent(db: Db, run: Pick<Run, 'engine' | 'startedAt' | 'status'> | undefined, group: Pick<SplitGroup, 'agentId' | 'thread' | 'parentRunId'>, live?: { engine?: EngineId; model?: string }): SplitParentSession | undefined {
  const running = run?.status === 'running';
  const engine = running ? live?.engine : run?.engine;
  if (!engine || (running && !FORKS_IN_TURN.has(engine))) return undefined;
  try {
    const binding = new SessionStore(db).get(group.agentId, group.thread, engine);
    // B-080 review: only the binding the splitting run left – an older turn's session lacks the split's own context
    const before = run?.startedAt !== undefined && binding !== undefined && binding.updatedAt < run.startedAt;
    if (!binding || before !== running) return undefined;
    const turns = turnsOn(db, { agentId: group.agentId, conversationId: group.thread, engine }, binding.ref);
    const turn = turns.find((entry) => entry.runId === group.parentRunId)?.turn; // a running turn has none yet
    return {
      engine: binding.engine, ...(binding.accountId ? { accountId: binding.accountId } : {}), ref: binding.ref,
      ...(binding.contextTokens !== undefined ? { contextTokens: binding.contextTokens } : {}), ...(turn ? { turn } : {}),
      ...(running && live?.model ? { model: live.model } : {}),
    };
  } catch { return undefined; }
}

/** (b) The parent's checkpoint and my record as text in front of the worker's input; fresh when there is nothing. */
function textSeed(s: RuntimeServices, args: SeedArgs, fellBack: string[]): SeedResult {
  const agentId = args.plan.agent.id;
  const chat = args.split.parentConversationId;
  const taskId = args.split.parentTaskId;
  let checkpoint = '';
  // A task's checkpoint (goal, steps done and open …); a chat alone has none worth more than its lines – its checkpoint
  // would name the chat's newest request, which may be a line the parent had not seen at the split.
  if (taskId) {
    try { checkpoint = clip(quoteHeaders(checkpointText(s.context.checkpoint({ agentId, taskId, conversationId: chat }))), CHECKPOINT_CHARS); }
    catch (error) { fellBack.push(`checkpoint: ${reason(error)}`); }
  }
  const budget = Math.floor(fitLimit(windowOf(s, args)) / 2 * engineUnit(args.route.engine.id)); // the window's tokens in the record's unit
  // F26: the part's copy of my record (its subconscious's marks applied), else mine
  const record = historyText(s, agentId, splitThread(args.split.splitId), budget) ?? historyText(s, agentId, args.split.parentThread, budget) ?? '';
  if (!checkpoint.trim() && !record.trim()) return { how: 'fresh' };
  const parts = [TEXT_HEAD, checkpoint && `My state:\n${checkpoint}`, record];
  return { how: 'text', inputPrefix: parts.filter(Boolean).join('\n\n') };
}

/**
 * F26 (0): my record copied into the part's thread (ledger.fork, only while it holds none – a later seeding of the same part keeps
 * its copy and makes no call); on that copy the part's subconscious condenses, with its brief, what this piece will not read again.
 * How many it condensed; 0 without a copy, a brief or a model, and on any failure.
 */
async function condenseCopy(s: RuntimeServices, args: SeedArgs): Promise<number> {
  const { agent } = args.plan;
  const thread = splitThread(args.split.splitId);
  try {
    if (!s.ledger?.fork?.(agent.id, args.split.parentThread, thread, args.split.parentRunId)) return 0;
    if (!args.brief?.trim() || !s.subconscious?.condensePart) return 0;
    const conversationId = args.split.chat ?? args.split.parentConversationId;
    return await s.subconscious.condensePart({ agent, thread, ...(conversationId ? { conversationId } : {}), brief: args.brief, ...(args.signal ? { signal: args.signal } : {}) });
  } catch (error) {
    s.log.warn("the part's record was not condensed; it starts as before", { splitId: args.split.splitId, error: reason(error) });
    return 0;
  }
}

/** What a cache write costs in cached reads where the price table knows no price for that model (measured on Claude Code 15.–17.11.2026: about 40). */
const WRITE_IN_READS = 40;

/**
 * What one written token costs in cached read tokens for that model, from the price table (the prior's write price against its
 * cached price, else the input price against a tenth of it, models/pricing.ts): on Claude Code about 40, on Codex about 10.
 */
function writeInReads(s: RuntimeServices, modelId: string): number {
  try {
    const info = s.catalog.get(modelId);
    const prior = priorFor(Priors.shipped(s.paths?.resources), info?.model ?? modelId.slice(modelId.indexOf(':') + 1), modelId);
    const { write, read } = cachePrices(prior, info);
    return write && read ? write / read : WRITE_IN_READS;
  } catch { return WRITE_IN_READS; }
}

/**
 * F26: whether my native fork costs less than the part's condensed record. The fork re-reads my session on each model call, cached
 * while my cache is warm on the same model (agents/compaction-policy.ts CACHE_COLD_MS); the record with the turn's prompt and tools is read once
 * uncached, then cached – the fork wins while the record's saving over the calls of my splitting run stays below what writing it
 * costs in reads (writeInReads). No warm fork to weigh (another engine, account or model, a cold cache, past the window, no size): false.
 */
function forkPays(s: RuntimeServices, args: SeedArgs, record: string): boolean {
  try {
    const parent = args.split.parentSession;
    const { engine, account, route } = args.route;
    if (!engine.caps.fork || !parent?.contextTokens || parent.engine !== engine.id || parent.accountId !== account.id || pastFit(parent.contextTokens, windowOf(s, args))) return false;
    const ran = s.runs.get(args.split.parentRunId);
    const model = ran?.model ?? parent.model; // FIXES-3 B1: a splitting turn that still runs names its model only in its recorded session
    if (!ran || !model || model !== route.modelId || s.clock.now() - (ran.endedAt ?? ran.startedAt ?? 0) > CACHE_COLD_MS) return false;
    // in the engine's own tokens, as the parent's count is (shared/model/context-ledger.ts engineUnit)
    const lean = tokensOf(record.length + args.system.stable.length + args.system.volatile.length + JSON.stringify(args.tools).length) / engineUnit(parent.engine);
    const calls = Math.max(1, ran.modelCalls || Math.round((ran.inputTokens ?? 0) / parent.contextTokens));
    return (parent.contextTokens - lean) * calls < writeInReads(s, route.modelId) * lean;
  } catch { return false; }
}

/** The checkpoint as text, without its "next step" (the worker's part is its next step). */
export function checkpointText(handoff: Handoff): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');
  return [
    handoff.goal && `Goal: ${handoff.goal}`,
    handoff.verified.length && `Done so far:\n${list(handoff.verified)}`,
    handoff.open.length && `Open:\n${list(handoff.open)}`,
    handoff.constraints?.length && `Known so far:\n${list(handoff.constraints)}`, // B-080: what checkpoint.ts puts there – tried ways, facts found
    handoff.artifacts.length && `Artifacts:\n${list(handoff.artifacts.map((item) => `${item.label}: ${item.ref}`))}`,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}

/**
 * The worker model's context window for the fit – B-080: the main path's rule (agents/session-choice.ts chooseSession): the
 * window its engine reported for this model (the one it really runs with), else the catalog's; neither → DEFAULT_WINDOW.
 */
function windowOf(s: RuntimeServices, args: SeedArgs): number | undefined {
  const modelId = args.route.route.modelId;
  try {
    const reported = new SessionStore(s.db).reportedWindow(args.route.engine.id, modelId);
    if (reported) return reported;
  } catch { /* the catalog's then */ }
  try { return s.catalog.get(modelId)?.caps.contextTokens; } catch { return undefined; }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** The split's `fork` record (Split.fork, shown on its view): how, and for a seeded session its engine, account and parent. */
function mark(s: RuntimeServices, args: SeedArgs, result: SeedResult): void {
  const seeded = result.how === 'native';
  const fork: SplitFork = {
    how: result.how, ...(seeded ? { engine: args.route.engine.id, accountId: args.route.account.id } : {}), ...(result.parentRef ? { parentRef: result.parentRef } : {}),
  };
  try { s.splits?.markFork?.(args.split.splitId, fork); } catch { /* the view only */ }
}

function note(s: RuntimeServices, runId: string, result: SeedResult): void {
  try {
    s.runs.item(runId, { kind: 'note', data: { splitSeed: result.how, ...(result.condensed ? { condensed: result.condensed } : {}), ...(result.parentRef ? { parentRef: result.parentRef } : {}), ...(result.fellBack ? { fellBack: result.fellBack } : {}) }, effectStatus: 'none' });
  } catch { /* journal only */ }
}
