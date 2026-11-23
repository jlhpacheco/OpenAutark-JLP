// The context fold (KI-Runde 17.11.2026, owner: "immer mal wieder Compactings … vor allem wenn Schritte aufhören … ein bisschen
// mehr Thinking … dass das Ding grundsätzlich kleiner ist"): when a piece of work ends, the agent writes its own hand-over
// on its warm session and its next turn starts from that instead of from everything it read on the way. Measured
// 15.–17.11.2026: a model call carried 430k tokens on average and a run makes 13 of them, so what stays in the context is
// paid 13 times per run; 51 % of what was still in view belonged to finished tasks.
// How it runs (not the dispatcher's fold of a chat line into a running turn, dispatch-fold.ts – this one makes the context small):
//   1. A main-lane turn ends done (turn-finish.ts → wantsFold): no part, no call's turn, on an engine that keeps a session
//      and can start one from the ledger, a session that is not folded already and whose rebuilds are not blocked (rebuild.ts
//      rebuildBlocked: nothing would replay the hand-over). The engine's own count of the session decides (compaction-policy.ts
//      foldWhy: a task was finished and FOLD_STEP is reached, FOLD_IDLE is reached, or the engine compacted by itself – that
//      cause stays on the binding, SessionBinding.compactedAt, until a fold ran). The turn's outcome carries the cause.
//   2. The dispatcher starts the fold turn right after that turn (dispatcher.ts handOver → dispatch-runs.ts fold): a turn like
//      every other – its own run (trigger 'fold'), journaled, priced, in the live bar of the chat the work came from, stopped by
//      that chat's Stop. What holds it back is a wake a person caused (their line, answer, approval, a run they started) or a
//      call the agent takes part in, on this PC or a linked one (foldWaitsFor); the agent's own background wakes – task, child, review, schedule, retry –
//      and a colleague's line wait the one turn it takes, which is the cheapest moment there is: they then read the small
//      context. A person's line cuts the fold turn at its next tool boundary and nothing is marked. A fold that cannot start
//      now is not kept: the next turn's end asks again.
//   3. The fold turn (planFold; turn-prepare.ts buildTurn) resumes the same session on the same account and model at an
//      effort of at least high (the last turn's where another effort would write the cache anew), with the system text and tools the session started with, no live block, and one note as its
//      whole input (FOLD_NOTE). The router is not asked; its run counts as a request's, so its raised effort is nobody's to
//      return to. A session that is not there to resume (it ended, the route moved to another account) fails the turn.
//   4. Its closing text is the hand-over (endFold) – Quests round 20.11.2026: with my "## My quests" lines as they stand under
//      it (FOLD_QUESTS), so a fold never drops an ask –, in one transaction: journaled as the run's 'Hand-over' note(s) – the ledger
//      records them as checkpoint items –, the ledger pins it and hides everything of the agent's own work before it by 'fold'
//      (context/ledger/service.ts fold) and the session is marked folded (SessionBinding.foldedAt). Nothing of it is posted:
//      the turn has no chat, so the safety net has nowhere to go; blocks it addresses go out as always.
//   5. The next turn's chooseSession finds the folded session and starts it anew from the ledger view (rebuild.ts why 'fold').
// A fold turn that fails, is stopped or cut, or writes less than FOLD_MIN_CHARS marks nothing; the session stays as it is. It
// has no failover and no renewal retry (turn.ts): the next turn's end asks again.
// Owns: the trigger at a turn's end (and the engine's compaction mark, set at the end of every main-lane turn it happened in),
// what holds a fold back, the fold turn's plan and route (a stand-in's mark carried on), the note's wording, and what its end
// writes. Never: posts a message, folds for a turn that did not end done, or folds a part's session.

