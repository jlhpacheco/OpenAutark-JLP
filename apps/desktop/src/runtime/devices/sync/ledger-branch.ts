// Two records of one agent that drifted apart (both PCs went on during a split; Umzug 21.11.2026): the agents row
// decides, the PC it names is the writer. The other PC (the loser) sends its own rows the writer has not acknowledged
// (pc NULL, `changed` past its cursor for the writer) as op 'branch' in pages; the writer appends every row it lacks
// after its own last one – new ids from the store's counters (LedgerStore.insert), new orders, `pc` = the loser (it holds
// their originals, so a restore fetches a hidden one from there; review M3) – and answers which ones it took and which it
// already had (the same item: kind, time, ref). The loser deletes only those context rows (the writer's mirror brings them
// back under their new ids; its run items stay) and leaves any row the writer took neither way (review L1). An agent with
// no rows at all on the writer is no branch: a PC that ran it before this version – its rows are taken as they are, ids kept.
// Rows the loser created before its record sync first started (`before`) are its older record, not work of the time
// apart: appended the same way but hidden (they cost nothing in the live context; context.restore brings any back).
// Once the last page is in, the agent hears it once (noteMove) and its native sessions here go once a turn of it that runs
// now has ended (dropSessionsAfterTurn; review M2), so its next turn rebuilds with them.
// Owns: picking the loser's rows, appending them, the note's text. Never: interleaves by time, renumbers rows the
// writer had, logs item text.

import type { RuntimeServices } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import { LedgerStore } from '../../context/ledger/store.ts';
import { SessionStore } from '../../agents/sessions.ts';
import type { EngineId } from '../../../shared/model/providers.ts';
import { clockText, dateText, profileZone } from '../../context/time.ts';
import { DevicesRepo } from '../repo.ts';
import { selfId } from './home.ts';
import { putOriginals, putRow, rerouted, sameItem, SELECT, type LocalRow, type Originals, type WireRow } from './ledger-wire.ts';

/** One page of a branch as it travels (op 'branch'); `before`: when the loser's record sync first started (its clock). */
export interface BranchPage extends Originals { agentId: string; rows: WireRow[]; first: boolean; last: boolean; before?: number }

interface Span { n: number; firstId?: string; lastId?: string }
/** What a writer appended of one PC's branch so far (the note at its last page): rows of the time apart, and the older record (`old`, hidden). */
export interface Appended extends Span { asIs: boolean; from: number; to: number; old: Span & { before?: number } }

const counted = (span: Span, itemId: string) => { span.n += 1; span.firstId ??= itemId; span.lastId = itemId; };

/** A row's key as the answer names it. */
export const keyOf = (row: Pick<WireRow, 'conversation_id' | 'item_id'>) => `${row.conversation_id}\u0000${row.item_id}`;

/** The loser's rows of `agentId` the writer has not acknowledged (its cursor for that PC), thread by thread in order. */
export function branchRows(db: Db, agentId: string, cursor: number): LocalRow[] {
  return db.all<LocalRow>(`SELECT ${SELECT} FROM context_items WHERE agent_id = ? AND pc IS NULL AND changed > ? ORDER BY conversation_id, "order"`, [agentId, cursor]);
}

/** The writer answered a page: what it took goes here (its mirror brings it back), what it had is its own now; anything else stays. */
export function settleBranch(db: Db, rows: readonly WireRow[], answer: { taken: ReadonlySet<string>; kept: ReadonlySet<string> }, writer: string): void {
  db.tx(() => {
    for (const row of rows) {
      const key = [row.agent_id, row.conversation_id, row.item_id];
      if (answer.kept.has(keyOf(row))) db.run('UPDATE context_items SET pc = ? WHERE agent_id = ? AND conversation_id = ? AND item_id = ?', [writer, ...key]);
      else if (answer.taken.has(keyOf(row))) db.run('DELETE FROM context_items WHERE agent_id = ? AND conversation_id = ? AND item_id = ? AND pc IS NULL', key);
    }
  });
}

