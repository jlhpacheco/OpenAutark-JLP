// Builds the global model rating that openautark.com serves as /model-priors.json (14.11., Unterbewusstsein v1 point 4;
// the app loads it once a day, apps/desktop/src/runtime/models/priors-feed.ts): our judgement from
// apps/desktop/resources/model-priors.json – tier, strengths, smarts, notes, efforts, caps, unchanged – with the list prices
// of Artificial Analysis' model data (GET /api/v2/language/models/free) for every hosted model AA lists under the same
// name. An AA list price replaces ours (and a hand-set relCost, which the app then derives from the prices); a read
// (cached input) price of ours stays – it is the CLI's own, measured – and AA's fills it only where we have none; our smarts stay
// ours – AA's intelligence index is printed beside them, and the AA models we do not rate yet are listed, so the
// judgement can follow by hand. Local models (tier 'local') keep their entries: AA's rows are hosted variants.
// Run – the owner's step, never in tests:
//   ARTIFICIAL_ANALYSIS_API_KEY=… node scripts/model-priors/generate.mts            → apps/website/public/model-priors.json
//   node scripts/model-priors/generate.mts --out <file>                             (no key: our judgement alone)
//   node scripts/model-priors/generate.mts --fixture <recorded answer> --out <file> (no network; --out required)
// then build and deploy the site (apps/website: node build.mjs copies public/ into dist/).
// Owns: the AA fetch, the mapping of AA rows onto our entries, the merge and the written file. Never: prints or writes
// the key (it only goes to AA in the x-api-key header), changes the shipped priors, or deploys.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Effort } from '../../apps/desktop/src/shared/model/providers.ts';
import { effortRank, normalizeEffort } from '../../apps/desktop/src/runtime/models/efforts.ts';
import { feedCopy } from '../../apps/desktop/src/runtime/models/priors-feed.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHIPPED = path.resolve(here, '../../apps/desktop/resources/model-priors.json');
export const OUT = path.resolve(here, '../../apps/website/public/model-priors.json');
export const AA_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
export const KEY_ENV = 'ARTIFICIAL_ANALYSIS_API_KEY';
export const ATTRIBUTION = 'Model data: Artificial Analysis (https://artificialanalysis.ai)';
const MAX_PAGES = 20;
const TIMEOUT_MS = 20_000;
const MAX_PRICE = 10_000;

const EFFORT_WORDS = new Set(['max', 'maximum', 'xhigh', 'x-high', 'high', 'medium', 'low', 'minimal', 'none']);
const NOISE_WORDS = new Set(['fallback', 'reasoning', 'non', 'thinking', 'adaptive', 'with']);

/** Our judgement as the shipped file has it (entries kept raw, so every field passes through). */
export interface Judgment { version: string; categories: Record<string, string>; models: Array<Record<string, unknown>> }
/** The file the site serves. */
export interface Feed { $source: string; version: string; categories: Record<string, string>; models: Array<Record<string, unknown>> }
/** One AA row (one effort variant of one model). */
export interface AaRow { name: string; bases: string[]; effort?: Effort; intelligence?: number; input?: number; output?: number; cached?: number }
export type AaFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined; // AA: null = not measured
}

function price(value: unknown): number | undefined {
  const number = num(value);
  return number !== undefined && number > 0 && number <= MAX_PRICE ? number : undefined;
}

/** A model's base name: variants in parentheses and trailing effort, noise and date words dropped, letters and digits only ("GPT-6.1 Sol (xhigh)", "gpt-6-1-sol-xhigh" → gpt61sol). */
export function baseOf(text: string): string {
  const tokens = text.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && (EFFORT_WORDS.has(tokens[tokens.length - 1]) || NOISE_WORDS.has(tokens[tokens.length - 1]) || /^\d{4,}$/.test(tokens[tokens.length - 1]))) tokens.pop();
  return tokens.join('');
}

