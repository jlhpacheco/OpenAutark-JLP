// Names and values as people paste or keep them (owner 04.11.2026: a secret's name and
// value side by side, a pasted .env splits into rows, a .env or JSON file goes in as it is): `.env` lines – `KEY=value`
// or `KEY: value`, an optional `export `, single or double quotes (a quoted value may span lines; in double quotes \n is
// a line break), `#` comments and blank lines – and a flat JSON object of text values. The Settings rows (paste
// splitting) and the runtime's import (runtime/secrets/import-parse.ts) read them here, so both agree. A file's import
// keeps only the pairs that hold a secret (isSecretPair): a plain setting stored as a secret would be masked in
// everything agents read ("production" turning into a handle).
// Owns: that reading, the two format names, the kind a name suggests and which pair is a secret. Never: logs or keeps
// what it reads.

export interface KeyValue { name: string; value: string }

/** The formats of a key/value file (SecretImportSummary.format): a working file of its own, no password export. */
export const ENV_FORMAT = '.env file';
export const JSON_FORMAT = 'JSON file';
export const isKeyValueFormat = (format: string): boolean => format === ENV_FORMAT || format === JSON_FORMAT;

const HEAD = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:(?=\s|$))\s*/;

/** Where `quote` closes `body` (a double-quoted value skips \" and \\); -1 when it does not. */
function closing(body: string, quote: string): number {
  for (let at = 0; at < body.length; at++) {
    if (quote === '"' && body[at] === '\\') { at++; continue; }
    if (body[at] === quote) return at;
  }
  return -1;
}

function fromJson(text: string): KeyValue[] | undefined {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const entries = Object.entries(data as Record<string, unknown>);
  if (!entries.length || entries.some(([name, value]) => !name.trim() || typeof value !== 'string')) return undefined;
  return entries.map(([name, value]) => ({ name: name.trim(), value: value as string }));
}

/** The pairs of a .env text or a flat JSON object of text values; undefined for anything else (a CSV, prose, a bare value). */
export function parseKeyValues(text: string): KeyValue[] | undefined {
  const source = text.replace(/^\uFEFF/, '');
  if (source.trimStart().startsWith('{')) return fromJson(source.trim());
  const lines = source.split(/\r?\n/);
  const pairs: KeyValue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    if (!line.trim() || line.startsWith('#')) continue;
    const head = HEAD.exec(line);
    if (!head) return undefined;
    const rest = line.slice(head[0].length);
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") { pairs.push({ name: head[1], value: rest.replace(/\s+#.*$/, '').trim() }); continue; }
    let body = rest.slice(1);
    let end = closing(body, quote);
    while (end < 0 && i + 1 < lines.length) { i++; body += `\n${lines[i]}`; end = closing(body, quote); }
    const tail = end < 0 ? '' : body.slice(end + 1).trim();
    if (end < 0 || (tail && !tail.startsWith('#'))) return undefined;
    const raw = body.slice(0, end);
    pairs.push({ name: head[1], value: quote === "'" ? raw : raw.replace(/\\([nr"\\])/g, (_, char: string) => (char === 'n' ? '\n' : char === 'r' ? '\r' : char)) });
  }
  return pairs.length ? pairs : undefined;
}

/** The kind a name suggests – it picks the route and nothing else (every kind works everywhere). */
export function kindForName(name: string): 'token' | 'password' | 'api_key' {
  if (/token|jwt|bearer/i.test(name)) return 'token';
  if (/password|passwd|passphrase|pwd|(?:^|[^a-z])pass(?![a-z])/i.test(name)) return 'password';
  return 'api_key';
}

const SECRET_NAME = /key|token|secret|pass|pwd|auth(?!or(?:_|$))|credential|private|session|cookie|signature|salt|dsn|webhook|jwt|bearer|cert|otp|(?:^|_)pat(?:_|$)/i;
const PLAIN_END = /(?:^|_)(?:url|uri|host|port|path|dir|file|endpoint|domain|timeout|ttl|enabled)$/i;
const ID_NAME = /(?:^|_)id$/i;
/** A long token-shaped value: letters and digits with "." "_" "~" "-" only, no space, no "/" or ":" (so no path or address); see credentialShaped. */
const CREDENTIAL_SHAPE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._~-]{32,}={0,2}$/;
const PASSWORD_URL = /:\/\/[^\s/@:]*:[^\s/@]+@/;

/**
 * Whether a pair of a file holds a secret, not a plain setting (NODE_ENV, PORT, an address): its name says key, token,
 * secret, password and the like – an address or path of one (AUTH_URL, PRIVATE_KEY_PATH) stays a setting, a webhook's or
 * DSN's is a secret – or its value is a URL with a password in it.
 */
export function isSecretPair(pair: KeyValue): boolean {
  if (PASSWORD_URL.test(pair.value)) return true;
  const name = pair.name.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/[.-]/g, '_'); // apiKeyFile → api_Key_File
  return SECRET_NAME.test(name) && (!PLAIN_END.test(name) || /webhook|dsn/i.test(name));
}

/** Credential-like, not a slug: the CREDENTIAL_SHAPE and either a fifth of it digits (hex ids) or both letter cases (base64 ids) – a hyphenated word list with a number in it is a setting. */
function credentialShaped(value: string): boolean {
  const text = value.trim();
  return CREDENTIAL_SHAPE.test(text) && ((text.match(/\d/g)?.length ?? 0) / text.length >= 0.2 || (/[a-z]/.test(text) && /[A-Z]/.test(text)));
}

/**
 * 0.3.20 (feedback 9A50C098, 17.11.2026: a 62-character OAuth client id of a .env file was dropped silently while the secret next
 * to it was imported – its name, LWA_CLIENT_ID, says no key/token/secret, so isSecretPair called it a plain setting): a file
 * import also keeps a pair whose name ends in "id" and whose value is as long and mixed as a credential. An id is no
 * secret on its own, but an agent needs it beside its secret and the catalog is where both belong; a short or word-like id
 * (CUSTOMER_ID=42, REGION_ID=eu-west) stays a setting. Used by the import only – the Settings rows and MCP env keep isSecretPair.
 */
export function isCredentialId(pair: KeyValue): boolean {
  const name = pair.name.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/[.-]/g, '_');
  return ID_NAME.test(name) && credentialShaped(pair.value);
}

/** Why a file import leaves a pair out – its name and this reason are reported, never its value; undefined when it is kept. */
export function pairSkipReason(pair: KeyValue, minChars: number): string | undefined {
  const length = pair.value.trim().length;
  if (!length) return 'the value is empty';
  if (length < minChars) return `the value is only ${length} characters (at least ${minChars} are needed so it can be masked)`;
  if (isSecretPair(pair) || isCredentialId(pair)) return undefined;
  return 'looks like a plain setting, not a secret (its name has no key, token, secret, password or similar word, and the value is no long credential-like id) – rename it, or add it with secrets.save';
}
