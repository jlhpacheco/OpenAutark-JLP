// The open work a line is about (src/runtime/tasks/related.ts, Quests round 20.11.2026): a to-do's words find its quest, a
// lone to-do is found by its own words, finished work stays out ("Only me" work counts like any other), skip and limit, changes are
// read at the next call (new to-do, new title, a finished quest), kinds, and the per-call cost for 500 unfinished tasks.
// Owns: these assertions only. Never: the task service (rows are written as the 110 schema has them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { relatedWork } from '../../../src/runtime/tasks/related.ts';

const T = 1_700_000_000_000;

interface Row { id: string; kind?: 'quest' | 'todo'; parent?: string; title: string; notes?: string; status?: string; owner?: string; by?: string; private?: boolean; ledger?: object; doneWhen?: string }

function setup(rows: Row[]) {
  const db = new Db(':memory:');
  migrate(db);
  for (const row of rows) add(db, row);
  return { db, s: { db } }; // one services object: the index lives as long as it (WeakMap)
}

function add(db: Db, row: Row): void {
  db.run(`INSERT INTO tasks (id, kind, parent_id, title, notes, status, assignee_kind, assignee_id, created_by, done_when, ledger, private, rev, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, [row.id, row.kind ?? 'todo', row.parent ?? null, row.title, row.notes ?? '', row.status ?? 'open',
    row.owner === 'human' ? 'human' : 'agent', row.owner === 'human' ? null : row.owner ?? 'ag_ava', row.by ?? 'human', row.doneWhen ?? null,
    JSON.stringify(row.ledger ?? {}), row.private ? 1 : 0, T, T]);
}

const QUESTS: Row[] = [
  { id: 'task_release', kind: 'quest', title: 'Release 0.4', owner: 'ag_ava', doneWhen: 'Installer on the website' },
  { id: 'task_sign', parent: 'task_release', title: 'Windows-Installer signieren', owner: 'ag_ava' },
  { id: 'task_notes', parent: 'task_release', title: 'Release-Notes schreiben', owner: 'ag_ben', status: 'done' },
  { id: 'task_books', kind: 'quest', title: 'Buchhaltung November', owner: 'ag_cleo', ledger: { facts: ['Belege kommen per Mail von Larsen'] } },
  { id: 'task_invoice', parent: 'task_books', title: 'Rechnung an Larsen Marine', owner: 'human' },
  { id: 'task_call', title: 'Zahnarzt anrufen', owner: 'human' },
  { id: 'task_old', kind: 'quest', title: 'Signatur-Zertifikat kaufen', status: 'done' },
];

const ids = (hits: Array<{ id: string }>) => hits.map((hit) => hit.id);

test("a to-do's words find its quest; a lone to-do is found by its own words; finished work is none", () => {
  const { s } = setup(QUESTS);
  assert.deepEqual(ids(relatedWork(s, 'Die Signierung unter Windows klappt nicht')), ['task_release']);
  assert.deepEqual(ids(relatedWork(s, 'neue Rechnungen von Larsen')), ['task_books']);
  assert.deepEqual(ids(relatedWork(s, 'Release-Notes')), ['task_release'], "a finished to-do's title still says what its quest is about");
  assert.deepEqual(ids(relatedWork(s, 'Belege per Mail')), ['task_books'], 'facts count');
  assert.deepEqual(ids(relatedWork(s, 'Installer website')), ['task_release'], 'done-when counts');
  assert.deepEqual(ids(relatedWork(s, 'beim Zahnarzt')), ['task_call']);
  assert.deepEqual(relatedWork(s, 'Zertifikat kaufen'), [], 'a finished quest is no open work');
  assert.deepEqual(relatedWork(s, '   '), []);
});

test('a hit carries kind, title and owner; skip leaves some out before the limit counts', () => {
  const { s } = setup([...QUESTS, { id: 'task_legacy', title: 'Larsen Angebot', owner: 'ag_ben' }, { id: 'task_legacy_part', parent: 'task_legacy', title: 'Preise für Larsen' }]);
  const hits = relatedWork(s, 'Larsen', 5);
  assert.deepEqual(hits.map(({ id, kind, assigneeId }) => ({ id, kind, assigneeId })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'task_books', kind: 'quest', assigneeId: 'ag_cleo' },
    { id: 'task_legacy', kind: 'quest', assigneeId: 'ag_ben' },
  ], 'a row with to-dos is a quest even when its kind says to-do');
  assert.ok(hits.every((hit) => hit.score > 0 && hit.score <= 1));
  assert.deepEqual(ids(relatedWork(s, 'Larsen', 1, (row) => row.assigneeId === 'ag_cleo')), ['task_legacy'], "the reader's own work skipped");
  assert.deepEqual(relatedWork(s, 'Zahnarzt', 3, (row) => row.assigneeKind === 'human'), []);
  assert.equal(relatedWork(s, 'Zahnarzt')[0].kind, 'todo');
});

test('"Only me" hides nothing (owner 20.11.2026): an "Only me" quest is found by everyone, an "Only me" to-do lends its quest its words', () => {
  const { s } = setup([
    { id: 'task_mine', kind: 'quest', title: 'Geschenk für Anna', owner: 'ag_ava', by: 'human', private: true },
    { id: 'task_open', kind: 'quest', title: 'Umzug planen', owner: 'ag_ava' },
    { id: 'task_own', parent: 'task_open', title: 'Kündigung Wohnung', private: true },
  ]);
  assert.deepEqual(ids(relatedWork(s, 'Geschenk Anna')), ['task_mine']);
  assert.deepEqual(ids(relatedWork(s, 'Kündigung')), ['task_open']);
});

test('changes are read at the next call: a new to-do, a new title, a finished quest', () => {
  const { db, s } = setup(QUESTS);
  assert.deepEqual(relatedWork(s, 'Steuerberater Termin'), []);
  add(db, { id: 'task_tax', parent: 'task_books', title: 'Termin beim Steuerberater' });
  assert.deepEqual(ids(relatedWork(s, 'Steuerberater Termin')), ['task_books']);
  db.run(`UPDATE tasks SET title = 'Zahnarzt Dr. Weber anrufen', rev = rev + 1 WHERE id = 'task_call'`);
  assert.deepEqual(ids(relatedWork(s, 'Weber')), ['task_call']);
  db.run(`UPDATE tasks SET status = 'done', rev = rev + 1 WHERE id = 'task_books'`);
  assert.deepEqual(relatedWork(s, 'Steuerberater Termin'), []);
});

test('the cost per call for 500 unfinished tasks stays small once the texts are indexed', () => {
  const rows: Row[] = [];
  for (let q = 0; q < 100; q++) {
    rows.push({ id: `task_q${q}`, kind: 'quest', title: `Projekt ${q} Kunde${q % 17} Bericht`, notes: `Notizen zu Projekt ${q}: Angebot, Termin, Rechnung ${q}.` });
    for (let d = 0; d < 3; d++) rows.push({ id: `task_q${q}d${d}`, parent: `task_q${q}`, title: `Schritt ${d} für Kunde${q % 17}: Entwurf prüfen` });
  }
  for (let t = 0; t < 100; t++) rows.push({ id: `task_t${t}`, title: `Einzelaufgabe ${t} Lieferant${t % 13}` });
  const { s } = setup(rows);
  relatedWork(s, 'warm up'); // the first call indexes every text
  const started = performance.now();
  for (let i = 0; i < 20; i++) relatedWork(s, `Entwurf für Kunde${i % 17} prüfen und Rechnung schreiben`);
  const perCall = (performance.now() - started) / 20;
  assert.ok(perCall < 25, `${perCall.toFixed(2)} ms per call`); // measured ≈ 2 ms here; the bound only catches a re-index per call
  assert.equal(relatedWork(s, 'Lieferant7 Einzelaufgabe 7')[0].id, 'task_t7');
});
