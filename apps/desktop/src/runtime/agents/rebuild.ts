// Native rebuild of an agent's session from the context ledger (B-048 E2) – the executor's side, called by turn-prepare.ts
// chooseSession. A session starts anew in six cases (KI-Runde 17.11.2026, 'trim' 21.11.2026), and in no other:
//   'switch'     the turn runs on another engine than the agent's last turn;
//   'no_session' the engine has no usable session while the ledger has items (after a renewal, on another account, in the
//                retry after an ended session – owner 13.11.2026: "der Kontext geht nie verloren");
//   'fold'       the session's context was folded (SessionBinding.foldedAt, agents/context-fold.ts): the agent's hand-over
//                stands in the ledger and everything before it is hidden – forced, and never a revert, so the new session
//                starts with the turn's own prompt and tools; wherever it does not run (blocked, a fallback, nothing to
//                replay) the mark goes with it (SessionStore.unfolded) and the hides ride on the next rebuild that runs;
//   'fit'        the session no longer fits the model's window (compaction-policy.ts pastFit);
//   'cold'       the session rested past CACHE_COLD_MS: its cache is gone, the next call reads everything uncached either
//                way, so the lean record costs nothing extra – unless the session already holds the record as it stands;
//   'trim'       (Runde "Halb" 21.11.2026) a warm session at TRIM_AT or more whose lean view (the lean history plus the marks
//                waiting) frees enough to pay back its own cache write within TRIM_PAYBACK_CALLS calls at the turn model's
//                prices (compaction-policy.ts trimPays) – else it goes on as it is and nothing is written.
// Until 17.11.2026 a warm session was rebuilt for any saving worth nine re-sends over the last run's calls: 110 such rebuilds
// took 11 % off and each paid a full cache write (40 reads on Claude Code, not 9). The trim weighs the model's real ratio against
// all it writes again (trimWeight) – an 11 % saving never pays, one that does is most of the session. The engine (caps.rebuild) starts a new native session holding the ledger view; the turn binds it and
// sends only the new chat lines.
// Owns: that choice (the view → RebuildItem mapping is rebuild-items.ts), the one call naming every condensed or hidden item
// when the ledger holds marks (context/ledger/marks.ts; every rebuild is a new session, and a hidden item leaves no other trace;
// placed in front of the agent's closing words), the probe per CLI version (kv 'engine-rebuild-probe': model-free, once per
// version, a failed one again after a day), binding the new session (generation + 1; the replaced ref is recorded as
// superseded by sessions.ts), ledger.rebuilt, the run notes {rebuild: 'native' | 'fallback'}, and the fallback memory (B-080
// wave 3): a rebuilt session that ends on its first turn, a rebuild the engine refuses, or a 'fold' rebuild that falls back
// (a failed probe, too large – else every turn's end would ask for a fold nothing replays) blocks rebuilds of that thread and
// engine for 6 h (process memory) – the turn renews as today; a rebuild that only timed out does not (a busy app-server; the
// next turn simply tries again), and a later turn never judges an earlier rebuild after the fact.
// Every rebuild replays the whole record of the turn's thread (the agent's main thread, which holds every chat it saw; a
// split's part never rebuilds) and carries the lean history (window.ts leanMarks: tool work keeps its call in place and leaves
// its output, reasoning is hidden; kept in full: the thread's newest KEEP_STEPS tool steps, the reasoning of this run and the
// newest run here, pins – open work included, Runde "Halb" 21.11.2026) and the chat lines' reach (oldChatLines), written only once the rebuild is certain to run (note
// lean: {condensed, hidden, before, after}).
// The fit (B-080, owner 08.11.2026: no fixed compaction size): a history that does not fit the model's window
// (compaction-policy.ts fitLimit) gets its oldest tool work hidden (window.ts fitHides; ledger marks by 'window', named in the
// marks call and restorable) until it fits – note fit: {hidden, before, after, room}. Past the fit the engine's own count
// calibrates that size (UNIT_DRIFT), so the new session really is under the limit – a history that nothing brings in falls
// back ('too_large') and the session is renewed with the record as text.
// Every size here (history, prompt and tools) is in window.ts tokensOf (shared/model/context-ledger.ts CHARS_PER_TOKEN); the
// window and the engine's own count are in that engine's tokens, so the room is read in the engine's unit (engineUnit:
// Claude Code 2 characters per token, Codex 3.4) and the rebuilt binding's context is saved in it. rebuildBlocked tells
// boundary.ts and context-fold.ts that nothing starts the session anew for a while.
// B-049 F7: a 'fit' or 'cold' rebuild on an engine with caps.revert first keeps the session, cut before the turn holding the
// first change, plus the tail (rebuild-revert.ts; note revert: true); any refusal starts a new one (note {rebuild:
// 'revert_fallback'}). A kept probe of an older revision (PROBE_REV) runs again once.
// A session that starts anew takes what the agent learned (NativeRebuildInput.anew: turn-prepare.ts promotes its learned
// tools there, once the rebuild is certain to run).
// Never: starts a turn, lets a failed rebuild fail the turn, or reads provider files.

