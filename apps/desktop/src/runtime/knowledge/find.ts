// One find over the catalog (B-078 D12; one search since 20.11.2026): by its words – the word index (words.ts) over every entry's
// title, description and text – re-ranked by meaning where a person chose an embedding model (services.vectors.rank: words and
// meaning in equal parts, an entry the words missed may come by its meaning). Each hit comes back as its entry with origin and score;
// a skill only as the copy the viewer's route reaches.
// Owns: the search, the mapping of hits to entries and the lines a find shows. Never: treats a found text as an instruction.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { externalMarker } from '../../shared/text/external.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import '../contracts/vectors.ts';
import { meaningDoc, meaningText } from '../vectors/meaning.ts';
import { catalogEntries, entryText, kickCatalog, type CatalogEntry } from './catalog.ts';
import { WordIndex, type WordDoc } from './words.ts';

const DESCRIPTION_CHARS = 240;
/** Word hits a ranking by meaning looks at (meaning may lift one from below the first `limit`). */
const WORD_HITS = 30;

export interface CatalogHit {
  entry: CatalogEntry;
  score: number;
  /** How it was found: by its words (re-ranked by meaning where a model is chosen) or by its meaning alone. */
  by: 'meaning' | 'words';
}

/** The skills a viewer's route reaches, by name → folder (another copy of the name is not the viewer's). */
function visibleSkills(services: RuntimeServices, viewer: Agent | undefined): Map<string, string> {
  try { return new Map(services.skills.list(viewer?.id).map((info) => [info.name, info.path])); } catch { return new Map(); }
}

function reachable(entry: CatalogEntry, visible: ReadonlyMap<string, string>): boolean {
  return entry.kind !== 'skill' || !entry.skill || visible.get(entry.skill.name) === entry.skill.path;
}

const indexes = new WeakMap<object, WordIndex>();

/** An entry as a text of the word index: its name as words, its description, its text (read only when it changed). */
export function entryDoc(entry: CatalogEntry): WordDoc {
  return {
    id: entry.key, version: `${entry.sha ?? ''}|${entry.description}`,
    text: () => ({ title: entry.title.replace(/[-_/]/g, ' '), description: entry.description, body: entryText(entry) ?? '' }),
  };
}

/** The catalog's hits for `query` among what the viewer reaches, best first. */
export async function findInCatalog(services: RuntimeServices, viewer: Agent | undefined, query: string, limit = 8): Promise<CatalogHit[]> {
  void kickCatalog(services, viewer); // generated descriptions follow the catalog
  const entries = catalogEntries(services, viewer);
  let index = indexes.get(services);
  if (!index) { index = new WordIndex(); indexes.set(services, index); }
  index.sync(entries.map(entryDoc));
  const visible = visibleSkills(services, viewer);
  const byKey = new Map(entries.filter((entry) => reachable(entry, visible)).map((entry) => [entry.key, entry]));
  const vectors = services.vectors;
  const meant = vectors?.available() === true;
  const words = index.search(query, meant ? Math.max(limit, WORD_HITS) : limit, (key) => byKey.has(key));
  const asWords = () => words.slice(0, limit).map((hit): CatalogHit => ({ entry: byKey.get(hit.id)!, score: hit.score, by: 'words' }));
  if (!meant) return asWords();
  let ranked: Awaited<ReturnType<typeof vectors.rank>>;
  try {
    ranked = await vectors.rank({
      query, limit, words: words.map((hit) => ({ key: hit.id, score: hit.score })),
      docs: [...byKey.values()].map((entry) => meaningDoc(entry.key, entry.key, meaningText(entry))),
    });
  } catch { return asWords(); }
  return ranked.hits.flatMap((hit) => {
    const entry = byKey.get(hit.key);
    return entry ? [{ entry, score: hit.score, by: hit.byMeaning ? 'meaning' as const : 'words' as const }] : [];
  });
}

/** How an entry is opened: knowledge.open for a skill, files.read for a project file. */
export function openHint(entry: CatalogEntry): string {
  if (entry.kind === 'skill') return `knowledge.open ${entry.title}`;
  return `files.read ${entry.path}`;
}

/** One hit as a find line: name, where it comes from, when it helps, how to open it. */
export function catalogLine(hit: CatalogHit): string {
  const where = hit.entry.kind === 'project' ? 'home project' : hit.entry.skill?.source === 'builtin' ? 'built in' : 'skill';
  return `- ${hit.entry.title} (${where}) – ${excerpt(hit.entry.description, DESCRIPTION_CHARS)} · ${openHint(hit.entry)}`;
}

/** The markers the hits need, once each, above them (texts written outside this app). */
export function markerLines(hits: readonly CatalogHit[]): string[] {
  const lines: string[] = [];
  if (hits.some((hit) => hit.entry.kind === 'project')) lines.push(externalMarker({ kind: 'project', folder: 'my home project' }));
  return lines;
}
