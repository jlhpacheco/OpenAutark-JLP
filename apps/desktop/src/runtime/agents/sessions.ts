// Native engine session bindings: (agent, thread, engine) → Codex thread / Claude session id.
// The key's second part is the turn's thread (TurnPlan.thread, threadKey in shared/model/origin.ts) – stored in the column
// conversation_id: 13.11.2026 'main' for every turn of the agent (one context per agent), `split:<id>` for a part. Rows under
// the older per-chat, task or source keys are no longer read; a new main session starts.
// Owns: the `engine_sessions` rows (ref, generation, account, model, context size, the context
// window the engine reported for that model, the wake chat's seq of its last input, and – SES2 – the
// prompt key the session was started with and the mode of its last turn); B-080: the window an engine last reported for a model on any thread
// (reportedWindow – the window rule of turn-prepare.ts and splits/fork.ts).
// KI-Runde 17.11.2026 (package C): the engine's running cost total at the thread's last turn with the session ref it counts
// (costTotal – Claude Code's total_cost_usd counts the whole session; agents/turn-cost.ts turnOwnCost takes the difference);
// only setCostTotal writes it, a save leaves it, and it counts only for the ref it names.
// KI-Runde 17.11.2026 (package S1): when the session's context was folded (foldedAt – agents/context-fold.ts sets it once the
// fold turn's hand-over stands in the ledger) and when the engine compacted it by itself (compactedAt – the cause of a fold
// that is still to come). Both hold while the session keeps its ref and generation, so the next turn starts it anew from the folded
// record and no second fold runs on it; the fold clears the compaction's mark. newest(): the agent's newest session of a
// thread on any engine.
// B-048 E2: a ref replaced by another (renewal, rebuild, account switch) or removed is recorded as superseded
// (kv 'superseded-sessions': who, which engine/account/ref, when) – only refs of rows the app wrote, i.e. sessions
// it created; agents/session-sweep.ts deletes them later. A newly bound ref tells the db's bind listeners.
// Never: treats a session as the agent's identity – it is disposable; when missing or
// mismatched the turn sends the full projection and a new session starts. Never deletes a provider session.