/** The effort an AA name or slug names: "(max, fallback)" → max, "(Non-reasoning)" → none, "…-xhigh" → xhigh. */
export function effortOf(text: string): Effort | undefined {
  const lower = text.toLowerCase();
  if (/non[-\s]?reasoning/.test(lower)) return 'none';
  for (const group of lower.matchAll(/\(([^)]*)\)/g)) {
    for (const word of group[1].split(/[\s,;/]+/)) if (EFFORT_WORDS.has(word)) return normalizeEffort(word);
  }
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && NOISE_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.length > 1 && EFFORT_WORDS.has(tokens[tokens.length - 1]) ? normalizeEffort(tokens[tokens.length - 1]) : undefined;
}

/** One page of AA's answer (`{ data: [...] }`) → rows; items without a name or slug are skipped. */
export function parseAaPage(json: unknown): AaRow[] {
  const data = record(json).data;
  return (Array.isArray(data) ? data : []).flatMap((item): AaRow[] => {
    const raw = record(item);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
    if (!name && !slug) return [];
    const pricing = record(raw.pricing);
    return [{
      name: name || slug,
      bases: [...new Set([name, slug].filter(Boolean).map(baseOf))],
      effort: effortOf(name) ?? effortOf(slug),
      intelligence: num(record(raw.evaluations).artificial_analysis_intelligence_index),
      input: price(pricing.price_1m_input_tokens),
      output: price(pricing.price_1m_output_tokens),
      cached: price(pricing.price_1m_cache_hit_tokens),
    }];
  });
}

/** The base an entry's AA rows must have: its id or its "<id>*" glob; none for globs elsewhere and per-provider entries. */
export function stemOf(match: string): string | undefined {
  const stem = match.endsWith('*') ? match.slice(0, -1) : match;
  return !stem || stem.includes('*') || stem.includes(':') ? undefined : baseOf(stem);
}

/** Rows nearest to the wanted effort first (ties go to the higher effort). */
function byEffort(rows: readonly AaRow[], wanted: Effort): AaRow[] {
  const rank = effortRank(wanted);
  const distance = (row: AaRow) => {
    const delta = effortRank(row.effort ?? 'medium') - rank;
    return Math.abs(delta) - (delta > 0 ? 0.1 : 0);
  };
  return [...rows].sort((a, b) => distance(a) - distance(b));
}

function priceText(entry: Record<string, unknown>): string {
  const input = num(entry.priceInputPerM);
  const output = num(entry.priceOutputPerM);
  if (input === undefined && output === undefined) return '–';
  const cached = num(entry.priceCachedInputPerM);
  return `${input ?? '–'}/${output ?? '–'}${cached !== undefined ? ` (cached ${cached})` : ''}`;
}

/** Our judgement + AA rows → the file and one report line per merged entry (plus the AA models we do not rate). */
export function buildFeed(input: { judgment: Judgment; pages?: readonly unknown[]; today: string; from?: string }): { feed: Feed; report: string[] } {
  const rows = (input.pages ?? []).flatMap(parseAaPage);
  const used = new Set<AaRow>();
  const report: string[] = [];
  const models = input.judgment.models.map((raw) => {
    const entry: Record<string, unknown> = { ...raw };
    const stem = typeof entry.match === 'string' && entry.tier !== 'local' ? stemOf(entry.match) : undefined;
    const mine = stem ? rows.filter((row) => row.bases.includes(stem)) : [];
    if (!mine.length) return entry;
    for (const row of mine) used.add(row);
    const ranked = byEffort(mine, normalizeEffort(entry.defaultEffort) ?? 'medium');
    const priced = ranked.find((row) => row.input !== undefined && row.output !== undefined);
    const rated = ranked.find((row) => row.intelligence !== undefined);
    const before = priceText(entry);
    if (priced) {
      entry.priceInputPerM = priced.input;
      entry.priceOutputPerM = priced.output;
      if (priced.cached !== undefined && entry.priceCachedInputPerM === undefined) entry.priceCachedInputPerM = priced.cached; // ours is the CLI's own read price
      delete entry.relCost; // the app derives it from both prices (priors.ts relCostOfPrices)
    }
    const index = rated ? `${rated.intelligence} (${rated.effort ?? 'medium'})` : '–';
    report.push(`${String(entry.match)}: smarts ${num(entry.smarts) ?? '–'} · AA index ${index} · price ${before} → ${priceText(entry)}`);
    return entry;
  });
  if (rows.length) {
    const best = new Map<string, { name: string; intelligence: number }>();
    for (const row of rows) {
      if (used.has(row) || row.intelligence === undefined) continue;
      const name = row.name.replace(/\s*\([^)]*\)/g, '').trim();
      if ((best.get(name)?.intelligence ?? -1) < row.intelligence) best.set(name, { name, intelligence: row.intelligence });
    }
    const top = [...best.values()].sort((a, b) => b.intelligence - a.intelligence).slice(0, 10);
    report.push(`AA models we do not rate (index): ${top.length ? top.map((row) => `${row.name} ${row.intelligence}`).join(', ') : 'none'}`);
  }
  const judged = `our judgement (apps/desktop/resources/model-priors.json, version ${input.judgment.version})`;
  return {
    feed: {
      $source: rows.length ? `Autark's model rating: ${judged} with list prices from Artificial Analysis, ${input.from ?? 'fetched'} on ${input.today}. ${ATTRIBUTION}.` : `Autark's model rating: ${judged}.`,
      version: input.judgment.version, // the judgement's, so an app update with a newer judgement wins over a fresh price list (review 14.11.)
      categories: input.judgment.categories,
      models,
    },
    report,
  };
}

