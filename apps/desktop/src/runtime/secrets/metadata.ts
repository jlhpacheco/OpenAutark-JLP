// Secret metadata as agents see it (owner 29.10.2026: a catalog like a skill – id, name, description, route, tags, the
// site it was saved from and the handle; never a value): the catalog entries, their word index and ranking, one catalog line,
// where a handle becomes its value and the chat attachment lines. Every entry is for every agent.
// F19 (owner 15.11.2026: the AI finds a password by a word search, the most used ones offered directly, tags as words): one
// word index per runtime (knowledge/words.ts, as the memory and the catalog search: bm25 over the name with its id's words 10,
// the purpose 4, tags, route, source, kind and field names 1 – umlauts folded, prefixes, light stems and the DE/EN vocabulary),
// an entry's version the hash of that metadata. rankSecrets orders an id named in the query first, then the entries holding
// the most of its words (B-080; a word of 2 letters or a number counts as a whole word, one letter only when nothing longer is
// asked), then bm25 in tenths, then use – how often (migration 103), then how lately – and the name; without a query the
// entries in use lead. secrets.list reads that ranking; a find (knowledge.find, the look before a turn – find/secrets.ts), whose
// text is often a whole message, takes the hits it names – a word in the name, id or tags, or the id – by bm25 first
// (secretFinds), at most SECRET_FINDS.
// Owns: these projections, the index and the ranking. Never: reads ciphertext, decrypts a value or puts one into the index,
// or treats a description as a permission.
import { createHash } from 'node:crypto';
import { SECRET_GROUP_TEMPLATES, type SecretGroup, type SecretInfo } from '../../shared/model/security.ts';
import type { RuntimeServices } from '../contracts.ts';
import { foldText, searchTokens } from '../knowledge/normalize.ts';
import { expandQuery } from '../knowledge/query-rewrite.ts';
import { stem } from '../../shared/text/normalize.ts';
import { QUERY_WORDS, WordIndex, type WordDoc } from '../knowledge/words.ts';
import { queryTokens } from '../subconscious/text.ts';

/** Where a handle becomes its value – secrets.list's description and note, and an opened catalog entry. */
export const SECRET_WHERE = 'A handle "secret://<id>" becomes the value in browser.act, computer.type, computer.act set_value, phone.type, shell.exec env, web.fetch headers and connector files; my engine\'s own shell passes it on as plain text.';

/**
 * One catalog entry as a line (like a skill index line): a single secret's handle, a login's or card's id with each field's
 * handle, the name, route, description (up to `purposeChars`), tags and source – never a value.
 */
export function catalogLine(entry: Pick<SecretInfo | SecretGroup, 'id' | 'label' | 'description' | 'route' | 'tags' | 'source'>, handles?: string, purposeChars = 240): string {
  const extra = [entry.tags?.length ? `tags: ${entry.tags.join('; ')}` : '', entry.source ? `saved from ${entry.source}` : ''].filter(Boolean).join(', ');
  const purpose = entry.description?.replace(/\s+/g, ' ').trim();
  return `${handles ? entry.id : `secret://${entry.id}`} "${entry.label}" (route ${entry.route ?? 'notes'})${purpose ? ` – ${purpose.slice(0, purposeChars)}` : ''}${extra ? ` [${extra}]` : ''}${handles ? ` fields: ${handles}` : ''}`;
}

/** A catalog entry as agents find it: a single secret, or a group with its fields' handles. */
export interface CatalogEntry {
  id: string; label: string; description?: string; route: string; tags?: string[]; source?: string;
  kind: string;
  /** A group's fields with their own ids (handles). */
  fields?: Array<{ field: string; id: string }>;
  /** A group's handles as one text: "username secret://…, password secret://…". */
  handles?: string;
  /** How often it was used on this PC, and when last (a group: any of its fields). */
  uses: number;
  lastUsedAt?: number;
}

