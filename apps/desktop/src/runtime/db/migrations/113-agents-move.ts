// Migration 113 (Umzug 21.11.2026, owner: an agent moves between the person's PCs, goes on where it is when its PC is
// gone, and two records that drifted apart come together again):
// - `agents.homes`: JSON list of the PC ids the agent is at home on besides the one it runs on (owner 21.11.2026: "dann
//   ist sie praktisch auf beiden PCs zu Hause"). Only among these does it go on by itself when its PC cannot be reached;
//   '[]' (default) – it waits for its PC. The agent sets it itself (agents.update homes). Travels with the agents row.
// - `context_items.pc`: the PC that wrote the row (NULL = this PC). A row that came from a linked PC keeps that PC's id
//   (devices/sync/ledger.ts), so two PCs that both went on with the same agent can tell their own rows apart, and a
//   restore knows where a hidden original lies.
// - `context_items.changed`: a number this PC raises on every insert and update of a row (two triggers), the one cursor
//   of the record's sync between PCs (what changed since the last link-up). It comes from the one-row table
//   `context_seq`, never from the rows themselves: deleting the newest rows (a removed chat, a settled branch) must not
//   let a later change take a number a peer's cursor has already passed (review R1 H1). Rows of before get 0.
// 111 and 112 stay reserved (migrate.ts).
// Owns: the three columns, the counter table, the index and the two triggers. Never: moves or rewrites a row's content.
export const sql = `ALTER TABLE agents ADD COLUMN homes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE context_items ADD COLUMN pc TEXT;
ALTER TABLE context_items ADD COLUMN changed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX context_items_changed ON context_items(changed);
CREATE TABLE context_seq (n INTEGER NOT NULL) STRICT;
INSERT INTO context_seq (n) VALUES (0);
CREATE TRIGGER context_items_changed_insert AFTER INSERT ON context_items BEGIN
  UPDATE context_seq SET n = n + 1;
  UPDATE context_items SET changed = (SELECT n FROM context_seq)
  WHERE agent_id = NEW.agent_id AND conversation_id = NEW.conversation_id AND item_id = NEW.item_id;
END;
CREATE TRIGGER context_items_changed_update AFTER UPDATE ON context_items WHEN NEW.changed = OLD.changed BEGIN
  UPDATE context_seq SET n = n + 1;
  UPDATE context_items SET changed = (SELECT n FROM context_seq)
  WHERE agent_id = NEW.agent_id AND conversation_id = NEW.conversation_id AND item_id = NEW.item_id;
END;`;
