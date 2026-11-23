// Migration 109 (KI-Runde 17.11.2026, package S1): engine_sessions gets folded_at and compacted_at, and the context ledger's
// rows move to two characters per token (shared/model/context-ledger.ts CHARS_PER_TOKEN) – rows counted at three are scaled, so
// the chat lines' reach and the room kept for good hold the same text as before the unit changed.
// Owns: checks of that schema step. Never: turn behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';

const ROW = `INSERT INTO context_items (agent_id, conversation_id, item_id, kind, run_id, "order", created_at, tokens, title, state, condensed, pinned_until, origin_engine, origin_model, ref, applied, bytes)
  VALUES ('ag_tom', 'main', ?, 'message', NULL, ?, 0, ?, 'a line', 'keep', NULL, NULL, NULL, NULL, NULL, 'keep', 0)`;

test('109 numbers itself after 108, so no version is left free for a profile to skip', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 108 });
  assert.equal(Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)!.value), 108);
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 109);
  assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }, 'applied once');
});

test('the session keeps when it was folded and when the engine compacted it; the ledger\'s rows are read in the new unit', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 108 });
  db.run(ROW, ['m1', 1, 300]); // 900 characters at the old three per token
  db.run(ROW, ['m2', 2, 1]);
  db.run(`INSERT INTO engine_sessions (agent_id, conversation_id, engine, session_ref, cursor_seq, generation, updated_at) VALUES ('ag_tom', 'main', 'claude', 's1', 0, 1, 1)`);
  migrate(db);

  assert.deepEqual(db.all<{ item_id: string; tokens: number }>('SELECT item_id, tokens FROM context_items ORDER BY "order"').map((row) => ({ ...row })),
    [{ item_id: 'm1', tokens: 450 }, { item_id: 'm2', tokens: 2 }], 'the same 900 characters are 450 tokens at two per token');

  const store = new SessionStore(db);
  const binding = { agentId: 'ag_tom', conversationId: 'main', engine: 'claude' as const, ref: 's1', generation: 1, cursorSeq: 0, updatedAt: 1 };
  assert.deepEqual([store.get('ag_tom', 'main', 'claude')?.foldedAt, store.get('ag_tom', 'main', 'claude')?.compactedAt], [undefined, undefined], 'a row from before carries neither');
  store.compacted('ag_tom', 'main', 'claude', 100);
  store.save({ ...binding, updatedAt: 2 });
  assert.equal(store.get('ag_tom', 'main', 'claude')?.compactedAt, 100, 'a save of the same generation keeps the unanswered compaction');
  store.folded('ag_tom', 'main', 'claude', 200);
  assert.deepEqual([store.get('ag_tom', 'main', 'claude')?.foldedAt, store.get('ag_tom', 'main', 'claude')?.compactedAt], [200, undefined], 'the fold answers it');
  store.unfolded('ag_tom', 'main', 'claude');
  assert.equal(store.get('ag_tom', 'main', 'claude')?.foldedAt, undefined, 'and the mark goes where its rebuild does not run');
  store.compacted('ag_tom', 'main', 'claude', 300);
  store.save({ ...binding, generation: 2, updatedAt: 3 });
  assert.equal(store.get('ag_tom', 'main', 'claude')?.compactedAt, undefined, 'a session that started anew carries no cause');
});
