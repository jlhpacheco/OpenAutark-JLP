// B-057 – the turn pipeline's split parts (S2/S5/S9/S10/S12/S15), called with one line from each phase. A split's turn
// (TurnRequest.split, started on its own dispatcher lane – dispatch-lanes.ts) is its parent agent working on one part:
//   plan   – its own thread `split:<id>`, no task or member cursor (its run carries the chat its work is for – the
//            part's `chat`), in the parent's mode at the split while it still exists;
//   route  – S10 (routing/split-route.ts): a part names its model where its context starts – a catalog model id = that
//            model; 'cheap' = the router's 'cheaper' need from the parent's model; 'strong' = the strong tier or above;
//            Halb 21.11.2026: a needs word (check | chain | judgment – a fresh part's own) = the kind default in the cost
//            mode and at the effort it asks for (RouteRequest.split.needs, routing/split-route.ts SPLIT_NEED).
//            17.11.2026 (measured: 12 of 56 parts named none and ran on their origin's model, 9 of them on the frontier
//            tier, with the reason "requested by the agent"): a part that names none starts on its origin's model – a fresh
//            one (from its brief) on the executing default when its origin is above it (RouteRequest.split.fresh,
//            routing/kind.ts) – with the origin's effort unless it names one; from its second turn on it stays on the
//            model its own session is on (boundary.ts, asked for its thread). The part's choice beats the agent's pin and
//            fixed effort; B-083: its temperature goes on the plan like a model.set request's (engines that take one send it);
//   session – the first turn without a binding on its thread is seeded from its parent (splits/fork.ts) and that ref is
//            bound under (agent, split thread, engine) – a native fork with its parent session's start record and key, any
//            other seed with this turn's prompt key; the seed's text goes before the input; FIXES-3 B1: a native fork's
//            binding keeps its parent's running cost total as its own start (Claude Code's fork carries it);
//            F26: a 'fork' part's subconscious first condenses its copy of the parent's record with the part's notes (its
//            brief) as what wakes it – the turn's stop ends that call;
//            the tool offer is its agent's, like its parent's (the agent's learned tools – S8; what a part finds through
//            tools.call is learned for its agent too, tools/registry.ts callThrough);
//   attempt – ToolContext.split, the parent's chat for reach, its folder (its worktree, else the group's), and on a warm
//            Codex app-server no heavy supervisor slot (S12);
//   finish – its <chat> blocks post like the agent's own; its final text goes to its origin – on its own, at once (gather.ts
//            returned); the split service hears how the run ended (B-080: a
//            done run that brought nothing back – no last words, no note to its origin, no files – fails, NOTHING_BACK).
// For the agent's own (non-split) turns: the "Split results" block of its parts that came back joins the turn input, and the
// turn's end lets the split service start the groups it created (afterParentTurn) and gather the parts it showed ('done').
// Owns: those split rules of the pipeline. Never: runs or stops a turn, touches the parent's session, ledger or chat
// cursor (F26: only the part's own copy of that ledger is condensed), or decides a split's lifecycle (runtime/splits/service.ts does).

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { SplitRunEnd } from '../contracts/splits.ts';
import type { Engine } from '../engines/types.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { Account, RouteDecision } from '../../shared/model/providers.ts';
import type { Run, RunStatus } from '../../shared/model/runs.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import { splitThread, type SplitTurn } from '../../shared/model/splits.ts';
import { effectsKnown } from '../context/recent-actions.ts';
import { seedSplitSession, type SeedResult } from '../splits/fork.ts';
import { SHUTDOWN_CUT } from '../splits/reconcile.ts';
import { resultOf } from '../splits/results.ts';
import { SPLIT_NEED, needsOfModel } from '../routing/split-route.ts';
import { boundaryOf } from './boundary.ts';
import { SessionStore, type SessionBinding } from './sessions.ts';
import { recordStart, startOf, type SessionStart, type ToolOffer } from './session-key.ts';
import type { AttemptResult, RoutedTurn, TurnPlan, TurnRequest } from './turn-types.ts';

