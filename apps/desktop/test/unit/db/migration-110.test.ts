// Quests round migration 110: the tasks rebuild (kind, at, minutes; the dropped columns), quests from tasks with pieces
// (pieces of pieces flattened), one "when" from due times, timers, blocks and windows – for the person's work only (an
// agent's old due date is dropped) –, preparations into notes (and their search text), snoozed to-dos open again while a
// real wait of the person stays with its reason, the calendar keeping only appointments, briefings/estimates dropped,
// routines → reminders/messages (oldSchedule, the one mapping), timers and old ended schedules gone, the kv mark
// quests/converted where task rows were converted.
// Owns: checks of that step on a migrate({until: 109}) fixture with real-shaped rows. Never: task behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { everyWords, oldSchedule } from '../../../src/runtime/db/migrations/110-quests.ts';

const T = Date.now();
const H = 3600_000;
const DAY = 24 * H;
const names = (db: Db, table: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name);
const row = (db: Db, id: string) => db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])!;

function task(db: Db, id: string, fields: Record<string, unknown> = {}): void {
  const all: Record<string, unknown> = { id, title: `Title ${id}`, assignee_kind: 'human', created_by: 'human', created_at: T, updated_at: T, ...fields };
  const keys = Object.keys(all);
  db.run(`INSERT INTO tasks (${keys.map((key) => `"${key}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((key) => all[key] as never));
  const rowid = db.get<{ r: number }>('SELECT rowid AS r FROM tasks WHERE id = ?', [id])!.r;
  db.run('INSERT INTO tasks_fts (rowid, task_id, text) VALUES (?, ?, ?)', [rowid, id, `title ${id}`.toLowerCase()]);
}

function schedule(db: Db, id: string, fields: Record<string, unknown>): void {
  const all: Record<string, unknown> = { id, owner_id: 'human', title: id, spec: '{}', payload: '{}', created_at: T, ...fields };
  const keys = Object.keys(all);
  db.run(`INSERT INTO schedules (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((key) => all[key] as never));
}

/** A profile at 109 with a goal and its pieces, to-dos with every old "when", schedules of every kind, a block and a briefing. */
function fixture(): Db {
  const db = new Db(':memory:');
  migrate(db, { until: 109 });
  db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_ida', 'Ida', '{}', 'human', 0, 0)`);
  db.run(`INSERT INTO conversations (id, title, created_by, settings, created_at, updated_at) VALUES ('cv_1', 'Work', 'human', '{}', ?, ?)`, [T, T]);
  task(db, 'tk_goal', { assignee_kind: 'agent', assignee_id: 'ag_ida', title: 'Windows signing', done_when: 'Signed builds', next_at: T + H, goal: 'old', attempts: 2 });
  task(db, 'tk_piece_a', { parent_id: 'tk_goal', title: 'Buy the certificate', status: 'waiting', waiting_on: JSON.stringify({ on: 'who', who: 'human', why: 'Payment', since: T, until: T + DAY }) });
  task(db, 'tk_piece_b', { parent_id: 'tk_goal', assignee_kind: 'agent', assignee_id: 'ag_ida', title: 'Sign the build', ledger: JSON.stringify({ stalls: 3, movedAt: T }) });
  task(db, 'tk_piece_b1', { parent_id: 'tk_piece_b', title: 'Approve the upload' });
  task(db, 'tk_due', { due_at: T + 2 * H, estimate_min: 45, estimate_source: 'said', spent_ms: 1000, timer_started_at: T, started_at: T });
  task(db, 'tk_block', {});
  task(db, 'tk_window', { window: JSON.stringify({ date: '2026-11-21', notBefore: '10:30' }) });
  task(db, 'tk_prep', { notes: 'Call the bank.', prep: JSON.stringify({ byAgentId: 'ag_ida', note: 'Number is 0800 123', links: [{ label: 'Bank page', url: 'https://bank.example' }], at: T }) });
  task(db, 'tk_snoozed', { status: 'waiting', waiting_on: JSON.stringify({ on: 'outside', why: 'Snoozed', since: T, until: T + 3 * H }) });
  task(db, 'tk_timer', { widget: JSON.stringify({ type: 'timer', at: new Date(T + 5 * H).toISOString(), repeat: 'daily' }) });
  task(db, 'tk_agent_due', { assignee_kind: 'agent', assignee_id: 'ag_ida', title: 'Write the report', due_at: T + 41 * H, estimate_min: 30, created_by: 'ag_ida' });
  task(db, 'tk_team_due', { assignee_kind: 'team', title: 'Someone checks the build', due_at: T + 20 * H, created_by: 'ag_ida' });
  task(db, 'tk_letter', { status: 'waiting', due_at: T + 6 * H, waiting_on: JSON.stringify({ on: 'outside', why: 'Wartet auf den Brief vom Finanzamt', since: T }) });
  db.run(`INSERT INTO calendar_events (id, owner_id, kind, task_id, start_at, end_at, set_by, state, created_by, created_at, updated_at)
          VALUES ('ce_block', 'human', 'todo', 'tk_block', ?, ?, 'planner', 'planned', 'system', ?, ?),
                 ('ce_event', 'human', 'event', NULL, ?, ?, 'person', 'planned', 'human', ?, ?)`, [T + 4 * H, T + 4 * H + 20 * 60_000, T, T, T, T + H, T, T]);
  db.run(`UPDATE calendar_events SET title = 'Dentist' WHERE id = 'ce_event'`);
  db.run(`INSERT INTO day_briefings (owner_id, date, data, created_at) VALUES ('human', '2026-11-20', '{}', ?)`, [T]);
  db.run(`INSERT INTO task_estimates (owner_id, key_hash, minutes, updated_at) VALUES ('human', 'k', 30, ?)`, [T]);
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('day', 'planned:human', '"2026-11-20"', ?), ('day', 'slept', '[]', ?)`, [T, T]);
  schedule(db, 'sc_routine', { owner_id: 'ag_ida', kind: 'routine', title: 'Comments', spec: JSON.stringify({ cron: '0 18 * * *' }),
    payload: JSON.stringify({ taskTemplate: { title: 'Answer YouTube comments', notes: 'Only new ones' } }) });
  schedule(db, 'sc_post', { owner_id: 'human', conversation_id: 'cv_1', kind: 'routine', title: 'Report', spec: JSON.stringify({ times: ['09:00'] }),
    payload: JSON.stringify({ body: 'Weekly report\n- numbers', taskTemplate: { title: 'Weekly report' } }) });
  schedule(db, 'sc_timer', { task_id: 'tk_timer', kind: 'timer', spec: JSON.stringify({ cron: '0 9 * * *' }), next_at: T + 5 * H });
  schedule(db, 'sc_snooze', { task_id: 'tk_snoozed', kind: 'timer', spec: JSON.stringify({ at: T + 3 * H }), next_at: T + 3 * H });
  schedule(db, 'sc_old', { owner_id: 'ag_ida', kind: 'reminder', active: 0, last_at: T - 10 * DAY, created_at: T - 20 * DAY });
  schedule(db, 'sc_recent', { owner_id: 'ag_ida', kind: 'reminder', active: 0, last_at: T - DAY });
  schedule(db, 'sc_live', { owner_id: 'ag_ida', kind: 'reminder', task_id: 'tk_goal', payload: JSON.stringify({ note: 'Look again' }) });
  schedule(db, 'sc_message', { conversation_id: 'cv_1', kind: 'message', payload: JSON.stringify({ body: 'Hi' }) });
  return db;
}

test('migration 110 rebuilds tasks: kind, at and minutes in, the old columns out, same rows, rowids and FTS', () => {
  const db = fixture();
  const rowids = db.all<{ id: string; r: number }>('SELECT id, rowid AS r FROM tasks ORDER BY id');
  migrate(db);
  const columns = names(db, 'tasks');
  for (const column of ['kind', 'at', 'minutes', 'files', 'private', 'space_id', 'source', 'depends_on', 'assigned_by']) assert.ok(columns.includes(column), column);
  for (const column of ['due_at', 'estimate_min', 'estimate_source', 'spent_ms', 'timer_started_at', 'window', 'prep', 'next_at', 'goal', 'mode', 'human_reason', 'attempts', 'started_at']) {
    assert.ok(!columns.includes(column), column);
  }
  assert.deepEqual(db.all<{ id: string; r: number }>('SELECT id, rowid AS r FROM tasks ORDER BY id'), rowids);
  assert.equal(db.get<{ id: string }>(`SELECT task_id AS id FROM tasks_fts WHERE tasks_fts MATCH 'tk_due'`)?.id, 'tk_due');
  const indexes = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE tbl_name = 'tasks' AND type = 'index' AND sql IS NOT NULL`).map((entry) => entry.name);
  assert.ok(indexes.includes('tasks_board') && indexes.includes('tasks_at') && indexes.includes('tasks_conversation') && !indexes.includes('tasks_next'));
  assert.equal(db.all('PRAGMA foreign_key_check').length, 0);
});

