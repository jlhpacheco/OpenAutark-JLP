// MCP settings use named apps.* RPCs (the same app controls on PC and a secure phone); the existing desktop-only mailbox
// editor still writes its file through files.*. AI/configuration imports may continue using the broader file path. The runtime
// watcher applies changes and `apps.changed` brings the rows up to date. Secret values go into the catalog; the file holds handles.
// A pasted Claude Desktop/Code/Cursor config goes in as it is (pastedServers); only values that hold a secret (isSecretPair, an
// Authorization header) move into the catalog, a plain setting like NODE_ENV stays readable in the file.
// Owns: pure editor transforms, entries forms/paste make, secret extraction, and the legacy desktop mailbox edit.
// Never: holds a value after handing it to secrets.save, writes a key into a file, or connects anything itself (the runtime does).

import type { AppStatus, ConnectedApp, MailServer } from '../../shared/model/apps.ts';
import { isSecretPair, kindForName } from '../../shared/model/key-values.ts';
import type { SecretInfo } from '../../shared/model/security.ts';
import { rpc } from '../lib/rpc.ts';

export type ConnectorFile = 'mcp.json' | 'mail.json';
type Json = Record<string, unknown>;

const SECTION: Readonly<Record<ConnectorFile, string>> = { 'mcp.json': 'mcpServers', 'mail.json': 'mailboxes' };

export const fileOf = (app: Pick<ConnectedApp, 'transport'>): ConnectorFile => (app.transport === 'mail' ? 'mail.json' : 'mcp.json');

const STATUS: Readonly<Record<AppStatus, string>> = { ok: 'Connected', connecting: 'Connecting…', waiting: 'Waiting for the sign-in in your browser', signin: 'Needs a sign-in', error: 'Not connected', off: 'Off' };
export const toolCount = (tools: number): string => `${tools} ${tools === 1 ? 'tool' : 'tools'}`;

/** The app's one line: its address, its state or why not, its tools. */
export function appLine(app: Pick<ConnectedApp, 'address' | 'status' | 'error' | 'tools'>): string {
  const state = app.status === 'ok' ? toolCount(app.tools) : app.error || STATUS[app.status];
  return [app.address, state].filter(Boolean).join(' · ');
}

