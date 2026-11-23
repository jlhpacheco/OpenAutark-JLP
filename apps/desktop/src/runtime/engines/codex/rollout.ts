// Where a Codex thread's native history lies (0.3.19, the managed-shell mark, engines/managed-path.ts): Codex writes each
// thread's rollout as <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl and appends to that one file on
// every later turn, resume and injection (seen on disk with codex-cli 0.167.0-alpha.3.2). A path the mark already holds is
// taken again only while it still lies under that home's sessions folder, bears the thread id in its name and exists; else
// the day folders are searched newest first.
// Owns: finding a thread's rollout file. Never: reads a rollout's content (the mark hashes its tail), or the home's login files.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

const name = (threadId: string) => (file: string) => file.startsWith('rollout-') && file.endsWith(`-${threadId}.jsonl`);
const newestFirst = (entries: string[]) => entries.filter((entry) => /^\d+$/.test(entry)).sort((a, b) => Number(b) - Number(a));
const list = (dir: string) => fsp.readdir(dir).catch(() => [] as string[]);

/** The rollout of `threadId` in this CODEX_HOME (undefined: the env's, else ~/.codex), or undefined when there is none. */
export async function codexRollout(home: string | undefined, threadId: string, known?: string): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(threadId)) return undefined;
  const root = path.resolve(home ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'sessions');
  const matches = name(threadId);
  if (known) {
    const inside = path.relative(root, path.resolve(known));
    const ok = inside && !inside.startsWith('..') && !path.isAbsolute(inside) && matches(path.basename(known));
    return ok && (await fsp.stat(known).then((stat) => stat.isFile(), () => false)) ? path.resolve(known) : undefined;
  }
  for (const year of newestFirst(await list(root))) {
    for (const month of newestFirst(await list(path.join(root, year)))) {
      for (const day of newestFirst(await list(path.join(root, year, month)))) {
        const dir = path.join(root, year, month, day);
        const file = (await list(dir)).find(matches);
        if (file) return path.join(dir, file);
      }
    }
  }
  return undefined;
}