import type { RuntimeServices } from '../contracts.ts';
import type { Account, EngineId, RouteDecision } from '../../shared/model/providers.ts';
import type { Engine, RebuildItem, RebuildProbe } from '../engines/types.ts';
import { engineUnit, type LedgerItem, type LedgerViewItem } from '../../shared/model/context-ledger.ts';
import { historyTokens, rebuildItems } from './rebuild-items.ts'; // B-049 F9: the view → items mapping (nested calls) lives there
import { marksCall, marksOf } from '../context/ledger/marks.ts';
import '../contracts/ledger.ts';
import { KvRepo } from '../store/kv.ts';
import { SessionStore, type SessionBinding } from './sessions.ts';
import { CACHE_COLD_MS, TRIM_AT, UNIT_DRIFT, fitLimit } from './compaction-policy.ts';
import { FIT_REASON, LEAN_REASON, LEAN_TEXT, fitHides, leanCall, leanMarks, oldChatLines, tokensOf, type LeanMark } from '../context/ledger/window.ts';
import { leanKeep, trimWeight } from './rebuild-lean.ts';
import { turnCwd } from '../git/records.ts';
import type { ToolOffer } from './session-key.ts';
import type { TurnPlan, TurnRequest } from './turn-types.ts';
import { revertPlan } from './rebuild-revert.ts'; // B-049 F7 (with native-turns.ts)
import { keepTurnsBefore } from './native-turns.ts';

export { rebuildItems };
export const PROBE_NS = 'engine-rebuild-probe';
/** B-049 F9: what a probe checks grew (Codex: custom_tool_call items) – a kept probe of an older revision runs again once. */
export const PROBE_REV = 2;
const PROBE_RETRY_MS = 24 * 60 * 60 * 1000;
const BLOCK_MS = 6 * 60 * 60 * 1000;
const LAST_RUNS = 50;
const MEMORY = 500;

/** Why a session starts anew (see the header). */
export type RebuildWhy = 'switch' | 'no_session' | 'fold' | 'fit' | 'cold' | 'trim';

/** Process memory: the run that last rebuilt each chat and engine (rebuildFellBack), chats whose rebuild failed, running probes. */
const pending = new Map<string, string>();
const blocked = new Map<string, number>();
const probing = new Map<string, Promise<RebuildProbe>>();
const probedHere = new Map<string, RebuildProbe>(); // versions the CLI did not name: kept for this process only

const keyOf = (agentId: string, conversationId: string, engine: EngineId) => `${agentId}|${conversationId}|${engine}`;
/** B-080: the engine did not answer in time (a busy app-server, codex/rpc.ts -32000) – no refusal, so nothing is kept or blocked for it. */
const timedOut = (reason?: string) => /did not answer|timed? ?out|timeout/i.test(reason ?? '');
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY) map.delete(map.keys().next().value!);
}

/** Forgets the process memory (tests). */
export function resetRebuildMemory(): void {
  pending.clear(); blocked.clear(); probing.clear(); probedHere.clear();
}

/**
 * Whether rebuilds of that thread and engine are blocked now (BLOCK_MS after a refusal or a failed first turn): nothing starts
 * the session anew there, so no boundary waits for one (agents/boundary.ts).
 */
