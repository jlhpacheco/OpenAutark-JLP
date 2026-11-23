// Schema migrations: ordered, forward-only, each in its own transaction.
// The list starts at the baseline (91, Quests round 20.11.2026): a new database gets the schema the chain 001–091 left
// behind in one step, then the migrations above it. Data this version updates starts at OLDEST_SCHEMA (103, 0.3.9 of
// 16.11.2026): a version from then on ran the one-time conversions of the 13.11. rebuild (old task states, SYSTEM.md heads)
// and the login move of 16.11. (one plan login per PC), which live in the bridge release, not here. Older data is refused with that release and where to get it (olderData) – it
// updates there first and then here; nothing is touched before that (db/upgrade.ts; migrate() itself refuses only data
// below the baseline, where no step of its list fits).
// An entry is SQL, or a `run(db)` step for one that must read the schema first (110 rebuilds tasks from what it finds).
// `foreignKeysOff` (B-054): a table rebuild runs with foreign keys OFF – the pragma is a no-op inside a transaction, so it
// is set before it – and must leave no new foreign_key_check row.
// Owns: the migration list, the `meta.schema` version, the oldest data this app updates and that runner flag. Never: data
// imports or one-time conversions of rows (bridges, runtime/bridge/*).

import type { Db } from './database.ts';
import { sql as baseline } from './migrations/091-baseline.ts';
import { sql as splitParentSession } from './migrations/092-split-parent-session.ts';
import { sql as taskFiles } from './migrations/093-task-files.ts';
import { sql as taskRouteKeys } from './migrations/094-task-route-keys.ts';
import { sql as accountCredits } from './migrations/095-account-credits.ts';
import { sql as splitTemperature } from './migrations/096-split-temperature.ts';
import { sql as templateEffort } from './migrations/097-template-effort.ts';
import { sql as wakeMailOrigin } from './migrations/098-wake-mail-origin.ts';
import { sql as runMailOrigin } from './migrations/099-run-mail-origin.ts';
import { sql as runUsage } from './migrations/100-run-usage.ts'; // B-089 (11.11.2026: a run's cached tokens and model calls)
import { sql as splitChat } from './migrations/101-split-chat.ts';
import { sql as taskNext } from './migrations/102-task-next.ts';
import { sql as secretUses } from './migrations/103-secret-uses.ts';
import { sql as accountExtraUsage } from './migrations/104-account-extra-usage.ts';
import { sql as accountThisPcOnly } from './migrations/105-account-this-pc-only.ts';
import { sql as mediaPreview } from './migrations/106-media-preview.ts';
import { sql as runCacheWrites } from './migrations/107-run-cache-writes.ts';
import { sql as sessionCostTotal } from './migrations/108-session-cost-total.ts';
import { sql as sessionFold } from './migrations/109-session-fold.ts';
import { run as quests } from './migrations/110-quests.ts';
import { sql as agentsMove } from './migrations/113-agents-move.ts';
import { sql as managedPaths } from './migrations/114-managed-paths.ts';

/**
 * Versions are applied in list order: keep the list in ascending version order and never edit a
 * shipped entry. Only the highest applied version is recorded (`meta.schema`), and a listed version
 * at or below a profile's recorded one is never applied there – so a new migration always takes a
 * number above the highest one used so far (114 now; 111 and 112 stay reserved).
 */
interface Migration {
  version: number;
  name: string;
  sql?: string;
  /** Runs after `sql`, in the same transaction. */
  run?: (db: Db) => void;
  /** Table rebuilds: foreign keys OFF around the transaction (else a DROP cascades), checked before COMMIT. */
  foreignKeysOff?: boolean;
}

/** The baseline's version: the first step of the list (a new database starts here). */
export const BASELINE = 91;
/** The oldest data this app updates (see the header): 103-secret-uses, shipped in 0.3.9 with the login move of 16.11.2026. */
export const OLDEST_SCHEMA = 103;
/** The release that updates data from any older schema (it carries the chain 001–091 and the 13.11. conversions). */
export const OLD_CHAIN_RELEASE = '0.3.14';
/** Where that release is (the releases the updater reads, main/updates/release.ts RELEASE_URL). */
export const OLD_CHAIN_URL = `https://github.com/teydra/OpenAutark/releases/tag/v${OLD_CHAIN_RELEASE}`;

/** Why data below OLDEST_SCHEMA is not updated here, and what updates it. */
export function olderData(schema: number): string {
  return `This data is from an older Autark (schema ${schema}). Install Autark ${OLD_CHAIN_RELEASE} first (${OLD_CHAIN_URL}) and start it once – it updates the data – then this version opens it.`;
}

/** The data folder of the product's old name: 0.3.0 moved it to "Autark" once; the bridge release still moves one that never moved. */
export const OLD_FOLDER = 'Proactive Agent Workforce';

/** Why a data folder that never moved from the old name is not opened here (db/upgrade.ts), and what moves it. */
export function olderFolder(): string {
  return `Your data is still in the folder of the old name "${OLD_FOLDER}". Install Autark ${OLD_CHAIN_RELEASE} first (${OLD_CHAIN_URL}) and start it once – it moves the data – then this version opens it.`;
}

