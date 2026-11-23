// Migration 91, the baseline (Quests round 20.11.2026): the schema a new install had after the chain 001–091 of
// 0.3.2 … 0.3.15 – every table, index and FTS5 table, in sqlite_master's own words (FTS5 makes its shadow tables
// itself). test/unit/db/baseline.test.ts pins it. Data below db/migrate.ts OLDEST_SCHEMA is not updated here (olderData).
// Never edited: a schema change is a new migration above the highest number.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;
CREATE TABLE spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, color TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, archived_at INTEGER
) STRICT;
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id), manager_id TEXT REFERENCES agents(id), team TEXT,
  instructions TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'general', skills TEXT NOT NULL DEFAULT '[]',
  model_policy TEXT NOT NULL DEFAULT '{}', permissions TEXT NOT NULL DEFAULT '{}', budget TEXT NOT NULL DEFAULT '{}',
  device_id TEXT, status TEXT NOT NULL DEFAULT 'idle', status_note TEXT, template TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
, based_on TEXT, voice TEXT, variant TEXT, person_manager_id TEXT) STRICT;
CREATE INDEX agents_manager ON agents(manager_id);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, title_named INTEGER NOT NULL DEFAULT 0, space_id TEXT,
  created_by TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}',
  last_message_at INTEGER, last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
) STRICT;
CREATE INDEX conversations_recent ON conversations(archived_at, pinned, last_message_at);
CREATE TABLE members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  read_seq INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, left_at INTEGER,
  PRIMARY KEY (conversation_id, member_id)
) STRICT;
CREATE INDEX members_member ON members(member_id, left_at);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, author_id TEXT NOT NULL, author_kind TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'normal', reply_to TEXT, run_id TEXT, task_id TEXT,
  state TEXT NOT NULL DEFAULT 'final', silent INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}',
  client_id TEXT, created_at INTEGER NOT NULL, edited_at INTEGER,
  UNIQUE (conversation_id, seq)
) STRICT;
CREATE UNIQUE INDEX messages_client ON messages(conversation_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX messages_task ON messages(task_id) WHERE task_id IS NOT NULL;
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE drafts (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
, secret_ids TEXT NOT NULL DEFAULT '[]') STRICT;
CREATE VIRTUAL TABLE tasks_fts USING fts5(task_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, kind TEXT NOT NULL,
  title TEXT NOT NULL, spec TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', next_at INTEGER, last_at INTEGER,
  runs INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, lease TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX schedules_due ON schedules(active, next_at);
CREATE TABLE wakes (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, reason TEXT NOT NULL,
  note TEXT, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
, source TEXT, source_label TEXT) STRICT;
CREATE INDEX wakes_due ON wakes(claimed_at, due_at);
CREATE INDEX wakes_agent ON wakes(agent_id);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, trigger TEXT NOT NULL,
  engine TEXT, model TEXT, effort TEXT, account_id TEXT, device_id TEXT, status TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
  error TEXT, summary TEXT, route TEXT
, cost_basis TEXT, notional_usd REAL, source TEXT, source_label TEXT, split_id TEXT) STRICT;
CREATE INDEX runs_agent ON runs(agent_id, started_at);
CREATE INDEX runs_status ON runs(status);
CREATE TABLE run_items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, name TEXT, data TEXT NOT NULL, effect_status TEXT, idem_key TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX run_items_run ON run_items(run_id, seq);
CREATE UNIQUE INDEX run_items_idem ON run_items(idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE engine_sessions (
  agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, engine TEXT NOT NULL, account_id TEXT,
  session_ref TEXT NOT NULL, cursor_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER, model TEXT, updated_at INTEGER NOT NULL, context_window INTEGER, prompt_key TEXT, mode TEXT,
  PRIMARY KEY (agent_id, conversation_id, engine)
) STRICT;
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.7, pinned INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER, valid_to INTEGER, recorded_at INTEGER NOT NULL, expired_at INTEGER, supersedes TEXT,
  created_by TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  embedding BLOB, embedding_profile TEXT
) STRICT;
CREATE INDEX knowledge_scope ON knowledge(scope, scope_id, expired_at);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, auth TEXT NOT NULL, home TEXT, base_url TEXT,
  secret_id TEXT, state TEXT NOT NULL DEFAULT 'unknown', plan TEXT, email TEXT, limits TEXT, cooling_until INTEGER,
  priority INTEGER NOT NULL DEFAULT 0, rotation INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  detected INTEGER NOT NULL DEFAULT 0, device_id TEXT, created_at INTEGER NOT NULL, checked_at INTEGER
, env_var TEXT) STRICT;
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL,
  efforts TEXT NOT NULL DEFAULT '[]', default_effort TEXT, caps TEXT NOT NULL DEFAULT '{}', scores TEXT,
  tier TEXT NOT NULL DEFAULT 'strong', strengths TEXT NOT NULL DEFAULT '{}', accounts TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE spend (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL,
  ref TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX spend_agent ON spend(agent_id, created_at);
CREATE TABLE secrets (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, cipher BLOB, hint TEXT, agents TEXT NOT NULL DEFAULT '[]',
  domains TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used_at INTEGER
, group_id TEXT REFERENCES secret_groups(id) ON DELETE CASCADE, field TEXT, created_by TEXT, path TEXT NOT NULL DEFAULT '/', description TEXT NOT NULL DEFAULT '', conversation_id TEXT, source TEXT, route TEXT, tags TEXT NOT NULL DEFAULT '[]') STRICT;
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, fingerprint TEXT NOT NULL,
  public_key TEXT, addresses TEXT NOT NULL DEFAULT '[]', caps TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'offline',
  self INTEGER NOT NULL DEFAULT 0, paired_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER
, allow TEXT NOT NULL DEFAULT '{}') STRICT;
CREATE TABLE tokens (
  id TEXT PRIMARY KEY, device_id TEXT, kind TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
  name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
) STRICT;
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY, device_id TEXT, endpoint TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
  text_preview TEXT, width INTEGER, height INTEGER, duration_ms INTEGER, refs INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE feedback (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, screenshot_file_id TEXT,
  annotation_file_id TEXT, context TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, url TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER
) STRICT;
CREATE TABLE media (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  conversation_id TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL,
  width INTEGER, height INTEGER, duration_ms INTEGER, pages INTEGER,
  description TEXT, tags TEXT, described_by TEXT, described_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
, colors TEXT, peak_db REAL, rms_db REAL, silent INTEGER, loudness_partial INTEGER, measured_at INTEGER) STRICT;
CREATE INDEX media_conversation ON media(conversation_id, created_at);
CREATE INDEX media_kind ON media(kind, created_at);
CREATE VIRTUAL TABLE media_fts USING fts5(file_id UNINDEXED, name, description, tags, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE bridges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL, external_chat_id TEXT NOT NULL, cursor TEXT,
  status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
, owner_user_id TEXT, owner_name TEXT, owner_linked_at INTEGER) STRICT;
CREATE INDEX bridges_conversation ON bridges(conversation_id);
CREATE INDEX messages_files ON messages(conversation_id, attachments) WHERE attachments <> '[]';
CREATE TABLE secret_groups (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, description TEXT,
  agents TEXT NOT NULL DEFAULT '[]', domains TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used_at INTEGER,
  created_by TEXT
, source TEXT, route TEXT, tags TEXT NOT NULL DEFAULT '[]') STRICT;
CREATE UNIQUE INDEX secrets_group_field ON secrets(group_id, field) WHERE group_id IS NOT NULL;
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '{}',
  manager_id TEXT,
  scopes TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  joined_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX people_manager ON people(manager_id);