export function rebuildBlocked(services: Pick<RuntimeServices, 'clock'>, agentId: string, thread: string, engine: EngineId): boolean {
  return (blocked.get(keyOf(agentId, thread, engine)) ?? 0) > services.clock.now();
}

/** The engine of the agent's last turn (this run excluded; B-057 S9: never a split's run – its engine is no route memory). */
export function lastEngine(services: Pick<RuntimeServices, 'runs'>, agentId: string, runId: string): EngineId | undefined {
  try {
    const runs = services.runs.listTopLevel?.(agentId, LAST_RUNS) ?? services.runs.list(agentId, LAST_RUNS);
    return runs.find((run) => run.id !== runId && !run.splitId && run.engine && run.status !== 'queued')?.engine;
  } catch { return undefined; }
}

/**
 * The call naming every condensed or hidden item the ledger holds (none without marks). Every rebuild starts from the whole view,
 * where a hidden item leaves no trace but this. `since` (the first changed order, 0 without new marks) only names the call.
 */
export function marksItem(services: RuntimeServices, agentId: string, conversationId: string, since: number): RebuildItem | undefined {
  const call = marksCall(marksOf(services, agentId, conversationId));
  return call && { itemId: `marks${since}`, kind: 't', role: 'tool', text: call.output, call: { name: call.tool, args: call.args, callId: `call_context_marks_${since}`, output: call.output } };
}

/**
 * The history with the marks call in front of the agent's closing words (its trailing text, reasoning or own chat
 * lines without a call), so the rebuilt history still ends at the agent's own answer – a clean turn boundary.
 */
export function withMarks(items: RebuildItem[], marks: RebuildItem | undefined): RebuildItem[] {
  if (!marks) return items;
  let at = items.length;
  while (at > 0 && items[at - 1].role === 'assistant' && !items[at - 1].call) at--;
  return [...items.slice(0, at), marks, ...items.slice(at)];
}

/** The probe of `engine`'s rebuild for its CLI version: kv per version; a failed one again after a day; one at a time. */
export async function probeFor(services: RuntimeServices, engine: Engine, account: Account, cwd: string): Promise<RebuildProbe> {
  const now = services.clock.now();
  if (!engine.probeRebuild) return { version: 'none', ok: true, at: now };
  const version = (await engine.rebuildVersion?.(account).catch(() => undefined)) ?? 'unknown';
  const key = `${engine.id}@${version}`;
  const kv = new KvRepo(services.db);
  const cached = version === 'unknown' ? probedHere.get(key) : kv.get<RebuildProbe & { rev?: number }>(PROBE_NS, key);
  if (cached && (cached as { rev?: number }).rev === PROBE_REV && (cached.ok || now - cached.at < PROBE_RETRY_MS)) return cached;
  let running = probing.get(key);
  if (!running) {
    running = engine.probeRebuild(account, cwd).then((probe) => {
      const kept = { ...probe, version: probe.version || version, at: services.clock.now(), rev: PROBE_REV };
      // B-080: a probe that only timed out (a busy moment of the CLI) is not kept – the next rebuild probes again instead of a day without
      if (!kept.ok && timedOut(kept.reason)) { /* not kept */ }
      else if (version === 'unknown') remember(probedHere, key, kept);
      else kv.set(PROBE_NS, key, kept, services.clock.now());
      services.log.info('rebuild probe', { engine: engine.id, version, ok: kept.ok, ...(kept.reason ? { reason: kept.reason } : {}) });
      return kept;
    }).finally(() => probing.delete(key));
    probing.set(key, running);
  }
  return running;
}

/** The turn's prompt sections and native tool definitions in tokens (the rebuilt session starts with them). */
function overheadTokens(input: Pick<NativeRebuildInput, 'prompt' | 'offer'>): number {
  let tools = 0;
  try { tools = (JSON.stringify(input.offer.native ?? []) ?? '').length; } catch { tools = 0; }
  return tokensOf(input.prompt.stable.length + input.prompt.volatile.length + tools);
}

