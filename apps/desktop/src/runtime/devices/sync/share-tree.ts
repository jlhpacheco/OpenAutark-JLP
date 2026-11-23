// Umzug 21.11.2026, part 2 (owner: at home on several PCs, "so halten die sich gegenseitig synchron … Browser und
// Dateien"): the plain parts of the home-project mirror (share-project.ts, share-take.ts) – which paths of a home
// project travel (never .git, node_modules, .venv, __pycache__, a pull's part file, or a name another system cannot
// hold), the walk of the folder, one file's look, the folder's identity, what this PC remembers per folder
// (<data>/share/project-<hash of the folder>.json: the folder's identity, every file as last seen, and per home PC the
// sha both agreed on), the one decision for a file two PCs hold differently, and the name a file gets that lost against
// a newer one changed on both sides.
// Round 3: a look says three things apart – the file as it is, 'gone' (it is not there, and no link lies on the way to
// it) and 'skip' (a link, a folder, a file over 256 MiB, or a path that leaves the folder through a link or junction:
// not carried, never a deletion); a file that cannot be read throws, and its caller leaves it as it was. Guard is the
// one check that a path stays inside the folder without following a link.
// Owns: these rules and that file. Never: dials, deletes or writes inside a home project.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from './file-io.ts';

/** Folders of a project that stay on their PC (each PC builds its own). */
export const SKIP: ReadonlySet<string> = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
/** A larger file stays on its PC. */
export const MAX_BYTES = 256 * 1024 * 1024;
/** A pull grows beside its target under this ending; the mirror never looks at it. */
export const PART = '.autark-part';
const MAX_FILES = 200_000;
/** Names one of the systems cannot hold: its forbidden characters, a trailing dot or space, a device name. */
const UNPORTABLE = /[\\:*?"<>|\u0000-\u001f]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** A file as this PC last saw it. */
export interface Seen { sha: string; size: number; mtime: number }
/** What travels about a file: sha '' = it is gone. */
export interface Have { rel: string; sha: string; size: number; mtime: number }
/** What this PC remembers of one home project folder; `id`: the folder it was (rootId). */
export interface Index { home: string; id: string; files: Record<string, Seen>; agreed: Record<string, Record<string, string>> }
/** A look: the file, 'gone', or 'skip' (not carried here – never a deletion). */
export type Look = Seen | 'gone' | 'skip';

const fold = (text: string) => (process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text);

/** Whether `rel` (forward slashes, below the home project) is a path the mirror carries. */
export function carried(rel: string): boolean {
  if (!rel || rel.length > 1024 || rel.endsWith(PART)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !SKIP.has(part) && !UNPORTABLE.test(part));
}

/** `rel` below `root` on this system; undefined when it is no carried path. */
export function inside(root: string, rel: string): string | undefined {
  return carried(rel) ? path.join(root, ...rel.split('/')) : undefined;
}

/** The folder `root` is now – another one under the same path has another identity; undefined: no folder is there. */
export function rootId(root: string): string | undefined {
  try {
    const info = statSync(root, { bigint: true });
    return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a path stays inside `root` with no link or junction on the way to it (the folders are asked once per guard). */
export class Guard {
  private readonly root: string;
  private real?: Promise<string>;
  private readonly dirs = new Map<string, Promise<boolean>>();

  constructor(root: string) {
    this.root = root;
  }

  /** True when every existing folder above `rel` is a real folder of this project. */
  ok(rel: string): Promise<boolean> {
    if (!carried(rel)) return Promise.resolve(false);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    let known = this.dirs.get(dir);
    if (!known) this.dirs.set(dir, (known = this.folder(dir).catch(() => false)));
    return known;
  }

  private async folder(dir: string): Promise<boolean> {
    for (let rel = dir; ; rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '') {
      const abs = rel ? path.join(this.root, ...rel.split('/')) : this.root;
      const info = await lstat(abs).catch(() => undefined);
      if (!info) { if (!rel) return false; continue; } // not there yet: the folder above decides
      if (rel && !info.isDirectory()) return false; // a link, a junction or a file on the way
      const [here, top] = await Promise.all([realpath(abs), (this.real ??= realpath(this.root))]);
      return fold(path.relative(top, here).split(path.sep).join('/')) === fold(rel);
    }
  }
}

/** Every carried file below `root` (links are not followed, skipped folders not entered). */
export async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < MAX_FILES) {
    const dir = queue.pop()!;
    for (const entry of await readdir(path.join(root, ...dir.split('/')), { withFileTypes: true }).catch(() => [])) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (!carried(rel)) continue;
      if (entry.isDirectory()) queue.push(rel); else if (entry.isFile()) out.push(rel);
    }
  }
  return out;
}

