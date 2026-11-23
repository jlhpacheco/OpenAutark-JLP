// The context ledger's rows (B-048 E1, table context_items – migration 77).
// The key is (agent, thread) – 13.11.2026: one context per agent, so its main thread holds the lines of every chat it saw.
// Owns: the SQL of context_items: row ↔ LedgerItem, id allocation (m<n> counting the thread's messages, t/s/r/a/f/c from one
// counter per agent and thread – each the highest number used plus one, and rows are never deleted one by one, so a number is never used twice), the monotonic order, the agent's turn count in the chat (distinct runs –
// the unit of a pin), pins, marks and the applied state of a rebuild, the copy that starts a fork's record (F26). B-049 F9: whether a row is NESTED (a call made
// inside a code-mode script) is read with every row from its journal row – the call id there starts with "exec-"
// (shared NESTED_CALL_PREFIX) – so rows captured before F9 count too, without a column; a pin's room counts no nested row
// and no checkpoint (a hand-over is pinned by the fold, not out of the room the agent keeps things in). KI-Runde 17.11.2026:
// the rows of one tool by its journal name (callItems – the fold leaves the tasks.update calls that finished a task, Quests
// round 20.11.2026: their arguments hold status done or dropped) and a pin set directly (pin).
// Never: decides what to capture or mark, reads originals or deletes rows other than a removed chat's.

import type { Db } from '../../db/database.ts';
import { TRACE_CALL_PREFIX } from '../../../shared/model/subconscious.ts';
import { KIND_PREFIX, NESTED_CALL_PREFIX, type LedgerItem, type LedgerKind, type LedgerState, type MarkBy } from '../../../shared/model/context-ledger.ts';

export interface LedgerRow {
  agent_id: string;
  conversation_id: string;
  item_id: string;
  kind: LedgerKind;
  run_id: string | null;
  order: number;
  created_at: number;
  tokens: number;
  title: string;
  state: LedgerState;
  condensed: string | null;
  pinned_until: number | null;
  origin_engine: string | null;
  origin_model: string | null;
  ref: string | null;
  applied: LedgerState;
  marked_by: MarkBy | null;
  mark_reason: string | null;
  marked_at: number | null;
  bytes: number;
  pruned_at: number | null;
  /** B-049 F9: 1 when the row is a call made inside a code-mode script (read from its journal row, not stored). */
  nested?: number;
}

export type NewRow = Pick<LedgerRow, 'agent_id' | 'conversation_id' | 'kind' | 'run_id' | 'created_at' | 'tokens' | 'title' | 'origin_engine' | 'origin_model' | 'ref' | 'bytes'>;

/** B-049 F9: a tool/skill/file row whose journal result names an "exec-" call id (the prefix has no LIKE wildcard). */
const NESTED = `COALESCE(kind IN ('tool', 'skill', 'file') AND ref LIKE 'item:%' AND EXISTS (SELECT 1 FROM run_items ri WHERE ri.id = substr(context_items.ref, 6)
  AND (CASE WHEN json_valid(ri.data) THEN json_extract(ri.data, '$.callId') END) LIKE '${NESTED_CALL_PREFIX}%'), 0)`;
const COLUMNS = `agent_id, conversation_id, item_id, kind, run_id, "order", created_at, tokens, title, state, condensed, pinned_until, origin_engine, origin_model, ref, applied, marked_by, mark_reason, marked_at, bytes, pruned_at, ${NESTED} AS nested`;
const KEY = 'agent_id = ? AND conversation_id = ?';

