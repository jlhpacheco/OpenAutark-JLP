// Migration 110 (Quests round 20.11.2026, owner 19./20.11.: one Tasks page, quests with to-dos, one "when").
//  1. `tasks` is rebuilt like 082 (rowid copied – tasks_fts is keyed by it; indexes and triggers read from sqlite_master
//     and made again, the ones on dropped columns replaced): `kind` ('quest' | 'todo'), `at` and `minutes` come in;
//     due_at, estimate_min, estimate_source, spent_ms, timer_started_at, "window", prep, next_at, goal, mode,
//     human_reason, attempts and started_at go. Runs with foreign keys OFF (migrate.ts `foreignKeysOff`).
//  2. Quests from today's data: a top-level task with pieces is a quest; its pieces and theirs (flattened) are its
//     to-dos (parent_id = the quest). Every other row is a to-do.
//  3. One "when", for a person's work only (an agent's old due date was mostly its own invention – it is dropped, not
//     kept in notes, so it never comes back as a time): `at` = a snoozed or repeating to-do's next ring (it is open
//     again), else due_at, else its pending timer ring, else its calendar block's start, else its window's day (at
//     notBefore, else 09:00, in this PC's zone); `minutes` = estimate_min, else the block's length. Only "Later" and
//     "Repeats" waits (or one with an `until`) open again; any other wait of the person stays as it is, with its reason.
//     A preparation becomes a notes paragraph "Prepared by <name>: …"; such a row's tasks_fts text is written again
//     (the text tasks/repo.ts index writes), so a search finds its words. Waits lose `until`, ledgers their `stalls`.
//  4. calendar_events keeps only appointments (kind 'event'); the to-do blocks are read into their tasks and deleted.
//     day_briefings and task_estimates are dropped, the kv marks of the morning planner and the stale-asks pass go.
//  5. schedules (oldSchedule – also read by bridge/quests-2011.ts for rows a 0.3.x PC still sends): an agent's routine
//     is a repeating reminder whose note is "Every <when>: <title> – <notes>"; the person's routine (a task post in a
//     chat) a repeating message; timer rows are gone (their ring is the to-do's `at`); ended rows (inactive) older than
//     7 days are deleted.
//  6. Where existing task rows were converted, the kv mark quests/converted (its updated_at = when) – the bridge wake
//     (bridge/quests-wake.ts) runs only there.
// Owns: this schema step and those data steps. Never: deletes a task, or edits a shipped migration.

import type { Db } from '../database.ts';
import { foldText } from '../../../shared/text/normalize.ts';

/** The columns of `tasks` before this step (001, 009, 068, 082, 093, 102), in their order. */
const OLD = [
  'id', 'conversation_id', 'message_id', 'parent_id', 'title', 'notes', 'status', 'assignee_kind', 'assignee_id', 'created_by',
  'priority', 'due_at', 'depends_on', 'goal', 'done_when', 'mode', 'widget', 'human_reason', 'waiting_on', 'result',
  'ledger', 'attempts', 'sort', 'rev', 'client_id', 'created_at', 'updated_at', 'started_at', 'completed_at',
  'assigned_by', 'estimate_min', 'estimate_source', 'spent_ms', 'timer_started_at', 'window', 'prep', 'private',
  'space_id', 'source', 'source_label', 'files', 'next_at',
] as const;
const DROPPED = ['due_at', 'estimate_min', 'estimate_source', 'spent_ms', 'timer_started_at', 'window', 'prep', 'next_at',
  'goal', 'mode', 'human_reason', 'attempts', 'started_at'];
/** Kept as they are (copied by name). */
const KEPT = OLD.filter((name) => !DROPPED.includes(name));

const CREATE = /* sql */ `
CREATE TABLE tasks_v110 (
  id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT, parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'todo',
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  assignee_kind TEXT NOT NULL DEFAULT 'team', assignee_id TEXT, created_by TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, "at" INTEGER, minutes INTEGER, depends_on TEXT NOT NULL DEFAULT '[]',
  done_when TEXT, widget TEXT, waiting_on TEXT, result TEXT,
  ledger TEXT NOT NULL DEFAULT '{}', sort REAL NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, client_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, assigned_by TEXT,
  private INTEGER NOT NULL DEFAULT 0, space_id TEXT, source TEXT, source_label TEXT, files TEXT NOT NULL DEFAULT '[]'
) STRICT;`;