function note(services: RuntimeServices, runId: string, data: Record<string, unknown>): void {
  try { services.runs.item(runId, { kind: 'note', data, effectStatus: 'none' }); } catch { /* journal only */ }
}

/**
 * renewSession's hook for a session that ended in this run (overflow): the run's retry rebuilds from the record; when this run
 * had rebuilt that session, its first turn failed – note the fallback and block rebuilds of the thread and engine for a while
 * (the retry then gets the record as text, agents/history-text.ts). B-080 wave 3: the only judge of a rebuilt session's first turn – an interrupted run
 * (a Stop, the agent's own model.set now:true, a steer restart) or a next turn under a changed prompt says nothing about it.
 */
export function rebuildFellBack(services: RuntimeServices, agentId: string, thread: string | undefined, engine: EngineId, runId: string): boolean {
  const key = keyOf(agentId, thread ?? '', engine);
  if (pending.get(key) !== runId) return false;
  pending.delete(key);
  remember(blocked, key, services.clock.now() + BLOCK_MS);
  note(services, runId, { rebuild: 'fallback', reason: 'first_turn_error' });
  return true;
}

export interface NativeRebuildInput {
  plan: TurnPlan;
  request: TurnRequest;
  engine: Engine;
  account: Account;
  route: RouteDecision;
  /** Provider model id of the turn. */
  model: string;
  /** The usable binding of this engine and account (none after a renewal or for another account). */
  session?: SessionBinding;
  offer: ToolOffer;
  /** The turn's prompt as the engine gets it (the volatile part as buildTurn ends it). */
  prompt: { stable: string; volatile: string };
  promptKey: string;
  contextWindow?: number;
  /** The session no longer fits the model's window (pastFit): it starts anew under the limit, the renewal only follows when nothing brings it in. */
  overLimit?: boolean;
  /**
   * What the session starts with, asked once the rebuild is certain to run: the turn's offer, prompt and key after everything a
   * session that starts anew takes along (turn-prepare.ts promotes the agent's learned tools there). Absent: `offer`, `prompt`, `promptKey`.
   */
  anew?: () => { offer: ToolOffer; prompt: { stable: string; volatile: string }; promptKey: string };
}

/** Why this turn's session starts anew (see the header); undefined: it goes on as it is. */
function whyOf(services: RuntimeServices, input: NativeRebuildInput, last: EngineId | undefined): RebuildWhy | undefined {
  const { engine, session } = input;
  if (last && last !== engine.id) return 'switch';
  if (!session) return 'no_session';
  if (session.foldedAt !== undefined) return 'fold';
  if (input.overLimit) return 'fit';
  if (services.clock.now() - session.updatedAt > CACHE_COLD_MS) return 'cold';
  return (session.contextTokens ?? 0) >= TRIM_AT ? 'trim' : undefined; // weighed once the lean view is known (trimPays)
}

