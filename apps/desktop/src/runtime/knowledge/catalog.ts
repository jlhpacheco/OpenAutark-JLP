// One knowledge catalog (B-078 D12, owner 06.11.2026: "nicht so getrennt … wie aktuell Skills und Memory"): every text the
// AI can reach, as one list – the skills of every root (skills/service.ts), the home project's instruction files and
// SKILL.md skills (agent-core/home.ts); the public library is its own search (library.find). Memory is the same kind of text; a find
// searches "catalog" and "memory" together (find/service.ts), both by their words (knowledge/words.ts). Each entry:
// key, title, description (given, else generated – knowledge/describe.ts – else heading + first sentence), size, origin
// (own | project), always, path. syncCatalog runs when a find asks and the last sync is older than SYNC_MS or
// something changed (catalogChanged), never on a timer of its own, and describes a few entries that have no description. An
// entry's meaning (a short text whole, a big one by title + description) is embedded when a find asks for it (knowledge/find.ts).
// Owns: the entry list, the sync and when descriptions are asked for. Never: reads a body into a prompt or treats a text as an instruction.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { SkillInfo } from '../../shared/model/knowledge.ts';
import { fallbackDescription } from '../../shared/text/external.ts';
import '../contracts/agent-core.ts';
import { parseFrontMatter } from '../skills/frontmatter.ts';
import { sha256 } from '../skills/import-text.ts';
import { readSkillBody } from '../skills/discover.ts';
import { CHUNK_CHARS } from '../vectors/chunk.ts';
import { helperOf } from '../day/helper.ts';
import { describeFile, describedText, describeText, rememberDescribed } from './describe.ts';

export type CatalogOrigin = 'own' | 'project';
export type CatalogKind = 'skill' | 'project';

export interface CatalogEntry {
  /** Its key (also in the vector store): catalog/skill/<owner>/<name>, catalog/project/<home>/<route>. */
  key: string;
  kind: CatalogKind;
  title: string;
  description: string;
  /** The description was written by someone (front matter), not generated or taken from the text. */
  given: boolean;
  origin: CatalogOrigin;
  always: boolean;
  /** The file on this PC, or the web address of an index-only entry. */
  path: string;
  size: number;
  sha?: string;
  /** The text itself when it is short enough to stand for its meaning whole. */
  body?: string;
  skill?: SkillInfo;
  /** An own file: a generated description goes into its front matter. */
  writable?: boolean;
}

export const SYNC_MS = 10 * 60_000;
const DESCRIBE_BATCH = 6;

const shortHash = (text: string): string => sha256(text).slice(0, 10);

/** The description an entry shows: given, else generated, else heading + first sentence of its text. */
function descriptionOf(services: RuntimeServices, given: string, body: string, sha: string): { description: string; given: boolean } {
  const fallback = fallbackDescription(body);
  if (given && given !== fallback) return { description: given, given: true };
  return { description: describedText(services, sha) ?? (given || fallback), given: false };
}

const skillCache = new WeakMap<object, { signature: string; entries: CatalogEntry[] }>();