import type { Db } from '../db/database.ts';
import type { EngineId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';

/** kv namespace of superseded sessions (agents/session-sweep.ts deletes them). */
export const SUPERSEDED_NS = 'superseded-sessions';

export interface SupersededSession {
  agentId: string; conversationId: string; engine: EngineId; accountId?: string; ref: string;
  /** When it was superseded. */
  at: number;
  /** Failed deletion attempts so far. */
  attempts?: number;
}

/** The kv key of a superseded session. */
export function supersededKey(session: Pick<SupersededSession, 'engine' | 'accountId' | 'ref'>): string {
  return `${session.engine}:${session.accountId ?? ''}:${session.ref}`;
}

type BindListener = (binding: SessionBinding) => void;
const bindListeners = new WeakMap<Db, Set<BindListener>>();

/** Calls `listener` whenever a new ref is bound in this database (not on a save of the same ref); returns the unsubscribe. */
export function onSessionBound(db: Db, listener: BindListener): () => void {
  let set = bindListeners.get(db);
  if (!set) bindListeners.set(db, set = new Set());
  set.add(listener);
  return () => { set!.delete(listener); };
}

export interface SessionBinding {
  agentId: string;
  /** The thread: 'main' (the agent's one context) or `split:<id>`. */
  conversationId: string;
  engine: EngineId;
  accountId?: string;
  ref: string;
  generation: number;
  /** The wake chat's seq of the session's last input (kept for the record; nothing reads it back for a catch-up). */
  cursorSeq: number;
  contextTokens?: number;
  /** Context window the engine reported for `model` (used when the catalog has none). */
  contextWindow?: number;
  model?: string;
  /** sha256 of the stable prompt + sorted offered tool names (session-key.ts); none for rows before SES2. */
  promptKey?: string;
  /** Mode key of the session's last turn (S2: a changed one is told once, agents/turn-prepare.ts). */
  mode?: string;
  /** Package C: the engine's running cost total (USD) at the thread's last turn and the session ref it counts; only setCostTotal writes it. */
  costTotal?: { ref: string; usd: number };
  /** Package S1: when this session's context was folded (its hand-over stands in the ledger and waits to be replayed); only folded() writes it. */
  foldedAt?: number;
  /** Package S1: when the engine compacted this session by itself – the cause of a fold until one ran; only compacted() and folded() write it. */
  compactedAt?: number;
  updatedAt: number;
}

interface Row {
  agent_id: string; conversation_id: string; engine: string; account_id: string | null; session_ref: string;
  cursor_seq: number; generation: number; context_tokens: number | null; context_window: number | null; model: string | null;
  prompt_key: string | null; mode: string | null; updated_at: number;
  cost_total?: number | null; cost_ref?: string | null; // package C (migration 108)
  folded_at?: number | null; compacted_at?: number | null; // package S1 (migration 109)
}

export class SessionStore {
  private db: Db;
  constructor(db: Db) { this.db = db; }

  get(agentId: string, thread: string | undefined, engine: EngineId): SessionBinding | undefined {
    const row = this.db.get<Row>('SELECT * FROM engine_sessions WHERE agent_id = ? AND conversation_id = ? AND engine = ?', [agentId, thread ?? '', engine]);
    if (!row) return undefined;
    return {
      agentId: row.agent_id, conversationId: row.conversation_id, engine: row.engine as EngineId, accountId: row.account_id ?? undefined,
      ref: row.session_ref, generation: Number(row.generation), cursorSeq: Number(row.cursor_seq),
      contextTokens: row.context_tokens ?? undefined, contextWindow: row.context_window ?? undefined,
      model: row.model ?? undefined, promptKey: row.prompt_key ?? undefined, mode: row.mode ?? undefined, updatedAt: Number(row.updated_at),
      ...(typeof row.cost_total === 'number' && row.cost_ref ? { costTotal: { ref: row.cost_ref, usd: row.cost_total } } : {}), // package C
      ...(typeof row.folded_at === 'number' ? { foldedAt: row.folded_at } : {}), // package S1
      ...(typeof row.compacted_at === 'number' ? { compactedAt: row.compacted_at } : {}),
    };
  }

  /** Package S1: the agent's newest session of `thread` on any engine – the one its last turn there ran on. */
  newest(agentId: string, thread: string | undefined): SessionBinding | undefined {
    const row = this.db.get<{ engine: string }>('SELECT engine FROM engine_sessions WHERE agent_id = ? AND conversation_id = ? ORDER BY updated_at DESC LIMIT 1', [agentId, thread ?? '']);
    return row ? this.get(agentId, thread, row.engine as EngineId) : undefined;
  }

  /** Upsert. Without `contextWindow` the stored window is kept while the model stays the same. A replaced ref is recorded as superseded (B-048). */
  save(binding: SessionBinding): void {
    const before = this.get(binding.agentId, binding.conversationId, binding.engine);
    if (before && before.ref !== binding.ref) this.supersede(before, binding.updatedAt);
    this.db.run(
      `INSERT INTO engine_sessions (agent_id, conversation_id, engine, account_id, session_ref, cursor_seq, generation, context_tokens, context_window, model, prompt_key, mode, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, conversation_id, engine) DO UPDATE SET account_id = excluded.account_id, session_ref = excluded.session_ref,
         cursor_seq = excluded.cursor_seq, generation = excluded.generation, context_tokens = excluded.context_tokens,
         context_window = CASE WHEN excluded.context_window IS NOT NULL THEN excluded.context_window
           WHEN engine_sessions.model IS excluded.model THEN engine_sessions.context_window END,
         model = excluded.model, prompt_key = excluded.prompt_key, mode = excluded.mode, updated_at = excluded.updated_at,
         folded_at = CASE WHEN engine_sessions.session_ref = excluded.session_ref AND engine_sessions.generation = excluded.generation THEN engine_sessions.folded_at END,
         compacted_at = CASE WHEN engine_sessions.session_ref = excluded.session_ref AND engine_sessions.generation = excluded.generation THEN engine_sessions.compacted_at END`,
      [binding.agentId, binding.conversationId, binding.engine, binding.accountId ?? null, binding.ref, binding.cursorSeq,
        binding.generation, binding.contextTokens ?? null, binding.contextWindow ?? null, binding.model ?? null,
        binding.promptKey ?? null, binding.mode ?? null, binding.updatedAt],
    );
    if (before?.ref === binding.ref) return;
    for (const listener of [...(bindListeners.get(this.db) ?? [])]) { try { listener(binding); } catch { /* a listener never breaks a save */ } }
  }

  /** B-048: records a ref the app created that no row binds any more (the sweep deletes it after the successor's first finished turn and 24 h). */
  private supersede(binding: SessionBinding, at: number): void {
    try {
      const record: SupersededSession = {
        agentId: binding.agentId, conversationId: binding.conversationId, engine: binding.engine, ref: binding.ref, at,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
      };
      new KvRepo(this.db).set(SUPERSEDED_NS, supersededKey(record), record, at);
    } catch { /* bookkeeping only: the binding change goes on */ }
  }

  /**
   * B-080: the context window this engine last reported for `model` on any agent's thread – the window it really runs with
   * (Codex runs a model with another window than its API's); undefined when it never reported one.
   */
  reportedWindow(engine: EngineId, model: string): number | undefined {
    const row = this.db.get<{ context_window: number }>(
      'SELECT context_window FROM engine_sessions WHERE engine = ? AND model = ? AND context_window IS NOT NULL ORDER BY updated_at DESC LIMIT 1', [engine, model]);
    return row ? Number(row.context_window) : undefined;
  }

  /** Package C: keeps the engine's running cost total of session `ref` on the thread's row (the ref the finish binds may still come). */
  setCostTotal(agentId: string, thread: string | undefined, engine: EngineId, total: { ref: string; usd: number }): void {
    this.db.run('UPDATE engine_sessions SET cost_total = ?, cost_ref = ? WHERE agent_id = ? AND conversation_id = ? AND engine = ?',
      [total.usd, total.ref, agentId, thread ?? '', engine]);
  }

  /** Package S1: the bound session's context was folded at `at` – it holds until the session gets a new generation (a rebuild) or goes, and the compaction that may have caused it is answered. */
  folded(agentId: string, thread: string | undefined, engine: EngineId, at: number): void {
    this.db.run('UPDATE engine_sessions SET folded_at = ?, compacted_at = NULL WHERE agent_id = ? AND conversation_id = ? AND engine = ?', [at, agentId, thread ?? '', engine]);
  }

  /** Package S1: the engine compacted the bound session by itself at `at` – the cause of a fold until one ran (folded()) or the session starts anew. */
  compacted(agentId: string, thread: string | undefined, engine: EngineId, at: number): void {
    this.db.run('UPDATE engine_sessions SET compacted_at = ? WHERE agent_id = ? AND conversation_id = ? AND engine = ?', [at, agentId, thread ?? '', engine]);
  }

  /** Package S1: the fold this session carried is answered or gone – its hand-over waits in the ledger for the next rebuild that runs (agents/rebuild.ts). */
  unfolded(agentId: string, thread: string | undefined, engine: EngineId): void {
    this.db.run('UPDATE engine_sessions SET folded_at = NULL WHERE agent_id = ? AND conversation_id = ? AND engine = ?', [agentId, thread ?? '', engine]);
  }

  /** Records the context window an engine reported for the bound session's model. */
  setContextWindow(agentId: string, thread: string | undefined, engine: EngineId, contextWindow: number): void {
    this.db.run('UPDATE engine_sessions SET context_window = ? WHERE agent_id = ? AND conversation_id = ? AND engine = ?',
      [Math.round(contextWindow), agentId, thread ?? '', engine]);
  }

  /** Drops the binding; its ref is recorded as superseded (B-048; `at`: when, default the row's last update). */
  remove(agentId: string, thread: string | undefined, engine: EngineId, at?: number): void {
    const before = this.get(agentId, thread, engine);
    if (before) this.supersede(before, at ?? before.updatedAt);
    this.db.run('DELETE FROM engine_sessions WHERE agent_id = ? AND conversation_id = ? AND engine = ?', [agentId, thread ?? '', engine]);
  }
}