const INDEXES = /* sql */ `
CREATE INDEX IF NOT EXISTS tasks_board ON tasks(status, assignee_kind, "at");
CREATE INDEX IF NOT EXISTS tasks_at ON tasks("at") WHERE "at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id) WHERE parent_id IS NOT NULL;`;

const DAY_MS = 86_400_000;
const MIN = 60_000;

interface OldRow {
  id: string; parent_id: string | null; title: string; notes: string; status: string; assignee_kind: string; due_at: number | null;
  estimate_min: number | null; window: string | null; prep: string | null; waiting_on: string | null;
}

const parse = <T>(text: string | null): T | undefined => {
  if (!text) return undefined;
  try { return JSON.parse(text) as T; } catch { return undefined; }
};

/** 'YYYY-MM-DD' at 'HH:MM' in this PC's zone (undefined when either is not one). */
function localAt(date: unknown, clock: unknown): number | undefined {
  const day = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!day) return undefined;
  const time = typeof clock === 'string' ? /^(\d{2}):(\d{2})$/.exec(clock) : null;
  const at = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), time ? Number(time[1]) : 9, time ? Number(time[2]) : 0).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** The task each row belongs to at the top (itself for a top-level row; a loop or a missing parent stops the walk). */
function rootsOf(rows: OldRow[]): Map<string, string> {
  const parent = new Map(rows.map((row) => [row.id, row.parent_id]));
  const out = new Map<string, string>();
  for (const row of rows) {
    let current = row.id;
    const seen = new Set([current]);
    for (let next = parent.get(current); next && parent.has(next) && !seen.has(next); next = parent.get(current)) {
      seen.add(next);
      current = next;
    }
    out.set(row.id, current);
  }
  return out;
}

/** The pending ring of each to-do's timer (oldSchedule). */
function timerRings(db: Db): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of db.all<OldSchedule>(`SELECT * FROM schedules WHERE kind = 'timer' AND task_id IS NOT NULL ORDER BY created_at`)) {
    const now = oldSchedule(row);
    if (now.as === 'ring') out.set(now.taskId, now.at);
  }
  return out;
}

/** Each task's to-do block (the newest), with its length in minutes. */
function blocks(db: Db): Map<string, { startAt: number; minutes: number }> {
  const out = new Map<string, { startAt: number; minutes: number }>();
  for (const row of db.all<{ task_id: string; start_at: number; end_at: number }>(
    `SELECT task_id, start_at, end_at FROM calendar_events WHERE task_id IS NOT NULL ORDER BY updated_at, id`)) {
    out.set(row.task_id, { startAt: row.start_at, minutes: Math.max(1, Math.round((row.end_at - row.start_at) / MIN)) });
  }
  return out;
}

/** A preparation as a notes paragraph ("Prepared by Ida: …" and its links). */
function prepNote(db: Db, text: string | null): string | undefined {
  const prep = parse<{ byAgentId?: string; note?: string; links?: Array<{ label?: string; url?: string }> }>(text);
  if (!prep?.note?.trim()) return undefined;
  const name = prep.byAgentId ? db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', [prep.byAgentId])?.name : undefined;
  const links = (prep.links ?? []).filter((link) => link.url).map((link) => `- [${link.label || link.url}](${link.url})`);
  return [`Prepared by ${name ?? 'an agent'}: ${prep.note.trim()}`, ...links].join('\n');
}

/** tasks_fts of a row whose notes changed here: the text tasks/repo.ts index writes (title, notes, done-when, result summary). */
function reindex(db: Db, id: string): void {
  const row = db.get<{ title: string; notes: string; done_when: string | null; result: string | null }>('SELECT title, notes, done_when, result FROM tasks WHERE id = ?', [id]);
  if (!row) return;
  const text = foldText([row.title, row.notes, row.done_when ?? '', parse<{ summary?: string }>(row.result)?.summary ?? ''].join(' ')).trim();
  db.run('DELETE FROM tasks_fts WHERE rowid = (SELECT rowid FROM tasks WHERE id = ?)', [id]);
  if (text) db.run('INSERT INTO tasks_fts (rowid, task_id, text) SELECT rowid, id, ? FROM tasks WHERE id = ?', [text, id]);
}

