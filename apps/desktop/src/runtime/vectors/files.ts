// The files and folders vector.embed adds to the one search: each file's whole text (Markdown, text, code, JSON, CSV; PDF through
// files/pdf.ts) cut into pieces (chunk.ts) and stored with its lines, so its words are found at once – the one word index
// (knowledge/words.ts) over every added piece, the file's name as its title – and its meaning once a chosen model embedded the
// pieces (meaning.ts, in the one queue; vector.embed waits for that within its budget). An unchanged file costs one stat; a search
// notes a hit's file that changed since and drops one that is gone.
// Owns: reading, cutting and storing added files, and their search. Never: embeds itself, walks without being asked, or reads memory.

import { open, readFile as readWhole, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MeaningDoc } from '../contracts/vectors.ts';
import type { VectorEmbedResult, VectorHit, VectorSearchInput, VectorSearchResult } from '../../shared/model/vectors.ts';
import { extractPdfText } from '../files/pdf.ts';
import { WordIndex } from '../knowledge/words.ts';
import { chunkText } from './chunk.ts';
import type { Meaning } from './meaning.ts';
import { isGone, refusedFolder, walkFolder, type Places } from './places.ts';
import { isUnder, type VectorStore } from './store.ts';

/** A call's default budget: what does not fit is reported and the model calls again. */
export const EMBED_BUDGET_MS = 45_000;
export const MAX_K = 50;
const DEFAULT_K = 8;
/** Word hits a ranking looks at (meaning may lift one from below the first k). */
const WORD_HITS = 30;
/** Bigger files are not added (a log of this size is no knowledge; files.search reads it). */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_WALK_FILES = 50_000;
const MAX_LISTED = 60;
const SNIPPET_CHARS = 320;
/** At most this share of a call's time goes to walking a folder. */
const WALK_SHARE = 1 / 3;
/** A locked file: what is stored of it stays, the next call reads it again. */
const NOT_READABLE = 'not readable';

const PIECE = /#(\d+)$/;
const pieceKey = (file: string, n: number): string => `${file}#${n}`;
const fileOf = (key: string): string => key.replace(PIECE, '');
const pieceOf = (key: string): number => Number(PIECE.exec(key)?.[1] ?? 0);
/** Memory notes and catalog entries share the store; they are no files. */
const isFileKey = (key: string): boolean => !key.startsWith('memory/') && !key.startsWith('catalog/');

/** The text of a file, or why there is none. */
export type ReadFile = (file: string, size: number) => Promise<string | { skip: string }>;