import type { RuntimeServices } from '../contracts.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { Effort, EngineId, RouteDecision } from '../../shared/model/providers.ts';
import { ROUTE_BY_REQUEST, type Run, type WakeReason } from '../../shared/model/runs.ts';
import { MAIN_THREAD } from '../../shared/model/origin.ts';
import type { Engine } from '../engines/types.ts';
import { clampEffort, effortRank } from '../models/efforts.ts';
import { effortKeepsCache } from '../subconscious/route-turn.ts';
import { inLiveCall } from '../calls/wiring.ts';
import { thisPc } from '../calls/call-log.ts';
import { callRecord, callState } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import '../contracts/ledger.ts';
import { FOLD_MIN_CHARS, foldWhy, type FoldWhy } from './compaction-policy.ts';
import { journalAnswer, splitAnswer } from './publishing.ts';
import { SessionStore } from './sessions.ts';
import { rebuildBlocked } from './rebuild.ts';
import type { AttemptResult, RoutedTurn, TurnPlan, TurnRequest } from './turn-types.ts';
import { myQuestsSection } from '../context/quest-text.ts';
import { profileZone } from '../context/time.ts';

declare module './turn-types.ts' {
  interface TurnRequest {
    /** Set on a fold's turn (reason 'fold', no chat, no task, no notes): why it runs. */
    fold?: FoldWhy;
  }
  interface TurnPlan {
    /** The fold this turn is: why it runs and the route it resumes its session on (the router is not asked). */
    fold?: { why: FoldWhy; route: RouteDecision };
  }
  interface TurnOutcome {
    /** The turn ended done and its session calls for a fold (wantsFold); the dispatcher starts one when nothing else is due. */
    fold?: FoldWhy;
  }
}

/**
 * The fold turn's whole input, in my own voice – true for each cause it runs for (a step that ended, the size alone, the
 * engine's own compaction): `{{size}}` is the engine's count of my session where it has one.
 */
export const FOLD_NOTE = 'My turn is done, and my context holds {{size}}: I read all of it again on every step. '
  + 'I write my hand-over to myself now – it is all my next turn starts from, beside my chats with my own lines in them, '
  + 'my quests and my files: what I am working on and for whom, what I decided and why, the exact names, paths, ids and '
  + 'values I will need again, what is promised to whom, and what I do next. What is finished gets one line; an ask that is '
  + 'not done stays open in its quest, and my quests as they stand now are added under my hand-over. '
  + 'The full record stays in reach (`context.restore`).';

/** Quests round 20.11.2026: the heading of the "## My quests" lines a hand-over carries as they stood (endFold). */
export const FOLD_QUESTS = 'My quests when I wrote this hand-over:';

/** FOLD_NOTE with the session's size ("312,000 tokens"; without a count: "all I read on the way"). */
export function foldNote(tokens: number | undefined): string {
  const size = tokens !== undefined && tokens > 0 ? `${Math.round(tokens).toLocaleString('en-US')} tokens` : 'all I read on the way';
  return FOLD_NOTE.replace('{{size}}', size);
}

/** The run note name of a hand-over's part (data {checkpoint: true, text}; context/ledger/capture.ts records it as a checkpoint item). */
export const CHECKPOINT_ITEM = 'Hand-over';
/** The call that finishes a task (status done or dropped) – with a task of mine ended in the run it says a step ended. */
const FINISH_CALL = 'tasks.update';
/** The effort a fold turn runs at, at least. */
const FOLD_EFFORT: Effort = 'high';
/** The fold turn's route reason, as the run journal shows it. */
const FOLD_ROUTE = 'context fold · the session\'s own model';
const LAST_RUNS = 20;

function note(services: Pick<RuntimeServices, 'runs'>, runId: string, data: Record<string, unknown>): void {
  try { services.runs.item(runId, { kind: 'note', data, effectStatus: 'none' }); } catch { /* journal only */ }
}

/**
 * Whether the turn that just ended done calls for a fold, and why (see the header, step 1). Read after the turn's session was
 * saved: the binding's count is the engine's own.
 */
