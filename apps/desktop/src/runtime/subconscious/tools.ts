// The subconscious's tools (owner 01.11.2026: "die haben Wissen und Tools"). A tool = name, its args in one short form,
// one line, a handler; the prompt's tool list is generated from FLOW_TOOLS, so a new ability is one entry here (or one
// more list spread into FLOW_TOOLS). The flow's own steering (agent.tell, done) is built the same way. Since v1 (14.11.2026)
// every run is the main AI's own call (service.ts ask): it waits for the answer, so what a run tells, shows and answers
// all reaches it.
// knowledge.find finds what the main AI's knowledge.find finds: memory files (knowledge search – by their words, by meaning
// where a person chose an embedding model) as hits a run can show, the knowledge catalog (knowledge/find.ts) and the secrets
// catalog's best entries with their handles (F19, secrets/metadata.ts findSecretLines – never a value).
// vector.search is the main AI's (tools/builtin/vector-search.ts searchByMeaning): the one search over memory, the catalog and
// added files, re-ranked by meaning where a person chose an embedding model; vector.embed adds files or folders to it, only when
// the run calls it. thought.keep keeps the run's own keyword thoughts
// (thoughts.ts), knowledge.open opens one of the agent's skills whole, memory.read pages a
// file. voice.words adds to the learned words of speech recognition (settings.json voice.vocabulary) through the settings
// store and writes nothing else there. How the main AI's coming turn runs is the routing call's (route-turn.ts, v1), not a tool's.
// Owns: these handlers and what they answer the run. Never: talks to a model, throws past a handler's own error text,
// lists memory into any agent's context, or stores a secret value.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { NOTE_CALL, type TraceCall } from '../../shared/model/subconscious.ts';
import type { MemoryWriteInput } from '../../shared/model/memory.ts';
import type { VectorHit } from '../../shared/model/vectors.ts';
import { withWords, WORD_CHARS, wordOf } from '../../shared/voice/vocabulary.ts';
import '../contracts/open-fs.ts';
import '../contracts/vectors.ts';
import { folderText } from '../tools/builtin/memory.ts';
import { searchByMeaning } from '../tools/builtin/vector-search.ts';
import { loadedSkillText } from '../tools/builtin/skills.ts';
import { contextTools } from './context-tools.ts';
import { thoughtTool } from './thoughts.ts';
import { catalogLine, findInCatalog, markerLines } from '../knowledge/find.ts';
import { findSecretLines } from '../secrets/metadata.ts';
import { knownShare, similarity } from './text.ts';

/** What a handler sees of the running flow. */
export interface FlowRun {
  readonly services: RuntimeServices;
  readonly agent: Agent;
  readonly conversationId?: string;
  readonly thread: string;
  readonly taskId?: string;
  readonly signal: AbortSignal;
  /** A search's hits by their reference (h1, h2 …): what done.show may pick. */
  readonly hits: Map<string, { search: number; hit: VectorHit }>;
  /** Each search that numbered hits: the tool and its query and places, as the main AI is shown the call. */
  readonly searches: Array<{ tool: string; query: string; in: string[] }>;
  /** What this run knows: what happened and what its tools returned, as its last step read them. */
  saw?(): string;
  /** What the run costs and saves, in tokens: its model use against what its marks take off the main AI's context at each of its turns. */
  readonly tally?: { used: number; saved: number };
  /** Shows a call to the main AI (the trace). */
  show(call: TraceCall): void;
  /** Ends the flow. `answer`: what it says to the one who asked; `show`: the hits that go to the main AI; `note`: what it noticed, which goes with them. */
  finish(result: { answer?: string; show?: string[]; note?: string }): void;
}

export interface FlowTool {
  name: string;
  /** The args in one short form, e.g. {query, in: [places], k?}. */
  args: string;
  line: string;
  run(args: Record<string, unknown>, run: FlowRun): Promise<string> | string;
}

