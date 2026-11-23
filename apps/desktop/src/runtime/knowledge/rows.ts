// Row mapping for the `knowledge` table: what stays in the database besides the memory files – the old versions of memory
// files (rows with expired_at, `supersedes` = the file's id) – and the map of old `kn_…` ids to the files they moved to.
// Owns: KnowledgeItem <-> SQLite row conversion, version chains, correcting, expiring and pinning a row (a file's versions
// never change), the deletion of rows and reading the old-id map.
// Never: deciding what a turn reads or ranking (acl.ts / search.ts).

import { bool, int, json, toJson, type Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { KnowledgeItem, KnowledgeSource } from '../../shared/model/knowledge.ts';

/** Upper bound for one correction chain (a chain is linear; this only guards against bad data). */
const MAX_CHAIN = 1000;

export interface KnowledgeRow {
  id: string; scope: string; scope_id: string | null; kind: string; title: string; body: string; tags: string;
  source: string; confidence: number; pinned: number; valid_from: number | null; valid_to: number | null;
  recorded_at: number; expired_at: number | null; supersedes: string | null; created_by: string; uses: number;
  last_used_at: number | null;
}

/** The item columns (the table's old embedding columns stay unread). */
export const ITEM_COLUMNS = 'id, scope, scope_id, kind, title, body, tags, source, confidence, pinned, valid_from, valid_to, recorded_at, expired_at, supersedes, created_by, uses, last_used_at';

const opt = <T>(value: T | null | undefined): T | undefined => (value === null || value === undefined ? undefined : value);

export function toItem(row: KnowledgeRow): KnowledgeItem {
  return {
    id: row.id,
    scope: row.scope as KnowledgeItem['scope'],
    scopeId: opt(row.scope_id),
    kind: row.kind as KnowledgeItem['kind'],
    title: row.title,
    body: row.body,
    tags: json<string[]>(row.tags, []),
    source: json<KnowledgeSource>(row.source, { kind: 'agent', trusted: false }),
    confidence: row.confidence,
    pinned: bool(row.pinned),
    validFrom: opt(row.valid_from),
    validTo: opt(row.valid_to),
    recordedAt: row.recorded_at,
    expiredAt: opt(row.expired_at),
    supersedes: opt(row.supersedes),
    createdBy: row.created_by,
    uses: row.uses,
    lastUsedAt: opt(row.last_used_at),
  };
}

export function insertItem(db: Db, item: KnowledgeItem): void {
  db.run(
    `INSERT INTO knowledge (id, scope, scope_id, kind, title, body, tags, source, confidence, pinned, valid_from, valid_to,
      recorded_at, expired_at, supersedes, created_by, uses, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.id, item.scope, item.scopeId ?? null, item.kind, item.title, item.body, toJson(item.tags), toJson(item.source),
      item.confidence, int(item.pinned), item.validFrom ?? null, item.validTo ?? null, item.recordedAt, item.expiredAt ?? null,
      item.supersedes ?? null, item.createdBy, item.uses, item.lastUsedAt ?? null],
  );
}

export function getRow(db: Db, id: string): KnowledgeRow | undefined {
  return db.get<KnowledgeRow>(`SELECT ${ITEM_COLUMNS} FROM knowledge WHERE id = ?`, [id]);
}

/** The memory file an old `kn_…` id moved to on 01.11.2026 (one meta row per id, migration 090 for older maps). */
export function movedTo(db: Db, id: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [`memory.old-id.${id}`])?.value;
}

/** `id` and every id linked to it through `supersedes`; [] when missing. */
export function chainIds(db: Db, id: string): string[] {
  if (!getRow(db, id)) return [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length && seen.size < MAX_CHAIN) {
    const current = queue.shift()!;
    const older = db.get<{ supersedes: string | null }>('SELECT supersedes FROM knowledge WHERE id = ?', [current])?.supersedes;
    const newer = db.all<{ id: string }>('SELECT id FROM knowledge WHERE supersedes = ?', [current]).map((row) => row.id);
    for (const next of older ? [older, ...newer] : newer) {
      if (seen.has(next) || !getRow(db, next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

/** The versions of a row, oldest first. */
export function rowHistory(db: Db, start: KnowledgeRow): KnowledgeItem[] {
  const chain: KnowledgeRow[] = [start];
  const seen = new Set([start.id]);
  for (let row = start; row.supersedes && !seen.has(row.supersedes);) {
    const older = getRow(db, row.supersedes);
    if (!older) break;
    seen.add(older.id);
    chain.unshift(older);
    row = older;
  }
  for (let current = start.id; ;) {
    const newer = db.get<KnowledgeRow>(`SELECT ${ITEM_COLUMNS} FROM knowledge WHERE supersedes = ? ORDER BY recorded_at LIMIT 1`, [current]);
    if (!newer || seen.has(newer.id)) break;
    seen.add(newer.id);
    chain.push(newer);
    current = newer.id;
  }
  return chain.map(toItem);
}

/** Deletes rows and any old FTS rows (inside the caller's transaction). */
export function deleteRows(db: Db, ids: readonly string[]): void {
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    const marks = chunk.map(() => '?').join(', ');
    db.run(`DELETE FROM knowledge_fts WHERE knowledge_id IN (${marks})`, chunk);
    db.run(`DELETE FROM knowledge WHERE id IN (${marks})`, chunk);
  }
}

/** A new version of a current row, in one transaction: the old row expires. */
export function correctRow(db: Db, id: string, now: number, build: (previous: KnowledgeItem) => KnowledgeItem): { item: KnowledgeItem; old: KnowledgeItem } {
  return db.tx(() => {
    const row = getRow(db, id);
    if (!row) throw new WorkforceError('not_found', 'Knowledge item not found.');
    if (row.expired_at !== null) throw new WorkforceError('conflict', 'This item was already corrected or expired. Correct the newest version.');
    const previous = toItem(row);
    const item = build(previous);
    db.run('UPDATE knowledge SET expired_at = ? WHERE id = ?', [now, id]);
    insertItem(db, item);
    return { item, old: { ...previous, expiredAt: now } };
  });
}

/** Ends a row; undefined when it had ended already. */
export function expireRow(db: Db, id: string, now: number): KnowledgeItem | undefined {
  const row = getRow(db, id);
  if (!row) throw new WorkforceError('not_found', 'Knowledge item not found.');
  if (row.expired_at !== null) return undefined;
  db.run('UPDATE knowledge SET expired_at = ? WHERE id = ?', [now, id]);
  return { ...toItem(row), expiredAt: now };
}

/** Pins or unpins a row; `changed` false when it was so already. */
export function pinRow(db: Db, id: string, pinned: boolean): { item: KnowledgeItem; changed: boolean } {
  const row = getRow(db, id);
  if (!row) throw new WorkforceError('not_found', 'Knowledge item not found.');
  if (row.expired_at !== null) throw new WorkforceError('conflict', 'This item was already corrected or expired. Pin the newest version.');
  const item = { ...toItem(row), pinned };
  if (Boolean(row.pinned) === pinned) return { item, changed: false };
  db.run('UPDATE knowledge SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
  return { item, changed: true };
}