const FOCUS_CHARS = 4000;

type Previous = NonNullable<RouteRequest['previous']>;

/** The plan of a split's turn (planTurn's split branch); undefined when its agent is gone, archived or paused. */
export function planSplit(services: RuntimeServices, request: TurnRequest, resolveMode: (services: RuntimeServices, keys: Array<string | undefined>) => ModeInfo): TurnPlan | undefined {
  const split = request.split;
  const agent = services.org.get(request.agentId);
  if (!split || !agent || agent.archivedAt || agent.status === 'paused') return undefined;
  const thread = splitThread(split.splitId);
  const boundary = boundaryOf(services, agent.id, thread); // its own session: none before its first turn
  // The model the origin is on while its splitting run still runs (agents.split with wait: true): a run's row gets its model
  // only when it ends, so its session there says it (measured 18.11.2026: parts of a waiting Terra turn ran on Sonnet).
  let origin: string | undefined;
  try { origin = new SessionStore(services.db).newest(agent.id, split.parentThread)?.model; } catch { origin = undefined; }
  const previous = splitPrevious(services, split, boundary.on?.modelId, origin);
  return {
    agent, mode: resolveMode(services, [split.modeKey, agent.mode]), ...(request.origin ? { origin: request.origin } : {}),
    thread, memberCursor: 0, focus: request.notes.map((note) => note.text).join('\n').slice(-FOCUS_CHARS),
    ...(previous ? { previous } : {}), boundary: boundary.at, ...(split.temperature !== undefined ? { temperature: split.temperature } : {}), // B-083
    needsVision: false, split,
  };
}

/**
 * S10: RouteRequest.previous of a split's turn. `on` = the model the part's own session is on (none before its first turn):
 * where it is, else its origin's model. A model it names is its explicit request; without one the model is where it is and
 * only an effort it names is asked for.
 */
export function splitPrevious(services: Pick<RuntimeServices, 'runs' | 'log'>, split: Pick<SplitTurn, 'parentRunId' | 'model' | 'effort'>, on?: string, origin?: string): Previous | undefined {
  let parent: Run | undefined;
  try { parent = services.runs.get(split.parentRunId); } catch (error) {
    services.log.warn('reading the parent run failed; the split routes as usual', { runId: split.parentRunId, error: String(error) });
  }
  // `origin`: the model of the origin's session, for a parent run that is still running and names none yet
  const from = parent?.model ?? (parent ? origin : undefined);
  const effort = split.effort;
  const base = parent?.effort ?? 'medium';
  const choice = split.model?.trim();
  /** Where the part is – its session's model, else `start` – with an effort it names (or its needs asks for) as its request. */
  const where = (start: string | undefined, asked = effort): Previous | undefined => {
    const modelId = on ?? start ?? '';
    if (asked) return { modelId, effort: asked, explicit: true, asked: 'effort' };
    return modelId ? { modelId, effort: base } : undefined;
  };
  if (!choice || choice === 'same') return where(from); // none named: its origin's model, with the origin's effort
  if (choice === 'strong') return where(undefined); // needs.tier (splitRoute) – the executing default inside it
  // Halb 21.11.2026: its needs – the kind default in the cost mode they ask for (split.needs, routing/split-route.ts), at their effort
  const needs = needsOfModel(choice);
  if (needs) return where(undefined, effort ?? SPLIT_NEED[needs].effort);
  // B-083 D1: `from` – the model the part is on (its origin's before its first turn); it stays there while the one it asks for cannot run.
  const stay = on ?? from;
  if (choice === 'cheap') {
    const need = { kind: 'cheaper' as const, ...(from ? { from } : {}) };
    const model = { modelId: from ?? '', explicit: true as const, need, ...(stay ? { from: stay } : {}) };
    return effort ? { ...model, effort } : { ...model, effort: base, asked: 'model' };
  }
  // A model it names takes the part's effort, else the rules'.
  const model = { modelId: choice, explicit: true as const, ...(stay ? { from: stay } : {}) };
  return effort ? { ...model, effort } : { ...model, effort: base, asked: 'model' };
}