const MIGRATIONS: Migration[] = [
  { version: BASELINE, name: 'baseline', sql: baseline }, // Quests 20.11.2026: the schema of 001–091 in one step (migrations/091-baseline.ts)
  { version: 92, name: 'split-parent-session', sql: splitParentSession }, // B-080: the session a split group's parent turn ended with (splits/fork.ts – the native fork's source)
  { version: 93, name: 'task-files', sql: taskFiles }, // B-080 F5: a task's own files (a quick task's), copied from the per-PC kv namespace
  { version: 94, name: 'task-route-keys', sql: taskRouteKeys }, // B-080: a task's model request is keyed by agent and task, not by chat
  { version: 95, name: 'account-credits', sql: accountCredits }, // B-083: an API key holding a plan's monthly API credits counts as a plan
  { version: 96, name: 'split-temperature', sql: splitTemperature }, // B-083: a part's temperature (Split.temperature)
  { version: 97, name: 'template-effort', sql: templateEffort }, // B-083: the fixed effort a hire copied from its template goes (templates carry none now)
  { version: 98, name: 'wake-mail-origin', sql: wakeMailOrigin },
  { version: 99, name: 'run-mail-origin', sql: runMailOrigin },
  { version: 100, name: 'run-usage', sql: runUsage }, // B-089: runs.cached_tokens (a part of input_tokens) and runs.model_calls
  { version: 101, name: 'split-chat', sql: splitChat }, // 13.11.2026: the chat a split part's work is for (Split.chat)
  { version: 102, name: 'task-next', sql: taskNext }, // 13.11.2026: a task's one planned look (tasks.next_at)
  { version: 103, name: 'secret-uses', sql: secretUses }, // 16.11.2026 F19: how often a secret and a login were used (this PC's count)
  { version: 104, name: 'account-extra-usage', sql: accountExtraUsage }, // 17.11.2026: a plan may continue on the provider's extra usage (off until switched on)
  { version: 105, name: 'account-this-pc-only', sql: accountThisPcOnly }, // 17.11.2026: a plan login that stays on this PC (not synced)
  { version: 106, name: 'media-preview', sql: mediaPreview }, // 17.11.2026: a heavy video's light preview copy (media.preview_file_id / preview_state)
  { version: 107, name: 'run-cache-writes', sql: runCacheWrites }, // KI-Runde 17.11.2026: runs.cache_write_tokens (a part of input_tokens)
  { version: 108, name: 'session-cost-total', sql: sessionCostTotal }, // KI-Runde 17.11.2026: engine_sessions.cost_total (the engine's running total)
  { version: 109, name: 'session-fold', sql: sessionFold }, // KI-Runde 17.11.2026 (package S1): engine_sessions.folded_at / compacted_at, the ledger's sizes at two characters per token
  { version: 110, name: 'quests', run: quests, foreignKeysOff: true }, // Quests 20.11.2026: tasks kind quest|todo, one at/minutes, to-do blocks/briefings/estimates/routines/timers folded in
  { version: 113, name: 'agents-move', sql: agentsMove }, // Umzug 21.11.2026: agents.homes, context_items.pc/changed (the record travels between PCs)
  { version: 114, name: 'managed-paths', sql: managedPaths }, // 0.3.19 masked engine shell: managed_paths (where Autark left a native session, this PC only), catalog_epoch
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** `until` (tests): stop after that version, to build the schema an older app left behind (the baseline at least). */
export function migrate(db: Db, options: { until?: number } = {}): { from: number; to: number } {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`);
  const from = row ? Number(row.value) : 0;
  if (from > SCHEMA_VERSION) {
    throw new Error(`Database schema ${from} is newer than this app (${SCHEMA_VERSION}). Update the app.`);
  }
  if (from > 0 && from < BASELINE) throw new Error(olderData(from));
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    if (options.until !== undefined && migration.version > options.until) break;
    if (migration.foreignKeysOff) withForeignKeysOff(db, () => apply(db, migration));
    else apply(db, migration);
  }
  return { from, to: SCHEMA_VERSION };
}

function apply(db: Db, migration: Migration): void {
  db.tx(() => {
    // A rebuild must not add a dangling reference; ones the profile already had (checked before) do not block it.
    const known = migration.foreignKeysOff ? new Set(violations(db)) : undefined;
    if (migration.sql) db.exec(migration.sql);
    migration.run?.(db);
    if (known) {
      const added = violations(db).filter((row) => !known.has(row));
      if (added.length) throw new Error(`Migration ${migration.version} left ${added.length} broken references (first: ${added[0]}).`);
    }
    db.run(`INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(migration.version)]);
  });
}

/** `PRAGMA foreign_keys` only takes effect outside a transaction: OFF before it, back ON in any case. */
function withForeignKeysOff(db: Db, fn: () => void): void {
  const wasOn = Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys ?? 0) === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  try { fn(); } finally { if (wasOn) db.exec('PRAGMA foreign_keys = ON'); }
}

/** foreign_key_check rows as stable keys (table, rowid, parent, constraint). */
function violations(db: Db): string[] {
  return db.all<{ table: string; rowid: number | null; parent: string; fkid: number }>('PRAGMA foreign_key_check')
    .map((row) => `${row.table}#${row.rowid ?? ''}->${row.parent}/${row.fkid}`);
}
