// 24.11.2026 (owner, B249F927: "diese Tabellenvorschau" – an agent's .csv opened as raw text at best): a CSV or TSV file
// opens in the file tab as a table to read. This holds the plain rules: which files are tables, the separator (the one
// of `,` `;` tab that splits the first lines most evenly – a German Excel export uses `;`), the cells by RFC 4180
// (quoted fields with `""`, separators and line breaks inside quotes), and the most a tab draws.
// Owns: the parse. Never: changes the file or guesses types beyond "this column reads as numbers".

/** Rows a tab draws; the line under it says how many more the file holds. */
export const TABLE_MAX_ROWS = 2000;
/** Columns a tab draws. */
export const TABLE_MAX_COLUMNS = 60;

const TABLE_EXT = ['csv', 'tsv'];

/** A CSV or TSV file by its name. */
export function isTable(name: string): boolean {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return TABLE_EXT.includes(ext);
}

export interface Table {
  header: string[];
  rows: string[][];
  /** Data rows in the file (without the header). */
  total: number;
  /** Columns in the widest row. */
  columns: number;
  /** Per drawn column: every non-empty cell reads as a number (right-aligned). */
  numeric: boolean[];
  separator: ',' | ';' | '\t';
}

/** Splits `text` into records; stops after `limit` records (the rest only counted when `count`). */
function records(text: string, separator: string, limit: number): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false; // the record has any character (a blank line is no record)
  const push = () => {
    row.push(cell);
    if (started) { total++; if (rows.length < limit) rows.push(row); }
    row = []; cell = ''; started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === '') { quoted = true; started = true; }
    else if (char === separator) { row.push(cell); cell = ''; started = true; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      push();
    } else { cell += char; started = true; }
  }
  if (started || row.length) push();
  return { rows, total };
}

/** The separator that splits the first lines into the same number of cells (more than one), most of them. */
export function separatorOf(text: string, name = ''): ',' | ';' | '\t' {
  if (/\.tsv$/i.test(name)) return '\t';
  const head = text.slice(0, 16_384);
  let best: ',' | ';' | '\t' = ',';
  let bestScore = 0;
  for (const separator of [',', ';', '\t'] as const) {
    const { rows } = records(head, separator, 20);
    const lines = rows.length > 1 ? rows.slice(0, -1) : rows; // the last may be cut by the slice
    const width = lines[0]?.length ?? 0;
    if (width < 2) continue;
    const even = lines.filter((row) => row.length === width).length;
    const score = even * width;
    if (score > bestScore) { best = separator; bestScore = score; }
  }
  return best;
}

/** A number as people write it: thousands with . , ' or a (narrow) space, a decimal . or , a sign, a % after it. */
const NUMBER = /^[-+]?(?:\d{1,3}(?:[.,' \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?\s*%?$|^[-+]?[.,]\d+$/;

/** The file's text as a table: the first record as header, at most TABLE_MAX_ROWS rows and TABLE_MAX_COLUMNS columns. */
export function parseTable(text: string, name = ''): Table {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const separator = separatorOf(body, name);
  const { rows, total } = records(body, separator, TABLE_MAX_ROWS + 1);
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const width = Math.min(columns, TABLE_MAX_COLUMNS);
  const fit = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');
  const header = fit(rows[0] ?? []);
  const data = rows.slice(1).map(fit);
  const numeric = header.map((_, i) => {
    const cells = data.map((row) => row[i]!.trim()).filter(Boolean);
    return cells.length > 0 && cells.every((cell) => NUMBER.test(cell));
  });
  return { header, rows: data, total: Math.max(0, total - 1), columns, numeric, separator };
}
