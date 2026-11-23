// What a PC that goes on with an agent needs besides its record (Umzug part 2, review R3 M1): a fingerprint of the
// agent's state as the sync between my PCs already keeps it on each of them –
// - its chats: per chat it is a member of, the number of messages, the newest written and edited time and how many are
//   not final (rows of sync.rows; a message's seq is each PC's own and stays out);
// - its tasks: those given to it or made by it – id, status, title, the size of notes and result, when completed;
// - its files: what the file sync's manifest (kv 'sync.files') holds under agents/<id>/ and memory/ – path and sha256
//   (a removal, sha '', stays out: a PC that never had the file holds no entry).
// The PC an agent runs on sends it with "settled"; the PC that would go on compares it with its own at that moment
// (home.ts settledHere), so rows or files still on their way – either way – keep the agent waiting for its PC.
// Not in it: the record itself (the acknowledged `head`, ledger-settled.ts), a chat's own fields, knowledge rows,
// schedules, settings, secrets and logins, workspace skills, stored files' bytes, the home project and browser
// sign-ins (share.ts).
// Owns: this fingerprint and, on the sending side, when it is worked out again. Never: writes, or reads a message's or
// a file's content.

import { createHash } from 'node:crypto';
import type { RuntimeServices } from '../../contracts.ts';

type Db = RuntimeServices['db'];
const FILES_NS = 'sync.files';

/** The manifest ranges of `agentId`: its own folder and the memory. */
const ranges = (agentId: string): string[] => [`agents/${agentId}/`, `agents/${agentId}0`, 'memory/', 'memory0'];
const IN_RANGES = '((key >= ? AND key < ?) OR (key >= ? AND key < ?))';

/** The fingerprint of `agentId`'s chats, tasks and files on this PC. */
export function standing(db: Db, agentId: string): string {
  const chats = db.all(
    `SELECT m.conversation_id AS c, COUNT(x.id) AS n, MAX(x.created_at) AS a, MAX(x.edited_at) AS e, SUM(x.state <> 'final') AS o
       FROM members m LEFT JOIN messages x ON x.conversation_id = m.conversation_id
      WHERE m.member_id = ? AND m.left_at IS NULL GROUP BY m.conversation_id ORDER BY m.conversation_id`, [agentId]);
  const tasks = db.all(
    `SELECT id, status, title, length(notes) AS n, length(coalesce(result, '')) AS r, completed_at AS d
       FROM tasks WHERE assignee_id = ? OR created_by = ? ORDER BY id`, [agentId, agentId]);
  const files = db.all(
    `SELECT key, json_extract(value, '$.sha') AS sha FROM kv WHERE ns = ? AND ${IN_RANGES} AND json_extract(value, '$.sha') <> '' ORDER BY key`,
    [FILES_NS, ...ranges(agentId)]);
  return createHash('sha1').update(JSON.stringify([chats.map((row) => Object.values(row)), tasks.map((row) => Object.values(row)), files.map((row) => Object.values(row))])).digest('hex');
}

/** When the manifest under `agentId`'s folders last changed, as one cheap value. */
function filesMark(db: Db, agentId: string): string {
  const row = db.get<{ n: number; u: number | null }>(`SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM kv WHERE ns = ? AND ${IN_RANGES}`, [FILES_NS, ...ranges(agentId)]);
  return `${row?.n ?? 0}/${row?.u ?? 0}`;
}

/** The sending side: each agent's fingerprint, worked out again only after one of its chats, a task or its files changed. */
export class Standing {
  private readonly s: Pick<RuntimeServices, 'db' | 'bus'>;
  private readonly kept = new Map<string, { state: string; files: string; chats: Set<string> }>();
  private listening = false;

  constructor(s: Pick<RuntimeServices, 'db' | 'bus'>) { this.s = s; }

  /** Listens to what changes a fingerprint; returns the off switch. */
  attach(): () => void {
    const chat = (id: string | undefined) => { for (const [agentId, entry] of this.kept) if (!id || entry.chats.has(id)) this.kept.delete(agentId); };
    const all = () => this.kept.clear();
    const bus = this.s.bus;
    const offs = [
      bus.on('message.created', (message) => chat(message.conversationId)), bus.on('message.updated', (message) => chat(message.conversationId)),
      bus.on('message.removed', (message) => chat(message.conversationId)), bus.on('conversation.upserted', all), // a member may have come or gone
      bus.on('task.upserted', all), bus.on('task.removed', all),
    ];
    this.listening = true;
    return () => { for (const off of offs) off(); this.listening = false; all(); };
  }

  of(agentId: string): string {
    const files = filesMark(this.s.db, agentId);
    const kept = this.kept.get(agentId);
    if (kept && kept.files === files) return kept.state;
    const chats = new Set(this.s.db.all<{ c: string }>('SELECT conversation_id AS c FROM members WHERE member_id = ? AND left_at IS NULL', [agentId]).map((row) => row.c));
    const state = standing(this.s.db, agentId);
    if (this.listening) this.kept.set(agentId, { state, files, chats }); // kept only while its changes are heard
    return state;
  }
}