export function wantsFold(services: RuntimeServices, plan: TurnPlan, turn: Pick<RoutedTurn, 'engine'>, attempt: Pick<AttemptResult, 'result' | 'tools'>): FoldWhy | undefined {
  if (plan.split || plan.fold || !attempt.result.session) return undefined;
  const { caps, id } = turn.engine;
  if (!caps.sessions || !caps.rebuild || !services.ledger?.fold) return undefined;
  try {
    const store = new SessionStore(services.db);
    const session = store.get(plan.agent.id, plan.thread, id);
    if (!session || session.foldedAt !== undefined) return undefined; // gone, or folded already and not started anew yet
    // The engine's own compaction stays the cause until a fold ran, whatever the end of the main-lane turn it happened in (a
    // call's, a failed or a cut one too): the next turn's end that can be followed by a fold asks again (folded() and a new
    // session clear it).
    if (attempt.result.compacted === true && session.compactedAt === undefined) store.compacted(plan.agent.id, plan.thread, id, services.clock.now());
    if (plan.callId || attempt.result.stop !== 'done') return undefined; // a fold follows only a done turn, never between a call's lines
    // While the thread's rebuilds are blocked nothing would start the session from a hand-over: a fold now only costs its turn.
    if (rebuildBlocked(services, plan.agent.id, plan.thread, id)) return undefined;
    return foldWhy({
      tokens: session.contextTokens, compacted: attempt.result.compacted === true || session.compactedAt !== undefined,
      finishedTask: (attempt.tools ?? []).some((use) => use.name === FINISH_CALL && use.ok !== false) && endedInRun(services, plan.agent.id),
    });
  } catch (error) {
    services.log.warn('the fold was not weighed', { agentId: plan.agent.id, error: String(error) });
    return undefined;
  }
}

/** A task I own ended (done or dropped) since my newest run – the turn that just ended – started. */
function endedInRun(services: RuntimeServices, agentId: string): boolean {
  try {
    const run = (services.runs.listTopLevel?.(agentId, 1) ?? services.runs.list(agentId, 1))[0];
    if (run?.startedAt === undefined) return false;
    return services.tasks.list({ assigneeKind: 'agent', assigneeId: agentId, completedSince: run.startedAt, includeSteps: true, limit: 1 }).length > 0;
  } catch { return false; }
}

/** The "## My quests" lines as they stand now, under FOLD_QUESTS ('' when they cannot be read). */
function questsNow(services: RuntimeServices, agentId: string): string {
  try {
    const lines = myQuestsSection(services, agentId, profileZone(services)).split('\n').slice(1);
    return [FOLD_QUESTS, ...lines].join('\n');
  } catch (error) {
    services.log.warn('the hand-over got no quest lines', { agentId, error: String(error) });
    return '';
  }
}

/** The wakes a person's own step causes without a line of theirs: their answer, a run they started. */
const PERSON_WAKES: ReadonlySet<WakeReason> = new Set<WakeReason>(['answer', 'manual']);
/** How many unseen lines of a chat are read to see whether one of them is the person's. */
const UNSEEN_LINES = 50;

/**
 * What holds the fold back until a later turn's end: a wake a person caused ('person' – their line in one of my chats, their
 * answer, their approval, a run they started) or a call I take part in ('call'). My own background work – a task, a part's
 * result, a review, a schedule, a retry – and a colleague's line wait the one turn the fold takes and then read the small
 * context. Undefined: nothing holds it. Anything unreadable counts as a person waiting.
 */
export function foldWaitsFor(services: RuntimeServices, agentId: string): 'person' | 'call' | undefined {
  // calls/call-log.ts inCall: a call running on this PC with me in its chat; callElsewhere: one a linked PC runs
  if (inLiveCall(services, agentId) || callElsewhere(services, agentId)) return 'call';
  return personDue(services, agentId) ? 'person' : undefined;
}

/** A call row nobody has spoken in for this long holds nothing back: a PC that went away leaves its row open until it starts again. */
const CALL_QUIET_MS = 30 * 60 * 1000;

/**
 * A call in one of my chats that another linked PC runs: its row (synced, written only by the PC that holds it) is open, and
 * something was said in it within CALL_QUIET_MS. This PC's own calls are inLiveCall's.
 */