/** Writer: appends one page of `from`'s branch of `page.agentId`; returns the keys it took (new ids) and those it had (or took as they are). */
export function appendBranch(db: Db, page: BranchPage, from: string, acc: Appended, now: number): { taken: string[]; kept: string[] } {
  const store = new LedgerStore(db);
  const kept: string[] = [];
  const taken: string[] = [];
  db.tx(() => {
    const moved = putOriginals(db, page, from);
    const rows = [...page.rows].sort((a, b) => String(a.conversation_id).localeCompare(String(b.conversation_id)) || Number(a.order) - Number(b.order));
    for (const raw of rows) {
      const row = rerouted(raw, moved);
      if (acc.asIs) { putRow(db, row, from); kept.push(keyOf(raw)); continue; }
      const had = db.all<WireRow>('SELECT item_id, "order", kind, created_at, ref FROM context_items WHERE agent_id = ? AND conversation_id = ? AND kind = ? AND created_at = ?',
        [row.agent_id, row.conversation_id, row.kind, row.created_at]).find((local) => sameItem(local, row));
      // Had under the same id and order: the same row on both PCs. Else this branch appended it before (an answer that was lost).
      if (had) { (had.item_id === raw.item_id && Number(had.order) === Number(raw.order) ? kept : taken).push(keyOf(raw)); continue; }
      const added = store.insert({
        agent_id: String(row.agent_id), conversation_id: String(row.conversation_id), kind: row.kind as never, run_id: (row.run_id as string | null) ?? null,
        created_at: Number(row.created_at), tokens: Number(row.tokens), title: String(row.title), origin_engine: (row.origin_engine as string | null) ?? null,
        origin_model: (row.origin_model as string | null) ?? null, ref: (row.ref as string | null) ?? null, bytes: Number(row.bytes),
      });
      const old = page.before !== undefined && Number(row.created_at) < page.before; // created before the loser's sync started: its older record
      const marks = old ? ['hidden', row.condensed, null, row.applied, 'window', 'older record from another PC', now, row.pruned_at]
        : [row.state, row.condensed, row.pinned_until, row.applied, row.marked_by, row.mark_reason, row.marked_at, row.pruned_at];
      db.run(
        `UPDATE context_items SET state = ?, condensed = ?, pinned_until = ?, applied = ?, marked_by = ?, mark_reason = ?, marked_at = ?, pruned_at = ?, pc = ?
          WHERE agent_id = ? AND conversation_id = ? AND item_id = ?`,
        [...marks, from, added.agent_id, added.conversation_id, added.item_id],
      );
      taken.push(keyOf(raw));
      if (old) { counted(acc.old, added.item_id); acc.old.before = page.before; continue; }
      counted(acc, added.item_id);
      acc.from = Math.min(acc.from, Number(row.created_at));
      acc.to = Math.max(acc.to, Number(row.created_at));
    }
  });
  return { taken, kept };
}

/** The line the agent reads once its record holds the other PC's work (and its older record from there). */
export function branchNote(s: Pick<RuntimeServices, 'db' | 'settings' | 'clock'>, from: string, acc: Appended): string {
  const devices = new DevicesRepo(s.db);
  const other = devices.get(from)?.name ?? from;
  const me = devices.get(selfId(s.db))?.name ?? 'this PC';
  const zone = profileZone(s);
  const apart = acc.n ? `While ${other} could not reach ${me} (${clockText(acc.from, zone)}–${clockText(acc.to, zone)}) I also worked on ${other}: ${acc.n} items, ${acc.firstId}–${acc.lastId} in my record.` : '';
  const old = acc.old.n
    ? `My older record from ${other} (before ${dateText(acc.old.before ?? s.clock.now(), zone, s.clock.now())}) is in my record now, hidden – ${acc.old.n} items, ${acc.old.firstId}–${acc.old.lastId}; context.restore brings any back.`
    : '';
  return [apart, old].filter(Boolean).join(' ');
}

/** The agent's native sessions here go once no turn of it runs here (its runs' final status), so its next turn rebuilds them from the record. */
export function dropSessionsAfterTurn(s: Pick<RuntimeServices, 'db' | 'bus'>, agentId: string): void {
  const open = () => s.db.all<{ id: string }>(`SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued', 'running')`, [agentId]).map((run) => run.id);
  if (!open().length) { dropSessions(s.db, agentId); return; }
  waiting.get(s.db)?.get(agentId)?.(); // one listener per agent
  const off = s.bus.on('run.upserted', (run) => {
    if (run.agentId !== agentId || open().length) return;
    stop();
    dropSessions(s.db, agentId);
  });
  const stop = () => { off(); waiting.get(s.db)?.delete(agentId); };
  let mine = waiting.get(s.db);
  if (!mine) waiting.set(s.db, (mine = new Map()));
  mine.set(agentId, stop);
}

const waiting = new WeakMap<object, Map<string, () => void>>();

/** The agent's native sessions here go: its next turn rebuilds them from the record. */
export function dropSessions(db: Db, agentId: string): void {
  const sessions = new SessionStore(db);
  for (const row of db.all<{ conversation_id: string; engine: string }>('SELECT conversation_id, engine FROM engine_sessions WHERE agent_id = ?', [agentId])) {
    sessions.remove(agentId, row.conversation_id, row.engine as EngineId);
  }
}