/**
 * The split fields of a RouteRequest (routeRequest in turn-prepare.ts): the split marker – `fresh` on the first turn of a part
 * that starts from its brief and names no model, `needs` for a part that says what its hardest step asks – and the tier
 * floor of 'strong' or of its needs.
 */
export function splitRoute(plan: Pick<TurnPlan, 'split'>): Partial<Pick<RouteRequest, 'split' | 'needs'>> {
  const split = plan.split;
  if (!split) return {};
  const model = split.model?.trim();
  const fresh = split.firstTurn && split.context === 'brief' && (!model || model === 'same');
  const needs = needsOfModel(model);
  const floor = model === 'strong' ? 'strong' : needs ? SPLIT_NEED[needs].floor : undefined;
  return {
    split: { splitId: split.splitId, ...(fresh ? { fresh: true as const } : {}), ...(needs ? { needs } : {}) },
    ...(floor ? { needs: { tier: floor } } : {}),
  };
}

/** A split's folder: its own (a worktree) or its group's (the parent's at the split); undefined = the usual folder. */
export function splitCwd(services: Pick<RuntimeServices, 'splits' | 'log'>, split: SplitTurn | undefined): string | undefined {
  if (!split) return undefined;
  if (split.cwd) return split.cwd;
  try { return services.splits?.get(split.splitId)?.group.cwd; } catch (error) {
    services.log.warn('reading the split group failed; the split runs in the usual folder', { splitId: split.splitId, error: String(error) });
    return undefined;
  }
}

/** What seeding needs besides the plan (turn-prepare.ts buildTurn's rebuild context). */
export interface SeedContext { account: Account; model: string; offer: ToolOffer; prompt: { stable: string; volatile: string } }

/**
 * A split's first turn without a session on its thread: seeded from its parent (splits/fork.ts). A seeded ref is bound
 * under (agent, split thread, engine) – a native fork on its parent's start, else with this turn's prompt key; `prefix` goes before the turn's input. Undefined =
 * the usual path (no split, not its first turn, or seeding failed – the split then starts fresh).
 */
export async function seedSplit(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, engine: Engine, route: RouteDecision, promptKey: string, native: SeedContext | undefined): Promise<{ session?: SessionBinding; prefix?: string } | undefined> {
  const split = plan.split;
  if (!split?.firstTurn || !native) return undefined;
  let seed: SeedResult;
  try {
    seed = await seedSplitSession(services, {
      plan, split, route: { route, engine, account: native.account, model: native.model, effort: route.effort },
      tools: native.offer.native, toolNames: native.offer.names, system: native.prompt, promptKey, cwd: splitCwd(services, split), runId: request.runId,
      brief: request.notes.map((note) => note.text).join('\n\n'), signal: request.signal, // F26: what wakes the part's condense call
    });
  } catch (error) {
    services.log.warn('seeding the split session failed; it starts fresh', { splitId: split.splitId, error: String(error) });
    return undefined;
  }
  const prefix = seed.inputPrefix?.trim() ? seed.inputPrefix : undefined;
  if (!seed.ref || !engine.caps.sessions) return prefix ? { prefix } : {};
  // A native fork holds its parent session's start: the part's thread records that start beside its binding, so the part runs
  // on it like a resume (turn-prepare.ts) and gets what changed since as was/now lines. Without the parent's record: this turn's.
  const store = new SessionStore(services.db);
  const parent = seed.parentRef ? parentBinding(store, plan.agent.id, split.parentThread, engine.id, seed.parentRef) : undefined;
  const start = parent ? parentStart(services, plan.agent.id, split.parentThread, engine.id, parent) : undefined;
  const session: SessionBinding = {
    agentId: plan.agent.id, conversationId: plan.thread, engine: engine.id, accountId: native.account.id, ref: seed.ref,
    generation: seed.generation ?? 1, cursorSeq: 0, model: route.modelId, promptKey: start?.key ?? promptKey, mode: plan.mode.key, updatedAt: services.clock.now(),
  };
  store.save(session);
  // FIXES-3 B1 (measured 18.11.2026): Claude Code's fork carries its parent's running cost total – the part's own count starts there
  if (parent?.costTotal && parent.costTotal.ref === parent.ref) store.setCostTotal(plan.agent.id, plan.thread, engine.id, { ref: seed.ref, usd: parent.costTotal.usd });
  if (start) recordStart(services.db, { agentId: plan.agent.id, thread: plan.thread, engine: engine.id }, start, services.clock.now());
  return { session, ...(prefix ? { prefix } : {}) };
}