function callElsewhere(services: RuntimeServices, agentId: string): boolean {
  try {
    const now = services.clock.now();
    const here = thisPc(services);
    const rows = services.db.all<{ meta: string }>(
      `SELECT meta FROM messages WHERE conversation_id IN (SELECT conversation_id FROM members WHERE member_id = ? AND left_at IS NULL)
         AND kind = 'status' AND json_extract(meta, '$.call.id') IS NOT NULL AND json_extract(meta, '$.call.endedAt') IS NULL`, [agentId]);
    return rows.some((row) => {
      const call = callRecord({ kind: 'status', meta: JSON.parse(row.meta) as Message['meta'] });
      if (!call || (here !== undefined && call.pc === here)) return false;
      const state = callState(call, now);
      return (state === 'running' || state === 'ringing') && now - Math.max(call.startedAt, call.lines.at(-1)?.at ?? 0) < CALL_QUIET_MS;
    });
  } catch { return false; }
}

/** A due, unclaimed wake of the agent that a person caused. */
function personDue(services: RuntimeServices, agentId: string): boolean {
  try {
    const now = services.clock.now();
    for (const wake of services.wakes.list(agentId)) {
      if (wake.claimedAt !== undefined || wake.dueAt > now) continue;
      if (PERSON_WAKES.has(wake.reason)) return true;
      if (wake.reason === 'message' && wake.conversationId && personLine(services, agentId, wake.conversationId)) return true;
    }
    return false;
  } catch { return true; }
}

/**
 * Whether a line of a person waits unseen for the agent in that chat (a colleague's line does not hold the fold back).
 * `taken` – for a running turn: the seq up to which it already took that chat's lines, and (a fold's turn, which takes
 * none) when it started; only a person's line after both is new to it.
 */
export function personLine(services: Pick<RuntimeServices, 'chats'>, agentId: string, conversationId: string, taken?: { seq?: number; since?: number }): boolean {
  try {
    const member = services.chats.members(conversationId).find((item) => item.memberId === agentId && !item.leftAt);
    return services.chats.messages(conversationId, { afterSeq: Math.max(member?.readSeq ?? 0, taken?.seq ?? 0), limit: UNSEEN_LINES })
      .some((message) => message.authorKind === 'human' && message.kind !== 'status' && message.state !== 'streaming'
        && (taken?.since === undefined || message.createdAt >= taken.since));
  } catch { return true; }
}

/** The effort the agent's newest finished turn on that session's model ran at, and its work category. */
function lastTurn(services: Pick<RuntimeServices, 'runs'>, agentId: string, engine: EngineId, model: string): Run | undefined {
  try {
    const runs = services.runs.listTopLevel?.(agentId, LAST_RUNS) ?? services.runs.list(agentId, LAST_RUNS);
    return runs.find((run) => !run.splitId && run.status === 'done' && run.engine === engine && run.model === model);
  } catch { return undefined; }
}

/**
 * The plan of a fold's turn (TurnRequest.fold): the agent's newest main session as it stands – same engine, account and model,
 * the effort of its last turn there raised to at least high. Undefined (no run): no such session, one folded already, an
 * engine that cannot start it anew, an agent that is paused or gone.
 */