/**
 * The file `rel` as it is now, hashed only when its size or mtime moved since `old`. 'gone': nothing is there; 'skip':
 * what is there is not carried. Throws when the file cannot be looked at or read (held open, no access).
 */
export async function look(root: string, rel: string, old: Seen | undefined, guard: Guard): Promise<Look> {
  const file = inside(root, rel);
  if (!file) return 'skip';
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return await guard.ok(rel) ? 'gone' : 'skip';
  }
  if (!info.isFile() || info.size > MAX_BYTES || !await guard.ok(rel)) return 'skip';
  if (old && old.size === info.size && old.mtime === info.mtimeMs) return old;
  return { sha: await hashFile(file), size: info.size, mtime: info.mtimeMs };
}

/**
 * What this PC does with a file the other PC holds as `theirs` (sha, '' = gone) while it holds `mine` and both last
 * agreed on `base`: 'same' – nothing; 'take' – theirs comes (only they changed it); 'give' – mine goes (only I changed
 * it); 'aside' – both changed it and theirs is the newer one: mine stays beside it under copyName, theirs comes.
 */
export function decide(mine: Seen | undefined, base: string | undefined, theirs: Pick<Have, 'sha' | 'mtime'>): 'same' | 'take' | 'give' | 'aside' {
  const m = mine?.sha ?? '';
  const b = base ?? '';
  if (theirs.sha === m) return 'same';
  if (m === b) return 'take';
  if (theirs.sha === b || !theirs.sha) return 'give'; // gone there, changed here: the change stays
  if (!m) return 'take'; // gone here, changed there
  return newer(theirs, mine!) ? 'aside' : 'give';
}

/** Whether `a` is the later writer (the file's own time; the same time: the larger sha, so both PCs say the same). */
export function newer(a: Pick<Have, 'sha' | 'mtime'>, b: Pick<Have, 'sha' | 'mtime'>): boolean {
  const [x, y] = [Math.floor(a.mtime), Math.floor(b.mtime)];
  return x !== y ? x > y : a.sha > b.sha;
}

/** "notes.md" → "notes (from Tower).md": the name of the version `pc` wrote that lost against a newer one. */
export function copyName(rel: string, pc: string): string {
  const at = rel.lastIndexOf('/');
  const { name, ext } = path.posix.parse(rel.slice(at + 1));
  const from = pc.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/[. ]+$/, '').trim() || 'another PC';
  return `${rel.slice(0, at + 1)}${name} (from ${from})${ext}`;
}

const indexFile = (data: string, key: string) => path.join(data, 'share', `project-${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);
/** Nothing remembered of the folder `id`. */
export const freshIndex = (home: string, id: string): Index => ({ home, id, files: {}, agreed: {} });
const fresh = freshIndex;

/** What this PC remembers of the folder `key` (the folder `id` it is now); fresh when it has nothing for that very folder. */
export async function readIndex(data: string, key: string, home: string, id: string): Promise<Index> {
  try {
    const value = JSON.parse(await readFile(indexFile(data, key), 'utf8')) as Partial<Index>;
    if (value.id === id && value.files && typeof value.files === 'object' && value.agreed && typeof value.agreed === 'object') return { ...value, home } as Index;
  } catch { /* none yet, or unreadable: fresh */ }
  return fresh(home, id);
}

/**
 * Forgets what this PC remembered of `key` (its folder went or was replaced). A folder's identity is its device and
 * inode, and a file system may give a new folder the inode of one just removed (ext4 does): a remembered list would
 * then count for the new folder, and its missing files as deleted here (CI 23.11.2026). Gone means forgotten.
 */
export async function forgetIndex(data: string, key: string): Promise<void> {
  await rm(indexFile(data, key), { force: true });
}

export async function writeIndex(data: string, key: string, index: Index): Promise<void> {
  const file = indexFile(data, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(index));
  await rename(`${file}.tmp`, file);
}
