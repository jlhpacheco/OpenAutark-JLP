// Turn phase 1, the session part (turn-prepare.ts buildTurn asks here once the route is known): which native session the
// turn runs on – the bound one for this engine and account, a split's seeded one, a rebuilt one (rebuild.ts) – and the
// renewal that drops a binding whose context nothing brings into the window (also turn.ts on an overflow or another folder).
// Owns: chooseSession (the window the turn runs with, the fit, the rebuild or the renewal), renewSession, SeedContext.
// Never: builds the prompt or the input, starts the engine or writes the start record (turn-finish.ts does).

import type { RuntimeServices } from '../contracts.ts';
import type { EngineId, RouteDecision, Account } from '../../shared/model/providers.ts';
import type { Engine } from '../engines/types.ts';
import { SessionStore, type SessionBinding } from './sessions.ts';
import { pastFit } from './compaction-policy.ts';
import { nativeRebuild, rebuildFellBack, type NativeRebuildInput } from './rebuild.ts';
import type { TurnPlan, TurnRequest } from './turn-types.ts';
import type { ToolOffer } from './session-key.ts';
import { LEGACY_SESSION, resumable } from '../engines/managed-session.ts';
import { seedSplit } from './split-turn.ts'; // B-057

/**
 * Session renewal: the native session binding is dropped; the next build rebuilds the session from the agent's record
 * (agents/rebuild.ts) or, where that cannot run, starts with the record as text (history-text.ts) – nothing of the context is lost.
 * 'folder': bound to another working folder (Codex, I02; note {fresh: 'folder'}).
 */
export async function renewSession(services: RuntimeServices, plan: TurnPlan, engine: EngineId, runId: string, reason: 'context' | 'overflow' | 'folder', details: Record<string, unknown> = {}): Promise<void> {
  if (reason === 'overflow') rebuildFellBack(services, plan.agent.id, plan.thread, engine, runId); // a session this run rebuilt that ended on its first turn: no rebuild of the thread for a while
  new SessionStore(services.db).remove(plan.agent.id, plan.thread, engine, services.clock.now()); // B-048: the ref is recorded as superseded
  const data = reason === 'folder' ? { fresh: reason, ...details } : { sessionRenewed: reason };
  services.runs.item(runId, { kind: 'note', data, effectStatus: 'none' });
}

interface SessionChoice {
  session?: SessionBinding;
  contextWindow?: number;
  /** Delta start: the agent's cursor in the wake's chat. */
  sinceSeq: number;
  /** B-057: a split's session seeded from its parent (it holds the earlier context). */
  seeded?: boolean;
  /** B-057: a split's seed text (splits/fork.ts text fallback), put before the turn's input. */
  prefix?: string;
}

/** What seeding a split's session from its parent needs besides the plan (agents/split-turn.ts seedSplit). */
export interface SeedContext {
  account: Account; model: string; offer: ToolOffer; prompt: { stable: string; volatile: string };
  /** What a session that starts anew takes along, asked once a rebuild is certain to run (rebuild.ts NativeRebuildInput.anew). */
  anew?: NativeRebuildInput['anew'];
}

/**
 * The native session for this turn: none for another account; a changed prompt key keeps it (S2: it resumes on the prompt
 * and tools it started with; a row without a key, from before SES2, is accepted once and stamped); past the fit of the window (B-080 pastFit: the window the engine reported for this model – the one it really
 * runs with: the bound session's, else the newest any session of that model got (SessionStore.reportedWindow, so a model's
 * first session in a thread gets it too; splits/fork.ts uses the same rule) –, else the catalog's) the marks and the fit
 * come first and a renewal only when they cannot bring it in.
 */
export async function chooseSession(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, engine: Engine, accountId: string, route: RouteDecision, catalogWindow: number | undefined, key: string, native?: SeedContext): Promise<SessionChoice> {
  const store = new SessionStore(services.db);
  let session = engine.caps.sessions ? store.get(plan.agent.id, plan.thread, engine.id) : undefined;
  // A native session lives in one account home (CODEX_HOME / CLAUDE_CONFIG_DIR): no cross-account resume.
  if (session && session.accountId && session.accountId !== accountId) session = undefined;
  const contextWindow = (session && session.model === route.modelId ? session.contextWindow : undefined) ?? store.reportedWindow(engine.id, route.modelId) ?? catalogWindow;
  if (session && !(await resumable(engine, native?.account ?? services.accounts.get(accountId), session.ref))) {
    // 0.3.19: neither opened by this process nor matching its mark (engines/managed-session.ts) – no fit/revert on this ref; a new session takes the filtered ledger or its text fallback.
    session = undefined;
    services.runs.item(request.runId, { kind: 'note', data: { sessionRenewed: 'managed-shell', reason: LEGACY_SESSION }, effectStatus: 'none' });
  }
  if (plan.fold) return { session, contextWindow, sinceSeq: plan.memberCursor }; // a fold's turn resumes the session as it stands (agents/context-fold.ts)
  // The native rebuild, when the session starts anew this turn (rebuild.ts: an engine switch, no session, a fold waiting, past the fit, a cold cache, a trim that pays; undefined: the path below).
  const rebuild = async (current: SessionBinding | undefined, overLimit?: boolean) => (native && engine.caps.rebuild
    ? nativeRebuild(services, { plan, request, engine, account: native.account, route, model: native.model, session: current, offer: native.offer, prompt: native.prompt, promptKey: key, contextWindow, overLimit, anew: native.anew })
    : undefined);
  // B-057: a split's first turn without a session on its thread starts from its parent (agents/split-turn.ts seedSplit).
  const seeded = session ? undefined : await seedSplit(services, plan, request, engine, route, key, native);
  if (seeded) return { session: seeded.session, contextWindow, sinceSeq: plan.memberCursor, prefix: seeded.prefix, seeded: seeded.session !== undefined };

  // S2: a changed prompt key keeps the session – it resumes on the prompt and tools it started with (buildTurn, session-key.ts).
  // Every engine with sessions. Past the fit the session starts anew under the limit; the renewal (the record as text) is the
  // backstop for a context nothing brings into the window. Otherwise it goes on unless it starts anew anyway (rebuild.ts).
  const past = session !== undefined && pastFit(session.contextTokens, contextWindow);
  const rebuilt = await rebuild(session, past);
  if (rebuilt) return { session: rebuilt.session, contextWindow, sinceSeq: rebuilt.sinceSeq, seeded: true };
  if (!past) return { session, contextWindow, sinceSeq: plan.memberCursor };
  await renewSession(services, plan, engine.id, request.runId, 'context');
  return { contextWindow, sinceSeq: plan.memberCursor };
}
