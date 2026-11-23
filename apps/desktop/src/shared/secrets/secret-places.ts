// Where a secret stands. Owner 22.11.2026, after a card number showed in clear text in agents' tool results three times
// (16./17./21.11.: a payment page and Windows UI Automation wrote it in groups of four, so the exact-value redactor
// missed it; CVC and expiry were too short for it to look at all): a value is a secret by where it stands, not only by
// its length. A long stored value matches in any grouping ("5412 7512 …", "DE89-3704-…"). A short one (a CVC, a PIN,
// an expiry) is replaced only in a secret place – a card, code or password field or right after such a label or flag;
// in running text "123" stays a number. A field with such a label shows no value at all, known to the vault or not.
// Used by the vault's redactor (runtime/secrets/redact.ts), the Windows UI tree (runtime/computer/tree.ts), the browser
// snapshot (runtime/browser/page.ts) and the helper's screenshot mask (the label rule travels as its source).
// Owns: the secret-label rule, the field mask, grouping-blind matching and short values in secret places.
// Never: knows values by itself, logs them, or decides what the vault learns.

/**
 * Labels of fields and flags that hold a secret: card number, CVC/CVV, expiry, PIN, password, one-time and
 * verification codes (English and German, field names like "input-creditCardNumber" or "cc-csc" too).
 * Plain enough for .NET as well (the Windows helper gets `.source`, case-insensitive).
 */
export const SECRET_LABEL = /(?<![\p{L}\p{N}])(?:(?:credit[ _.-]?)?card[ _.-]?(?:number|num|no)|kartennummer|cc[ _.-]?(?:number|num|csc|exp)|cvc2?|cvv2?|csc|security[ _.-]?code|sicherheitscode|sicherheitsschlüssel|kartenprüf\p{L}*|prüf(?:nummer|ziffer|code)|exp(?:iry|iration)(?:[ _.-]?date)?|exp[ _.-]?date|ablauf\p{L}*|gültig[ _.-]?bis|valid[ _.-]?(?:thru|until|to)|mm ?\/ ?(?:yy|jj)|pin(?:[ _.-]?code)?|passwor[dt]|passwd|kennwort|passcode|one[ _.-]?time[ _.-]?(?:code|password)|einmal(?:code|passwort)|otp|tan|2fa[ _.-]?code|verification[ _.-]?code|bestätigungscode)(?!\p{L})/iu;

/** True when a field's label, name or id names a secret (see SECRET_LABEL). */
export function isSecretLabel(text: string | undefined): boolean {
  return !!text && SECRET_LABEL.test(text);
}

/** What a secret field shows instead of its value: the last four digits of a card number, else only its length. */
export function fieldMask(value: string): string {
  const digits = value.replace(/[\s  .-]/g, '');
  return /^\d{12,19}$/.test(digits) ? `•••• ${digits.slice(-4)}` : `•••• (${[...value].length} characters)`;
}

/** Characters a page or a person puts between the groups of a value. */
const SEPARATOR = /[\s  .\-/]/;
const SEPARATORS = /[\s  .\-/]+/g;
/** More separators in a row than this end a value (a table's columns are not one number). */
const MAX_GAP = 3;

/** A value without its grouping: what grouping-blind matching compares. */
export function looseKey(value: string): string {
  return value.replace(SEPARATORS, '');
}

/**
 * `text` with every key of `keys` replaced by `mark(id)` wherever it shows with separators between its characters
 * (at most MAX_GAP in a row, never across a line). Keys are grouping-free (looseKey) and long (the caller decides).
 */
export function looseReplace(text: string, keys: ReadonlyMap<string, string>, mark: (id: string) => string): string {
  if (!text || !keys.size) return text;
  let skeleton = '';
  const at: number[] = []; // skeleton index → text index
  let gap = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') { skeleton += '\n'; at.push(i); gap = 0; continue; }
    if (SEPARATOR.test(char)) { gap++; continue; }
    if (gap > MAX_GAP) { skeleton += '\n'; at.push(i); }
    gap = 0;
    skeleton += char;
    at.push(i);
  }
  const spans: Array<[number, number, string]> = [];
  const taken = new Uint8Array(skeleton.length);
  for (const [key, id] of [...keys].sort((a, b) => b[0].length - a[0].length)) {
    for (let from = skeleton.indexOf(key); from >= 0; from = skeleton.indexOf(key, from + 1)) {
      const to = from + key.length;
      if (taken.subarray(from, to).some(Boolean)) continue;
      taken.fill(1, from, to);
      spans.push([at[from], at[to - 1] + 1, id]);
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let last = 0;
  for (const [start, end, id] of spans) { out += text.slice(last, start) + mark(id); last = end; }
  return out + text.slice(last);
}

/** How far after a secret label a short value still belongs to it (a field line and the value line below it). */
const PLACE_CHARS = 120;
const LABELS = new RegExp(SECRET_LABEL.source, 'giu');
const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** A short key as a whole token, in any grouping ("12/29", "12 / 29", "1229"). */
function shortPattern(key: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${[...key].map(escape).join('[\\s\\u00a0\\u202f./-]{0,3}')}(?![\\p{L}\\p{N}])`, 'gu');
}

/**
 * `text` with every short key of `keys` replaced by `mark(id)` where it stands in a secret place: within PLACE_CHARS
 * after a secret label ("CVC: 123", `textbox "Sicherheitscode": "123"`, "--pin 1234", "PIN=1234"). Elsewhere it stays.
 */
export function maskInPlaces(text: string, keys: ReadonlyMap<string, string>, mark: (id: string) => string): string {
  if (!text || !keys.size) return text;
  const windows: Array<[number, number]> = [];
  for (const match of text.matchAll(LABELS)) {
    const start = match.index ?? 0;
    const end = Math.min(text.length, start + match[0].length + PLACE_CHARS);
    const previous = windows[windows.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else windows.push([start, end]);
  }
  if (!windows.length) return text;
  const patterns = [...keys].sort((a, b) => b[0].length - a[0].length).map(([key, id]) => [shortPattern(key), id] as const);
  let out = '';
  let last = 0;
  for (const [start, end] of windows) {
    let part = text.slice(start, end);
    for (const [pattern, id] of patterns) part = part.replace(pattern, () => mark(id));
    out += text.slice(last, start) + part;
    last = end;
  }
  return out + text.slice(last);
}