/** Who a memory file names as its writer. */
export const SUBCONSCIOUS_ID = 'subconscious';
const SNIPPET_CHARS = 400;
/** Memory files and catalog entries one knowledge.find shows each (within what a step keeps of an output, flow.ts OUTPUT_CHARS). */
const FIND_HITS = 5;
/** One page of a memory file or a skill's text: within what a step keeps of an output (flow.ts OUTPUT_CHARS), like context.read. */
const PAGE_CHARS = 3600;
const BROWSE_CHARS = 3000;
const EMBED_BUDGET_MS = 20_000;
/** Below this share of its long words known to the run, a memory text comes from elsewhere, or is in another language than the exchange's. */
const KNOWN_SHARE = 1 / 3;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()} …` : text;
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());

/** PAGE_CHARS of `text` from the character `given`, with what follows named (memory.read, knowledge.open). */
function page(text: string, given: unknown): string {
  const from = Math.max(0, Math.trunc(Number(given)) || 0);
  const rest = text.length - from - PAGE_CHARS;
  return `${text.slice(from, from + PAGE_CHARS)}${rest > 0 ? `\n[… ${rest} more characters, from ${from + PAGE_CHARS}]` : ''}`;
}

function redacted(services: RuntimeServices, text: string): string {
  return services.secrets ? services.secrets.redact(text) : text;
}

/** A place as the run names it: a folder or file of the workspace may be named as the main AI's tools take it; "memory…" and absolute paths are as they are. */
function placeOf(run: FlowRun, given: string): string {
  if (given === 'memory' || /^memory[\\/]/.test(given) || path.isAbsolute(given)) return given;
  const inWorkspace = path.resolve(run.services.paths.workspace, given);
  return existsSync(inWorkspace) ? inWorkspace : given;
}

/** One hit as a line: where it is and its text. */
export function hitLine(hit: VectorHit): string {
  const lines = hit.lines ? ` lines ${hit.lines[0]}-${hit.lines[1]}` : '';
  return `${hit.path}${lines}: ${clip(hit.snippet.replace(/\s+/g, ' ').trim(), SNIPPET_CHARS)}`;
}

/** One hit of search number `search` as its line, numbered: a hit found before keeps its reference (h1, h2 …). */
function numbered(run: FlowRun, search: number, hit: VectorHit): string {
  const known = [...run.hits].find(([, held]) => held.hit.path === hit.path && held.hit.chunk === hit.chunk)?.[0];
  const ref = known ?? `h${run.hits.size + 1}`;
  if (!known) run.hits.set(ref, { search, hit });
  return `${ref} (${hit.score.toFixed(2)}) ${hitLine(hit)}`;
}

const vectorTools: FlowTool[] = [
  {
    name: 'vector.search',
    args: '{query, in: [places], k?, hops?}',
    line: 'Finds texts by what they mean and the words they hold, in the places of "in": the memory tree (memory, memory/<folder>), "catalog" (the agent\'s skills and home project) or files and folders added with vector.embed. The words a matching text holds (names, things) find it best; a question or a list of kinds of information blurs it. hops 1–2: the best hits\' own texts search on, so what lies close to them comes too. Numbers its hits h1, h2 ….',
    async run(args, run) {
      const query = stringOf(args.query);
      const places = listOf(args.in).map((given) => placeOf(run, given));
      if (!query || !places.length) return 'vector.search needs a query and at least one place in "in".';
      const k = Number(args.k);
      const hops = Number(args.hops);
      const result = await searchByMeaning(run.services, run.agent, { query, in: places, ...(Number.isInteger(k) && k > 0 ? { k } : {}), ...(Number.isInteger(hops) && hops > 0 ? { hops } : {}) });
      const search = run.searches.push({ tool: 'vector.search', query, in: places }) - 1;
      const lines = result.hits.map((hit) => numbered(run, search, hit));
      return [...lines, result.note ?? '', lines.length || result.note ? '' : 'No hits.'].filter(Boolean).join('\n');
    },
  },
  {
    name: 'vector.embed',
    args: '{paths: [files or folders]}',
    line: 'Adds these files or folders to what vector.search finds (whole files; binaries, caches and secrets stay out): their words at once, their meaning once a model embedded them. I choose them deliberately.',
    async run(args, run) {
      const { vectors } = run.services;
      const paths = listOf(args.paths).map((given) => placeOf(run, given));
      if (!paths.length) return 'vector.embed needs "paths".';
      return JSON.stringify(await vectors.embed(paths, { budgetMs: EMBED_BUDGET_MS }));
    },
  },
];

/** Titles this run was told about: written again, they are another fact. */
const toldClose = new WeakMap<FlowRun, Set<string>>();
/** At this share of shared words a new title may well be the same note (no search: the folder's own titles, its newest files). */
const CLOSE_TITLE = 0.4;

/** What a new file's folder already holds under a close title, once per title; undefined to go on. */
function closeNote(run: FlowRun, folder: string, title: string): string | undefined {
  const told = toldClose.get(run) ?? new Set<string>();
  if (told.has(title)) return undefined;
  let close: { path: string; title: string } | undefined;
  try { close = run.services.knowledge.memoryBrowse(folder).files.find((file) => similarity(file.title, title) >= CLOSE_TITLE); } catch { return undefined; } // a new folder
  if (!close) return undefined;
  toldClose.set(run, told.add(title));
  const held = run.services.knowledge.memoryRead(close.path);
  return `Not written yet: ${close.path} has a close title. It says: ${clip(held?.text ?? close.title, SNIPPET_CHARS)}\nIf it is the same thing, I update that file with path or leave it. If it is another fact, I write this again.`;
}

const memoryTools: FlowTool[] = [
  {
    name: 'memory.browse',
    args: '{folder?}',
    line: 'A memory folder: its description, subfolders and file titles (with a file\'s description when it has one).',
    async run(args, run) {
      const memory = run.services.knowledge;
      return clip(folderText(memory.memoryBrowse(stringOf(args.folder) || undefined)), BROWSE_CHARS);
    },
  },
  {
    name: 'memory.read',
    args: '{path, from?}',
    line: `One memory file, ${PAGE_CHARS} characters from the character "from".`,
    async run(args, run) {
      const memory = run.services.knowledge;
      const path = stringOf(args.path);
      if (!path) return 'memory.read needs a path.';
      const file = memory.memoryRead(path);
      return file ? page(`${file.title}${file.description ? `\n${file.description}` : ''}\n${file.text}`, args.from) : `No memory file ${path}.`;
    },
  },
  {
    name: 'memory.write',
    args: '{title, text, folder? | path?, kind?, tags?}',
    line: 'Writes one memory file: a new one in folder (default the agent\'s own), or the file at path updated. It is findable at once.',
    async run(args, run) {
      const memory = run.services.knowledge;
      const title = stringOf(args.title);
      const text = stringOf(args.text);
      if (!title || !text) return 'memory.write needs a title and a text.';
      const seen = run.saw?.();
      if (seen && (knownShare(seen, `${title} ${text}`) ?? 1) < KNOWN_SHARE) return 'Not written: most of this text is not in what happened or in what my tools returned. Memory holds what was said here, in the language of the exchange.';
      const file = stringOf(args.path);
      const folder = stringOf(args.folder) || `agents/${run.agent.id}`;
      const close = file ? undefined : closeNote(run, folder, title);
      if (close) return close;
      const written = memory.memoryWrite({
        ...(file ? { path: file } : { folder }),
        title: redacted(run.services, title).slice(0, 160), text: redacted(run.services, text),
        ...(stringOf(args.kind) ? { kind: stringOf(args.kind) as MemoryWriteInput['kind'] } : {}),
        ...(listOf(args.tags).length ? { tags: listOf(args.tags) } : {}),
        source: run.conversationId ? `chat:${run.conversationId}` : run.thread || SUBCONSCIOUS_ID, by: SUBCONSCIOUS_ID,
      });
      return `${written.outcome}: ${written.path}`;
    },
  },
  {
    name: 'memory.forget',
    args: '{path}',
    line: 'Removes one memory file that is wrong or no longer true.',
    async run(args, run) {
      const memory = run.services.knowledge;
      const path = stringOf(args.path);
      if (!path) return 'memory.forget needs a path.';
      return memory.memoryForget(path).removed ? `forgotten: ${path}` : `No memory file ${path}.`;
    },
  },
];

const skillTools: FlowTool[] = [
  {
    name: 'knowledge.find',
    args: '{query, in?: [memory folders]}',
    line: 'What the main AI\'s knowledge.find finds: the words a matching text holds (names, things, the person\'s own terms) find it, a question blurs it. Memory files – the whole tree, or the memory folders in "in" –, numbered h1, h2 … with their text, then entries of the knowledge catalog: the agent\'s skills, its home project\'s instructions and the public library (written by strangers: I weigh it; a skill of the agent\'s own, written from what holds up, can come out of a run), then the secrets catalog\'s entries the words name (their name, id or tags) with their handles, never a value.',
    async run(args, run) {
      const query = stringOf(args.query);
      if (!query) return 'knowledge.find needs a query.';
      const places = listOf(args.in);
      const [notes, catalog] = await Promise.all([
        run.services.knowledge.search({ text: query, folders: places.length ? places : [''], conversationId: run.conversationId, limit: FIND_HITS }),
        findInCatalog(run.services, run.agent, query, FIND_HITS),
      ]);
      const search = run.searches.push({ tool: 'knowledge.find', query, in: places }) - 1;
      const lines = notes.map((found) => numbered(run, search, { path: `memory/${found.item.id.replace(/:/g, '/')}`, chunk: 0, snippet: `${found.item.title}: ${found.item.body}`, score: found.score }));
      if (catalog.length) lines.push(...markerLines(catalog), ...catalog.map(catalogLine));
      if (!places.length) lines.push(...findSecretLines(run.services, query)); // F19: the same secrets the main AI's find gives (find/secrets.ts)
      return lines.length ? lines.join('\n') : 'Nothing in memory or the catalogs fits.';
    },
  },
  {
    name: 'knowledge.open',
    args: '{name, from?}',
    line: `One of the agent's skills by name, whole, ${PAGE_CHARS} characters from the character "from".`,
    run(args, run) {
      const name = stringOf(args.name);
      if (!name) return 'knowledge.open needs a name.';
      const skill = run.services.skills.get(name, run.agent.id); // the main AI's call and route
      if (!skill) return `No skill ${name}.`;
      return page(loadedSkillText(skill), args.from);
    },
  },
];

