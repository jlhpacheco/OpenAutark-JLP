// vector.search: the one search, asked for by meaning (Quests 20.11.2026), over places – memory folders (the knowledge search),
// "catalog" (knowledge/find.ts) and the files and folders vector.embed added (services.vectors.search) – by their words, re-ranked
// by meaning where a person chose an embedding model; without one the word hits come with one line saying so. `hops` let the best
// hits' own texts search on. searchByMeaning is the subconscious's vector.search too.
// Owns: the places' routing, the hops, the tool's wording and result text. Never: embeds files itself (vector.embed adds them).

import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import type { Agent } from '../../../shared/model/org.ts';
import type { VectorHit, VectorSearchInput, VectorSearchResult } from '../../../shared/model/vectors.ts';
import type { ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool } from './util.ts';
import { findInCatalog, openHint } from '../../knowledge/find.ts';
import { noteKey } from '../../knowledge/search.ts';
import { MAX_K } from '../../vectors/files.ts';
import { NO_MODEL } from '../../vectors/meaning.ts';
import { placePath, vectorEmbed } from './vector-embed.ts';
import '../../contracts/vectors.ts';

export const MAX_HOPS = 2;
const DEFAULT_K = 8;
/** The best hits of a hop that search on, and the path score below which a hop's hit says nothing. */
const BEAM = 3;
const HOP_FLOOR = 0.3;
const HOP_QUERY_CHARS = 600;

const isMemory = (place: string): boolean => place === 'memory' || /^memory[\\/]/.test(place);
const isCatalog = (place: string): boolean => place === 'catalog';
const hitKey = (hit: VectorHit): string => `${hit.path}#${hit.chunk}`;

/** One search over the places: each place by its own search, merged by score (each 0..1 relative to its best). */
async function searchOnce(services: RuntimeServices, viewer: Agent | undefined, query: string, places: readonly string[], k: number): Promise<{ hits: VectorHit[]; note?: string; files: number }> {
  const memory = places.filter(isMemory);
  const files = places.filter((place) => !isMemory(place) && !isCatalog(place));
  const [notes, catalog, found] = await Promise.all([
    memory.length ? services.knowledge.search({ text: query, folders: memory, limit: k }) : [],
    places.some(isCatalog) ? findInCatalog(services, viewer, query, k) : [],
    files.length ? services.vectors.search({ query, in: files, k }) : undefined,
  ]);
  const hits: VectorHit[] = [
    ...notes.map((hit) => ({ path: noteKey(hit.item), chunk: 0, snippet: `${hit.item.title}: ${hit.item.body}`, score: hit.score })),
    ...catalog.map((hit) => ({ path: hit.entry.key, chunk: 0, snippet: `${hit.entry.title}: ${hit.entry.description} · ${openHint(hit.entry)}`, score: hit.score })),
    ...(found?.hits ?? []),
  ];
  return { hits: hits.sort((a, b) => b.score - a.score).slice(0, k), ...(found?.note ? { note: found.note } : {}), files: found?.searched.embeddedFiles ?? 0 };
}

/** The best `k` hits for the query in the places, and with hops what lies close to the best ones (a path scores the product of its steps). */
export async function searchByMeaning(services: RuntimeServices, viewer: Agent | undefined, input: VectorSearchInput): Promise<VectorSearchResult> {
  const places = input.in.map((place) => place.trim()).filter(Boolean);
  const k = Math.max(1, Math.min(Math.trunc(input.k ?? DEFAULT_K), MAX_K));
  const first = await searchOnce(services, viewer, input.query, places, k);
  const hits = [...first.hits];
  const seen = new Set(hits.map(hitKey));
  let frontier = hits;
  for (let hop = 0; hop < Math.min(Math.trunc(input.hops ?? 0), MAX_HOPS) && frontier.length; hop++) {
    const next: VectorHit[] = [];
    for (const from of frontier.slice(0, BEAM)) {
      const found = await searchOnce(services, viewer, from.snippet.slice(0, HOP_QUERY_CHARS), places, k);
      for (const hit of found.hits) {
        const score = from.score * hit.score;
        if (score < HOP_FLOOR || seen.has(hitKey(hit))) continue;
        seen.add(hitKey(hit));
        next.push({ ...hit, score: Number(score.toFixed(3)), via: from.path });
      }
    }
    hits.push(...next);
    frontier = next.sort((a, b) => b.score - a.score);
  }
  const notes = [first.note, services.vectors.available() ? undefined : NO_MODEL].filter(Boolean);
  return { hits: hits.sort((a, b) => b.score - a.score).slice(0, k), searched: { places, embeddedFiles: first.files }, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

function line(hit: VectorHit): string {
  const where = hit.lines ? `${hit.path}:${hit.lines[0]}-${hit.lines[1]}` : hit.chunk ? `${hit.path} #${hit.chunk}` : hit.path;
  return `${hit.score.toFixed(2)} ${where}${hit.via ? ` (via ${hit.via})` : ''}\n  ${clip(hit.snippet.replace(/\s+/g, ' ').trim(), 240)}`;
}

export const vectorSearch: ToolDef = defineTool<{ query: string; in: string[]; limit?: number; hops?: number }>({
  name: 'vector.search',
  description: 'Finds texts by what they mean and the words they hold – in memory ("memory", "memory/<folder>"), the "catalog" of my skills and home project, and files or folders I added with vector.embed. A query in the words a matching text would use finds it best; an exact string anywhere is files.search.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000 },
      in: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1024 }, description: 'Places.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_K },
      hops: { type: 'integer', minimum: 0, maximum: MAX_HOPS, description: '1–2: the best hits\' own texts search on, so what lies close to them comes too.' },
    },
    required: ['query', 'in'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => ({ summary: `Search by meaning for "${clip(args.query, 80)}" in ${clip(args.in.join(', '), 80)}`, resource: args.in[0], reversible: true, external: false }),
  async run(args, ctx) {
    if (ctx.fromPc !== undefined) return failure('vector.search runs only for agents of this PC.');
    const query = args.query.trim();
    if (!query) return failure('Say what to search for.');
    const places = await Promise.all(args.in.map((given) => placePath(ctx, given)));
    const result = await searchByMeaning(ctx.services, ctx.agent, { query, in: places, ...(args.limit ? { k: args.limit } : {}), ...(args.hops ? { hops: args.hops } : {}) });
    const lines: string[] = [];
    if (result.note) lines.push(result.note);
    lines.push(`${result.hits.length} hits.`);
    lines.push(...result.hits.map(line));
    if (result.hits.some((hit) => hit.path.startsWith('memory/'))) lines.push(`memory/ is ${path.join(ctx.services.paths.data, 'memory')}`);
    return text(lines.join('\n'));
  },
});

export const vectorTools: ToolDef[] = [vectorEmbed, vectorSearch];
