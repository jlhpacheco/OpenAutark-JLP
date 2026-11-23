// The app's one light stem and the person's search query (src/shared/text/normalize.ts, Quests round 20.11.2026): plurals
// and -ieren/-ierung/-ation forms meet, a typed ae/oe/ue meets ä/ö/ü in the tables folded ä → a, operators stay quoted,
// and the query runs against a real FTS5 table built as tasks_fts and messages_fts are (unicode61, remove_diacritics 2).
// Owns: these assertions only. Never: the runtime's stores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { foldText, ftsQuery, matchesQuery, stem } from '../../../src/shared/text/normalize.ts';

test('stem: inflections off, -ieren/-ierung/-ation to their root, at least four letters, ids whole', () => {
  assert.equal(stem('rechnungen'), 'rechnung');
  assert.equal(stem('meetings'), 'meeting');
  assert.equal(stem('rendering'), 'render');
  assert.equal(stem('signierung'), 'sign');
  assert.equal(stem('signieren'), 'sign');
  assert.equal(stem('installation'), 'install');
  assert.equal(stem('konfigurieren'), 'konfigur');
  assert.equal(stem('notieren'), 'notier', 'a root under four letters: the inflection rule instead');
  assert.equal(stem('kunden'), 'kund');
  assert.equal(stem('peter'), 'peter', 'a stem keeps at least four letters');
  assert.equal(stem('abc12345'), 'abc12345');
  for (const token of ['rechnungen', 'signierung', 'installationen']) assert.ok(token.startsWith(stem(token)), token);
});

test('ftsQuery: every token by its stem, AND-ed; ae/oe/ue also as a/o/u; operators stay quoted', () => {
  assert.equal(ftsQuery('Rechnungen Larsen'), '"rechnung"* AND "lars"*');
  assert.equal(ftsQuery('Mueller'), '("muell"* OR "mull"*)');
  assert.equal(ftsQuery('Müller'), '"mull"*');
  assert.equal(ftsQuery('a AND b* NEAR "c"'), '"a"* AND "and"* AND "b"* AND "near"* AND "c"*');
  assert.equal(ftsQuery('?!'), '');
});

test('the person\'s search finds plurals, the -ieren family and Müller typed as Mueller in a table folded ä → a', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')");
  const rows = { invoice: 'Rechnung für Larsen schreiben', sign: 'Windows-Installer signieren', seal: 'Signatur der App prüfen', mueller: 'Herrn Müller anrufen', other: 'Untertitel brennen' };
  for (const [id, text] of Object.entries(rows)) db.prepare('INSERT INTO t (id, text) VALUES (?, ?)').run(id, foldText(text));
  const find = (query: string) => db.prepare('SELECT id FROM t WHERE t MATCH ? ORDER BY id').all(ftsQuery(query)).map((row) => String(row.id));
  assert.deepEqual(find('Rechnungen'), ['invoice']);
  assert.deepEqual(find('Signierung'), ['seal', 'sign']);
  assert.deepEqual(find('Mueller anrufen'), ['mueller']);
  assert.deepEqual(find('Rechnungen Untertitel'), [], 'every word must be there');
});

test('matchesQuery reads the query the same way', () => {
  assert.ok(matchesQuery('Rechnung für Larsen', 'Rechnungen'));
  assert.ok(matchesQuery('Herrn Müller anrufen', 'mueller'));
  assert.ok(matchesQuery('Installer signieren', 'Signierung'));
  assert.ok(!matchesQuery('Rechnung für Larsen', 'Rechnungen Oslo'));
  assert.ok(matchesQuery('anything', '  '));
});