export function planFold(services: RuntimeServices, request: TurnRequest, resolveMode: (services: RuntimeServices, keys: Array<string | undefined>) => ModeInfo): TurnPlan | undefined {
  const agent = services.org.get(request.agentId);
  if (!agent || agent.archivedAt || agent.status === 'paused' || !request.fold) return undefined;
  const session = new SessionStore(services.db).newest(agent.id, MAIN_THREAD);
  if (!session?.model || !session.accountId || session.foldedAt !== undefined) return undefined;
  let engine: Engine | undefined;
  try { engine = services.engines.get(session.engine); } catch { engine = undefined; }
  if (!engine?.caps.sessions || !engine.caps.rebuild) return undefined;
  const last = lastTurn(services, agent.id, session.engine, session.model);
  // The raised effort is free only where the model keeps its cache across one (subconscious/route-turn.ts effortKeepsCache):
  // where it does not, the fold would write the whole context instead of reading it, so it stays on the last turn's effort.
  const wanted = effortKeepsCache(session.engine, session.model) === false ? (last?.effort ?? FOLD_EFFORT)
    : last?.effort && effortRank(last.effort) > effortRank(FOLD_EFFORT) ? last.effort : FOLD_EFFORT;
  const route: RouteDecision = {
    modelId: session.model, engine: session.engine, accountId: session.accountId, effort: clampEffort(wanted, services.catalog.get(session.model)?.efforts ?? []),
    category: last?.route?.category ?? 'chat', reason: FOLD_ROUTE, by: ROUTE_BY_REQUEST as string as RouteDecision['by'], alternatives: [],
    // A stand-in stays one through the fold: the next boundary still goes back to the model it stood in for (next-route.ts).
    ...(last?.route?.standIn ? { standIn: true as const } : {}),
  };
  return { agent, mode: resolveMode(services, [session.mode, agent.mode]), thread: MAIN_THREAD, memberCursor: 0, needsVision: false, fold: { why: request.fold, route } };
}

/** The next turn's note on a session whose fold turn was cut or failed after it read the fold note (turn-finish.ts). */
export const FOLD_CUT_NOTE = 'I did not finish my hand-over: nothing was folded, and my context stands as it was.';

/**
 * The end of a fold turn: when it ended `done`, its closing text becomes the hand-over (see the header, step 4). A text below
 * FOLD_MIN_CHARS is journaled as the run's answer and marks nothing; so does a hand-over the ledger did not record. A fold
 * that was cut or failed keeps its partial text in a plain note – the ledger records no words of mine from it.
 */
export function endFold(services: RuntimeServices, plan: TurnPlan, turn: Pick<RoutedTurn, 'engine' | 'session'>, request: Pick<TurnRequest, 'runId'>, text: string, done: boolean): void {
  const agentId = plan.agent.id;
  const why = plan.fold?.why;
  const before = turn.session?.contextTokens;
  if (!done) {
    let partial = text.trim();
    try { partial = services.secrets.redact(partial); } catch { /* the journal is local */ }
    note(services, request.runId, { fold: 'kept', why, reason: 'cut', ...(partial ? { text: partial.slice(0, 4000) } : {}) });
    return;
  }
  if (text.trim().length < FOLD_MIN_CHARS) {
    journalAnswer(services, request.runId, text, 'internal');
    note(services, request.runId, { fold: 'kept', why, reason: 'no hand-over written' });
    return;
  }
  const quests = questsNow(services, agentId); // Quests round 20.11.2026: the asks stand in the hand-over as data, never as my retelling
  const whole = quests ? `${text.trimEnd()}\n\n${quests}` : text;
  let clean = whole;
  try { clean = services.secrets.redact(whole); } catch { /* the journal is local */ }
  const parts = splitAnswer(clean);
  try {
    // One transaction: the hand-over's notes (the ledger records them as checkpoint items), the hides it pins and the mark on
    // the session – a crash in between would otherwise leave unpinned items beside the whole record with no fold recorded.
    const done = services.db.tx(() => {
      parts.forEach((part, index) => services.runs.item(request.runId, {
        kind: 'note', name: CHECKPOINT_ITEM, effectStatus: 'none', data: { checkpoint: true, text: part, ...(parts.length > 1 ? { part: index + 1, parts: parts.length } : {}) },
      }));
      const folded = services.ledger?.fold?.(agentId, plan.thread, request.runId);
      if (folded) new SessionStore(services.db).folded(agentId, plan.thread, turn.engine.id, services.clock.now());
      return folded;
    });
    note(services, request.runId, done
      ? { fold: why, ...(before !== undefined ? { before } : {}), hidden: done.hidden, checkpoint: done.checkpoint }
      : { fold: 'kept', why, reason: 'the hand-over is not in the record' });
  } catch (error) {
    services.log.warn('the fold was not written', { agentId, runId: request.runId, error: String(error) });
    note(services, request.runId, { fold: 'kept', why, reason: 'failed' });
  }
}
