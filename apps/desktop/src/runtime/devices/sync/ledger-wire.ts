// The agent's record as it travels between the CEO's own PCs (ledger.ts): a context_items row with every column but
// `pc` and `changed`, and – for a kept or condensed row whose ref is `item:<run item id>` – its originals: that run item,
// the tool_call row of the same run and call id (originals.ts callRow) and a minimal runs row (the FK; a run still
// going on its PC is 'unknown' here, a final status as it is). A hidden row travels without them. Pages stay under
// PAGE_BYTES (the channel takes frames up to 8 MiB). A row written here from another PC keeps that PC's id in `pc`
// (NULL = written here). Run items keep their ids (uuids); one whose id another run holds here gets a new one, and the
// row's ref follows it. A row or run item that is here as it is gets no write.
// Owns: these shapes, their checks, reading and writing them with SQL. Never: decides which rows go where, logs content.

import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/database.ts';
import { callRow } from '../../context/ledger/originals.ts';
import { isCeoPc, selfId } from './home.ts';

/** Bytes of one page at most (a quarter of the channel's frame). */
export const PAGE_BYTES = 2 * 1024 * 1024;

export const COLUMNS = ['agent_id', 'conversation_id', 'item_id', 'kind', 'run_id', 'order', 'created_at', 'tokens', 'title', 'state', 'condensed',
  'pinned_until', 'origin_engine', 'origin_model', 'ref', 'applied', 'marked_by', 'mark_reason', 'marked_at', 'bytes', 'pruned_at'] as const;
type Column = typeof COLUMNS[number];
export type WireRow = Record<Column, string | number | null>;
/** A row read here: the wire columns plus the cursor value and who wrote it. */
export type LocalRow = WireRow & { changed: number; pc: string | null };

export interface RunWire { id: string; agent_id: string; conversation_id: string | null; trigger: string; status: string; started_at: number | null; ended_at: number | null }
export interface ItemWire { id: string; run_id: string; seq: number; kind: string; name: string | null; data: string; effect_status: string | null; idem_key: string | null; created_at: number }
export interface Originals { runs: RunWire[]; items: ItemWire[] }
export interface Page extends Originals { rows: WireRow[]; /** The highest `changed` in it. */ top: number }

const quoted = (column: string) => (column === 'order' ? '"order"' : column);
export const SELECT = `${COLUMNS.map(quoted).join(', ')}, changed, pc`;
const KINDS = new Set(['message', 'tool', 'skill', 'reasoning', 'assistant', 'file', 'checkpoint']);
const STATES = new Set(['keep', 'condensed', 'hidden']);
const ITEM_ID = /^[mtsrafc][1-9]\d{0,11}$/;
const INTS: ReadonlySet<Column> = new Set(['order', 'created_at', 'tokens', 'bytes']);
const FINAL = new Set(['done', 'failed', 'interrupted', 'unknown']);
const ITEM_COLUMNS = 'id, run_id, seq, kind, name, data, effect_status, idem_key, created_at';

const isText = (value: unknown, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isNum = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/** Whether an incoming row has the shape of a context_items row (ids, kind, states, numbers). */
export function validRow(value: unknown): value is WireRow {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== 'object') return false;
  if (!isText(row.agent_id) || typeof row.conversation_id !== 'string' || row.conversation_id.length > 200) return false;
  if (typeof row.item_id !== 'string' || !ITEM_ID.test(row.item_id) || !KINDS.has(String(row.kind))) return false;
  if (!STATES.has(String(row.state)) || !STATES.has(String(row.applied)) || typeof row.title !== 'string') return false;
  for (const column of COLUMNS) {
    const cell = row[column];
    if (INTS.has(column) ? !isNum(cell) : !(cell === null || typeof cell === 'string' || isNum(cell))) return false;
  }
  return Number(row.order) >= 1;
}

function validRun(value: unknown): value is RunWire {
  const run = value as RunWire;
  return Boolean(run) && isText(run.id) && isText(run.agent_id) && isText(run.trigger, 100) && isText(run.status, 40);
}

function validItem(value: unknown): value is ItemWire {
  const item = value as ItemWire;
  return Boolean(item) && isText(item.id) && isText(item.run_id) && isNum(item.seq) && isText(item.kind, 40) && typeof item.data === 'string' && isNum(item.created_at);
}

