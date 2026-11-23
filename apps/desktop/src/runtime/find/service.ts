// FindService: the one find/open path every caller shares – the agent's knowledge.find / knowledge.open tools and the look
// before a turn. It asks the existing stores (candidates.ts: knowledge notes, references; catalog.ts: the knowledge catalog –
// skills and home project files – by words, and by meaning where a person chose an embedding model; secrets.ts, F19: the
// secrets catalog's names and handles, at most three), merges what they found
// into one ranked list and opens one candidate page by page (open.ts).
// Ranking: score buckets of SCORE_BUCKET, then authority (skill > document > hint), then score, then id.
// Runde „Halb“ 21.11.2026: an agent's find that names no folder reads what is the agent's to read (reachOf) – before, the whole
// tree, so other agents' own notes came up as hits; the subconscious's thoughts file is no note and never a hit.
// Owns: the merge, the ranking and an agent's default reach. Never: grants anything, stores query text, or opens anything by itself.

import type { RuntimeServices } from '../contracts.ts';
import type { FindCandidate, FindKind, FindOpened } from '../../shared/model/find.ts';
import { AUTHORITY_ORDER } from '../../shared/model/find.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { idTokens } from '../knowledge/query-rewrite.ts';
import { queryTokens } from '../subconscious/text.ts';
import { noteCandidates, referenceCandidates, type FindCaller, type Found, type Gather } from './candidates.ts';
import { GONE, openNote, openSkill, type OpenInput, type Opened } from './open.ts';
import { catalogCandidates, openCatalog } from './catalog.ts';
import { openSecret, secretCandidates } from './secrets.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { queryFolders } from '../knowledge/acl.ts';

export const ALL_KINDS: readonly FindKind[] = ['main-skill', 'product-skill', 'note', 'reference', 'document', 'secret'];
export type { FindCaller };
export const MAX_LIMIT = 20;
const SCORE_BUCKET = 0.05;

export interface FindQuery {
  query: string;
  kinds?: readonly FindKind[];
  limit?: number;
  signal?: AbortSignal;
  /** Memory folders the notes come from (default the whole tree). */
  folders?: string[];
  /** Whose references: 'human' (default) or a person per_…. */
  subject?: string;
}

const authorityRank = (candidate: FindCandidate) => AUTHORITY_ORDER.indexOf(candidate.authority);

