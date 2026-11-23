// Test helpers for the managed-shell trust (0.3.19, engines/managed-session.ts, engines/managed-path.ts): a mark store on a
// migrated in-memory database, a temporary CODEX_HOME / Claude transcript with synthetic content, and the precondition of a
// resume test that this engine instance opened the session itself earlier. Never: a real key or a real transcript.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManagedPathStore } from '../../../src/runtime/engines/managed-path.ts';
import { rememberManaged } from '../../../src/runtime/engines/managed-session.ts';

/** A Codex version on the verified list (managed-path.ts CODEX_VERIFIED) and how its app-server names itself. */
export const VERIFIED_CODEX = '0.167.0-alpha.3.2';
export const VERIFIED_CODEX_AGENT = `codex_cli_rs/${VERIFIED_CODEX} (Windows 11; x86_64) fake`;

export function managedStore(device = 'dev_self', now?: () => number): { db: Db; store: ManagedPathStore } {
  const db = new Db(':memory:');
  migrate(db);
  return { db, store: new ManagedPathStore({ db, device: () => device, ...(now ? { now } : {}) }) };
}

/** A CODEX_HOME whose sessions folder holds one rollout per thread id (as Codex names them). */
export function codexHome(threads: string[]): { dir: string; file: (id: string) => string; append: (id: string, line: string) => void; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  const day = path.join(dir, 'sessions', '2026', '11', '23');
  mkdirSync(day, { recursive: true });
  const file = (id: string) => path.join(day, `rollout-2026-11-23T10-00-00-${id}.jsonl`);
  for (const id of threads) writeFileSync(file(id), `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
  return { dir, file, append: (id, line) => appendFileSync(file(id), `${line}\n`), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The precondition of a resume test: this engine instance opened `ref` itself before (an earlier turn of the same runtime). */
export function openedBefore(engine: { id: string }, ref: string, account = 'acc_test'): void {
  rememberManaged(engine, account, ref);
}