/** The parent's binding while it still binds the session `ref` a native fork copied. */
function parentBinding(store: SessionStore, agentId: string, thread: string, engine: Engine['id'], ref: string): SessionBinding | undefined {
  try {
    const parent = store.get(agentId, thread, engine);
    return parent?.ref === ref ? parent : undefined;
  } catch { return undefined; }
}

/** The start record of that parent session. */
function parentStart(services: Pick<RuntimeServices, 'db'>, agentId: string, thread: string, engine: Engine['id'], parent: SessionBinding): SessionStart | undefined {
  try { return startOf(services.db, { agentId, thread, engine }, parent.promptKey); } catch { return undefined; }
}

/** S6: the "Split results" block of the agent's own turn on this thread (its parts that ended and did not reach it yet); never a split's. */
export function splitResults(services: RuntimeServices, plan: Pick<TurnPlan, 'agent' | 'thread' | 'split'>): { splitIds: string[]; text: string } | undefined {
  if (plan.split || !services.splits) return undefined;
  try {
    const found = services.splits.pendingResults(plan.agent.id, plan.thread);
    return found && found.splitIds.length && found.text.trim() ? found : undefined;
  } catch (error) {
    services.log.warn('split results unavailable for this turn', { agentId: plan.agent.id, error: String(error) });
    return undefined;
  }
}

/** turn-finish: a split's run end goes to the split service; the agent's own turn starts its new groups and gathers the shown ones. */
export function splitTurnEnded(services: RuntimeServices, plan: TurnPlan, turn: Pick<RoutedTurn, 'splitParts'>, request: TurnRequest, attempt: AttemptResult, status: RunStatus): void {
  const splits = services.splits;
  if (!splits) return;
  try {
    if (plan.split) {
      splits.onSplitRunEnd(plan.split.splitId, splitEnd(services, request, attempt, status));
      return;
    }
    if (status === 'done' && turn.splitParts?.length) splits.markGathered(request.runId, turn.splitParts);
    splits.afterParentTurn(request.runId, status === 'done' ? 'done' : request.control.stopKind === 'human' ? 'stopped' : 'failed');
  } catch (error) {
    services.log.warn('split bookkeeping after the turn failed', { runId: request.runId, error: String(error) });
  }
}

/** B-080: why a part whose run ended without bringing anything back failed (it runs once more – splits/runner.ts). */
export const NOTHING_BACK = 'It ended without last words or a note to its origin – nothing came back.';

/**
 * How a split's run ended: the person's Stop → stopped; a shutdown cut → retryable; a failure is retryable while no effect
 * of it is unknown (and it is no setup error). B-080: a done run counts as done when it brought something back – its last
 * words or a note to its origin (splits/results.ts resultOf; turn-finish journaled its Answer before this) or files.
 */
