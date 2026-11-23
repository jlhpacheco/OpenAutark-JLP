// Where a file or folder sent from a linked PC lands here and under which name (Umzug 21.11.2026, PCSEC; the protocol is
// receive-file.ts). The place: `at` when it is a folder here, else the folder it lay in on the sending PC when this PC
// has it, else inbox/<sending PC>/ of the workspace – and the inbox too when this PC's rules keep the folder closed to
// the sending agent (a call naming no agent gets only what is open), with a note why. A path that is no local absolute
// path on this system (a network path `\\host\…`, `\\?\…`, a POSIX path on Windows and the reverse) is never touched: it
// counts as no folder. Names: only what Windows cannot hold is changed (forbidden characters, trailing dots and spaces,
// the reserved CON, PRN, AUX, NUL, COM1–9, LPT1–9 get "_"); leading dots stay (.git, .env). A taken name gets " (2)" –
// a file is put in place by first creating its final name exclusively, so two landings never overwrite each other.
// Owns: the landing place, names, putting a finished file or folder in place, and the free space there. Never: reads a
// piece, writes outside the landing folder, or replaces a file that was there.

import { open, rename, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** One file or folder name as Windows can hold it; `fallback` for a name that is only dots and spaces. */
export function clean(name: string, fallback: string): string {
  const out = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120).replace(/[\s.]+$/, '');
  if (!out.replace(/[\s.]/g, '')) return fallback;
  const dot = out.indexOf('.');
  const stem = dot <= 0 ? out : out.slice(0, dot); // '.env': no stem to check
  return RESERVED.test(stem.trim()) ? `${stem}_${out.slice(stem.length)}` : out;
}

/** True for an absolute path of this system's own disks; a network path or another system's spelling is not. */
export function localAbsolute(target: string): boolean {
  if (/^[\\/]{2}/.test(target)) return false; // \\host\share, \\?\…, //host
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(target) : target.startsWith('/');
}

const exists = async (target: string): Promise<boolean> => Boolean(await stat(target).catch(() => undefined));
const isFolder = async (target: string): Promise<boolean> => Boolean((await stat(target).catch(() => undefined))?.isDirectory());

/** The n-th candidate: "name", "name (2).ext", … ("name (2)" for a folder). */
function candidate(dir: string, name: string, n: number, folder: boolean): string {
  if (n === 1) return path.join(dir, name);
  const { name: stem, ext } = folder ? { name, ext: '' } : path.parse(name); // '.env' parses as a name without extension
  return path.join(dir, `${stem} (${n})${ext}`);
}

/** Puts the finished `part` in `dir` under the first free name: that name is created exclusively first, then filled. */
export async function placeFile(part: string, dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const target = candidate(dir, name, n, false);
    let handle;
    try { handle = await open(target, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    await handle.close();
    await rename(part, target); // over the empty file just made for it
    return target;
  }
}

/** Puts the finished working folder `work` in `dir` under the first free name. */
export async function placeFolder(work: string, dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const target = candidate(dir, name, n, true);
    if (await exists(target)) continue;
    try { await rename(work, target); return target; } catch (error) { if (await exists(target)) continue; throw error; }
  }
}

export interface LandingAsk { at?: string; from?: string; agentId?: string }

/** Where a transfer lands, and why not where it was meant to (said to the sending agent). */
export async function landing(services: RuntimeServices, ask: LandingAsk, fromName: string): Promise<{ dir: string; note?: string }> {
  const box = clean(fromName, 'linked PC');
  const inbox = path.join(services.paths.workspace, 'inbox', box);
  const here = (() => { try { return services.devices.self().name || 'this PC'; } catch { return 'this PC'; } })();
  let wanted: string | undefined;
  if (ask.at) {
    if (!localAbsolute(ask.at) || !await isFolder(ask.at)) return { dir: inbox, note: `${ask.at} is no folder on ${here}, so it went into inbox/${box}/ there.` };
    wanted = ask.at;
  } else if (ask.from && localAbsolute(ask.from) && await isFolder(ask.from)) wanted = ask.from;
  if (!wanted) return { dir: inbox };
  const agentId = ask.agentId && ask.agentId !== HUMAN_ID && ask.agentId !== SYSTEM_ID ? ask.agentId : ''; // no agent: only what is open
  let verdict = 'open';
  try { if (services.security) verdict = services.security.check({ agentId, capability: 'write', path: wanted, fingerprint: '' }); } catch { verdict = 'ask'; }
  if (verdict !== 'open') return { dir: inbox, note: `Changing files in ${wanted} is closed to me on ${here}, so it went into inbox/${box}/ there.` };
  return { dir: wanted };
}

/** Free bytes on the disk of `dir` (its nearest existing folder); undefined when the system does not say. */
export async function freeBytes(dir: string): Promise<number | undefined> {
  let probe = dir;
  while (!await exists(probe)) { const up = path.dirname(probe); if (up === probe) return undefined; probe = up; }
  try { const fs = await statfs(probe); return Number(fs.bavail) * Number(fs.bsize); } catch { return undefined; }
}

/** Bytes in words ("1.4 GB", "820 MB"). */
export function sizeText(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