/** The one action of the row's cell by its status: Test, Connect again, the open sign-in page; none while off; `wait` runs nothing new while it connects. */
export function appAction(app: Pick<ConnectedApp, 'status' | 'signInUrl'>): { kind: 'test' | 'connect' | 'page'; label: string; wait?: true } | undefined {
  switch (app.status) {
    case 'ok': return { kind: 'test', label: 'Test' };
    case 'signin': case 'error': return { kind: 'connect', label: 'Connect again' };
    case 'waiting': return app.signInUrl ? { kind: 'page', label: 'Sign-in page' } : { kind: 'connect', label: 'Connect again' };
    case 'connecting': return { kind: 'test', label: 'Test', wait: true };
    default: return undefined;
  }
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's object and its section; a file that is broken stays untouched (the error names it). */
function parsed(file: ConnectorFile, text: string): { root: Json; entries: Json } {
  let root: unknown;
  try { root = JSON.parse(text.replace(/^﻿/, '') || '{}'); } catch { throw new Error(`${file} is not valid JSON. Open it and fix it first.`); }
  if (!isRecord(root)) throw new Error(`${file} must hold an object. Open it and fix it first.`);
  const entries = root[SECTION[file]] ?? {};
  if (!isRecord(entries)) throw new Error(`"${SECTION[file]}" in ${file} must be an object. Open it and fix it first.`);
  return { root, entries };
}

const written = (file: ConnectorFile, root: Json, entries: Json): string => `${JSON.stringify({ ...root, [SECTION[file]]: entries }, null, 2)}\n`;

/** A key not in use yet: `name`, else "name 2", "name 3" … (a new entry never replaces one). */
export function freeKey(name: string, entries: Json): string {
  if (!Object.hasOwn(entries, name)) return name;
  for (let n = 2; ; n += 1) if (!Object.hasOwn(entries, `${name} ${n}`)) return `${name} ${n}`;
}

/** Throws when the file is broken (the error names it), before anything is stored for it. */
export function checkFile(file: ConnectorFile, text: string): void {
  parsed(file, text);
}

/** The file with each server added under a free name. */
export function withEntries(file: ConnectorFile, text: string, servers: readonly PastedServer[]): string {
  const { root, entries } = parsed(file, text);
  const next = { ...entries };
  for (const server of servers) next[freeKey(server.name, next)] = server.entry;
  return written(file, root, next);
}

/** The file with a new entry `name` (made free). */
export const withEntry = (file: ConnectorFile, text: string, name: string, entry: Json): string => withEntries(file, text, [{ name, entry }]);


/** The entry `name` changed by `patch`; a key set to undefined leaves it. */
export function patchedEntry(file: ConnectorFile, text: string, name: string, patch: Json): string {
  const { root, entries } = parsed(file, text);
  const entry = entries[name];
  if (!isRecord(entry)) throw new Error(`"${name}" is no longer in ${file}.`);
  return written(file, root, { ...entries, [name]: { ...entry, ...patch } });
}


/** An HTTP header that carries a token by its handle. */
export const tokenHeaders = (secretId: string): Json => ({ Authorization: `Bearer secret://${secretId}` });

/** The entry `name` with this token; its other headers stay, the one it replaces is any spelling of Authorization. */
export function withToken(file: ConnectorFile, text: string, name: string, secretId: string): string {
  const headers = parsed(file, text).entries[name];
  const now = isRecord(headers) && isRecord(headers.headers) ? headers.headers : {};
  const kept = Object.fromEntries(Object.entries(now).filter(([header]) => header.toLowerCase() !== 'authorization'));
  return patchedEntry(file, text, name, { headers: { ...kept, ...tokenHeaders(secretId) } });
}

/** One command line as program and arguments ("quoted parts" stay together). */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = (line.match(/"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^"|"$/g, ''));
  return { command: parts[0] ?? '', args: parts.slice(1) };
}

const hostOf = (address: string): string | undefined => /^https?:\/\/([^/:?#]+)/i.exec(address)?.[1];
const hostName = (host: string): string => (/^\d+(\.\d+){3}$/.test(host) ? host : host.replace(/^(www|mcp|api)\./, '').split('.')[0] || host);
const baseName = (path: string): string => path.split(/[\\/]/).pop()?.replace(/[@:][^@:]*$/, '').replace(/\.(exe|cmd|bat|ps1|com|m?js|py)$/i, '') ?? '';

/**
 * A name for a server without one: an address's host (an IP whole); for a command the server it runs – the host of an address
 * among `args`, a scoped package, an argument naming "mcp" – else the program's name.
 */
export function nameFromAddress(address: string, args: readonly string[] = []): string {
  const host = hostOf(address) ?? args.map(hostOf).find(Boolean);
  if (host) return hostName(host);
  const runs = args.find((arg) => /^@[\w.-]+\/[\w.-]/.test(arg)) ?? args.find((arg) => !arg.startsWith('-') && /mcp/i.test(arg));
  return (runs && baseName(runs)) || baseName(address) || 'app';
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9.-]+$/i;

/** A server from host and port ('' port: `fallback`); TLS follows the port (143/587/25/2525: STARTTLS). */
function mailServer(host: string, port: string, fallback: number): MailServer | string {
  const name = host.trim();
  if (!name) return 'Enter both servers, or leave them all empty';
  if (!HOST.test(name)) return 'A server is a host name like imap.example.com';
  const number = port.trim() ? Number(port.trim()) : fallback;
  if (!Number.isInteger(number) || number < 1 || number > 65535) return 'A port is a number from 1 to 65535';
  return { host: name, port: number, tls: [143, 587, 25, 2525].includes(number) ? 'starttls' : 'implicit' };
}

export interface MailFields { address: string; password: string; imapHost: string; imapPort: string; smtpHost: string; smtpPort: string }

/** Why the mailbox form cannot save yet ('' = it can), and the entry without its password. */
export function mailEntry(fields: MailFields): { blocked: string; entry?: Json } {
  const address = fields.address.trim();
  if (!address || !ADDRESS.test(address)) return { blocked: 'Enter an email address like name@example.com' };
  if (!fields.password) return { blocked: 'Enter the password' };
  if (!`${fields.imapHost}${fields.imapPort}${fields.smtpHost}${fields.smtpPort}`.trim()) return { blocked: '', entry: { address } };
  const imap = mailServer(fields.imapHost, fields.imapPort, 993);
  if (typeof imap === 'string') return { blocked: imap };
  const smtp = mailServer(fields.smtpHost, fields.smtpPort, 465);
  if (typeof smtp === 'string') return { blocked: smtp };
  return { blocked: '', entry: { address, imap, smtp } };
}

export interface PastedServer { name: string; entry: Json }

const serverAddress = (entry: Json): string => [entry.url, entry.serverUrl, entry.command].find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? '';

/** An object from pasted text; a fragment like `"mcpServers": {…}` without its outer braces is read as one. */
function pastedObject(text: string): Json | string {
  const source = text.replace(/^﻿/, '').trim();
  if (!source) return 'Paste an mcpServers block from Claude Desktop, Claude Code or Cursor';
  for (const candidate of source.startsWith('{') ? [source] : [source, `{${source.replace(/,\s*$/, '')}}`]) {
    try {
      const value: unknown = JSON.parse(candidate);
      return isRecord(value) ? value : 'This is JSON, but not an object of servers';
    } catch { /* the next candidate */ }
  }
  try { JSON.parse(source); } catch (failure) { return `Not valid JSON: ${(failure as Error).message}`; }
  return 'Not valid JSON';
}

/**
 * The servers of a pasted config – {"mcpServers": {…}} (Claude Desktop, Claude Code, Cursor), {"servers": {…}} (VS Code), the bare
 * map or one server – each as it is, without "type" and with "serverUrl" as "url". `error`: the first entry without a command or
 * an address, or why the text is no config ('' = all of them go in).
 */
export function pastedServers(text: string): { servers: PastedServer[]; error: string } {
  const root = pastedObject(text);
  if (typeof root === 'string') return { servers: [], error: root };
  const args = Array.isArray(root.args) ? root.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const map = isRecord(root.mcpServers) ? root.mcpServers : isRecord(root.servers) ? root.servers : serverAddress(root) ? { [nameFromAddress(serverAddress(root), args)]: root } : root;
  const servers: PastedServer[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (!isRecord(value) || !serverAddress(value)) return { servers: [], error: `"${name}" needs a "command" or a "url"` };
    const { type: _type, serverUrl, ...entry } = value;
    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== '';
    servers.push({ name, entry: hasUrl || typeof serverUrl !== 'string' || !serverUrl.trim() ? entry : { ...entry, url: serverUrl } });
  }
  return servers.length ? { servers, error: '' } : { servers, error: 'No server in it' };
}

/** One value of an entry that goes into Secrets: env or headers, its key, the scheme kept in front ("Bearer "), the value itself. */
export interface SecretSpot { field: 'env' | 'headers'; key: string; prefix: string; value: string }

/** A raw secret handle will be resolved by the host, so adding it requires Secrets capability too. */
export const hasSecretReference = (value: string): boolean => /secret:\/\/[A-Za-z0-9_-]{1,128}/i.test(value);

export function entryUsesSecretReference(entry: Json): boolean {
  return (['env', 'headers'] as const).some((field) => isRecord(entry[field]) && Object.values(entry[field]).some((value) => typeof value === 'string' && hasSecretReference(value)));
}

const SCHEME = /^(?:Bearer|Token|Basic)\s+/i;

/** Whether a header (`header`) or env value goes into Secrets: any Authorization header, else what isSecretPair calls a secret. */
export const holdsSecret = (key: string, value: string, header: boolean): boolean => (header && key.trim().toLowerCase() === 'authorization') || isSecretPair({ name: key.trim(), value });

/** The values of `entry` that hold a secret (isSecretPair, any Authorization header); a handle or a ${VAR} placeholder stays as it is. */
export function secretSpots(entry: Json): SecretSpot[] {
  const spots: SecretSpot[] = [];
  for (const field of ['env', 'headers'] as const) {
    const values = entry[field];
    if (!isRecord(values)) continue;
    for (const [key, raw] of Object.entries(values)) {
      if (typeof raw !== 'string' || !raw.trim() || raw.includes('secret://') || raw.includes('${')) continue;
      if (!holdsSecret(key, raw, field === 'headers')) continue;
      const prefix = field === 'headers' ? SCHEME.exec(raw)?.[0] ?? '' : '';
      if (raw.slice(prefix.length).trim()) spots.push({ field, key, prefix, value: raw.slice(prefix.length).trim() });
    }
  }
  return spots;
}

type Store = (label: string, kind: SecretInfo['kind'], value: string, description: string) => Promise<string>;

/** `entry` with each secret value in the catalog and its handle in the file (`store` saves one and gives its id). */
export async function movedSecrets(name: string, entry: Json, store: Store = storeKey): Promise<Json> {
  const out: Json = { ...entry };
  for (const spot of secretSpots(entry)) {
    const auth = spot.key.toLowerCase() === 'authorization';
    const id = await store(auth ? `${name} token` : `${name} ${spot.key}`, auth ? 'token' : kindForName(spot.key), spot.value, `Connects the app ${name} (Settings › Apps).`);
    out[spot.field] = { ...(out[spot.field] as Json), [spot.key]: `${spot.prefix}secret://${id}` };
  }
  return out;
}

/** A validation-only copy: the runtime checks the exact shape without receiving a pasted secret value. */
function preflightEntry(entry: Json): Json {
  const out: Json = { ...entry };
  for (const spot of secretSpots(entry)) {
    out[spot.field] = { ...(out[spot.field] as Json), [spot.key]: `${spot.prefix}secret://preflight` };
  }
  return out;
}

/** The paste dialog's check line for servers that parsed: their names, how many keys go into Secrets, a ${…} still to fill in. */
export function pasteLine(servers: readonly PastedServer[]): string {
  const keys = servers.reduce((sum, server) => sum + secretSpots(server.entry).length, 0);
  return [
    `Adds ${servers.map((server) => server.name).join(', ')}`,
    keys ? `${keys} ${keys === 1 ? 'key goes' : 'keys go'} into Secrets` : '',
    servers.some((server) => JSON.stringify(server.entry).includes('${')) ? 'fill in each ${…} first' : '',
  ].filter(Boolean).join(' · ');
}

/** The env (a command) or header (an address) values of the own-server form's rows; `blocked` names a row that cannot go in. */
export function namedValues(kind: 'url' | 'command', rows: ReadonlyArray<{ name: string; value: string }>): { values: Record<string, string>; blocked: string } {
  const values: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!name) return { values, blocked: 'Give every value a name' };
    if (kind === 'url' ? !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) : /[\s=]/.test(name)) return { values, blocked: `"${name}" is not ${kind === 'url' ? 'a header' : 'a variable'} name` };
    values[name] = row.value;
  }
  return { values, blocked: '' };
}

/** A key into the catalog; the file gets its handle. */
export async function storeKey(label: string, kind: SecretInfo['kind'], value: string, description: string): Promise<string> {
  return (await rpc.call('secrets.save', { label, kind, value, description })).id;
}

/**
 * Reads the file, applies `change` to its text and writes it back, unless someone changed it in between (a conflict the caller
 * shows). An async `change` stores its keys after it has checked the text, so a broken file leaves no key behind.
 */
export async function editConnectors(file: ConnectorFile, change: (text: string) => string | Promise<string>): Promise<void> {
  const root = (await rpc.call('system.root')).path;
  const slash = root.includes('\\') ? '\\' : '/';
  const path = `${root}${slash}connectors${slash}${file}`;
  const now = await rpc.call('files.readPath', { path });
  if (now.state !== 'text' && now.state !== 'missing') throw new Error(`${file} cannot be read as text.`);
  await rpc.call('files.writePath', { path, text: await change(now.text ?? ''), ...(now.stamp ? { base: now.stamp } : {}) });
}

/** Preflight the entire batch without secret bytes; then store secret values and send only handles to apps.add. */
export async function addServers(servers: readonly PastedServer[]): Promise<void> {
  await rpc.call('apps.validateAdd', { entries: servers.map((server) => ({ name: server.name, entry: preflightEntry(server.entry) })) });
  const moved: PastedServer[] = [];
  for (const server of servers) moved.push({ name: server.name, entry: await movedSecrets(server.name, server.entry) });
  await rpc.call('apps.add', { entries: moved });
}