test('migration 110: a task with pieces is a quest, its pieces and theirs are its to-dos', () => {
  const db = fixture();
  migrate(db);
  assert.equal(row(db, 'tk_goal').kind, 'quest');
  for (const id of ['tk_piece_a', 'tk_piece_b', 'tk_piece_b1']) {
    assert.equal(row(db, id).kind, 'todo', id);
    assert.equal(row(db, id).parent_id, 'tk_goal', id);
  }
  assert.equal(row(db, 'tk_due').kind, 'todo');
  assert.equal(row(db, 'tk_due').parent_id, null);
  assert.equal(JSON.parse(String(row(db, 'tk_piece_a').waiting_on)).until, undefined); // a wait has no until
  assert.equal(row(db, 'tk_piece_a').status, 'waiting');
  assert.equal(JSON.parse(String(row(db, 'tk_piece_b').ledger)).stalls, undefined);
});

test('migration 110: one "when" from due times, blocks, windows, timers and snoozes; preparations into notes', () => {
  const db = fixture();
  migrate(db);
  assert.deepEqual([row(db, 'tk_due').at, row(db, 'tk_due').minutes], [T + 2 * H, 45]);
  assert.deepEqual([row(db, 'tk_block').at, row(db, 'tk_block').minutes], [T + 4 * H, 20]);
  assert.equal(row(db, 'tk_window').at, new Date(2026, 10, 21, 10, 30).getTime());
  assert.equal(row(db, 'tk_timer').at, T + 5 * H);
  assert.deepEqual([row(db, 'tk_snoozed').status, row(db, 'tk_snoozed').waiting_on, row(db, 'tk_snoozed').at], ['open', null, T + 3 * H]);
  assert.equal(row(db, 'tk_prep').notes, 'Call the bank.\n\nPrepared by Ida: Number is 0800 123\n- [Bank page](https://bank.example)');
  const found = (query: string) => db.all<{ id: string }>('SELECT task_id AS id FROM tasks_fts WHERE tasks_fts MATCH ?', [query]).map((hit) => hit.id);
  assert.deepEqual(found('prepared 0800'), ['tk_prep'], 'the preparation\'s words are searchable');
  assert.deepEqual(found('bank'), ['tk_prep'], 'one FTS row for it, with its notes');
  assert.equal(row(db, 'tk_goal').at, null);
});