/** "<when>" of "Every <when>: …" for a routine's spec, in plain words. */
export function everyWords(spec: { cron?: string; everyMs?: number; times?: string[]; days?: number[] }): string {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const on = spec.days?.length ? ` (${spec.days.map((day) => DAYS[day] ?? String(day)).join(', ')})` : '';
  if (spec.times?.length) return `day at ${spec.times.join(', ')}${on}`;
  if (spec.everyMs) {
    const minutes = Math.round(spec.everyMs / MIN);
    return `${minutes % 1440 === 0 ? `${minutes / 1440} day(s)` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`}${on}`;
  }
  const cron = spec.cron?.trim().split(/\s+/) ?? [];
  if (cron.length === 5 && /^\d+$/.test(cron[0]) && /^\d+$/.test(cron[1]) && cron[2] === '*' && cron[3] === '*') {
    const clock = `${cron[1].padStart(2, '0')}:${cron[0].padStart(2, '0')}`;
    if (cron[4] === '*') return `day at ${clock}${on}`;
    if (cron[4] === '1-5') return `weekday at ${clock}`;
    if (/^\d$/.test(cron[4])) return `${DAYS[Number(cron[4]) % 7]} at ${clock}`;
  }
  return spec.cron ? `time of "${spec.cron}"` : 'time it was set for';
}

/** A 0.3.x schedule row of kind routine or timer, as stored or as an older PC sends it (next_at: this PC's due time, if any). */
export interface OldSchedule {
  kind: string; owner_id: string; conversation_id?: string | null; task_id?: string | null; title: string; spec: string; payload: string;
  active: number | boolean; next_at?: number | null;
}

/** What an old routine or timer is in this version: a row of another kind, the ring of its to-do, or nothing. */
export type OldScheduleNow = { as: 'reminder' | 'message'; payload: string } | { as: 'ring'; taskId: string; at: number } | { as: 'gone' };

/**
 * The one mapping of a 0.3.x routine or timer (this step, and bridge/quests-2011.ts for the rows an older PC still sends):
 * an agent's routine is a repeating reminder with the note "Every <when>: <title> – <notes>"; the person's routine (a
 * task post in a chat) a repeating message – nothing without its chat; a timer is no row: its pending ring (next_at of an
 * active row, else its one-off time) is its to-do's `at`.
 */
export function oldSchedule(row: OldSchedule): OldScheduleNow {
  if (row.kind === 'timer') {
    const at = row.active ? row.next_at ?? parse<{ at?: number }>(row.spec)?.at : undefined;
    return row.task_id && typeof at === 'number' ? { as: 'ring', taskId: row.task_id, at } : { as: 'gone' };
  }
  const payload = parse<{ body?: string; note?: string; taskTemplate?: { title?: string; notes?: string } }>(row.payload) ?? {};
  if (row.owner_id === 'human') {
    if (!row.conversation_id) return { as: 'gone' };
    const body = payload.body ?? [payload.taskTemplate?.title ?? row.title, payload.taskTemplate?.notes ?? ''].filter(Boolean).join('\n');
    return { as: 'message', payload: JSON.stringify({ body }) };
  }
  const title = payload.taskTemplate?.title?.trim() || row.title;
  const notes = [payload.taskTemplate?.notes?.trim(), payload.note?.trim()].filter(Boolean).join(' – ');
  return { as: 'reminder', payload: JSON.stringify({ note: `Every ${everyWords(parse(row.spec) ?? {})}: ${title}${notes ? ` – ${notes}` : ''}` }) };
}

function schedules(db: Db, now: number): void {
  for (const row of db.all<OldSchedule & { id: string }>(`SELECT * FROM schedules WHERE kind = 'routine'`)) {
    const next = oldSchedule(row);
    if (next.as === 'reminder' || next.as === 'message') db.run('UPDATE schedules SET kind = ?, payload = ? WHERE id = ?', [next.as, next.payload, row.id]);
    else db.run('DELETE FROM schedules WHERE id = ?', [row.id]);
  }
  db.run(`DELETE FROM schedules WHERE kind = 'timer'`);
  db.run('DELETE FROM schedules WHERE active = 0 AND COALESCE(last_at, created_at) < ?', [now - 7 * DAY_MS]);
}

/** The person's waits that were the "Later" list's: snoozed, or a repeating to-do until its next time (todo-later.ts before 110). */
const LATER_WAITS = new Set(['Snoozed', 'Repeats']);

/** Runs inside the runner's transaction, with foreign keys OFF (migrate.ts checks foreign_key_check after it). */
export function run(db: Db): void {
  const now = Date.now();
  const present = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('tasks')`).map((row) => row.name);
  const unknown = present.filter((name) => !(OLD as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`Migration 110: tasks has columns this migration does not know (${unknown.join(', ')}).`);
  const missing = OLD.filter((name) => !present.includes(name));
  if (missing.length) throw new Error(`Migration 110: tasks lacks columns (${missing.join(', ')}).`);

  // What the old columns say, read before the rebuild.
  const rows = db.all<OldRow>(`SELECT id, parent_id, title, notes, status, assignee_kind, due_at, estimate_min, "window", prep, waiting_on FROM tasks`);
  const roots = rootsOf(rows);
  const quests = new Set(rows.flatMap((row) => (roots.get(row.id) !== row.id ? [roots.get(row.id)!] : [])));
  const rings = timerRings(db);
  const blocked = blocks(db);

  const keep = db.all<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`,
  ).filter((entry) => !DROPPED.some((column) => new RegExp(`\\b${column}\\b`).test(entry.sql)));
  const list = KEPT.map((name) => `"${name}"`).join(', ');
  const before = rows.length;
  db.exec(CREATE);
  db.exec(`INSERT INTO tasks_v110 (rowid, ${list}) SELECT rowid, ${list} FROM tasks;`);
  db.exec('DROP TABLE tasks;');
  db.exec('ALTER TABLE tasks_v110 RENAME TO tasks;');
  for (const entry of keep) db.exec(`${entry.sql};`);
  db.exec(INDEXES);
  const after = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')?.n ?? 0);
  if (after !== before) throw new Error(`Migration 110: ${before} tasks before the rebuild, ${after} after.`);

  for (const row of rows) {
    const root = roots.get(row.id)!;
    const person = row.assignee_kind === 'human';
    const wait = parse<{ on?: string; why?: string; until?: number }>(row.waiting_on);
    const later = typeof wait?.until === 'number' || LATER_WAITS.has(wait?.why ?? '');
    const ringWait = person && row.status === 'waiting' && wait?.on === 'outside' && later; // snoozed or repeating: open again
    const ring = ringWait && typeof wait?.until === 'number' ? wait.until : undefined;
    const window = parse<{ date?: string; notBefore?: string }>(row.window);
    const block = blocked.get(row.id);
    const at = person ? ring ?? row.due_at ?? rings.get(row.id) ?? block?.startAt ?? localAt(window?.date, window?.notBefore) : undefined;
    const minutes = person ? row.estimate_min ?? block?.minutes : undefined;
    const prep = prepNote(db, row.prep);
    db.run(
      `UPDATE tasks SET kind = ?, parent_id = ?, "at" = ?, minutes = ?, notes = ?,
         status = CASE WHEN ? THEN 'open' ELSE status END, waiting_on = CASE WHEN ? THEN NULL ELSE waiting_on END WHERE id = ?`,
      [root === row.id && quests.has(row.id) ? 'quest' : 'todo', root === row.id ? null : root,
        at ?? null, minutes ?? null, prep ? `${row.notes.trimEnd()}${row.notes.trim() ? '\n\n' : ''}${prep}` : row.notes,
        ringWait ? 1 : 0, ringWait ? 1 : 0, row.id],
    );
    if (prep) reindex(db, row.id);
  }
  db.exec(`UPDATE tasks SET waiting_on = json_remove(waiting_on, '$.until') WHERE json_valid(waiting_on) AND json_extract(waiting_on, '$.until') IS NOT NULL;
UPDATE tasks SET ledger = json_remove(ledger, '$.stalls') WHERE json_valid(ledger) AND json_extract(ledger, '$.stalls') IS NOT NULL;
DELETE FROM calendar_events WHERE kind <> 'event' OR task_id IS NOT NULL;
DROP TABLE IF EXISTS day_briefings;
DROP TABLE IF EXISTS task_estimates;
DELETE FROM kv WHERE ns = 'day' AND (key = 'stale-asks' OR key LIKE 'planned:%');`);
  schedules(db, now);
  if (rows.length) {
    db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('quests', 'converted', ?, ?)
            ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify(rows.length), now]);
  }
}