/** The shipped priors as our judgement. */
export function readJudgment(file: string): Judgment {
  const raw = record(JSON.parse(readFileSync(file, 'utf8')));
  if (!Array.isArray(raw.models) || typeof raw.version !== 'string') throw new Error(`${file} is no model priors file`);
  return { version: raw.version, categories: record(raw.categories) as Record<string, string>, models: raw.models.map(record) };
}

/** Every page of AA's free model list with the key (only in the x-api-key header). */
export async function fetchAa(key: string, get: AaFetch = (url, init) => fetch(url, init)): Promise<unknown[]> {
  const pages: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await get(page === 1 ? AA_URL : `${AA_URL}?page=${page}`, { headers: { accept: 'application/json', 'x-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const why = response.status === 401 || response.status === 403 ? ' (key rejected or tier too low)' : response.status === 429 ? ' (daily quota used up)' : '';
      throw new Error(`Artificial Analysis answered HTTP ${response.status}${why}`);
    }
    const json = await response.json();
    if (!Array.isArray(record(json).data)) throw new Error('Artificial Analysis answered without a data list');
    pages.push(json);
    if (record(record(json).pagination).has_more !== true) break;
  }
  return pages;
}

/** The command; returns the exit code. */
export async function main(args: readonly string[], env: Record<string, string | undefined>, print: (line: string) => void = console.log): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { out: { type: 'string' }, fixture: { type: 'string' }, priors: { type: 'string' } } });
  if (values.fixture && !values.out) throw new Error('--fixture needs --out (a recorded answer is never written to the site)');
  const judgment = readJudgment(values.priors ?? SHIPPED);
  const key = env[KEY_ENV]?.trim();
  let pages: unknown[] = [];
  let from: string | undefined;
  if (values.fixture) {
    const json: unknown = JSON.parse(readFileSync(values.fixture, 'utf8'));
    pages = Array.isArray(json) ? json : [json];
    from = `from the recorded answer ${path.basename(values.fixture)}`;
  } else if (key) {
    pages = await fetchAa(key);
    from = `fetched ${new Date().toISOString()}`;
  } else {
    print(`${KEY_ENV} is not set: the file carries our judgement alone.`);
  }
  const { feed, report } = buildFeed({ judgment, pages, today: new Date().toISOString().slice(0, 10), from });
  if (!feedCopy(feed)) throw new Error('the built file is not one the app takes (a dated version and at least one model)');
  const out = path.resolve(values.out ?? OUT);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
  for (const line of report) print(line);
  print(`wrote ${out} (version ${feed.version}, ${feed.models.length} models)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(`model-priors: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; },
  );
}