test('migration 110: an agent\'s old due date never comes back as a time (nor a team row\'s); the person\'s real wait stays with its reason', () => {
  const db = fixture();
  migrate(db);
  for (const id of ['tk_agent_due', 'tk_team_due']) {
    assert.deepEqual([row(db, id).at, row(db, id).minutes], [null, null], id);
    assert.ok(!String(row(db, id).notes).includes('Due'), `${id}: not kept in notes either`);
  }
  assert.equal(row(db, 'tk_letter').status, 'waiting');
  assert.equal(JSON.parse(String(row(db, 'tk_letter').waiting_on)).why, 'Wartet auf den Brief vom Finanzamt');
  assert.equal(row(db, 'tk_letter').at, T + 6 * H, 'its own due time stays (it is the person\'s)');
});

test('migration 110 marks quests/converted (updated_at = when) where it converted task rows, and nothing on an empty profile', () => {
  const db = fixture();
  const before = Date.now();
  migrate(db);
  const mark = db.get<{ value: string; updated_at: number }>(`SELECT value, updated_at FROM kv WHERE ns = 'quests' AND key = 'converted'`);
  assert.equal(JSON.parse(mark!.value), db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n);
  assert.ok(mark!.updated_at >= before);
  const fresh = new Db(':memory:');
  migrate(fresh, { until: 109 });
  migrate(fresh);
  assert.equal(fresh.get(`SELECT 1 AS hit FROM kv WHERE ns = 'quests'`), undefined);
});