/** Rebuilds the turn's native session from the ledger when one of the cases holds; undefined: today's path. */
export async function nativeRebuild(services: RuntimeServices, input: NativeRebuildInput): Promise<{ session: SessionBinding; sinceSeq: number } | undefined> {
  const { plan, request, engine, account, session } = input;
  const conversationId = plan.thread; // the ledger's key (the agent's main thread)
  const ledger = services.ledger;
  if (plan.split || !conversationId || !engine.caps.rebuild || !engine.rebuild || !ledger) return undefined;
  const agentId = plan.agent.id;
  const key = keyOf(agentId, conversationId, engine.id);
  const last = lastEngine(services, agentId, request.runId);
  const why = whyOf(services, input, last);
  if (!why) return undefined;
  // The folded mark lives exactly as long as its rebuild: wherever a 'fold' rebuild does not run, it goes – else every later
  // warm turn counts as a boundary and no second fold could start. The ledger's hides stay and ride on the next rebuild that runs.
  const unfold = () => {
    if (why !== 'fold') return;
    try { new SessionStore(services.db).unfolded(agentId, conversationId, engine.id); } catch { /* the mark stays */ }
  };
  if ((blocked.get(key) ?? 0) > services.clock.now()) { unfold(); return undefined; }
  let need: ReturnType<typeof ledger.needsRebuild>;
  try { need = ledger.needsRebuild(agentId, conversationId, 0); } catch { need = undefined; }
  // A 'fold' rebuild that cannot run (a failed probe, too large, the engine refused) blocks the thread's rebuilds as a refusal
  // does: rebuildBlocked then stops the next fold, which nothing would replay either; a rebuild that only timed out blocks nothing.
  const fallback = (reason: string, block = why === 'fold') => {
    if (block) remember(blocked, key, services.clock.now() + BLOCK_MS);
    note(services, request.runId, { rebuild: 'fallback', why, reason }); unfold(); return undefined;
  };
  const overhead = overheadTokens(input);

  let split: ReturnType<typeof rebuildItems> = { items: [] };
  let entries: LedgerViewItem[] = [];
  const read = () => { entries = ledger.view(agentId, conversationId).map(leanCall); split = rebuildItems(entries); }; // condensed calls with their long arguments cut (window.ts)
  try { read(); } catch (error) { return fallback(`ledger: ${String(error).slice(0, 120)}`); }
  if (!split.items.length) { unfold(); return undefined; } // nothing of the agent's own work to replay: today's path
  let since = need?.since ?? 0;
  let marks = marksItem(services, agentId, conversationId, since);
  const history = () => withMarks(split.items, marks);
  let items = history();
  let tokens = historyTokens(items);
  // The lean history – only the tool work of unfinished work stays in full (window.ts leanMarks); sized here, written below
  const fitKeep = keptByFit(ledger, agentId, conversationId, entries, request.runId);
  const lean: LeanMark[] = [...leanMarks(entries, leanKeep(entries, fitKeep, request.runId)), ...chatReach(ledger, agentId, conversationId, entries, fitKeep.pinned)];
  // A cold session that holds the record as the ledger has it, with nothing to set aside: starting it anew would change nothing
  if (why === 'cold' && !need && !lean.length) return undefined;
  const whole = tokens;
  const leaned = Math.max(0, whole - lean.reduce((sum, mark) => sum + mark.saves, 0));
  // A warm session starts anew only when what it sheds pays for writing it again (the header's 'trim'); else nothing is written
  const trim = why === 'trim' ? trimWeight(services, {
    revert: Boolean(engine.caps.revert), modelId: input.route.modelId, volatile: input.prompt.volatile, sessionKey: session?.promptKey, promptKey: input.promptKey, overhead,
  }, entries, lean, need, leaned) : undefined;
  if (trim && !trim.pays) return undefined;
  // Sized by the rebuilt history. Past the fit the engine's own count of the session calibrates that size, so the new session
  // really is under the limit: the room shrinks by how far the count lies above the ledger's estimate of what the session
  // holds – at most UNIT_DRIFT, beyond that the difference is not the unit but content a rebuild does not replay.
  const unit = engineUnit(engine.id); // the history is estimated in CHARS_PER_TOKEN, the window is in the engine's own tokens
  const drift = why === 'fit' && session?.contextTokens ? Math.min(UNIT_DRIFT, Math.max(1, session.contextTokens * unit / (whole + (need?.saves ?? 0) + overhead))) : 1;
  const room = Math.floor(fitLimit(input.contextWindow) * unit / drift) - overhead;
  let leanNote: { condensed: number; hidden: number; before: number; after: number } | undefined;
  let probe: RebuildProbe | undefined;
  if (lean.length) { // written only once the rebuild runs – a fit that could not bring the lean history in leaves it unwritten
    const leanIds = new Set(lean.map((mark) => mark.itemId));
    if (leaned > room && !fitHides(entries.filter((entry) => !leanIds.has(entry.itemId)), leaned - room, fitKeep).length) return fallback('too_large');
    probe = await probeOf(services, input);
    if (!probe.ok) return fallback(`probe ${probe.version}: ${probe.reason ?? 'failed'}`);
    try {
      ledger.mark(agentId, conversationId, lean.map((mark) => (mark.state === 'condensed'
        ? { itemId: mark.itemId, state: 'condensed' as const, by: 'window' as const, condensed: mark.text ?? LEAN_TEXT, reason: LEAN_REASON }
        : { itemId: mark.itemId, state: 'hidden' as const, by: 'window' as const, reason: mark.reason ?? LEAN_REASON })));
      const first = entries.find((entry) => entry.itemId === lean[0].itemId)?.order;
      if (first !== undefined) since = since > 0 ? Math.min(since, first) : first; // a revert cuts before the first item that changed
      read();
      marks = marksItem(services, agentId, conversationId, since);
      items = history();
      tokens = historyTokens(items);
      leanNote = { condensed: lean.filter((mark) => mark.state === 'condensed').length, hidden: lean.filter((mark) => mark.state === 'hidden').length, before: whole, after: tokens };
    } catch (error) { return fallback(`lean: ${String(error).slice(0, 120)}`); }
  }
  const excess = tokens - room;
  if (excess > 0) { // the oldest tool work goes first, as much as needed – the chat lines, the newest turn and pins stay
    const hidden = fitHides(entries, excess, keptByFit(ledger, agentId, conversationId, entries, request.runId));
    if (!hidden.length) return fallback('too_large');
    try {
      ledger.mark(agentId, conversationId, hidden.map((itemId) => ({ itemId, state: 'hidden' as const, by: 'window' as const, reason: FIT_REASON })));
      const first = entries.find((entry) => entry.itemId === hidden[0])?.order;
      if (first !== undefined) since = since > 0 ? Math.min(since, first) : first; // a revert cuts before the first item that changed
      read();
      marks = marksItem(services, agentId, conversationId, since);
      items = history();
      const before = tokens;
      tokens = historyTokens(items);
      note(services, request.runId, { fit: { hidden: hidden.length, before, after: tokens, room } });
    } catch (error) { return fallback(`fit: ${String(error).slice(0, 120)}`); }
    if (tokens > room) return fallback('too_large');
  }

  const cwd = turnCwd(services, plan.task, agentId);
  probe ??= await probeOf(services, input);
  if (!probe.ok) return fallback(`probe ${probe.version}: ${probe.reason ?? 'failed'}`);

  // The session starts anew for certain now: it takes the turn's offer and prompt as they stand then (learned tools promoted).
  // A trim on the replaced session's own prompt and tools keeps that start, so their cache is read (rebuild-lean.ts samePrefix).
  const start = (trim?.samePrefix ? undefined : input.anew?.()) ?? { offer: input.offer, prompt: input.prompt, promptKey: input.promptKey };
  const store = new SessionStore(services.db);
  const previous = session ?? store.get(agentId, conversationId, engine.id);
  let result: Awaited<ReturnType<NonNullable<Engine['rebuild']>>> | undefined;
  const base = {
    runId: request.runId, agentId, account, model: input.model, cwd, items, tools: start.offer.native, toolNames: start.offer.names,
    system: start.prompt, generation: (previous?.generation ?? 0) + 1, probe,
  };
  // B-049 F7: on an engine that can revert, a session that only sheds work keeps itself and its prompt cache (rebuild-revert.ts);
  // any refusal starts a new one. Never after a fold: its new session starts with the turn's own prompt and tools.
  const turnKey = { agentId, conversationId, engine: engine.id };
  const revert = (why === 'fit' || why === 'cold' || why === 'trim') && session && engine.caps.revert ? revertPlan(services, turnKey, session.ref, since, entries, split.items) : undefined;
  if (revert && session) {
    try { result = await engine.rebuild({ ...base, items: withMarks(revert.items, marks), revert: { ref: session.ref, beforeTurn: revert.turn } }); } catch (error) {
      note(services, request.runId, { rebuild: 'revert_fallback', reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
    }
  }
  const reverted = result !== undefined;
  if (!result) {
    try { result = await engine.rebuild(base); } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'failed';
      // A refusal is not tried again every turn (each try starts and deletes a session); B-080 wave 3: a rebuild that only timed out is.
      return fallback(reason, !timedOut(reason));
    }
  }
  const binding: SessionBinding = {
    agentId, conversationId, engine: engine.id, accountId: account.id, ref: result.ref, generation: result.generation, cursorSeq: plan.memberCursor,
    // The whole context the session starts with (history plus prompt and tools) in the engine's own unit, until it reports its own count
    // A reverted session runs on with the start it had (its start record names that key); a new one starts with the turn's
    contextTokens: Math.round((tokens + overhead) / unit), model: input.route.modelId, promptKey: reverted ? session?.promptKey ?? start.promptKey : start.promptKey, mode: plan.mode.key, updatedAt: services.clock.now(),
  };
  store.save(binding);
  if (reverted && revert) keepTurnsBefore(services.db, turnKey, result.ref, revert.turn, services.clock.now()); // B-049 F7: the cut turns are gone
  try {
    const upTo = ledger.items(agentId, conversationId).reduce((max, item) => Math.max(max, item.order), 0);
    if (upTo > 0) ledger.rebuilt(agentId, conversationId, upTo);
  } catch (error) { services.log.warn('marking the ledger rebuilt failed', { agentId, error: String(error) }); }
  remember(pending, key, request.runId);
  note(services, request.runId, {
    rebuild: 'native', why, engine: engine.id, items: result.items, generation: result.generation, tokens,
    ...(why === 'fit' && session?.contextTokens ? { live: session.contextTokens } : {}),
    ...(last && last !== engine.id ? { from: last } : {}), ...(marks ? { marks: true } : {}), ...(probe.tier ? { tier: probe.tier } : {}),
    ...(reverted && revert ? { revert: true, fromOrder: revert.from } : {}), ...(leanNote ? { lean: leanNote } : {}),
    ...(trim ? { trim: { freed: trim.freed, rewritten: trim.rewritten, writeInReads: trim.writeInReads, samePrefix: trim.samePrefix } } : {}),
  });
  return { session: binding, sinceSeq: plan.memberCursor };
}

/** The view's chat lines past their reach (window.ts oldChatLines over ledger.lines – the others' lines and my own posted words), sized as the rebuilt history counts them. */
function chatReach(ledger: NonNullable<RuntimeServices['ledger']>, agentId: string, thread: string, entries: readonly LedgerViewItem[], pinned: ReadonlySet<string>): LeanMark[] {
  let rows: LedgerItem[] = [];
  try { rows = ledger.lines?.(agentId, thread) ?? ledger.items(agentId, thread, { kinds: ['message'] }); } catch { return []; }
  const shown = new Map(entries.map((entry) => [entry.itemId, entry]));
  return oldChatLines(rows, pinned).filter((mark) => shown.has(mark.itemId)).map((mark) => ({ ...mark, saves: tokensOf(shown.get(mark.itemId)!.text.length) }));
}

/** The probe of the turn's engine (a throw reads as a failed probe). */
function probeOf(services: RuntimeServices, input: NativeRebuildInput): Promise<RebuildProbe> {
  const cwd = turnCwd(services, input.plan.task, input.plan.agent.id);
  return probeFor(services, input.engine, input.account, cwd).catch((error): RebuildProbe => ({ version: 'unknown', ok: false, reason: String(error).slice(0, 120), at: services.clock.now() }));
}

/**
 * What the fit leaves in place besides chat lines: the newest turn here (its run, not this one), the history's closing words (the
 * last item of the agent's own work – without them the lines before it would fall back to the delta) and what is pinned (what
 * the main AI brought back, its hand-over).
 */
function keptByFit(
  ledger: NonNullable<RuntimeServices['ledger']>, agentId: string, conversationId: string, entries: readonly Pick<LedgerViewItem, 'itemId' | 'kind' | 'runId' | 'order'>[], runId: string,
): { newestRun?: string; pinned: Set<string> } {
  const own = [...entries].reverse().filter((entry) => entry.kind !== 'message');
  const newestRun = own.find((entry) => entry.runId && entry.runId !== runId)?.runId;
  let pinned = new Set<string>();
  try { pinned = new Set(ledger.items(agentId, conversationId, { since: entries[0]?.order ?? 0 }).filter((item) => item.pinnedUntil !== undefined).map((item) => item.itemId)); } catch { /* none known */ }
  if (own[0]) pinned.add(own[0].itemId);
  return { ...(newestRun ? { newestRun } : {}), pinned };
}