function splitEnd(services: RuntimeServices, request: TurnRequest, attempt: AttemptResult, status: RunStatus): SplitRunEnd {
  const runId = request.runId;
  if (status === 'done') return resultOf(services.runs, { id: runId }) || attempt.result.files?.length ? { runId, status: 'done' } : { runId, status: 'failed', retryable: true, error: NOTHING_BACK };
  const kind = request.control.stopKind;
  if (status === 'interrupted' && kind === 'human') return { runId, status: 'stopped' };
  // S14: a shutdown cut is no failure of the part – it runs again (its next turn resumes its session and sees its earlier
  // actions in the recap), like the main lane's wakes that a shutdown releases.
  if (status === 'interrupted' && kind === 'shutdown') return { runId, status: 'failed', retryable: true, error: SHUTDOWN_CUT }; // its next attempt reads why (RESTART_NOTE)
  const { result } = attempt;
  const known = attempt.toolCalls === 0 || effectsKnown(services, runId, attempt.toolCalls);
  const error = status === 'interrupted'
    ? (kind ? 'The split was cut off.' : 'The engine interrupted the split.')
    : result.error?.message ?? (result.stop === 'limit' ? 'A usage limit was reached.' : 'The turn failed.');
  const retryable = known && result.error?.details?.setup !== true;
  // A usage limit (or the provider refusing for one): it waits for an account instead of using its retry at once (splits/holds.ts).
  const wait = status !== 'interrupted' && retryable && (result.stop === 'limit' || result.error?.code === 'rate_limited');
  return { runId, status: 'failed', retryable, error, ...(wait ? { wait: true } : {}) };
}

/** turn.ts failBeforeEngine: a split's run that never reached its engine (no model or account, a limit …). */
export function splitTurnFailed(services: RuntimeServices, plan: Pick<TurnPlan, 'split'>, runId: string, error: WorkforceErrorData): void {
  if (!plan.split) return; // an agent's own turn that never ran created no group
  const outage = error.code === 'rate_limited' || ((error.code === 'unavailable' || error.code === 'cancelled') && error.details?.setup !== true);
  const wait = error.code === 'rate_limited' || (error.code === 'unavailable' && error.details?.setup !== true); // no account can run it now: it waits for one
  try { services.splits?.onSplitRunEnd(plan.split.splitId, { runId, status: 'failed', retryable: outage, error: error.message, ...(wait ? { wait: true } : {}) }); } catch (failure) {
    services.log.warn('split bookkeeping after a failed start failed', { runId, error: String(failure) });
  }
}

/**
 * How a split's turn that never reached its finish ended (turnEndedEarly). `requeue`: its work never started (the
 * runtime stopped first) – back to queued without using an attempt; failed and retryable as well, so a split service
 * without `requeue` still runs it once more.
 */
const EARLY: Record<'skipped' | 'stopped' | 'cut' | 'crashed', Omit<SplitRunEnd, 'runId'>> = {
  skipped: { status: 'stopped', error: 'The agent is paused or archived.' },
  stopped: { status: 'stopped' },
  cut: { status: 'failed', retryable: true, requeue: true, error: 'The runtime stopped before the split ran.' },
  crashed: { status: 'failed', error: 'The turn failed unexpectedly.' },
};

/**
 * dispatch-runs.ts: a turn that ended without its finish – a split's turn planned no run (its agent is paused or archived
 * now), was stopped before it started (by the person, or cut by a
 * shutdown: re-queued) or crashed; a crashed agent's own run lets the groups it created start.
 */
export function turnEndedEarly(services: RuntimeServices, runId: string, split: SplitTurn | undefined, how: keyof typeof EARLY): void {
  const splits = services.splits;
  if (!splits) return;
  try {
    if (split) splits.onSplitRunEnd(split.splitId, { runId, ...EARLY[how] });
    else if (how === 'crashed') splits.afterParentTurn(runId, 'failed');
  } catch (error) {
    services.log.warn('split bookkeeping after an early end failed', { runId, error: String(error) });
  }
}
