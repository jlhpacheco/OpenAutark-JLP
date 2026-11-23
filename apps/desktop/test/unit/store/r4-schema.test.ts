// R4 contracts schema: media + media_fts, agents.based_on, bridges (in the baseline since 20.11.2026), the list
// order of the migrations above the baseline (db/migrate.ts: ascending), and that AgentRepo leaves the old based_on and
// budget columns alone.
// Owns: checks of the tables and the minimal agent mapping only (media/bridges behaviour is
// tested by their packages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { BASELINE, migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { memoryDb } from './helpers.ts';

const FILE = 'f'.repeat(64);

function columns(db: Db, table: string): string[] {
  return db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name);
}

function agentRow(extra: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_1', name: 'Writer', role: '', avatar: { kind: 'initials', value: 'WR', color: 0 }, instructions: '', mode: 'general',
    skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 1, updatedAt: 1, ...extra,
  };
}

test('a fresh database has the media, media_fts and bridges tables and agents.based_on (kept, unused)', () => {
  const db = memoryDb();
  assert.ok(SCHEMA_VERSION >= 4, 'R4 tables exist from version 4 on (005 renews sessions)');
  assert.deepEqual(columns(db, 'media'), [
    'file_id', 'conversation_id', 'kind', 'mime', 'name', 'width', 'height', 'duration_ms', 'pages',
    'description', 'tags', 'described_by', 'described_at', 'created_at', 'updated_at',
    'colors', 'peak_db', 'rms_db', 'silent', 'loudness_partial', 'measured_at', // MM5 (migration 031)
    'preview_file_id', 'preview_state', // 17.11.2026 (migration 106): a heavy video's light preview copy
  ]);
  assert.deepEqual(columns(db, 'bridges'), [
    'id', 'kind', 'conversation_id', 'secret_id', 'external_chat_id', 'cursor', 'status', 'error', 'created_at', 'updated_at',
    'owner_user_id', 'owner_name', 'owner_linked_at', // C9 (migration 011)
  ]);
  assert.ok(columns(db, 'agents').includes('based_on'));
  assert.deepEqual(columns(db, 'media_fts'), ['file_id', 'name', 'description', 'tags']);
});

test('migrations apply in ascending list order from the baseline on; the recorded version never goes back', () => {
  const db = new Db(':memory:');
  const recorded = () => Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)?.value ?? 0);
  const steps: number[] = [];
  for (let until = BASELINE; until <= SCHEMA_VERSION; until++) { migrate(db, { until }); steps.push(recorded()); }
  steps.forEach((value, index) => {
    assert.ok(value <= BASELINE + index, `nothing above ${BASELINE + index} applied yet`);
    if (index) assert.ok(value >= steps[index - 1], `the recorded version never goes back (step ${BASELINE + index})`);
  });
  assert.equal(steps[0], BASELINE);
  assert.equal(steps.at(-1), SCHEMA_VERSION);
});

test('media rows reference stored files and are searchable through media_fts', () => {
  const db = memoryDb();
  const insertMedia = () => db.run(
    `INSERT INTO media (file_id, kind, mime, name, tags, created_at, updated_at) VALUES (?, 'image', 'image/png', 'logo.png', '["brand"]', 1, 1)`, [FILE],
  );
  assert.throws(insertMedia, /FOREIGN KEY/); // no file row yet
  db.run(`INSERT INTO files (id, name, mime, size, created_at) VALUES (?, 'logo.png', 'image/png', 3, 1)`, [FILE]);
  insertMedia();
  db.run('INSERT INTO media_fts (file_id, name, description, tags) VALUES (?, ?, ?, ?)', [FILE, 'logo.png', 'Blue company logo', 'brand']);
  const hits = db.all<{ file_id: string }>(`SELECT file_id FROM media_fts WHERE media_fts MATCH 'logo'`);
  assert.deepEqual(hits.map((hit) => hit.file_id), [FILE]);
});

test('bridges belong to a chat and disappear with it', () => {
  const db = memoryDb();
  db.run(`INSERT INTO conversations (id, title, created_by, created_at, updated_at) VALUES ('ch_1', 'Ops', 'human', 1, 1)`);
  db.run(
    `INSERT INTO bridges (id, kind, conversation_id, secret_id, external_chat_id, status, created_at, updated_at)
     VALUES ('br_1', 'telegram', 'ch_1', 'sec_1', '12345', 'connecting', 1, 1)`,
  );
  assert.throws(() => db.run(
    `INSERT INTO bridges (id, kind, conversation_id, secret_id, external_chat_id, status, created_at, updated_at)
     VALUES ('br_2', 'telegram', 'ch_missing', 'sec_1', '12345', 'connecting', 1, 1)`,
  ), /FOREIGN KEY/);
  db.run(`DELETE FROM conversations WHERE id = 'ch_1'`);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bridges')?.n, 0);
});

test('AgentRepo neither reads nor writes the old based_on and budget columns', () => {
  const db = memoryDb();
  const repo = new AgentRepo(db);
  repo.save(agentRow());
  db.run(`UPDATE agents SET based_on = 'ag_origin', budget = '{"monthlyUsd":20}' WHERE id = 'ag_1'`);
  assert.deepEqual(repo.get('ag_1'), agentRow()); // the stored values do not show up on the agent
  repo.save({ ...repo.get('ag_1')!, name: 'Editor', updatedAt: 2 });
  assert.equal(repo.get('ag_1')?.name, 'Editor');
  assert.deepEqual({ ...db.get('SELECT based_on, budget FROM agents WHERE id = ?', ['ag_1'])! }, { based_on: 'ag_origin', budget: '{"monthlyUsd":20}' }); // an update leaves them as they were
  repo.save(agentRow({ id: 'ag_2', name: 'Plain' }));
  assert.deepEqual({ ...db.get('SELECT based_on, budget FROM agents WHERE id = ?', ['ag_2'])! }, { based_on: null, budget: '{}' }); // a new row takes the defaults
});