const readText: ReadFile = async (file, size) => {
  if (/\.pdf$/i.test(file)) {
    if (size > MAX_PDF_BYTES) return { skip: 'too large' };
    const text = await extractPdfText(await readWhole(file)).catch(() => undefined);
    return text?.trim() ? text : { skip: 'no readable text' };
  }
  if (size > MAX_TEXT_BYTES) return { skip: `too large (${Math.round(size / 1_048_576)} MB)` };
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return { skip: NOT_READABLE };
  try {
    const body = Buffer.alloc(size);
    const { bytesRead } = await handle.read(body, 0, size, 0);
    if (body.subarray(0, Math.min(bytesRead, 8192)).includes(0)) return { skip: 'binary' };
    return body.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
};

export interface FileDeps {
  store: VectorStore;
  meaning: Meaning;
  places: Places;
  now: () => number;
  redact?: (text: string) => string;
  readFile?: ReadFile;
}

export class FileTexts {
  private readonly deps: FileDeps;
  private readonly index = new WordIndex();

  constructor(deps: FileDeps) {
    this.deps = deps;
  }

  /** Adds files or folders, whole, until the budget ends; what it does not reach is reported and the next call goes on. */
  async add(paths: string[], opts: { budgetMs?: number } = {}): Promise<VectorEmbedResult> {
    const { places, store, meaning, now } = this.deps;
    const deadline = now() + (opts.budgetMs ?? EMBED_BUDGET_MS);
    const result: VectorEmbedResult = { embedded: 0, reembedded: 0, unchanged: 0, skipped: [] };
    const skip = (where: string, reason: string) => { if (result.skipped.length < MAX_LISTED) result.skipped.push({ path: where, reason }); };
    const files: string[] = [];
    for (const given of paths) {
      const place = places.resolve(given);
      if (!place) { skip(given, /^(memory|catalog)([\\/]|$)/.test(given.trim()) ? 'memory and the catalog are in the search already' : 'give an absolute path'); continue; }
      const info = await stat(place.absolute).catch(() => undefined);
      if (!info) {
        if (!(await isGone(place.absolute))) { skip(given, 'not reachable right now'); continue; }
        store.removeUnder(place.key); // gone: what was stored of it goes too
        skip(given, 'not found');
        continue;
      }
      if (info.isFile()) { files.push(place.absolute); continue; }
      if (!info.isDirectory()) { skip(given, 'neither a file nor a folder'); continue; }
      const refused = refusedFolder(place.absolute);
      if (refused) { skip(given, refused); continue; }
      const start = now();
      const walked = await walkFolder(place.absolute, { deadline: start + (deadline - start) * WALK_SHARE, maxFiles: MAX_WALK_FILES, now });
      files.push(...walked.files);
      for (const entry of walked.skipped) skip(entry.path, entry.reason);
      const binary = walked.counts.get('binary');
      if (binary) skip(given, `${binary} binary files`);
      if (walked.cut) skip(given, 'folder too big to walk at once – name its subfolders'); // the same walk would stop at the same place
    }
    const docs: MeaningDoc[] = [];
    let left = 0;
    for (const file of files) {
      if (now() > deadline) { left++; continue; }
      const outcome = await this.addFile(file, docs);
      if (typeof outcome === 'string') result[outcome]++;
      else skip(file, outcome.skip);
    }
    if (left) { skip(`${left} more files`, 'budget used – call vector.embed again'); result.remaining = left; }
    if (meaning.need(docs)) {
      await meaning.settled(Math.max(0, deadline - now()));
      const waiting = docs.filter((doc) => meaning.waiting(doc.key)).length;
      if (waiting) result.waiting = waiting;
    }
    return result;
  }

  /** The added files under `in`, by their words and – with a chosen model – their meaning, best first. */
  async search(input: VectorSearchInput): Promise<VectorSearchResult> {
    const { places, store, meaning } = this.deps;
    const given = input.in.map((place) => place.trim()).filter(Boolean);
    const keys = given.flatMap((place) => places.resolve(place)?.key ?? []);
    const notes: string[] = [];
    if (keys.length < given.length) notes.push(`Not a place: ${given.filter((place) => !places.resolve(place)).join(', ')} – use absolute paths, "memory/…" or "catalog".`);
    const all = store.keys().filter(isFileKey);
    const inPlace = (key: string) => keys.some((place) => isUnder(key, place));
    const under = all.filter(inPlace);
    const searched = { places: given, embeddedFiles: new Set(under.map(fileOf)).size };
    if (!under.length) return { hits: [], searched, note: [...notes, `Nothing added under ${given.join(', ')} – vector.embed adds files and folders.`].join(' ') };
    this.index.sync(all.map((key) => ({ id: key, version: String(store.get(key)?.version), text: () => {
      const stored = store.text(key);
      return { title: stored ? path.basename(stored.path) : '', description: '', body: stored?.text ?? '' };
    } })));
    const k = Math.max(1, Math.min(Math.trunc(input.k ?? DEFAULT_K), MAX_K));
    const words = this.index.search(input.query, Math.max(k * 3, WORD_HITS), inPlace).map((hit) => ({ key: hit.id, score: hit.score }));
    const ranked = await meaning.rank({ query: input.query, words, docs: under.map((key) => ({ key, version: store.get(key)?.version ?? 0 })), limit: k });
    if (ranked.note && meaning.available()) notes.push(ranked.note); // without a model the caller says so once for every place
    const hits: VectorHit[] = [];
    const states = new Map<string, Promise<'ok' | 'changed' | 'gone'>>();
    let changed = false;
    for (const hit of ranked.hits) {
      const stored = store.text(hit.key);
      if (!stored) continue;
      if (!states.has(stored.path)) states.set(stored.path, fileState(stored.path, stored.version));
      const state = await states.get(stored.path);
      if (state === 'gone') { store.removeUnder(fileOf(hit.key)); continue; }
      if (state === 'changed') changed = true;
      hits.push({ path: stored.path, chunk: pieceOf(hit.key), ...(stored.lines ? { lines: stored.lines } : {}), snippet: stored.text.slice(0, SNIPPET_CHARS), score: hit.score });
    }
    if (changed) notes.push('Some of these files changed since vector.embed read them; vector.embed reads them again.');
    return { hits, searched, ...(notes.length ? { note: notes.join(' ') } : {}) };
  }

  /** One file's pieces stored anew when it changed; its docs go to `docs` either way. */
  private async addFile(file: string, docs: MeaningDoc[]): Promise<'embedded' | 'reembedded' | 'unchanged' | { skip: string }> {
    const { places, store } = this.deps;
    const key = places.keyOf(file);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return { skip: NOT_READABLE };
    const version = Math.trunc(info.mtimeMs);
    const known = store.get(pieceKey(key, 0));
    const pieces = () => store.keysUnder(key).filter((piece) => piece !== key).map((piece) => ({ key: piece, version }));
    if (known?.version === version) { docs.push(...pieces()); return 'unchanged'; }
    const text = await (this.deps.readFile ?? readText)(file, info.size);
    if (typeof text !== 'string') { if (known && text.skip !== NOT_READABLE) store.removeUnder(key); return text; }
    const chunks = chunkText(text);
    store.removeUnder(key);
    if (!chunks.length) return { skip: 'empty' };
    const redact = this.deps.redact ?? ((value: string) => value);
    const pdf = /\.pdf$/i.test(file);
    store.put(chunks.map((chunk, n) => ({ key: pieceKey(key, n), path: file, version, text: redact(chunk.text), ...(pdf ? {} : { lines: [chunk.from, chunk.to] as [number, number] }) })));
    docs.push(...pieces());
    return known ? 'reembedded' : 'embedded';
  }
}

/** Is a hit's file as it was read, changed since, or really gone (a drive that is away proves nothing)? */
async function fileState(file: string, version: number): Promise<'ok' | 'changed' | 'gone'> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return (await isGone(file)) ? 'gone' : 'ok';
  if (!info.isFile()) return 'gone'; // it became a folder: a search never walks one
  return Math.trunc(info.mtimeMs) === version ? 'ok' : 'changed';
}
