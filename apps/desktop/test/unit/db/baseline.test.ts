// The baseline (db/migrations/091-baseline.ts, Quests round 20.11.2026): it is pinned to the schema the old chain
// 001–091 left behind (the fingerprint was proved once against that chain: build/W2RT-baseline-proof.test.ts of the
// round); a new database takes it and every migration above it once; data below 103 (OLDEST_SCHEMA, 0.3.9 with the login
// move of 16.11.) is refused by the start path without a copy, and data below 91 by migrate() too – with the release that
// updates it and where to get it; so is a first start in "Autark" while the old name's folder still holds the data (no
// empty database is made there); the streaming rows' index serves its reads; the
// split tables keep their keys; a failing table rebuild (foreignKeysOff) rolls back and turns foreign keys on again.
// Owns: these checks. Never: the steps above 91 (their own tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { BASELINE, migrate, OLD_CHAIN_RELEASE, OLD_FOLDER, OLDEST_SCHEMA, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { isUpgradeError, listUpgradeBackups, openDatabase, storedSchema, upgradePending } from '../../../src/runtime/db/upgrade.ts';

const T = 1_700_000_000_000;
/** sqlite_master at 91 through the chain 001–091 (67 table rows with the FTS shadow tables, 87 indexes, no trigger). */
const CHAIN_091 = '66ef5bbcf400bc45';

const master = (db: Db) => db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
const fingerprint = (db: Db) => createHash('sha256').update(JSON.stringify(master(db))).digest('hex').slice(0, 16);
const schema = (db: Db) => Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)?.value ?? 0);
const fk = (db: Db) => Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys);

test('the baseline is the schema the chain 001–091 left behind', () => {
  const db = new Db(':memory:');
  assert.deepEqual(migrate(db, { until: BASELINE }), { from: 0, to: SCHEMA_VERSION });
  assert.equal(schema(db), BASELINE);
  assert.equal(fingerprint(db), CHAIN_091, 'a schema change is a new migration above the highest number, never an edit of the baseline');
  assert.deepEqual(db.all<{ key: string }>('SELECT key FROM meta').map((row) => row.key), ['schema'], 'no data rows besides the version');
});

test('a new database takes the baseline and every migration above it, once', () => {
  const db = new Db(':memory:');
  assert.deepEqual(migrate(db), { from: 0, to: SCHEMA_VERSION });
  assert.equal(schema(db), SCHEMA_VERSION);
  assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  const stepwise = new Db(':memory:');
  migrate(stepwise, { until: BASELINE });
  assert.deepEqual(migrate(stepwise), { from: BASELINE, to: SCHEMA_VERSION }, 'a profile at the baseline goes through the rest');
  assert.deepEqual(master(stepwise), master(db));
});

/** The refusal's text for data at `schema`: the release that updates it and where it is. */
const refusal = (at: number) => new RegExp(`This data is from an older Autark \\(schema ${at}\\)\\. Install Autark ${OLD_CHAIN_RELEASE.replace(/\./g, '\\.')} first \\(https://github\\.com/teydra/OpenAutark/releases/tag/v${OLD_CHAIN_RELEASE.replace(/\./g, '\\.')}\\) and start it once`);

test('data below the baseline is refused with the release that updates it; nothing is copied or changed', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-baseline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, 'workforce.db');
  const old = new Db(file);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO meta VALUES ('schema', '55');
            CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO agents VALUES ('ag_1', 'Mira');`);
  const text = refusal(55);
  assert.throws(() => migrate(old), text);
  assert.equal(schema(old), 55);
  old.close();

  assert.equal(upgradePending(file), false, 'no update notice for data this version refuses');
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.3.16' }),
    (error: unknown) => isUpgradeError(error) && error.stage === 'migration_failed' && error.dataSchema === 55 && text.test(error.message));
  assert.deepEqual(listUpgradeBackups(dir), [], 'no pre-update copy');
  const again = new Db(file);
  try {
    assert.equal(storedSchema(again), 55);
    assert.equal(again.get<{ name: string }>(`SELECT name FROM agents WHERE id = 'ag_1'`)?.name, 'Mira');
    assert.equal(again.get(`SELECT 1 AS hit FROM sqlite_master WHERE name = 'conversations'`), undefined, 'not migrated');
  } finally { again.close(); }
});

test('data from before 0.3.9 (below OLDEST_SCHEMA – the login move of 16.11. never ran on it) is refused at the start the same way; from there on it updates', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-oldest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(OLDEST_SCHEMA, 103);
  const file = path.join(dir, 'workforce.db');
  const old = new Db(file);
  migrate(old, { until: OLDEST_SCHEMA - 1 });
  old.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('system', 'version', '"0.3.5"', ?)`, [T]);
  old.close();
  assert.equal(upgradePending(file), false, 'no update notice for data this version refuses');
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.3.16' }),
    (error: unknown) => isUpgradeError(error) && error.stage === 'migration_failed' && error.dataSchema === OLDEST_SCHEMA - 1 && refusal(OLDEST_SCHEMA - 1).test(error.message));
  assert.deepEqual(listUpgradeBackups(dir), [], 'no pre-update copy');
  const kept = new Db(file);
  try { assert.equal(storedSchema(kept), OLDEST_SCHEMA - 1, 'nothing changed'); } finally { kept.close(); }

  const ok = path.join(dir, 'ok.db');
  const at = new Db(ok);
  migrate(at, { until: OLDEST_SCHEMA });
  at.close();
  assert.equal(upgradePending(ok), true, 'data from 0.3.9 on updates');
  const opened = openDatabase({ file: ok, dataDir: dir, version: '0.3.16' });
  try { assert.equal(storedSchema(opened), SCHEMA_VERSION); } finally { opened.close(); }
});