/** The row as callers see it; a pin shows only while it holds (`turns`: the agent's turn count in the chat now). */
export function toItem(row: LedgerRow, turns: number): LedgerItem {
  const pinned = row.pinned_until !== null && Number(row.pinned_until) >= turns;
  return {
    agentId: row.agent_id, conversationId: row.conversation_id, itemId: row.item_id, kind: row.kind,
    ...(row.run_id ? { runId: row.run_id } : {}),
    order: Number(row.order), createdAt: Number(row.created_at), tokens: Number(row.tokens), title: row.title, state: row.state,
    ...(row.condensed ? { condensed: row.condensed } : {}),
    ...(pinned ? { pinnedUntil: Number(row.pinned_until) } : {}),
    origin: { ...(row.origin_engine ? { engine: row.origin_engine } : {}), ...(row.origin_model ? { model: row.origin_model } : {}) },
    ...(row.ref ? { ref: row.ref } : {}),
    ...(row.pruned_at !== null ? { pruned: true } : {}),
    ...(row.marked_by ? { markedBy: row.marked_by } : {}),
    ...(row.mark_reason ? { markReason: row.mark_reason } : {}),
    ...(Number(row.nested) ? { nested: true } : {}),
  };
}

export class LedgerStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  row(agentId: string, conversationId: string, itemId: string): LedgerRow | undefined {
    return this.db.get<LedgerRow>(`SELECT ${COLUMNS} FROM context_items WHERE ${KEY} AND item_id = ?`, [agentId, conversationId, itemId]);
  }

  byRef(agentId: string, conversationId: string, ref: string): LedgerRow | undefined {
    return this.db.get<LedgerRow>(`SELECT ${COLUMNS} FROM context_items WHERE ${KEY} AND ref = ?`, [agentId, conversationId, ref]);
  }

  rows(agentId: string, conversationId: string, since?: number, kinds?: readonly LedgerKind[]): LedgerRow[] {
    const kindFilter = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    return this.db.all<LedgerRow>(
      `SELECT ${COLUMNS} FROM context_items WHERE ${KEY} AND "order" >= ?${kindFilter} ORDER BY "order"`,
      [agentId, conversationId, since ?? 0, ...(kinds?.length ? kinds : [])],
    );
  }

  /** The agent's turns in the chat so far (distinct runs that captured items) – pins count in these. */
  turns(agentId: string, conversationId: string): number {
    return Number(this.db.get<{ n: number }>(`SELECT COUNT(DISTINCT run_id) AS n FROM context_items WHERE ${KEY} AND run_id IS NOT NULL`, [agentId, conversationId])?.n ?? 0);
  }

  /** Has this run captured anything in the chat yet? */
  hasRun(agentId: string, conversationId: string, runId: string): boolean {
    return this.db.get(`SELECT 1 AS hit FROM context_items WHERE ${KEY} AND run_id = ? LIMIT 1`, [agentId, conversationId, runId]) !== undefined;
  }

  /** The run's own words are in the ledger (its text, its hand-over or a tool call) – its chat message is not recorded again. */
  hasOwnWords(agentId: string, conversationId: string, runId: string): boolean {
    return this.db.get(`SELECT 1 AS hit FROM context_items WHERE ${KEY} AND run_id = ? AND kind IN ('assistant', 'tool', 'checkpoint') LIMIT 1`, [agentId, conversationId, runId]) !== undefined;
  }

  /** Inserts a new row with the next order and id; returns it. Call inside a transaction. */
  insert(input: NewRow): LedgerRow {
    const { agent_id: agentId, conversation_id: conversationId } = input;
    const order = Number(this.db.get<{ n: number | null }>(`SELECT MAX("order") AS n FROM context_items WHERE ${KEY}`, [agentId, conversationId])?.n ?? 0) + 1;
    const message = input.kind === 'message'; // messages count apart (m1, m2 …); t/s/r/a/f/c share one counter
    const last = this.db.get<{ n: number | null }>(`SELECT MAX(CAST(substr(item_id, 2) AS INTEGER)) AS n FROM context_items WHERE ${KEY} AND kind ${message ? '=' : '<>'} 'message'`, [agentId, conversationId])?.n;
    const itemId = `${KIND_PREFIX[input.kind]}${Number(last ?? 0) + 1}`;
    this.db.run(
      `INSERT INTO context_items (agent_id, conversation_id, item_id, kind, run_id, "order", created_at, tokens, title, ref, origin_engine, origin_model, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, conversationId, itemId, input.kind, input.run_id, order, input.created_at, input.tokens, input.title, input.ref, input.origin_engine, input.origin_model, input.bytes],
    );
    return this.row(agentId, conversationId, itemId)!;
  }

  /** A capture seen again (a journal update): fresher title, tokens and size. */
  refresh(row: LedgerRow, patch: { title?: string; tokens?: number; bytes?: number }): LedgerRow {
    const title = patch.title ?? row.title;
    const tokens = patch.tokens ?? Number(row.tokens);
    const bytes = patch.bytes ?? Number(row.bytes);
    if (title === row.title && tokens === Number(row.tokens) && bytes === Number(row.bytes)) return row;
    this.db.run(`UPDATE context_items SET title = ?, tokens = ?, bytes = ? WHERE ${KEY} AND item_id = ?`, [title, tokens, bytes, row.agent_id, row.conversation_id, row.item_id]);
    return { ...row, title, tokens, bytes };
  }

  setMark(row: LedgerRow, mark: { state: LedgerState; condensed: string | null; by: MarkBy; reason: string; at: number; pinnedUntil?: number }): void {
    this.db.run(
      `UPDATE context_items SET state = ?, condensed = ?, marked_by = ?, mark_reason = ?, marked_at = ?, pinned_until = COALESCE(?, pinned_until) WHERE ${KEY} AND item_id = ?`,
      [mark.state, mark.condensed, mark.by, mark.reason, mark.at, mark.pinnedUntil ?? null, row.agent_id, row.conversation_id, row.item_id],
    );
  }

  /** B-050 K5: the tokens of the items pinned at least until `atLeast` (KEEP_PIN: the items kept for good) – B-049 F9: nested rows cost none. */
  pinnedTokens(agentId: string, conversationId: string, atLeast: number): number {
    return Number(this.db.get<{ n: number | null }>(`SELECT SUM(tokens) AS n FROM context_items WHERE ${KEY} AND pinned_until >= ? AND kind <> 'checkpoint' AND NOT ${NESTED}`, [agentId, conversationId, atLeast])?.n ?? 0);
  }

  /** Pins a row until the turn count `until` (the fold pins its hand-over for good). */
  pin(row: Pick<LedgerRow, 'agent_id' | 'conversation_id' | 'item_id'>, until: number): void {
    this.db.run(`UPDATE context_items SET pinned_until = ? WHERE ${KEY} AND item_id = ?`, [until, row.agent_id, row.conversation_id, row.item_id]);
  }

  /**
   * The ids of the rows that are the agent's own words posted in a chat: their journal note names the message it became, or
   * reached one (agents/publishing.ts), or – a commentary segment's 'Update' note – the messages its blocks became (agents/chat-out.ts).
   */
  postedItems(agentId: string, conversationId: string): Set<string> {
    return new Set(this.db.all<{ item_id: string }>(
      `SELECT item_id FROM context_items WHERE ${KEY} AND kind = 'assistant' AND ref LIKE 'item:%'
         AND EXISTS (SELECT 1 FROM run_items ri WHERE ri.id = substr(context_items.ref, 6)
           AND (json_extract(ri.data, '$.messageId') IS NOT NULL OR json_extract(ri.data, '$.visibility') = 'notify' OR json_extract(ri.data, '$.messageIds') IS NOT NULL))`,
      [agentId, conversationId],
    ).map((row) => row.item_id));
  }

  /**
   * The ids of the tool rows whose call is `name`, read from their journal row (a call through tools.call is journaled under its
   * target's name); `argsLike`: only those whose journaled arguments match one of these LIKE patterns.
   */
  callItems(agentId: string, conversationId: string, name: string, argsLike: readonly string[] = []): Set<string> {
    // A row may point at the call or at its result: the arguments are read from the call with the same callId in that run.
    const like = (alias: string) => argsLike.map(() => `CAST(json_extract(${alias}.data, '$.args') AS TEXT) LIKE ?`).join(' OR ');
    const args = argsLike.length ? ` AND EXISTS (SELECT 1 FROM run_items c WHERE c.run_id = ri.run_id AND c.kind = 'tool_call'
         AND json_extract(c.data, '$.callId') = json_extract(ri.data, '$.callId') AND (${like('c')}))` : '';
    return new Set(this.db.all<{ item_id: string }>(
      `SELECT item_id FROM context_items WHERE ${KEY} AND kind = 'tool' AND ref LIKE 'item:%'
         AND EXISTS (SELECT 1 FROM run_items ri WHERE ri.id = substr(context_items.ref, 6) AND ri.name = ?${args})`,
      [agentId, conversationId, name, ...argsLike],
    ).map((row) => row.item_id));
  }

  /** The newest `limit` rows of the subconscious's calls (their journal call id starts with TRACE_CALL_PREFIX), hidden ones left out. */
  traceRows(agentId: string, conversationId: string, limit: number): LedgerRow[] {
    return this.db.all<LedgerRow>(
      `SELECT ${COLUMNS} FROM context_items WHERE ${KEY} AND state <> 'hidden' AND kind IN ('tool', 'skill', 'file') AND ref LIKE 'item:%'
         AND EXISTS (SELECT 1 FROM run_items ri WHERE ri.id = substr(context_items.ref, 6) AND (CASE WHEN json_valid(ri.data) THEN json_extract(ri.data, '$.callId') END) GLOB '${TRACE_CALL_PREFIX}*')
       ORDER BY "order" DESC LIMIT ?`,
      [agentId, conversationId, limit],
    ).reverse();
  }

  /** Items whose state differs from what the native session holds. */
  changed(agentId: string, conversationId: string): LedgerRow[] {
    return this.db.all<LedgerRow>(`SELECT ${COLUMNS} FROM context_items WHERE ${KEY} AND state <> applied ORDER BY "order"`, [agentId, conversationId]);
  }

  applied(agentId: string, conversationId: string, upTo: number): void {
    this.db.run(`UPDATE context_items SET applied = state WHERE ${KEY} AND "order" <= ? AND state <> applied`, [agentId, conversationId, upTo]);
  }

  pruned(row: Pick<LedgerRow, 'agent_id' | 'conversation_id' | 'item_id'>, at: number): void {
    this.db.run(`UPDATE context_items SET pruned_at = ? WHERE ${KEY} AND item_id = ?`, [at, row.agent_id, row.conversation_id, row.item_id]);
  }

  /** Blob-backed originals of condensed/hidden items still kept: their total size. */
  heldBytes(agentId: string, conversationId: string): number {
    return Number(this.db.get<{ n: number | null }>(`SELECT SUM(bytes) AS n FROM context_items WHERE ${KEY} AND state <> 'keep' AND pruned_at IS NULL AND bytes > 0`, [agentId, conversationId])?.n ?? 0);
  }

  /** Prune candidates: condensed/hidden blob originals marked before `before` – hidden first, then the oldest. */
  pruneCandidates(agentId: string, conversationId: string, before: number): LedgerRow[] {
    return this.db.all<LedgerRow>(
      `SELECT ${COLUMNS} FROM context_items WHERE ${KEY} AND state <> 'keep' AND pruned_at IS NULL AND bytes > 0 AND COALESCE(marked_at, created_at) <= ?
       ORDER BY CASE state WHEN 'hidden' THEN 0 ELSE 1 END, "order"`,
      [agentId, conversationId, before],
    );
  }

  /** (agent, chat) pairs whose held originals exceed `budget` (the start-up pass; at most `limit`). */
  overBudget(budget: number, limit: number): Array<{ agent_id: string; conversation_id: string }> {
    return this.db.all(
      `SELECT agent_id, conversation_id FROM context_items WHERE state <> 'keep' AND pruned_at IS NULL AND bytes > 0
       GROUP BY agent_id, conversation_id HAVING SUM(bytes) > ? LIMIT ?`,
      [budget, limit],
    );
  }

  /** Another unpruned blob-backed row (any chat) whose journal item names this blob id. */
  blobHeldElsewhere(blobId: string, except: Pick<LedgerRow, 'agent_id' | 'conversation_id' | 'item_id'>): boolean {
    return this.db.get(
      `SELECT 1 AS hit FROM context_items c JOIN run_items i ON i.id = substr(c.ref, 6)
        WHERE c.ref LIKE 'item:%' AND c.pruned_at IS NULL AND c.bytes > 0 AND instr(i.data, ?) > 0
          AND NOT (c.agent_id = ? AND c.conversation_id = ? AND c.item_id = ?) LIMIT 1`,
      [blobId, except.agent_id, except.conversation_id, except.item_id],
    ) !== undefined;
  }

  /** Rows (any agent and thread) of one chat message. */
  byMessage(messageId: string): LedgerRow[] {
    return this.db.all<LedgerRow>(`SELECT ${COLUMNS} FROM context_items WHERE ref = ?`, [`msg:${messageId}`]);
  }

  /** An edited message: its rows' title and estimate follow the new text. */
  retitle(row: LedgerRow, title: string, tokens: number): void {
    this.db.run(`UPDATE context_items SET title = ?, tokens = ? WHERE ${KEY} AND item_id = ?`, [title, tokens, row.agent_id, row.conversation_id, row.item_id]);
  }

  /** An edited message marked before the edit: back to its (new) original – a condensed text of the old words never stands in for it. */
  reopen(row: LedgerRow, at: number): void {
    this.db.run(
      `UPDATE context_items SET state = 'keep', condensed = NULL, marked_by = NULL, mark_reason = 'edited by its author', marked_at = ? WHERE ${KEY} AND item_id = ?`,
      [at, row.agent_id, row.conversation_id, row.item_id],
    );
  }

  /** A deleted message: its rows keep none of its words, leave the view and count as pruned (the id stays). */
  forgetMessage(messageId: string, at: number): number {
    return this.db.run(
      `UPDATE context_items SET title = 'Deleted message', condensed = NULL, state = 'hidden', mark_reason = 'deleted by its author', marked_at = ?, pruned_at = COALESCE(pruned_at, ?)
        WHERE ref = ?`,
      [at, at, `msg:${messageId}`],
    ).changes;
  }

  /**
   * F26: a fork's record – `from`'s rows up to the last one of `runId` (all of them when that run left none) copied into `to` as they
   * are (ids, order, marks, pins, refs to the same originals), when `to` holds no row yet; returns how many it copied.
   */
  copy(agentId: string, from: string, to: string, runId: string): number {
    return this.db.tx(() => {
      if (this.db.get(`SELECT 1 AS hit FROM context_items WHERE ${KEY} LIMIT 1`, [agentId, to])) return 0;
      const upTo = this.db.get<{ n: number | null }>(`SELECT MAX("order") AS n FROM context_items WHERE ${KEY} AND run_id = ?`, [agentId, from, runId])?.n;
      const columns = 'kind, run_id, "order", created_at, tokens, title, state, condensed, pinned_until, origin_engine, origin_model, ref, applied, marked_by, mark_reason, marked_at, bytes, pruned_at';
      return this.db.run(
        `INSERT INTO context_items (agent_id, conversation_id, item_id, ${columns}) SELECT agent_id, ?, item_id, ${columns} FROM context_items WHERE ${KEY} AND "order" <= ?`,
        [to, agentId, from, upTo ?? Number.MAX_SAFE_INTEGER],
      ).changes;
    });
  }

  /** A removed chat: its blob-backed unpruned rows (for their blobs), then every row goes. */
  removeChat(conversationId: string): LedgerRow[] {
    const held = this.db.all<LedgerRow>(`SELECT ${COLUMNS} FROM context_items WHERE conversation_id = ? AND bytes > 0 AND pruned_at IS NULL`, [conversationId]);
    this.db.run('DELETE FROM context_items WHERE conversation_id = ?', [conversationId]);
    return held;
  }
}
