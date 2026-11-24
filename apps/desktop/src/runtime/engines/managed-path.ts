// The persistent mark of a native Claude/Codex session (0.3.19, the masked engine shell; table managed_paths, migration 114):
// where Autark left the session's native transcript when its own write of it ended – a turn, a fork's first turn, a revert,
// a rebuild. A row is 'pending' from the start of such a write until its end and 'ready' once the transcript was measured
// after the write: its exact size in bytes and the SHA-256 of its last TAIL_BYTES (read twice apart until the size holds
// still – the engine may still be flushing; never the file's mtime). With it go the masker version Autark ran the session's
// shell under, the engine's CLI version, this PC's device id and the catalog epoch (stored only, not evaluated yet).
// After a restart a session resumes natively only when its row is 'ready', from this PC, written under a verified masker
// and CLI version (verifiedCli), and the transcript is exactly as measured; anything else – a missing row, 'pending', a
// transcript that grew or changed, an unknown version – is cold: the session starts anew from the filtered Autark history.
// A wrong answer here may only ever mean cold. The mark is no promise that a transcript holds no secret – only that Autark
// was the last to write it, under its managed shell.
// Owns: the rows, the measuring, the verified version lists. Never: reads a transcript's content beyond its tail's hash,
// decides how a session is rebuilt, or travels to another PC (devices/sync never carries the table).

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { Db } from '../db/database.ts';

/** Raised when the shell masking changes in a way that makes older transcripts untrusted (then MASKERS_VERIFIED drops the old one). */
export const MASKER_VERSION = 1;
const MASKERS_VERIFIED: readonly number[] = [1];
/** Claude Code from 2.1.303 on takes `--tools` as an allowlist: a session run under it never had the native Bash/PowerShell tool. */
const CLAUDE_FROM = [2, 1, 303] as const;
/**
 * Codex turns its shells off feature by feature (a denylist): only versions checked against that list are verified – exact
 * versions, never a range, and an entry only after its live control is green (it counts for marks already written under it).
 * Each entry with its control (github.com/teydra/proactive-agent-runtime, isolated Windows runner, official npm package by its
 * integrity, local Responses fixture, synthetic values): no native shell offered at start, resume, fork and after a restart,
 * the managed tool's output masked, the seal still matching after the app-server exited, resume on the same rollout.
 */
const CODEX_VERIFIED: readonly string[] = [
  '0.167.0-alpha.3.2', // runs 44901554743 (0.3.16 + draft) and 45290886874 (this mark, 57eee74)
  '0.171.0-alpha.13', // run 45290886874 (57eee74)
  '0.171.0', // run 45290886874 (57eee74); npm's latest until 24.11.2026
  '0.172.0', // run 45303741097 (7bf2422), the version watch's first control; npm's latest since 24.11.2026, what the CLI update installs
];
const TAIL_BYTES = 64 * 1024;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export type ManagedEngine = 'claude' | 'codex';
export interface ManagedKey { engine: string; account: string; ref: string }
export interface Measured { bytes: number; tail: string }
interface Row { state: string; device_id: string; masker_version: number; cli_version: string | null; transcript: string | null; transcript_bytes: number | null; tail_sha256: string | null }

/** Whether a session written under `cli` (the engine's CLI version) is on the verified list. */
export function verifiedCli(engine: string, cli: string | null | undefined): boolean {
  if (!cli) return false;
  if (engine === 'codex') return CODEX_VERIFIED.includes(cli);
  if (engine !== 'claude') return false;
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(cli)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== CLAUDE_FROM[i]) return parts[i] > CLAUDE_FROM[i];
  return true;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One read of the file's size and tail hash, with the size taken again after the read (undefined: missing or moving). */
async function measureOnce(file: string): Promise<Measured | undefined | 'moving'> {
  let handle;
  try { handle = await fsp.open(file, 'r'); } catch { return undefined; }
  try {
    const bytes = (await handle.stat()).size;
    const start = Math.max(0, bytes - TAIL_BYTES);
    const buffer = Buffer.alloc(bytes - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== buffer.length || (await handle.stat()).size !== bytes) return 'moving';
    return { bytes, tail: createHash('sha256').update(buffer).digest('hex') };
  } finally { await handle.close(); }
}

