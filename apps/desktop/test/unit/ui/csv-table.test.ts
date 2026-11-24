// B249F927 (24.11.2026, "diese Tabellenvorschau"): a CSV or TSV file reads as a table in the file tab
// (src/ui/workspace/csv-table.ts): which files, the separator, RFC 4180 cells, the limits, number columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, isTable, parseTable, separatorOf } from '../../../src/ui/workspace/csv-table.ts';

test('isTable: .csv and .tsv by name, any case; other text is not', () => {
  for (const name of ['C:/w/VORSCHAU-SALZBURG-NUR-TESTDATEN.csv', 'a.TSV', '/x/y.Csv']) assert.ok(isTable(name), name);
  for (const name of ['a.md', 'a.txt', 'csv', 'a.csv.bak', '']) assert.ok(!isTable(name), name);
});

test('separator: comma, the German semicolon export, tab; a comma inside quotes or decimals does not win', () => {
  assert.equal(separatorOf('Name,Ort,Umsatz\nA,Salzburg,10\nB,Wien,20\n'), ',');
  assert.equal(separatorOf('Name;Ort;Umsatz\nA;Salzburg;10,5\nB;Wien;20,25\n'), ';');
  assert.equal(separatorOf('Name\tOrt\nA\tSalzburg\n'), '\t');
  assert.equal(separatorOf('a,b\n1,2\n', 'x.tsv'), '\t', 'a .tsv is tab by its name');
  assert.equal(separatorOf('"Müller, Anna";Salzburg\n"Huber, Max";Linz\n'), ';');
});

test('cells by RFC 4180: quotes, doubled quotes, separators and line breaks inside quotes, CRLF, BOM, blank lines', () => {
  const table = parseTable('\uFEFFFirma,Notiz,Umsatz\r\n"Kassio GmbH","sagt ""ja"", morgen",1.200\r\n\r\nBeta,"zwei\nZeilen",\r\n');
  assert.deepEqual(table.header, ['Firma', 'Notiz', 'Umsatz'], 'the BOM is no part of the first header');
  assert.deepEqual(table.rows, [['Kassio GmbH', 'sagt "ja", morgen', '1.200'], ['Beta', 'zwei\nZeilen', '']]);
  assert.equal(table.total, 2, 'a blank line is no row');
  assert.deepEqual(table.numeric, [false, false, true], 'empty cells do not spoil a number column');
});

test('numbers: German and English thousands and decimals, signs and percent; text, dates and IDs with letters are not', () => {
  const table = parseTable('a;b;c;d\n1.234,50;-3;12 %;2026-11-22\n0,5;+4;7%;2026-11-23\n');
  assert.deepEqual(table.numeric, [true, true, true, false]);
  assert.deepEqual(parseTable('id,x\nAT-1,1\nAT-2,2\n').numeric, [false, true]);
  assert.deepEqual(parseTable('Umsatz;y\n1\u00a0373\u00a0451;a\n1\u202f546\u202f902;b\n').numeric, [true, false], 'the spaces of toLocaleString (de-AT)');
});

test('limits: at most TABLE_MAX_ROWS rows and TABLE_MAX_COLUMNS columns drawn, the totals counted; short rows padded', () => {
  const many = ['h1,h2', ...Array.from({ length: TABLE_MAX_ROWS + 50 }, (_, i) => `${i},x`)].join('\n');
  const table = parseTable(many);
  assert.equal(table.rows.length, TABLE_MAX_ROWS);
  assert.equal(table.total, TABLE_MAX_ROWS + 50);
  const wide = parseTable(`${Array.from({ length: TABLE_MAX_COLUMNS + 5 }, (_, i) => `c${i}`).join(',')}\n1\n`);
  assert.equal(wide.header.length, TABLE_MAX_COLUMNS);
  assert.equal(wide.columns, TABLE_MAX_COLUMNS + 5);
  assert.equal(wide.rows[0]!.length, TABLE_MAX_COLUMNS, 'a short row is padded to the drawn width');
  assert.deepEqual(parseTable('').header, [], 'an empty file has no header');
});

test('the file tab: a CSV opens as its table read page, Edit / Read switches like Markdown', () => {
  const view = readFileSync(new URL('../../../src/ui/workspace/FileView.tsx', import.meta.url), 'utf8');
  assert.match(view, /const table = isTable\(path\);/);
  assert.match(view, /useState\(\(\) => readable_ && reading\.get\(id\) !== false\)/);
  assert.match(view, /table \? <TableRead text=\{doc\.text\} path=\{path\} \/>/);
  assert.match(view, /\{readable_ && <span class="file-mode">/);
});