/** Transitive order: score bucket, authority, score, id. */
export function rankOrder(a: FindCandidate, b: FindCandidate): number {
  const bucket = (c: FindCandidate) => Math.round(c.score / SCORE_BUCKET);
  return bucket(b) - bucket(a) || authorityRank(a) - authorityRank(b) || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Without internal fields (abs path). */
export function publicCandidate(found: Found): FindCandidate {
  const { abs: _abs, ...rest } = found;
  return rest;
}

export class FindService {
  private readonly services: () => RuntimeServices;

  constructor(services: () => RuntimeServices) {
    this.services = services;
  }

  async find(caller: FindCaller, query: FindQuery): Promise<Found[]> {
    const services = this.services();
    const mode = modeOf(services, caller);
    const limit = Math.max(1, Math.min(query.limit ?? 8, MAX_LIMIT));
    const reach = query.folders?.length ? { folders: query.folders, root: false } : caller.agent ? reachOf(services, caller.agent.id) : undefined;
    const gather: Gather = {
      query: query.query, tokens: queryTokens(query.query), ids: idTokens(query.query),
      kinds: new Set(query.kinds?.length ? query.kinds : ALL_KINDS), limit: limit + 1, signal: query.signal, // one more: a thoughts file may go
      ...(reach ? { folders: reach.folders } : {}), ...(query.subject ? { subject: query.subject } : {}),
    };
    const lists = await Promise.all([
      quiet(() => noteCandidates(services, caller, gather)),
      // a note directly in memory/ is company knowledge; a folder filter cannot name it, so the whole tree's hits give only those
      quiet(async () => (reach?.root ? (await noteCandidates(services, caller, { ...gather, folders: [''], limit: ROOT_PASS })).filter((found) => ROOT_NOTE.test(found.id)) : [])),
      quiet(() => referenceCandidates(services, caller, gather)),
      quiet(() => catalogCandidates(services, caller, gather, mode)),
      quiet(() => secretCandidates(services, caller, gather)),
    ]);
    const merged = new Map<string, Found>();
    for (const found of lists.flat()) {
      if (!gather.kinds.has(found.kind) || THOUGHTS.test(found.id)) continue;
      const known = merged.get(found.id);
      if (!known) { merged.set(found.id, found); continue; }
      const [best, other] = known.score >= found.score ? [known, found] : [found, known];
      merged.set(found.id, { ...best, section: best.section ?? other.section, why: [...new Set([best.why, other.why].flatMap((why) => why.split(' · ')))].join(' · ') });
    }
    return [...merged.values()].sort(rankOrder).slice(0, limit);
  }

  /** Opens one page of a candidate. */
  async open(caller: FindCaller, input: OpenInput): Promise<FindOpened & { candidate: Found }> {
    const services = this.services();
    const mode = modeOf(services, caller);
    const [prefix, ...rest] = input.id.split(':');
    const local = rest.join(':');
    let opened: Opened | undefined;
    if (prefix === 'skill') opened = openSkill(services, caller, local, input, mode);
    else if (prefix === 'note' || prefix === 'ref') opened = openNote(services, caller, local, input); // references are knowledge rows
    else if (prefix === 'cat') opened = openCatalog(services, caller, local, input); // B-078: a home project entry
    else if (prefix === 'secret') opened = openSecret(services, local, input); // F19: a secrets catalog entry (handles, never a value)
    if (!opened) throw new WorkforceError('not_found', GONE);
    return { candidate: opened.candidate, text: opened.text, page: opened.page, pages: opened.pages, ...(opened.changed ? { changed: opened.changed } : {}), follow: [] };
  }
}

/** The subconscious's thoughts file (subconscious/thoughts.ts): its own keywords, not a note – no find returns it. */
const THOUGHTS = /^note:agents:[^:]+:thoughts\.md$/;
/** Top folders of memory that belong to one branch, agent, chat or person: an agent reaches only its own of them. */
const OWNED = new Set(['agents', 'branches', 'chats', 'references']);

/** A note directly in memory/, in no folder. */
const ROOT_NOTE = /^note:[^:]+$/;
/** Whole-tree hits read for the notes directly in memory/ (only when there are any). */
const ROOT_PASS = 100;

/**
 * The memory folders an agent's find reads without naming any (Runde „Halb“ 21.11.2026): company, its branch, its own folder,
 * its chats and the references (knowledge/acl.ts queryFolders), and every free top folder, which counts as company-wide
 * (memory-tree.ts scopeOfPath) – not other agents' own folders; `root` when notes lie directly in memory/ (company-wide too).
 * The whole tree when that cannot be read.
 */
function reachOf(services: RuntimeServices, agentId: string): { folders: string[]; root: boolean } {
  try {
    const top = services.knowledge.memoryBrowse('');
    const free = top.folders.map((folder) => folder.path).filter((path) => !OWNED.has(path) && path !== 'company');
    return { folders: [...queryFolders(services.db, { agentId }), ...free], root: top.files.length > 0 };
  } catch {
    return { folders: [''], root: false };
  }
}

function modeOf(services: RuntimeServices, caller: FindCaller): ModeInfo | undefined {
  const key = caller.mode ?? caller.agent?.mode;
  if (!key) return undefined;
  try { return services.modes.get(key); } catch { return undefined; }
}

async function quiet<T>(work: () => T[] | Promise<T[]>): Promise<T[]> {
  try { return await work(); } catch { return []; }
}

const services = new WeakMap<object, FindService>();

/** The runtime's find service (one per RuntimeServices, created on first use – no composition step). */
export function findService(runtime: RuntimeServices): FindService {
  let service = services.get(runtime);
  if (!service) {
    service = new FindService(() => runtime);
    services.set(runtime, service);
  }
  return service;
}