/** The transcript as it stands; with `settleMs` it is read until two reads that far apart agree (an engine still flushing). */
export async function measure(file: string, settleMs = 0, tries = 5): Promise<Measured | undefined> {
  let last: Measured | undefined;
  for (let i = 0; i < tries; i++) {
    const now = await measureOnce(file);
    if (now === undefined) return undefined;
    if (now !== 'moving') {
      if (!settleMs || (last && last.bytes === now.bytes && last.tail === now.tail)) return now;
      last = now;
    } else last = undefined;
    await wait(settleMs || 25 * (i + 1));
  }
  return undefined;
}

export class ManagedPathStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly device: () => string;

  constructor(deps: { db: Db; now?: () => number; device?: () => string }) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.device = deps.device ?? (() => '');
    try { this.db.run('DELETE FROM managed_paths WHERE updated_at < ?', [this.now() - KEEP_MS]); } catch { /* older schema in a test */ }
  }

  private epoch(): number {
    return this.db.get<{ n: number }>('SELECT n FROM catalog_epoch')?.n ?? 0;
  }

  private write(key: ManagedKey, state: 'pending' | 'ready', at: { transcript?: string; cli?: string; measured?: Measured }): void {
    this.db.run(`INSERT INTO managed_paths (engine, account_id, session_ref, device_id, state, masker_version, cli_version, transcript, transcript_bytes, tail_sha256, catalog_epoch, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (engine, account_id, session_ref) DO UPDATE SET device_id = excluded.device_id, state = excluded.state,
        masker_version = excluded.masker_version, cli_version = excluded.cli_version, transcript = excluded.transcript,
        transcript_bytes = excluded.transcript_bytes, tail_sha256 = excluded.tail_sha256, catalog_epoch = excluded.catalog_epoch, updated_at = excluded.updated_at`,
    [key.engine, key.account, key.ref, this.device(), state, MASKER_VERSION, at.cli ?? null, at.transcript ?? null, at.measured?.bytes ?? null, at.measured?.tail ?? null, this.epoch(), this.now()]);
  }

  /** An own write of the session starts (or one whose end could not be measured): it stays cold until a seal. */
  pending(key: ManagedKey, transcript?: string): void {
    this.write(key, 'pending', { transcript });
  }

  /** An own write ended: the transcript as measured right after it, under this CLI version. */
  seal(key: ManagedKey, transcript: string, measured: Measured, cli: string | undefined): void {
    this.write(key, 'ready', { transcript, cli, measured });
  }

  /** The transcript path the row knows (a Codex rollout found once is not searched again). */
  transcript(key: ManagedKey): string | undefined {
    return this.row(key)?.transcript ?? undefined;
  }

  remove(key: ManagedKey): void {
    this.db.run('DELETE FROM managed_paths WHERE engine = ? AND account_id = ? AND session_ref = ?', [key.engine, key.account, key.ref]);
  }

  private row(key: ManagedKey): Row | undefined {
    return this.db.get<Row>('SELECT state, device_id, masker_version, cli_version, transcript, transcript_bytes, tail_sha256 FROM managed_paths WHERE engine = ? AND account_id = ? AND session_ref = ?', [key.engine, key.account, key.ref]);
  }

  /**
   * Warm only when every check holds: a 'ready' row of this PC, a verified masker and CLI version, the transcript the engine
   * finds for the ref now (`located`) is the one measured, and it is exactly as measured. Anything else – cold.
   */
  async warm(key: ManagedKey, located: string | undefined): Promise<boolean> {
    const row = this.row(key);
    if (!row || row.state !== 'ready' || row.device_id !== this.device()) return false;
    if (!MASKERS_VERIFIED.includes(row.masker_version) || !verifiedCli(key.engine, row.cli_version)) return false;
    if (!row.transcript || row.transcript !== located || row.transcript_bytes === null || !row.tail_sha256) return false;
    const now = await measure(row.transcript);
    return now !== undefined && now.bytes === row.transcript_bytes && now.tail === row.tail_sha256;
  }
}
