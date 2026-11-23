// The stored texts of the one search and their meaning (migration vector-chunks, Quests 20.11.2026): one row per text – a piece of
// a file vector.embed added ("<file key>#<n>", with its lines), or a memory note or catalog entry whose meaning was asked for (its
// own key) – holding the text (redacted), a version that changes with it, and its vector of one embedding model as int8 (empty
// until a model embedded it; another model's vector does not count). Writing a text drops its vector. A mirror of keys,
// versions and vectors stays in memory, so a ranking reads no SQL; texts are read from SQL when needed.
// Owns: the SQL of vector_files and vector_chunks, that mirror and the int8 form. Never: reads files, embeds or decides what is stored.

import type { Db } from '../db/database.ts';
import type { StoredText } from '../contracts/vectors.ts';

export interface Held {
  id: number;
  version: number;
  model: string;
  vector?: Int8Array;
}

/** A unit vector as int8 (a score is the dot product over 127). */
export function toInt8(vector: Float32Array): Int8Array {
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return out;
}

/** The cosine of a unit query and a stored int8 vector (0 when their lengths differ: another model). */
export function cosine(query: Float32Array, stored: Int8Array): number {
  if (query.length !== stored.length) return 0;
  let dot = 0;
  for (let i = 0; i < query.length; i++) dot += query[i] * stored[i];
  return dot / 127;
}

/** `place` itself, what lies below it as a folder, and its pieces ("<place>#<n>"). */
export const isUnder = (key: string, place: string): boolean =>
  key === place || key.startsWith(`${place}/`) || (key.startsWith(`${place}#`) && /^\d+$/.test(key.slice(place.length + 1)));

const EMPTY = new Uint8Array(0);

export class VectorStore {
  private readonly db: Db;
  private readonly now: () => number;
  private mirror?: Map<string, Held>;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  get(key: string): Held | undefined {
    return this.held().get(key);
  }

  keys(): string[] {
    return [...this.held().keys()];
  }

  /** The keys at or below `place` (a folder, a file and its pieces). */
  keysUnder(place: string): string[] {
    return [...this.held().keys()].filter((key) => isUnder(key, place));
  }

  /** Writes texts; a text that was there gets the new one and loses its vector. */
  put(rows: readonly StoredText[]): void {
    const held = this.held();
    this.db.tx(() => {
      for (const row of rows) {
        this.db.run(
          `INSERT INTO vector_files (key, path, mtime, size, model, chunks, done, embedded_at) VALUES (?, ?, ?, ?, '', 1, 0, ?)
           ON CONFLICT(key) DO UPDATE SET path = excluded.path, mtime = excluded.mtime, size = excluded.size, model = '', done = 0, embedded_at = excluded.embedded_at`,
          [row.key, row.path, row.version, row.text.length, this.now()],
        );
        const id = (this.db.get<{ id: number }>('SELECT id FROM vector_files WHERE key = ?', [row.key]) as { id: number }).id;
        this.db.run('DELETE FROM vector_chunks WHERE file_id = ?', [id]);
        this.db.run('INSERT INTO vector_chunks (file_id, chunk, line_from, line_to, vector, snippet) VALUES (?, 0, ?, ?, ?, ?)',
          [id, row.lines?.[0] ?? null, row.lines?.[1] ?? null, EMPTY, row.text]);
        held.set(row.key, { id, version: row.version, model: '' });
      }
    });
  }

  /** The stored text of `key`. */
  text(key: string): StoredText | undefined {
    const row = this.db.get<{ key: string; path: string; mtime: number; line_from: number | null; line_to: number | null; snippet: string }>(
      'SELECT f.key, f.path, f.mtime, c.line_from, c.line_to, c.snippet FROM vector_files f JOIN vector_chunks c ON c.file_id = f.id AND c.chunk = 0 WHERE f.key = ?', [key]);
    if (!row) return undefined;
    return { key: row.key, path: row.path, version: row.mtime, text: row.snippet, ...(row.line_from !== null && row.line_to !== null ? { lines: [row.line_from, row.line_to] as [number, number] } : {}) };
  }

  /** The vector of `model` for the text of `key` – only while the row still holds `version`. */
  setVector(key: string, version: number, model: string, vector: Int8Array): boolean {
    const held = this.held().get(key);
    if (!held || held.version !== version) return false;
    this.db.tx(() => {
      this.db.run('UPDATE vector_chunks SET vector = ? WHERE file_id = ? AND chunk = 0', [new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), held.id]);
      this.db.run('UPDATE vector_files SET model = ?, done = 1, embedded_at = ? WHERE id = ?', [model, this.now(), held.id]);
    });
    held.model = model;
    held.vector = vector;
    return true;
  }

  /** `place`, everything below it and its pieces go. */
  removeUnder(place: string): void {
    const keys = this.keysUnder(place);
    if (!keys.length) return;
    this.db.tx(() => { for (const key of keys) this.db.run('DELETE FROM vector_files WHERE key = ?', [key]); });
    for (const key of keys) this.mirror?.delete(key);
  }

  private held(): Map<string, Held> {
    if (this.mirror) return this.mirror;
    const rows = this.db.all<{ id: number; key: string; mtime: number; model: string; vector: Uint8Array | null }>(
      'SELECT f.id, f.key, f.mtime, f.model, c.vector FROM vector_files f LEFT JOIN vector_chunks c ON c.file_id = f.id AND c.chunk = 0');
    this.mirror = new Map(rows.map((row) => [row.key, {
      id: row.id, version: row.mtime, model: row.model,
      ...(row.vector?.length ? { vector: new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength).slice() } : {}),
    }]));
    return this.mirror;
  }
}