test('a first start in "Autark" while the old name\'s folder still holds the data is refused like old data, without an empty database; a moved one opens', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-unmoved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const data = path.join(dir, 'Autark');
  for (const folder of [data, path.join(dir, OLD_FOLDER), path.join(dir, 'Test profile')]) mkdirSync(folder);
  const old = new Db(path.join(dir, OLD_FOLDER, 'workforce.db'));
  migrate(old, { until: OLDEST_SCHEMA });
  old.close();
  const file = path.join(data, 'workforce.db');
  assert.throws(() => openDatabase({ file, dataDir: data, version: '0.3.16' }),
    (error: unknown) => isUpgradeError(error) && error.stage === 'migration_failed' && error.message.includes(`"${OLD_FOLDER}"`) && error.message.includes(`Install Autark ${OLD_CHAIN_RELEASE} first`));
  assert.equal(existsSync(file), false, 'no empty database where the bridge release moves the folder');
  const other = path.join(dir, 'Test profile');
  openDatabase({ file: path.join(other, 'workforce.db'), dataDir: other, version: '0.3.16' }).close(); // another folder: a fresh start
  const moved = new Db(file);
  migrate(moved, { until: OLDEST_SCHEMA });
  moved.close();
  const opened = openDatabase({ file, dataDir: data, version: '0.3.16' });
  try { assert.equal(storedSchema(opened), SCHEMA_VERSION, 'the folder has data now: it opens'); } finally { opened.close(); }
});

test('the streaming rows\' index serves the live-row and reconcile reads', () => {
  const db = new Db(':memory:');
  migrate(db);
  const plan = (sql: string, params: string[] = []) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((row) => row.detail).join(' | ');
  const live = plan(`SELECT id FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)) AND state = 'streaming' AND author_kind = 'agent' AND run_id IS NOT NULL ORDER BY seq`, ['["c1","c2"]']);
  assert.match(live, /messages_streaming/, live);
  const reconcile = plan(`SELECT * FROM messages WHERE state = 'streaming' AND (run_id IS NULL OR run_id IN (SELECT id FROM runs))`);
  assert.match(reconcile, /messages_streaming/, reconcile);
});

test('the split tables are STRICT, keyed and linked: idx unique per group, a group goes with its agent', () => {
  const db = new Db(':memory:');
  migrate(db);
  db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_ava', 'Ava', '{}', 'human', 0, 0)`);
  db.run(`INSERT INTO split_groups (id, agent_id, parent_run_id, thread, goal, created_at) VALUES ('sg_1', 'ag_ava', 'rn_1', 'cv_1', 'Goal', ?)`, [T]);
  db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('sp_1', 'sg_1', 'ag_ava', 1, 'One', 'Brief', ?)`, [T]);
  const row = db.get<{ after: string; worktree: number; attempts: number; status: string; context: string }>(`SELECT "after", worktree, attempts, status, context FROM splits WHERE id = 'sp_1'`);
  assert.deepEqual({ ...row }, { after: '[]', worktree: 0, attempts: 0, status: 'pending', context: 'fork' });
  assert.throws(() => db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('sp_2', 'sg_1', 'ag_ava', 1, 'Two', 'Brief', ?)`, [T]), /UNIQUE/);
  assert.throws(() => db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('sp_3', 'sg_1', 'ag_ava', 'two', 'Two', 'Brief', ?)`, [T]), /cannot store TEXT value in INTEGER column/, 'STRICT');
  assert.throws(() => db.run(`INSERT INTO split_groups (id, agent_id, parent_run_id, thread, goal, created_at) VALUES ('sg_x', 'ag_none', 'rn_1', 'cv_1', 'Goal', ?)`, [T]), /FOREIGN KEY/);
  db.run(`DELETE FROM agents WHERE id = 'ag_ava'`);
  assert.equal(db.all('SELECT id FROM split_groups').length, 0);
  assert.equal(db.all('SELECT id FROM splits').length, 0);
});

test('a failing table rebuild (foreignKeysOff) rolls back and turns foreign keys on again', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 109 });
  db.exec('DROP TABLE schedules'); // migration 110 reads the schedules: it throws inside its transaction
  assert.equal(fk(db), 1);
  assert.throws(() => migrate(db));
  assert.equal(fk(db), 1);
  assert.equal(schema(db), 109);
  assert.ok(db.all<{ name: string }>(`SELECT name FROM pragma_table_info('tasks')`).some((column) => column.name === 'due_at'), 'rolled back: the old table is still there');
});
