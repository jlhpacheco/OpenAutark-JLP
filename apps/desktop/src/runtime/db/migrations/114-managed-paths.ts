// Migration 114 (0.3.19, the masked engine shell): where a native Claude/Codex session stood when Autark last wrote it.
// - `managed_paths`: one row per engine session this PC's runtime opened or wrote (turn, fork, revert, rebuild, fold
//   follow-up). `state` 'pending' while a turn of it may still be running, 'ready' once Autark measured the native
//   transcript at the end of its own write: its exact size and the SHA-256 of its tail, with the masker version and the
//   engine's CLI version it was written under. After a restart a session resumes natively only when the transcript is
//   still exactly that (engines/managed-path.ts); anything else is rebuilt from the filtered Autark history. The row is
//   this PC's own: the device sync never carries it (devices/sync/tables.ts lists no such table) and `device_id` keeps a
//   restored copy on another PC from trusting it.
// - `catalog_epoch`: a counter raised on each new or changed secret (two triggers on `secrets`), stored with each row so a
//   later check can tell a transcript written before a value entered the catalog. Stored only for now – not evaluated.
// Owns: the two tables and the two triggers. Never: says a transcript holds no secret – only that Autark wrote it last.
export const sql = `CREATE TABLE managed_paths (
  engine TEXT NOT NULL, account_id TEXT NOT NULL, session_ref TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, masker_version INTEGER NOT NULL, cli_version TEXT, transcript TEXT, transcript_bytes INTEGER,
  tail_sha256 TEXT, catalog_epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (engine, account_id, session_ref)
) STRICT;
CREATE INDEX managed_paths_updated ON managed_paths(updated_at);
CREATE TABLE catalog_epoch (n INTEGER NOT NULL) STRICT;
INSERT INTO catalog_epoch (n) VALUES (0);
CREATE TRIGGER catalog_epoch_insert AFTER INSERT ON secrets BEGIN
  UPDATE catalog_epoch SET n = n + 1;
END;
CREATE TRIGGER catalog_epoch_update AFTER UPDATE OF cipher ON secrets WHEN NEW.cipher IS NOT OLD.cipher BEGIN
  UPDATE catalog_epoch SET n = n + 1;
END;`;
