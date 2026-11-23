// RPC handlers behind the pane's file tab: read, write and list by absolute path, anywhere on the PC – for the person
// on the PC and on the phone ('manage' on a secure transport: the phone's pane is the PC's, B-076; the whole disk with
// the plan logins and settings.json never goes over plain LAN http, like the live picture). A file is text when it is valid UTF-8
// without NUL bytes and small enough to edit; anything else says so and is not sent. A write is atomic
// (runtime/root/text-doc.ts) and made as an outside edit, so the data folder watcher applies a saved settings.json or
// SYSTEM.md like any other change on disk. B-076: a tab that came from a linked CEO PC names it in `device`, and the
// call goes on to that PC (devices/sync/paths.ts), which answers with PATH_OPS – the same rules, the same stamps.
// B-081: a path that holds nothing answers with `near`, up to 5 similar existing paths found on the PC that holds it
// (files/near-paths.ts) – the tabs' not-found page; a tab's look on a still missing file (`since: ''`) stays one stat.
// Sicher-Runde 19.11.2026 (REVIEW-2 3): the call to another PC says who asks – the person, the calling agent, or neither –
// and that PC gates it (devices/sync/paths.ts); this PC's own gate (security/rpc-guard.ts) judged the path already.
// 20.11.2026 (review of FCMWO5R5): a network path (`\\host\share\…`) – read, written, listed or stored, here or on a
// linked PC – reaches its host only once the person has confirmed that host on this PC (files/net-hosts.ts); the
// refusal names the host, and files.allowHost is the person's answer.
// Owns: these methods (and files.allowHost), their operations and the stamp. Never: confines paths, keeps history or
// knows what a file means.