test('oldSchedule: a timer is its to-do\'s ring (next_at, else its one-off time; none when ended); a routine a reminder or message', () => {
  const base = { owner_id: 'human', title: 't', spec: '{}', payload: '{}', active: 1 };
  assert.deepEqual(oldSchedule({ ...base, kind: 'timer', task_id: 'tk_a', next_at: T + H }), { as: 'ring', taskId: 'tk_a', at: T + H });
  assert.deepEqual(oldSchedule({ ...base, kind: 'timer', task_id: 'tk_a', spec: JSON.stringify({ at: T + 2 * H }) }), { as: 'ring', taskId: 'tk_a', at: T + 2 * H });
  assert.deepEqual(oldSchedule({ ...base, kind: 'timer', task_id: 'tk_a', active: 0, next_at: T + H }), { as: 'gone' });
  assert.deepEqual(oldSchedule({ ...base, kind: 'routine', conversation_id: null }), { as: 'gone' }, 'the person\'s routine without its chat');
  assert.deepEqual(oldSchedule({ ...base, kind: 'routine', owner_id: 'ag_ida', spec: JSON.stringify({ cron: '0 9 * * 1-5' }), payload: JSON.stringify({ taskTemplate: { title: 'Inbox' } }) }),
    { as: 'reminder', payload: JSON.stringify({ note: 'Every weekday at 09:00: Inbox' }) });
});

test('migration 110: a prepared row\'s search text is what the repository writes (title, notes, done-when, result)', () => {
  const db = fixture();
  db.run(`UPDATE tasks SET result = ?, done_when = 'Bank called' WHERE id = 'tk_prep'`, [JSON.stringify({ summary: 'Reached the hotline' })]);
  migrate(db);
  const text = db.get<{ text: string }>(`SELECT text FROM tasks_fts WHERE task_id = 'tk_prep'`)?.text ?? '';
  for (const word of ['title tk_prep', 'call the bank', 'prepared by ida', 'bank called', 'reached the hotline']) assert.ok(text.includes(word), word);
});

test('migration 110: the calendar keeps appointments; briefings, estimates and the planner marks go', () => {
  const db = fixture();
  migrate(db);
  assert.deepEqual(db.all<{ id: string }>('SELECT id FROM calendar_events').map((entry) => entry.id), ['ce_event']);
  const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((entry) => entry.name);
  assert.ok(!tables.includes('day_briefings') && !tables.includes('task_estimates'));
  assert.deepEqual(db.all<{ key: string }>(`SELECT key FROM kv WHERE ns = 'day'`).map((entry) => entry.key), ['slept']);
});

test('migration 110: routines become a reminder (an agent) or a message (the person), timers and old ended rows go', () => {
  const db = fixture();
  migrate(db);
  const kinds = Object.fromEntries(db.all<{ id: string; kind: string }>('SELECT id, kind FROM schedules').map((entry) => [entry.id, entry.kind]));
  assert.deepEqual(kinds, { sc_routine: 'reminder', sc_post: 'message', sc_recent: 'reminder', sc_live: 'reminder', sc_message: 'message' });
  const payload = (id: string) => JSON.parse(db.get<{ p: string }>('SELECT payload AS p FROM schedules WHERE id = ?', [id])!.p);
  assert.deepEqual(payload('sc_routine'), { note: 'Every day at 18:00: Answer YouTube comments – Only new ones' });
  assert.deepEqual(payload('sc_post'), { body: 'Weekly report\n- numbers' });
  assert.deepEqual(payload('sc_live'), { note: 'Look again' });
});

test('everyWords names a routine\'s rhythm in plain words', () => {
  assert.equal(everyWords({ cron: '30 9 * * 1-5' }), 'weekday at 09:30');
  assert.equal(everyWords({ cron: '0 8 * * 1' }), 'Monday at 08:00');
  assert.equal(everyWords({ times: ['09:00', '13:30'] }), 'day at 09:00, 13:30');
  assert.equal(everyWords({ everyMs: 2 * H }), '2 h');
  assert.equal(everyWords({ cron: '*/5 * * * *' }), 'time of "*/5 * * * *"');
});
