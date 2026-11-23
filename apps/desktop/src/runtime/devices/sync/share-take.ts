// Umzug 21.11.2026, part 2: what a home-project mirror (share-project.ts) does with the files another home PC holds –
// one decision per file (share-tree.ts decide), a pull in pieces into a part file, the check that the file here did not
// change meanwhile, and the file in place with its writer's time. Round 3 (review R3):
// - Each entry stands alone: one that cannot be looked at, renamed, removed or pulled counts as failed and is asked for
//   again; it never ends the page and never reads as gone.
// - "What that PC's list does not name is gone there" is concluded only from a list whose every page arrived; with a
//   page missing nothing is removed and the list is asked for again.
// - What is a link, a folder or a file over the limit here, or lies behind a link or junction, is left alone: never
//   written over, renamed or removed (share-tree.ts look 'skip', Guard).
// - A folder that is gone or another one now (share-project.ts alive) ends the take before anything is told.
// Owns: taking, pulling and the list pages. Never: opens or closes a mirror, decides who is a home PC, or writes
// outside the home folder.

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import { hashFile, pullPieces, replaceWith } from './file-io.ts';
import { Guard, PART, copyName, decide, inside, type Have, type Index, type Look, type Seen } from './share-tree.ts';

/** One mirrored folder: the agents whose home project it is with their other home PCs, and what this PC remembers of it. */
export interface Mirror {
  key: string; home: string; root: string; id: string; agents: Map<string, string[]>; index: Index;
  work: Promise<unknown>; queued: Set<string>; timer?: ReturnType<typeof setTimeout>; watcher?: { close(): void };
  /** A whole list still arriving, by PC and list id: the paths it named and the pages that came. */
  lists: Map<string, { named: Set<string>; pages: Set<number> }>;
  /** Asks for a PC's list again after a failed take: the step and its timer. */
  again: Map<string, { step: number; timer?: ReturnType<typeof setTimeout> }>;
}

/** A page of a PC's whole list: its number from 0, whether it is the last, and whether that PC starts over with me. */
export interface ListPage { id: string; page: number; end: boolean; first: boolean }

export interface TakeCtx {
  s: RuntimeServices;
  call(peer: string, params: Record<string, unknown>): Promise<unknown>;
  pc(): string;
  /** The mirror is still open and its folder the one it was. */
  alive(mirror: Mirror): boolean;
  look(root: string, rel: string, old: Seen | undefined, guard: Guard): Promise<Look>;
  save(mirror: Mirror): Promise<void>;
  announce(mirror: Mirror, entries: Have[], only?: string): void;
  askAgain(mirror: Mirror, from: string, failed: boolean): void;
}

export const gone = (rel: string): Have => ({ rel, sha: '', size: 0, mtime: 0 });
export const haveOf = (rel: string, seen: Seen | undefined): Have => (seen ? { rel, ...seen } : gone(rel));
const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** Takes what `from` holds and this PC should have, on behalf of `agentId`; `list`: a page of its whole list. */
export async function take(ctx: TakeCtx, mirror: Mirror, from: string, agentId: string, entries: Have[], list?: ListPage): Promise<void> {
  if (!ctx.alive(mirror)) return;
  const guard = new Guard(mirror.root);
  if (list?.first) delete mirror.index.agreed[from]; // that PC starts over with me: nothing it lacks counts as deleted there
  const out: Have[] = [];
  const back: Have[] = [];
  let failed = 0;
  const each = async (theirs: Have) => {
    try {
      if (!await one(ctx, mirror, from, agentId, theirs, out, back, guard)) failed++;
    } catch (error) {
      failed++; // unknown, never gone: asked for again
      ctx.s.log.info('home project file not taken', { agentId, rel: theirs.rel, error: errorText(error) });
    }
  };
  const key = `${from}/${list?.id}`;
  const state = list ? mirror.lists.get(key) ?? { named: new Set<string>(), pages: new Set<number>() } : undefined;
  for (const entry of entries) state?.named.add(entry.rel); // named before anything can fail
  for (const entry of entries) await each(entry);
  if (list && state) {
    state.pages.add(list.page);
    for (const stale of [...mirror.lists.keys()]) if (stale.startsWith(`${from}/`)) mirror.lists.delete(stale);
    if (!list.end) mirror.lists.set(key, state);
    else if (state.pages.size !== list.page + 1) failed++; // a page did not come: nothing is concluded from this list
    else for (const rel of new Set([...Object.keys(mirror.index.files), ...Object.keys(mirror.index.agreed[from] ?? {})])) if (!state.named.has(rel)) await each(gone(rel));
  }
  if (!ctx.alive(mirror)) return; // the folder went meanwhile: nothing of this take is told
  await ctx.save(mirror);
  ctx.announce(mirror, out);
  ctx.announce(mirror, back, from);
  ctx.askAgain(mirror, from, failed > 0);
}