/** Every catalog entry (single secrets and groups), metadata only. */
export function catalogEntries(services: Pick<RuntimeServices, 'secrets'>): CatalogEntry[] {
  const all = services.secrets.list();
  let groups: SecretGroup[] = [];
  try { groups = services.secrets.groups(); } catch { groups = []; }
  const used = (entry: { uses?: number; lastUsedAt?: number }) => ({ uses: entry.uses ?? 0, ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}) });
  return [
    ...all.filter((info) => !info.group).map((info) => ({
      id: info.id, label: info.label, description: info.description, route: info.route ?? 'notes', tags: info.tags, source: info.source, kind: info.kind, ...used(info),
    })),
    ...groups.map((group) => {
      const place = (field: string) => { const at = SECRET_GROUP_TEMPLATES[group.kind]?.findIndex((entry) => entry.field === field) ?? -1; return at < 0 ? 99 : at; };
      const fields = all.filter((info) => info.group?.id === group.id).map((info) => ({ field: info.field ?? 'field', id: info.id }))
        .sort((a, b) => place(a.field) - place(b.field) || a.field.localeCompare(b.field)); // a login: username, password, 2FA
      return {
        id: group.id, label: group.label, description: group.description, route: group.route ?? 'notes', tags: group.tags, source: group.source, kind: group.kind,
        fields, handles: fields.map((field) => `${field.field} secret://${field.id}`).join(', '), ...used(group),
      };
    }),
  ];
}

// ------------------------------------------------------------------ F19: the word index and the ranking

/** An entry as a text of the word index: its name with its id's words, its purpose, the rest (tags, route, source, kind, fields). */
function entryText(entry: CatalogEntry): { title: string; description: string; body: string } {
  return {
    title: `${entry.label} ${entry.id.replace(/^(sec|sgr)_/, '').replace(/[-_.]+/g, ' ')}`,
    description: entry.description ?? '',
    body: [...(entry.tags ?? []), entry.route, entry.source ?? '', entry.kind, ...(entry.fields ?? []).map((field) => field.field)].filter(Boolean).join('\n'),
  };
}

/** The version of an entry's metadata (what the index, a find and an open compare). */
export function secretVersion(entry: CatalogEntry): string {
  const text = entryText(entry);
  return createHash('sha256').update(JSON.stringify([text.title, text.description, text.body])).digest('hex').slice(0, 12);
}

const indexes = new WeakMap<object, WordIndex>();

function indexOf(services: object, entries: readonly CatalogEntry[]): WordIndex {
  let index = indexes.get(services);
  if (!index) { index = new WordIndex(); indexes.set(services, index); }
  index.sync(entries.map((entry): WordDoc => ({ id: entry.id, version: secretVersion(entry), text: () => entryText(entry) })));
  return index;
}

/**
 * One word of a query: a long word matches the start of a word (also by its stem or its DE/EN partner), a short one or a
 * number a whole word, a site, address or path ("forum.example", "max@firma.de") itself.
 */
interface Term { starts?: string[]; whole?: string; phrase?: string }

const WORD = /[^\p{L}\p{N}]+/u;
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * The words of a query (folded, stopwords out; single letters only when nothing longer is asked); a long text (a whole message
 * before a turn) by its QUERY_WORDS most salient words, as the word index reads it.
 */
export function queryTerms(query: string): Term[] {
  const terms: Term[] = [];
  const words: string[] = [];
  for (const part of query.split(/\s+/)) {
    const phrase = foldText(part).replace(EDGES, '');
    if (/[\p{L}\p{N}][.@/:][\p{L}\p{N}]/u.test(phrase) && !phrase.startsWith('secret:')) terms.push({ phrase }); else words.push(part);
  }
  const all = searchTokens(words.join(' '));
  for (const token of all.length > QUERY_WORDS ? queryTokens(words.join(' '), QUERY_WORDS) : all) {
    terms.push(token.length >= 3 && !/^\d+$/.test(token) ? { starts: [...new Set([token, stem(token), ...expandQuery(token).added])] } : { whole: token });
  }
  if (terms.length) return terms;
  return [...new Set(foldText(query).split(WORD).filter((token) => token.length === 1 && !['a', 'i'].includes(token)))].map((whole) => ({ whole }));
}