CREATE TABLE people_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX people_audit_person ON people_audit(person_id, at);
CREATE TABLE team_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE person_uploads (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, file_id, conversation_id)
) STRICT;
CREATE INDEX person_uploads_recent ON person_uploads(person_id, created_at);
CREATE INDEX person_uploads_file ON person_uploads(file_id);
CREATE TABLE chat_notes (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT,
  notes TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  source_id TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  etag TEXT,
  set_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned',
  read_only INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX calendar_events_owner_start ON calendar_events(owner_id, start_at);
CREATE INDEX calendar_events_task ON calendar_events(task_id);
CREATE UNIQUE INDEX calendar_events_external ON calendar_events(source_id, external_id);
CREATE TABLE calendar_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  writable INTEGER NOT NULL DEFAULT 0,
  secret_id TEXT,
  write_calendar_id TEXT,
  sync_token TEXT,
  pc_device_id TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX calendar_sources_owner ON calendar_sources(owner_id);
CREATE TABLE task_estimates (
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  category TEXT,
  minutes INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  person_set INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key_hash)
) STRICT;
CREATE TABLE day_briefings (
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, date)
) STRICT;
CREATE TABLE "tasks" (
  id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT, parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  assignee_kind TEXT NOT NULL DEFAULT 'team', assignee_id TEXT, created_by TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, due_at INTEGER, depends_on TEXT NOT NULL DEFAULT '[]',
  goal TEXT, done_when TEXT, mode TEXT, widget TEXT, human_reason TEXT, waiting_on TEXT, result TEXT,
  ledger TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0, client_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
  assigned_by TEXT,
  estimate_min INTEGER, estimate_source TEXT, spent_ms INTEGER, timer_started_at INTEGER, "window" TEXT, prep TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  space_id TEXT, source TEXT, source_label TEXT
) STRICT;
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX tasks_board ON tasks(status, assignee_kind, due_at);
CREATE INDEX tasks_conversation ON tasks(conversation_id, parent_id);
CREATE INDEX runs_task ON runs(task_id, started_at);
CREATE INDEX runs_source ON runs(agent_id, source, started_at);
CREATE TABLE split_groups (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, source TEXT, source_label TEXT, thread TEXT NOT NULL,
  mode_key TEXT, cwd TEXT, goal TEXT NOT NULL, ultra INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, gathered_at INTEGER
) STRICT;
CREATE INDEX split_groups_agent ON split_groups(agent_id, created_at);
CREATE INDEX split_groups_parent ON split_groups(parent_run_id);
CREATE INDEX split_groups_thread ON split_groups(agent_id, thread, status);
CREATE TABLE splits (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, returns TEXT,
  context TEXT NOT NULL DEFAULT 'fork', model TEXT, effort TEXT, "after" TEXT NOT NULL DEFAULT '[]', worktree INTEGER NOT NULL DEFAULT 0,
  fork TEXT, branch TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, UNIQUE (group_id, idx)
) STRICT;
CREATE INDEX splits_agent_status ON splits(agent_id, status);
CREATE INDEX runs_split ON runs(split_id) WHERE split_id IS NOT NULL;
CREATE TABLE vector_files (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  model TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  done INTEGER NOT NULL,
  embedded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX vector_files_model ON vector_files(model, embedded_at);
CREATE TABLE vector_chunks (
  rowid INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES vector_files(id) ON DELETE CASCADE,
  chunk INTEGER NOT NULL,
  line_from INTEGER,
  line_to INTEGER,
  vector BLOB NOT NULL,
  snippet TEXT NOT NULL,
  UNIQUE (file_id, chunk)
) STRICT;
CREATE TABLE context_items (
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  "order" INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'keep',
  condensed TEXT,
  pinned_until INTEGER,
  origin_engine TEXT,
  origin_model TEXT,
  ref TEXT,
  applied TEXT NOT NULL DEFAULT 'keep',
  marked_by TEXT,
  mark_reason TEXT,
  marked_at INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  pruned_at INTEGER
) STRICT;
CREATE UNIQUE INDEX context_items_id ON context_items(agent_id, conversation_id, item_id);
CREATE UNIQUE INDEX context_items_order ON context_items(agent_id, conversation_id, "order");
CREATE INDEX context_items_ref ON context_items(agent_id, conversation_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX context_items_chat ON context_items(conversation_id);
CREATE INDEX messages_streaming ON messages(conversation_id) WHERE state = 'streaming';
`;