/** One file `from` holds as `theirs`; false when it should have come and did not. */
async function one(ctx: TakeCtx, mirror: Mirror, from: string, agentId: string, theirs: Have, out: Have[], back: Have[], guard: Guard): Promise<boolean> {
  const { rel } = theirs;
  const agreed = (mirror.index.agreed[from] ??= {});
  const mine = await seen(ctx, mirror, rel, out, guard);
  if (mine === 'skip') return true; // not carried here: left alone
  const verdict = decide(mine, agreed[rel], theirs);
  if (verdict === 'same') { if (mine) agreed[rel] = mine.sha; else delete agreed[rel]; return true; }
  if (verdict === 'give') { back.push(haveOf(rel, mine)); return true; }
  const file = inside(mirror.root, rel)!;
  let held = mine;
  if (verdict === 'aside') {
    const copy = await freeCopy(ctx, mirror, rel);
    await rename(file, inside(mirror.root, copy)!);
    delete mirror.index.files[rel];
    await seen(ctx, mirror, copy, out, guard);
    held = undefined;
  }
  if (!theirs.sha) {
    await rm(file, { force: true });
    delete mirror.index.files[rel];
    delete agreed[rel];
    out.push(gone(rel));
    return true;
  }
  if (!await pull(ctx, mirror, from, agentId, theirs, held)) return false;
  agreed[rel] = theirs.sha;
  out.push(haveOf(rel, mirror.index.files[rel]));
  return true;
}

/** The file as it is here now, remembered; a content this PC had not seen yet is added to `out`. 'skip': not carried here. */
async function seen(ctx: TakeCtx, mirror: Mirror, rel: string, out: Have[], guard: Guard): Promise<Seen | undefined | 'skip'> {
  const old = mirror.index.files[rel];
  const now = await ctx.look(mirror.root, rel, old, guard);
  if (now === 'skip') return 'skip';
  const next = now === 'gone' ? undefined : now;
  if (next) mirror.index.files[rel] = next; else delete mirror.index.files[rel];
  if ((old?.sha ?? '') !== (next?.sha ?? '')) out.push(haveOf(rel, next));
  return next;
}

/** "name (from <this PC>).ext", or with a number when that name is taken. */
async function freeCopy(ctx: TakeCtx, mirror: Mirror, rel: string): Promise<string> {
  for (let n = 1; ; n++) {
    const copy = copyName(rel, n === 1 ? ctx.pc() : `${ctx.pc()} ${n}`);
    if (!await lstat(inside(mirror.root, copy)!).catch(() => undefined)) return copy;
  }
}

/** Pulls `theirs` from `from` and puts it in place when the file here is still `mine`. */
async function pull(ctx: TakeCtx, mirror: Mirror, from: string, agentId: string, theirs: Have, mine: Seen | undefined): Promise<boolean> {
  const file = inside(mirror.root, theirs.rel)!;
  const temp = `${file}.${randomUUID()}${PART}`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await pullPieces(temp, (offset) => ctx.call(from, { op: 'get', agentId, rel: theirs.rel, offset }));
    if (await hashFile(temp) !== theirs.sha) throw new Error('it changed on the way');
    const now = await ctx.look(mirror.root, theirs.rel, mine, new Guard(mirror.root)); // a fresh guard: no link came meanwhile
    if (now === 'skip' || ((now === 'gone' ? '' : now.sha) !== (mine?.sha ?? ''))) throw new Error('it changed here meanwhile');
    if (!ctx.alive(mirror)) throw new Error('the project folder is not the one it was');
    await replaceWith(temp, file);
    await utimes(file, new Date(), theirs.mtime / 1000).catch(() => undefined); // its writer's time: both PCs name the same later writer
    const info = await lstat(file);
    mirror.index.files[theirs.rel] = { sha: theirs.sha, size: info.size, mtime: info.mtimeMs };
    return true;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    ctx.s.log.info('home project file not pulled', { agentId, rel: theirs.rel, error: errorText(error) });
    return false;
  }
}