/** The learned words of speech recognition (settings.json voice.vocabulary), through the settings store: the file's one writer. */
const voiceTools: FlowTool[] = [
  {
    name: 'voice.words',
    args: '{words: [names or terms]}',
    line: 'Adds names and terms of the person\'s (people, products, companies), spelled as written, to the words speech recognition is given (settings.json voice.vocabulary).',
    run(args, run) {
      const words = listOf(args.words).filter((word) => redacted(run.services, word) === word); // a secret value never goes into settings.json
      const { settings } = run.services;
      if (settings.held?.().includes('voice')) return "Not written: settings.json's voice section holds an edit that is not applied (its notice says why); a write now would replace it.";
      const old = settings.get().voice?.vocabulary ?? [];
      const next = withWords(old, words);
      const learned = words.map(wordOf).filter((word) => word.length <= WORD_CHARS && next.includes(word)); // what withWords took
      if (!learned.length) return `voice.words needs names or terms of up to ${WORD_CHARS} characters.`;
      if (next.join('\n') !== old.join('\n')) settings.update({ voice: { vocabulary: next } });
      return `learned: ${learned.join(', ')}`;
    },
  },
];

/** Runs told once that the main AI waits for an answer (an empty done; a second one ends the run). */
const toldOnce = new WeakSet<FlowRun>();