function writableSkill(services: RuntimeServices, info: SkillInfo): boolean {
  if (info.source === 'agent') return true;
  if (info.source !== 'user') return false;
  const relative = path.relative(services.paths.workspace, info.path);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Every skill copy of every root as an entry (cached while no SKILL.md changed). */
export function skillEntries(services: RuntimeServices): CatalogEntry[] {
  let every: SkillInfo[];
  try { every = services.skills.every?.() ?? services.skills.list(); } catch { return []; }
  const signature = every.map((info) => `${info.path}@${info.updatedAt}`).join('|');
  const known = skillCache.get(services);
  if (known && known.signature === signature) return known.entries;
  const entries = every.flatMap((info): CatalogEntry[] => {
    let text: string;
    try { text = readFileSync(path.join(info.path, 'SKILL.md'), 'utf8'); } catch { return []; }
    const body = parseFrontMatter(text).body;
    const sha = sha256(text);
    const { description, given } = descriptionOf(services, info.description, body, sha);
    return [{
      key: `catalog/skill/${info.ownerAgentId ?? info.source}/${info.name}`, kind: 'skill', title: info.name, description, given,
      origin: 'own', always: info.always === true, path: path.join(info.path, 'SKILL.md'), size: body.length, sha,
      ...(body.length <= CHUNK_CHARS ? { body } : {}), skill: info, writable: writableSkill(services, info),
    }];
  });
  skillCache.set(services, { signature, entries });
  return entries;
}

/** The home project's instruction files and skills of `agent` as entries ([] without a usable home). */
export function projectEntries(services: RuntimeServices, agent: Agent | undefined): CatalogEntry[] {
  const homes = services.agentCore?.homes;
  let home: string | undefined;
  try { home = agent ? homes?.usable(agent.id) : undefined; } catch { home = undefined; }
  if (!homes || !home) return [];
  const prefix = `catalog/project/${shortHash(home.toLowerCase())}`;
  const files = homes.instructionsIn(home).map((file): CatalogEntry => ({
    key: `${prefix}/${file.route}`, kind: 'project', title: file.route, ...descriptionOf(services, file.description, file.text, file.sha256),
    origin: 'project', always: file.always, path: file.file, size: file.text.length, sha: file.sha256, ...(file.text.length <= CHUNK_CHARS ? { body: file.text } : {}),
  }));
  const skills = homes.skillsIn(home).skills.map((skill): CatalogEntry => ({
    key: `${prefix}/${skill.route || skill.name}`, kind: 'project', title: skill.name, description: describedText(services, skill.sha256) ?? skill.description, given: !skill.fallback,
    origin: 'project', always: false, path: skill.file, size: skill.size, sha: skill.sha256,
  }));
  return [...files, ...skills];
}

/** The whole catalog a viewer reaches (its home project only for an agent). */
export function catalogEntries(services: RuntimeServices, viewer?: Agent): CatalogEntry[] {
  return [...skillEntries(services), ...projectEntries(services, viewer)];
}

// ------------------------------------------------------------------ sync

interface SyncState { at: number; dirty: boolean; running?: Promise<void>; homes: Set<string> }
const syncs = new WeakMap<object, SyncState>();

function stateOf(services: RuntimeServices): SyncState {
  let state = syncs.get(services);
  if (!state) { state = { at: Number.NEGATIVE_INFINITY, dirty: true, homes: new Set() }; syncs.set(services, state); }
  return state;
}

/** Something in the catalog changed (a skill saved): the next find syncs again. */
export function catalogChanged(services: RuntimeServices): void {
  stateOf(services).dirty = true;
}

/** Starts a sync in the background when one is due; the find goes on with what is there. */
export function kickCatalog(services: RuntimeServices, viewer?: Agent): Promise<void> | undefined {
  const state = stateOf(services);
  if (state.running) return state.running;
  const home = viewer ? projectEntries(services, viewer)[0]?.key.split('/').slice(0, 3).join('/') : undefined;
  const newHome = home !== undefined && !state.homes.has(home);
  if (!state.dirty && !newHome && services.clock.now() - state.at < SYNC_MS) return undefined;
  state.dirty = false;
  state.at = services.clock.now();
  state.running = syncCatalog(services, viewer).catch((error: unknown) => {
    try { services.log.debug('catalog sync failed', { error: String(error) }); } catch { /* nothing to report to */ }
  }).finally(() => { state.running = undefined; });
  return state.running;
}

/** Describes a few entries without a description (a new home project's too). */
export async function syncCatalog(services: RuntimeServices, viewer?: Agent): Promise<void> {
  const entries = catalogEntries(services, viewer);
  const home = entries.find((entry) => entry.kind === 'project')?.key.split('/').slice(0, 3).join('/');
  if (home) stateOf(services).homes.add(home);
  await describeSome(services, entries);
}

/** A few entries without a written description get a generated one (decision model); none without a model. */
export async function describeSome(services: RuntimeServices, entries: readonly CatalogEntry[], runner = helperOf(services)): Promise<number> {
  if (!runner) return 0;
  const due = entries.filter((entry) => !entry.given && entry.sha && !describedText(services, entry.sha)).slice(0, DESCRIBE_BATCH);
  let described = 0;
  for (const entry of due) {
    const text = entryText(entry);
    if (!text) continue;
    let description: string | undefined;
    try { description = await describeText(runner, { title: entry.title, text }); } catch { description = undefined; }
    if (!description || !entry.sha) continue;
    rememberDescribed(services, entry.sha, description, services.clock.now()); // also an own file: the same text is not asked again
    if (entry.writable && entry.skill) describeFile(entry.path, entry.skill.name, description, sha256, entry.sha); // the skill library sees the new mtime on its next read
    described++;
  }
  return described;
}

/** An entry's text for its description and the word index. */
export function entryText(entry: CatalogEntry): string | undefined {
  if (entry.body) return entry.body;
  if (!entry.path) return undefined;
  try { return parseFrontMatter(readFileSync(entry.path, 'utf8')).body; } catch { return undefined; }
}
