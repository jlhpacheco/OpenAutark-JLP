// Similar existing paths for a path that holds nothing (B-081): the file and folder tabs' not-found page shows them, on
// the PC that holds the path (files.readPath / listPath answer them, a linked PC's answer travels unchanged). From the
// nearest folder that exists, each missing part of the path is matched against the names one level down (likeness:
// folded, separators dropped; equal 1, one the start of the other 0.9, one inside the other 0.8, else shared letter
// pairs), and the best few are followed to the next part. Bounded: TIPS per level, FOLDERS read, NAMES scored per folder.
// Owns: that search and the likeness score. Never: writes, keeps an index or state, or walks below the path's own depth.

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathEntry } from '../../shared/api/methods-files.ts';
import { foldText } from '../../shared/text/normalize.ts';
import { netHostOf } from './net-hosts.ts';

/** Rows an answer holds at most (the nearest existing folder included, always last). */
export const NEAR_MAX = 5;
/** Matches followed further per level. */
const TIPS = 5;
/** Folders read per search. */
const FOLDERS = 8;
/** Names scored per folder. */
const NAMES = 2000;
/** A name counts as similar from here. */
const KEEP = 0.5;

const squash = (text: string): string => foldText(text).replace(/[\s._-]+/g, '');

function letterPairs(text: string): Map<string, number> {
  const pairs = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) pairs.set(text.slice(i, i + 2), (pairs.get(text.slice(i, i + 2)) ?? 0) + 1);
  return pairs;
}

/** How alike a wanted name and a found one are, 0..1 (case, accents and separators ignored). */
export function likeness(want: string, name: string): number {
  const a = squash(want);
  const b = squash(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && short.length * 2 >= long.length) {
    if (long.startsWith(short)) return 0.9;
    if (long.includes(short)) return 0.8;
  }
  if (short.length < 2) return 0;
  const left = letterPairs(a);
  let shared = 0;
  for (const [pair, count] of letterPairs(b)) shared += Math.min(count, left.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

async function isFolder(at: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return (await stat(at)).isDirectory(); } catch { return false; }
}

/** The deepest folder above `target` that exists, or undefined when not even its root does. */
async function nearestFolder(target: string): Promise<string | undefined> {
  for (let at = path.dirname(target); ; at = path.dirname(at)) {
    try { if ((await stat(at)).isDirectory()) return at; } catch { /* climb on */ }
    if (path.dirname(at) === at) return undefined;
  }
}

type Tip = PathEntry & { score: number };

/** Up to NEAR_MAX existing paths like `target` (absolute), best first, the nearest existing folder last; [] without one
 *  and for a network path (20.11.2026: never a walk through another computer's share – net-hosts.ts). */
export async function nearPaths(target: string): Promise<PathEntry[]> {
  if (netHostOf(target)) return [];
  const base = await nearestFolder(target);
  if (!base) return [];
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  let tips: Tip[] = [{ name: path.basename(base) || base, path: base, folder: true, score: 1 }];
  let best: Tip[] = [];
  let reads = 0;
  for (const [index, want] of parts.entries()) {
    const last = index === parts.length - 1;
    const found: Tip[] = [];
    for (const tip of tips) {
      if (reads++ >= FOLDERS) break;
      const entries = await readdir(tip.path, { withFileTypes: true }).catch(() => [] as Dirent[]);
      for (const entry of entries.slice(0, NAMES)) {
        const like = likeness(want, entry.name);
        if (like < KEEP) continue;
        const at = path.join(tip.path, entry.name);
        const folder = await isFolder(at, entry);
        if (last || folder) found.push({ name: entry.name, path: at, folder, score: tip.score * like });
      }
    }
    if (!found.length) break;
    found.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    tips = best = found.slice(0, TIPS);
  }
  const rows = best.slice(0, NEAR_MAX - 1).map(({ name, path: at, folder }): PathEntry => ({ name, path: at, folder }));
  return [...rows, { name: path.basename(base) || base, path: base, folder: true }];
}