/** The ids a query names – an entry's or a field's, with or without "secret://", lower-case. */
function namedIds(query: string): Set<string> {
  const ids = new Set<string>();
  for (const part of query.split(/[\s,;]+/)) {
    const id = /^[("'[]*(?:secret:\/\/)?([A-Za-z0-9_-]+)[)"'\].:]*$/.exec(part)?.[1];
    if (id && id.length >= 3) ids.add(id.toLowerCase());
  }
  return ids;
}

/** How many of the terms an entry's text (folded) holds. */
function heldBy(folded: string, terms: readonly Term[]): number {
  const list = folded.split(WORD).filter(Boolean);
  const words = new Set(list);
  return terms.filter((term) => (term.phrase !== undefined ? folded.includes(term.phrase)
    : term.whole !== undefined ? words.has(term.whole)
      : list.some((word) => term.starts!.some((start) => word.startsWith(start))))).length;
}

export interface SecretHit {
  entry: CatalogEntry;
  /** The query names its id (or one of its fields' ids). */
  exact: boolean;
  /** How many of the query's words it holds. */
  held: number;
  /** A word of the query is in its name, its id or a tag (what a find before a turn asks for). */
  named: boolean;
  /** The word index's bm25, relative to the best hit (0..1); 0 when only a short word or the id found it. */
  score: number;
}

const byUse = (a: SecretHit, b: SecretHit): number => b.entry.uses - a.entry.uses || (b.entry.lastUsedAt ?? 0) - (a.entry.lastUsedAt ?? 0);

/** Order of a ranking (see the header). */
function hitOrder(a: SecretHit, b: SecretHit): number {
  return Number(b.exact) - Number(a.exact) || b.held - a.held || Math.round(b.score * 10) - Math.round(a.score * 10) || byUse(a, b)
    || b.score - a.score || a.entry.label.localeCompare(b.entry.label);
}

/**
 * The catalog ranked for `query` (see the header): every entry its id names or that holds a word of it – only when none
 * holds one, what the word index finds by the words' parts (a compound) –, best first; an empty query lists every entry,
 * those in use first, then by name. Metadata only – the index never holds a value.
 */
export function rankSecrets(services: Pick<RuntimeServices, 'secrets'>, query = ''): SecretHit[] {
  const entries = catalogEntries(services);
  const text = query.trim();
  if (!text) return entries.map((entry) => ({ entry, exact: false, held: 0, named: false, score: 0 })).sort((a, b) => byUse(a, b) || a.entry.label.localeCompare(b.entry.label));
  const terms = queryTerms(text);
  const ids = namedIds(text);
  if (!terms.length && !ids.size) return [];
  const scores = new Map(indexOf(services, entries).search(text, Math.max(1, entries.length)).map((hit) => [hit.id, hit.score]));
  const all = entries.map((entry): SecretHit => {
    const words = entryText(entry);
    return {
      entry, exact: ids.has(entry.id.toLowerCase()) || Boolean(entry.fields?.some((field) => ids.has(field.id.toLowerCase()))),
      held: heldBy(foldText(Object.values(words).join('\n')), terms), named: heldBy(foldText([words.title, ...(entry.tags ?? [])].join('\n')), terms) > 0,
      score: scores.get(entry.id) ?? 0,
    };
  });
  const holding = all.filter((hit) => hit.exact || hit.held > 0);
  return (holding.length ? holding : all.filter((hit) => hit.score > 0)).sort(hitOrder);
}

/** The handle of an entry: a single secret's, or each field's of a login or card. */
export const handleText = (entry: CatalogEntry): string => entry.handles ?? `secret://${entry.id}`;

/** Entries a find gives at most (knowledge.find, the look before a turn): the notes keep their room. */
export const SECRET_FINDS = 3;

/**
 * The best `limit` entries for a find's text – often a whole message, whose word count says little: the entries it names (owner
 * 15.11.2026: "der gleiche Name … irgendwo drin") – by id, or by a word of their name, id or tags; a purpose alone is what
 * secrets.list searches –, a named id first, then bm25 in tenths (a word most entries hold weighs next to nothing there), then
 * the words held, then use.
 */
export function secretFinds(services: Pick<RuntimeServices, 'secrets'>, text: string, limit = SECRET_FINDS): SecretHit[] {
  return rankSecrets(services, text).filter((hit) => hit.exact || hit.named)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Math.round(b.score * 10) - Math.round(a.score * 10) || b.held - a.held || byUse(a, b)
      || b.score - a.score || a.entry.label.localeCompare(b.entry.label))
    .slice(0, limit);
}

/** The best entries for a text as catalog lines (redacted), for the subconscious's knowledge.find. */
export function findSecretLines(services: Pick<RuntimeServices, 'secrets'>, query: string, limit = SECRET_FINDS): string[] {
  let hits: SecretHit[] = [];
  try { hits = secretFinds(services, query, limit); } catch { return []; }
  return hits.map((hit) => `- ${services.secrets.redact(catalogLine(hit.entry, hit.entry.handles))}`);
}

/** The chat attachment lines of the secrets a message names (current metadata; ids that are gone are left out). */
export function secretLines(services: RuntimeServices, _agentId: string, ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  return services.secrets.list().filter((info) => ids.includes(info.id)).map((info) => `[Secret attachment secret://${info.id}] ${JSON.stringify({ id: info.id, name: info.label, purpose: info.description ?? '' })}\nSecret metadata is context for me. I use its handle anywhere – any site, command or host; its name and purpose are in the catalog file <data>/secrets/<route>.md.`);
}