import type { Dirent, Stats } from 'node:fs';
import { chmod, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import '../../../shared/api/methods-files.ts'; // the method shapes (module augmentation)
import type { PathEntry, PathList, PathRead, PathWritten } from '../../../shared/api/methods-files.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { selfId } from '../../devices/sync/home.ts';
import { remotePathsOf, type PathCaller, type PathOp } from '../../devices/sync/paths.ts';
import { isPersonScope } from '../../security/rpc-guard.ts';
import { nearPaths } from '../../files/near-paths.ts';
import { checkNetHost, confirmHost } from '../../files/net-hosts.ts';
import { writeAtomic } from '../../root/text-doc.ts';
import { bad, input, onlyKeys, optId, optText, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

/** Larger files are not sent to the editor (a plain text field stays usable up to here). */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** What a save may hold (typed or pasted text can pass the read limit). */
const WRITE_MAX_CHARS = 16 * 1024 * 1024;
/** A folder's list stops here; `total` says how many there are. */
export const LIST_MAX_ENTRIES = 5000;
/** The owner and the phone (its pane is the PC's) on a secure transport. */
export const PATH_RULE = { capability: 'manage', secure: true } as const;

type Obj = Record<string, unknown>;

const stampOf = (info: Stats): string => `${Math.round(info.mtimeMs)}:${info.size}`;
const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? '';
const isGone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(codeOf(error));

/** A file system failure in words the person can use. */
function failure(error: unknown, doing: string, target: string): WorkforceError {
  const code = codeOf(error);
  const name = path.basename(target) || target;
  if (isGone(error)) return new WorkforceError('not_found', `${name} no longer exists.`);
  if (code === 'EACCES' || code === 'EPERM') return new WorkforceError('forbidden', `The system does not allow ${doing} ${name}.`);
  return new WorkforceError('unavailable', `Could not finish ${doing} ${name}${code ? ` (${code})` : ''}.`, { cause: error });
}

export function absolutePath(o: Obj): string {
  const requested = text(o, 'path', { max: 4096 });
  if (!path.isAbsolute(requested)) bad('path', 'an absolute path');
  return path.resolve(requested);
}

/** The bytes as text, or undefined when they are not text. The BOM stays, so a save gives the file back as it was. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}

async function readAt(target: string, since: string | undefined): Promise<PathRead> {
  let info: Stats;
  try { info = await stat(target); } catch (error) {
    if (!isGone(error)) throw failure(error, 'reading', target);
    if (since === '') return { path: target, state: 'same', size: 0, stamp: '' }; // a tab's look: still nothing there
    return { path: target, state: 'missing', size: 0, stamp: '', near: await nearPaths(target) };
  }
  if (info.isDirectory()) return { path: target, state: 'folder', size: 0, stamp: '' };
  const stamp = stampOf(info);
  const facts = { path: target, size: info.size, stamp };
  if (since === stamp) return { ...facts, state: 'same' };
  if (!info.isFile()) return { ...facts, state: 'binary' };
  if (info.size > TEXT_MAX_BYTES) return { ...facts, state: 'large' };
  let bytes: Uint8Array;
  try { bytes = await readFile(target); } catch (error) { throw failure(error, 'reading', target); }
  const content = textOf(bytes);
  return content === undefined ? { ...facts, state: 'binary' } : { ...facts, state: 'text', text: content };
}

async function isFolder(target: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return (await stat(target)).isDirectory(); } catch { return false; } // a broken link lists as a file
}

async function writeAt(o: Obj): Promise<PathWritten> {
  onlyKeys(o, ['path', 'text', 'base']);
  const target = absolutePath(o);
  const content = o.text;
  if (typeof content !== 'string') bad('text', 'a string');
  if (content.length > WRITE_MAX_CHARS) bad('text', `at most ${WRITE_MAX_CHARS} characters`);
  const base = optText(o, 'base', { max: 64, allowEmpty: true });
  const before = await stat(target).catch(() => undefined);
  if (before?.isDirectory()) throw new WorkforceError('conflict', 'This path is a folder.');
  if (base !== undefined && (before ? stampOf(before) : '') !== base) throw new WorkforceError('conflict', 'This file changed on disk.');
  try {
    const real = before ? await realpath(target) : target; // a link stays a link: its target gets the text
    writeAtomic(real, content);
    if (before && process.platform !== 'win32') await chmod(real, before.mode & 0o7777);
    const after = await stat(real);
    return { path: target, size: after.size, stamp: stampOf(after) };
  } catch (error) { throw failure(error, 'writing', target); }
}

async function listAt(o: Obj): Promise<PathList> {
  onlyKeys(o, ['path']);
  const target = absolutePath(o);
  const above = path.dirname(target);
  const parent = above === target ? {} : { parent: above };
  let found: Dirent[];
  try { found = await readdir(target, { withFileTypes: true }); } catch (error) {
    if (codeOf(error) === 'ENOENT') return { path: target, ...parent, entries: [], total: 0, missing: true as const, near: await nearPaths(target) };
    if (codeOf(error) === 'ENOTDIR') throw new WorkforceError('conflict', 'This path is not a folder.');
    throw failure(error, 'listing', target);
  }
  const entries = await Promise.all(found.slice(0, LIST_MAX_ENTRIES).map(async (entry): Promise<PathEntry> => {
    const at = path.join(target, entry.name);
    return { name: entry.name, path: at, folder: await isFolder(at, entry) };
  }));
  entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: target, ...parent, entries, total: found.length };
}

/** The three operations on this PC, on parameters without `device` – the methods below and a linked CEO PC's files.path. */
export const PATH_OPS = {
  read: (o: Obj): Promise<PathRead> => {
    onlyKeys(o, ['path', 'since']);
    return readAt(absolutePath(o), optText(o, 'since', { max: 64, allowEmpty: true }));
  },
  write: writeAt,
  list: listAt,
};

/** `params` without `device`: here, or – naming another PC – on that PC. */
export function onDevice<T>(ctx: HandlerContext, params: unknown, op: PathOp, here: (o: Obj) => Promise<T>): Promise<T> {
  const o = input(params);
  const device = optId(o, 'device');
  const { device: _device, ...rest } = o;
  checkNetHost(ctx.services.db, rest.path); // a network host only once the person confirmed it here, for any PC
  if (device && device !== selfId(ctx.services.db)) return remotePathsOf(ctx.services).forward(device, op, rest, callerOf(ctx)) as Promise<T>;
  return here(rest);
}

/** Who makes this call, as the other PC's gate reads it: the person (or the runtime itself), an agent's wf, or neither. */
export function callerOf(ctx: Pick<HandlerContext, 'scope' | 'services'>): PathCaller {
  const scope = ctx.scope;
  if (!scope || isPersonScope(scope)) return { person: true };
  if (scope.kind !== 'owner' || !scope.agentId) return {};
  let agentName: string | undefined;
  try { agentName = ctx.services.org.get(scope.agentId)?.name; } catch { agentName = undefined; }
  return { agentId: scope.agentId, ...(agentName ? { agentName } : {}) };
}

export function register(table: HandlerTable): void {
  table.add('files.readPath', (params, ctx) => onDevice(ctx, params, 'read', PATH_OPS.read), PATH_RULE);
  table.add('files.writePath', (params, ctx) => onDevice(ctx, params, 'write', PATH_OPS.write), PATH_RULE);
  table.add('files.listPath', (params, ctx) => onDevice(ctx, params, 'list', PATH_OPS.list), PATH_RULE);
  // The person's answer to a network host's question: this PC may go there from now on. An agent's call is refused.
  table.add('files.allowHost', (params, ctx) => {
    if (!('person' in callerOf(ctx))) throw new WorkforceError('forbidden', 'Only the person confirms a network host.');
    const o = input(params);
    onlyKeys(o, ['host']);
    return { host: confirmHost(ctx.services.db, text(o, 'host', { max: 255 }), Date.now()) };
  }, PATH_RULE);
}
