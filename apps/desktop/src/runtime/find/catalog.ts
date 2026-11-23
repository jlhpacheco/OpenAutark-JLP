// knowledge.find's search of the knowledge catalog (knowledge/find.ts) by words, re-ranked by meaning where a person chose an
// embedding model: skills (as skill candidates that open as skills) and the home project's instruction files and skills as
// 'document' candidates (data, written outside this app); knowledge.open opens such a document page by page with its marker
// above it. The public library is its own search (library.find).
// Owns: the mapping to candidates and the open of such an entry. Never: presents such a text as instructions.

import { readFileSync } from 'node:fs';
import type { RuntimeServices } from '../contracts.ts';
import { externalMarker } from '../../shared/text/external.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { parseFrontMatter } from '../skills/frontmatter.ts';
import { stripInvisible } from '../../shared/text/external.ts';
import { catalogEntries, type CatalogEntry } from '../knowledge/catalog.ts';
import { findInCatalog, type CatalogHit } from '../knowledge/find.ts';
import { GONE, pagesOf, type OpenInput, type Opened } from './open.ts';
import { scoreOf, shortHash, skillFound, MIN_SCORE, type FindCaller, type Found, type Gather } from './candidates.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';

function foundOf(hit: CatalogHit, score: number, why: string[]): Found {
  const { entry } = hit;
  return {
    id: `cat:${entry.key}`, kind: 'document', authority: 'document', title: entry.title, route: entry.title,
    version: entry.sha ? entry.sha.slice(0, 12) : shortHash(entry.description), score, why: why.join(' · '), origin: 'home project',
    ...(entry.description ? { description: entry.description } : {}), ...(entry.path && !/^https?:/.test(entry.path) ? { abs: entry.path } : {}),
  };
}

export async function catalogCandidates(services: RuntimeServices, caller: FindCaller, g: Gather, mode?: ModeInfo): Promise<Found[]> {
  const skills = g.kinds.has('main-skill') || g.kinds.has('product-skill');
  if (!g.kinds.has('document') && !skills) return [];
  const hits = await findInCatalog(services, caller.agent, g.query, g.limit * 2);
  return hits.flatMap((hit) => {
    const { score, why } = scoreOf(g, `${hit.entry.title} ${hit.entry.description}`, Math.min(1, hit.score), { semantic: hit.by === 'meaning' });
    if (score < MIN_SCORE) return [];
    if (hit.entry.kind !== 'skill') return [foundOf(hit, score, why)];
    const skill = hit.entry.skill && skillFound(services, caller, hit.entry.skill, mode, score, why);
    return skill ? [skill] : [];
  });
}

/** The text of an entry, invisible characters out; undefined when it is not on this PC. */
function entryText(entry: CatalogEntry): string | undefined {
  if (!entry.path || /^https?:/.test(entry.path)) return undefined;
  try { return parseFrontMatter(stripInvisible(readFileSync(entry.path, 'utf8')).text).body; } catch { return undefined; }
}

export function openCatalog(services: RuntimeServices, caller: FindCaller, key: string, input: OpenInput): Opened {
  const entry = catalogEntries(services, caller.agent).find((item) => item.key === key);
  if (!entry || entry.kind === 'skill') throw new WorkforceError('not_found', GONE);
  const marker = externalMarker({ kind: 'project', folder: 'my home project' });
  const body = entryText(entry) ?? entry.description;
  const pages = pagesOf(body);
  const page = Math.min(Math.max(1, input.page ?? 1), pages.length);
  const shown = pages[page - 1];
  const candidate = foundOf({ entry, score: 1, by: 'words' }, 1, ['opened']);
  const changed = input.version && input.version !== candidate.version ? `changed since I found it (version ${input.version} → ${candidate.version})` : undefined;
  return { candidate: { ...candidate, lines: { from: shown.firstLine, to: shown.lastLine } }, text: `${marker}\n\n${shown.text}`, page, pages: pages.length, ...(changed ? { changed } : {}) };
}