/** The originals of an incoming message, checked (anything malformed is left out). */
export function originalsIn(value: { runs?: unknown; items?: unknown }): Originals {
  return {
    runs: (Array.isArray(value.runs) ? value.runs : []).filter(validRun),
    items: (Array.isArray(value.items) ? value.items : []).filter(validItem),
  };
}

export const wireOf = (row: LocalRow): WireRow => Object.fromEntries(COLUMNS.map((column) => [column, row[column]])) as WireRow;

/** The same item: kind, creation time and ref (an id may differ only after a branch gave it a new one). */
export const sameItem = (a: Pick<WireRow, 'kind' | 'created_at' | 'ref'>, b: Pick<WireRow, 'kind' | 'created_at' | 'ref'>) =>
  a.kind === b.kind && Number(a.created_at) === Number(b.created_at) && (a.ref ?? null) === (b.ref ?? null);

const itemOf = (db: Db, id: string) => db.get<ItemWire>(`SELECT ${ITEM_COLUMNS} FROM run_items WHERE id = ?`, [id]);

/** The originals of `rows` that travel (kept and condensed rows with an item ref), each once. */
export function originalsOf(db: Db, rows: readonly WireRow[]): Originals {
  const items = new Map<string, ItemWire>();
  const runs = new Map<string, RunWire>();
  for (const row of rows) {
    if (row.state === 'hidden' || typeof row.ref !== 'string' || !row.ref.startsWith('item:')) continue;
    const item = itemOf(db, row.ref.slice(5));
    if (!item) continue;
    items.set(item.id, item);
    try {
      const callId = item.kind === 'tool_result' ? (JSON.parse(item.data) as { callId?: unknown }).callId : undefined;
      const call = typeof callId === 'string' ? callRow(db, item.run_id, callId) : undefined;
      const callItem = call ? itemOf(db, call.id) : undefined;
      if (callItem) items.set(callItem.id, callItem);
    } catch { /* unreadable data: the result alone */ }
    if (!runs.has(item.run_id)) {
      const run = db.get<RunWire>('SELECT id, agent_id, conversation_id, trigger, status, started_at, ended_at FROM runs WHERE id = ?', [item.run_id]);
      if (run) runs.set(run.id, run);
    }
  }
  return { runs: [...runs.values()], items: [...items.values()] };
}

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** `rows` (in order) cut into pages of at most `limit` bytes with their originals; a row too big with them goes alone without them. */
export function pagesOf(db: Db, rows: readonly LocalRow[], limit = PAGE_BYTES): Page[] {
  const pages: Page[] = [];
  let page: Page = { rows: [], runs: [], items: [], top: 0 };
  let size = 64;
  const seen = new Set<string>();
  for (const local of rows) {
    const row = wireOf(local);
    const extra = originalsOf(db, [row]);
    extra.runs = extra.runs.filter((run) => !seen.has(`r/${run.id}`));
    extra.items = extra.items.filter((item) => !seen.has(`i/${item.id}`));
    let add = sizeOf(row) + sizeOf(extra);
    if (page.rows.length && size + add > limit) {
      pages.push(page);
      page = { rows: [], runs: [], items: [], top: 0 };
      size = 64;
      seen.clear();
      Object.assign(extra, originalsOf(db, [row]));
      add = sizeOf(row) + sizeOf(extra);
    }
    if (size + add > limit) { extra.runs = []; extra.items = []; add = sizeOf(row); } // the row alone; its original stays where it is
    page.rows.push(row);
    page.runs.push(...extra.runs);
    page.items.push(...extra.items);
    for (const run of extra.runs) seen.add(`r/${run.id}`);
    for (const item of extra.items) seen.add(`i/${item.id}`);
    page.top = Math.max(page.top, Number(local.changed));
    size += add;
  }
  if (page.rows.length) pages.push(page);
  return pages;
}

/**
 * Writes originals that came from PC `from` (call inside a transaction): a missing runs row (device_id = that PC), run
 * items new or updated in place. Returns the run item ids that changed here (another run holds the id: a new one);
 * `newIds: false` leaves such an item out instead.
 */