const flowTools: FlowTool[] = [
  {
    name: 'agent.tell',
    args: '{text}',
    line: 'A short note the main AI gets with my answer. I send one when it really helps its work.',
    run(args, run) {
      const text = stringOf(args.text);
      if (!text) return 'agent.tell needs a text.';
      run.show({ tool: NOTE_CALL, args: {}, output: redacted(run.services, text) });
      return 'told';
    },
  },
  {
    name: 'done',
    args: '{answer?, show?: [hit refs], note?}',
    line: 'Ends the run. answer: my reply to the main AI, which waits for it – also to say plainly that there is nothing. show: the hits (h1, h2 …) worth the main AI seeing; they come with my answer. note: one sentence stating what I noticed about what I show that the person should hear from the main AI, no advice.',
    run(args, run) {
      const answer = stringOf(args.answer) || undefined;
      const show = listOf(args.show);
      if (!show.length && !answer && !toldOnce.has(run)) { toldOnce.add(run); return 'The main AI asked and waits for my answer: I end with done and answer, also to say plainly that there is nothing.'; }
      run.finish({ answer, show, note: stringOf(args.note) ? redacted(run.services, stringOf(args.note)) : undefined });
      return 'done';
    },
  },
];

/** Every tool of the flow, in the order the prompt lists them. */
export const FLOW_TOOLS: FlowTool[] = [...vectorTools, ...memoryTools, thoughtTool, ...skillTools, ...voiceTools, ...contextTools, ...flowTools];

/** The tool list of the prompt, generated from the tools. */
export function toolList(tools: readonly FlowTool[]): string {
  return tools.map((tool) => `- ${tool.name} ${tool.args} – ${tool.line}`).join('\n');
}