export function putOriginals(db: Db, originals: Originals, from: string, newIds = true): Map<string, string> {
  for (const run of originals.runs) {
    // A copy takes the source's final status once it has one (review M1); a run of this PC is never written over.
    db.run(`INSERT INTO runs (id, agent_id, conversation_id, trigger, status, started_at, ended_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at
      WHERE runs.device_id = excluded.device_id AND runs.status = 'unknown' AND excluded.status <> 'unknown'`,
      [run.id, run.agent_id, run.conversation_id ?? null, run.trigger, FINAL.has(run.status) ? run.status : 'unknown', run.started_at ?? null, run.ended_at ?? null, from]);
  }
  const moved = new Map<string, string>();
  for (const item of originals.items) {
    if (!db.get('SELECT 1 AS hit FROM runs WHERE id = ?', [item.run_id])) continue;
    const held = db.get<{ run_id: string }>('SELECT run_id FROM run_items WHERE id = ?', [item.id]);
    let id = item.id;
    if (held && held.run_id !== item.run_id) {
      if (!newIds) continue;
      id = randomUUID();
      moved.set(item.id, id);
    }
    const values = [id, item.run_id, item.seq, item.kind, item.name ?? null, item.data, item.effect_status ?? null, item.created_at];
    const upsert = (idem: string | null) => db.run(
      `INSERT INTO run_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, effect_status = excluded.effect_status
       WHERE run_items.data IS NOT excluded.data OR run_items.effect_status IS NOT excluded.effect_status`, [...values.slice(0, 7), idem, values[7]]);
    try { upsert(item.idem_key ?? null); } catch { upsert(null); } // an idempotency key another item holds here: the item without it
  }
  return moved;
}

/** `row` with its ref pointing at a run item's new id, when it got one. */
export function rerouted(row: WireRow, moved: ReadonlyMap<string, string>): WireRow {
  const ref = typeof row.ref === 'string' && row.ref.startsWith('item:') ? moved.get(row.ref.slice(5)) : undefined;
  return ref ? { ...row, ref: `item:${ref}` } : row;
}

/** The local rows an incoming row collides with: another item under its id, or another id at its order. */
export function collisions(db: Db, row: WireRow): LocalRow[] {
  return db.all<LocalRow>(
    `SELECT ${SELECT} FROM context_items WHERE agent_id = ? AND conversation_id = ? AND (item_id = ? OR "order" = ?)`,
    [row.agent_id, row.conversation_id, row.item_id, row.order],
  ).filter((local) => local.item_id !== row.item_id || !sameItem(local, row));
}

/** Whether a local row holds exactly what `row` carries. */
function same(local: WireRow, row: WireRow): boolean {
  return COLUMNS.every((column) => (local[column] ?? null) === (row[column] ?? null) || (isNum(local[column]) && Number(local[column]) === Number(row[column])));
}

/**
 * Writes `row` as PC `pc` wrote it (NULL: here), replacing what it collides with (call inside a transaction); a row that is
 * here already as it is stays untouched – no write, so no new `changed` and nothing echoes (review R1 H2). Returns whether it wrote.
 */
export function putRow(db: Db, row: WireRow, pc: string | null): boolean {
  const clashes = collisions(db, row);
  const local = db.get<WireRow>(`SELECT ${SELECT} FROM context_items WHERE agent_id = ? AND conversation_id = ? AND item_id = ?`, [row.agent_id, row.conversation_id, row.item_id]);
  if (local && !clashes.length && same(local, row)) return false;
  for (const local of clashes) {
    db.run('DELETE FROM context_items WHERE agent_id = ? AND conversation_id = ? AND item_id = ?', [local.agent_id, local.conversation_id, local.item_id]);
  }
  const columns = [...COLUMNS.map(quoted), 'pc'];
  const updates = [...COLUMNS.slice(3).map(quoted), 'pc'].map((column) => `${column} = excluded.${column}`).join(', ');
  db.run(
    `INSERT INTO context_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(agent_id, conversation_id, item_id) DO UPDATE SET ${updates}`,
    [...COLUMNS.map((column) => row[column]), pc],
  );
  return true;
}

/** A run copied from another of my PCs (its device_id names a CEO PC linked here): never this PC's own turn (review M1). */
export function copiedRun(db: Db, deviceId: string | null | undefined): boolean {
  return Boolean(deviceId) && deviceId !== selfId(db) && isCeoPc(db, deviceId!);
}
