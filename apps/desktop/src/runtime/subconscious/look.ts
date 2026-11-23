// What the subconscious reads and does before a turn besides the effort (Unterbewusstsein v2, owner 15.11.2026: "dass es sich
// die Suchergebnisse bekommt … Dann kann es dieses Suchergebnisse auswählen, die es glaubt, was wichtig ist. Es kann kompakten der
// Kontext und Teile davon"; 13:27: the rule of three hits goes, the model condenses with a good explanation, leanText stays the net).
// Hits: the word search the main AI's own knowledge.find runs (find/service.ts – notes, skills, references, documents, with the
// agent's own reach) on the text that wakes the turn; the call chooses freely among them. Each hit shows how it begins – a note's or
// reference's first words, read without opening it (opening counts as use). Runde „Halb“ 21.11.2026: a chosen hit reaches the turn
// as the call's own line of what it changes there (hintsOf → hints.ts, the live block's "## From my memory"), not as an opened
// entry in the trace – that stood whole in the context and was read again on every later model call. Measured 15.11. on 39
// hand-labelled live messages: with how each begins and the call's sentence it chose 2.4 entries a message (9/13 helping, 2/26
// wrong; v2/RESULTS-V2.md). An entry hinted to an agent in this runtime is not offered again in the same version.
// Context (a forked part's first start only, route-turn.ts condensePart): the biggest items still whole in the part's copy of the
// record (the context ledger) – tool, file and skill items of every run but the newest finished one, at least ITEM_TOKENS each –,
// read with how they start. The call says for every item whether its job is done (17.11.2026: one yes or no per
// item – with a single list to condense, items it only wanted to say "keep" about were condensed); a done one keeps its note of
// what still matters – checked against the item and the text the call was shown –, then window.ts leanText of the original
// (every id, path, file name and link: the net under the note) and the restore stamp. The call does not hide: on the 12 hard E2
// cases under these conditions all its lost values and critical cuts came from hiding (net 0.77 with, 0.88 without; code alone
// 0.89; v2/RESULTS-V2.md). The part starts from the record as the call leaves it (splits/fork.ts).
// Owns: which hits and items the call reads, how they read, the chosen hits' lines and writing the chosen marks. Never: chooses
// itself, shows an entry the agent cannot open, hides anything, marks a message, a pinned or nested item, or the newest finished run's work.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { LedgerItem, LedgerKind, LedgerMark } from '../../shared/model/context-ledger.ts';
import '../contracts/ledger.ts';
import { findService, type FindCaller } from '../find/service.ts';
import type { Found } from '../find/candidates.ts';
import { leanText } from '../context/ledger/window.ts';
import { HINT_CHARS, HINTS, type MemoryHint } from './hints.ts';
import { ageText } from '../knowledge/age.ts';
import { inventedValues } from './context-tools.ts';

/** Hits the call reads at most (find's own cap is 20). */
export const HITS = 10;
/** Context items the condensing call reads at most: the biggest still whole (nobody waits for it; 12 took up to ~28 s on 15.11.). */
export const ITEMS = 12;
/** An item below this many tokens stays: a note in its place costs about as much as it saves. */
export const ITEM_TOKENS = 1000;
/** The kinds of item the call reads: work the agent did or loaded – never a chat line, its own words or its reasoning (code hides that). */
const LISTED: ReadonlySet<LedgerKind> = new Set(['tool', 'file', 'skill']);
const DESCRIPTION_CHARS = 200;
/** How much of a hit's text the call reads (a note's or reference's first words). */
const HIT_HEAD_CHARS = 200;
const HEAD_CHARS = 240;
/** The call's note on a condensed item at most; leanText's values follow it. */
export const NOTE_CHARS = 400;
/** The reason a mark of the call carries (its note stands in the condensed text). */
export const LOOK_REASON = 'set aside before a turn: its job was done';
/** Runs looked at for the newest finished one. */
const RECENT_RUNS = 20;

/** A hit with how it begins (a note's or reference's first words; a skill shows its description). */
export type Hit = Found & { head?: string };

export interface Looked {
  agent: Agent;
  conversationId?: string;
  mode?: string;
  thread: string;
}

/** An item the call reads, with how it starts (redacted). */
export interface ContextItem { item: LedgerItem; head: string }

const shown = new WeakMap<object, Map<string, string>>();
const shownTo = (services: RuntimeServices): Map<string, string> => {
  let seen = shown.get(services);
  if (!seen) { seen = new Map(); shown.set(services, seen); }
  return seen;
};
const redact = (services: RuntimeServices, text: string): string => {
  try { return services.secrets.redact(text); } catch { return text; }
};
const callerOf = (input: Looked): FindCaller => ({ agent: input.agent, ...(input.conversationId ? { conversationId: input.conversationId } : {}), thread: input.thread, ...(input.mode ? { mode: input.mode } : {}), via: 'agent' });
const flat = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)} …` : line;
};

/** A note's or reference's first words, redacted, read from the store (not opened: knowledge.open counts as use); none for other kinds. */
function headOf(services: RuntimeServices, hit: Found): string | undefined {
  if (!/^(note|ref):/.test(hit.id)) return undefined;
  try {
    const body = services.knowledge.get(hit.id.replace(/^(note|ref):/, ''))?.body;
    return body ? redact(services, flat(body, HIT_HEAD_CHARS)) : undefined;
  } catch { return undefined; }
}

/** The word search's hits for `text` this agent can open and was not shown in this version, best first, with how each begins; none when the search fails. */
export async function searchHits(services: RuntimeServices, input: Looked & { text: string; signal?: AbortSignal }): Promise<Hit[]> {
  const text = input.text.trim();
  if (!text) return [];
  try {
    const found = await findService(services).find(callerOf(input), { query: text, limit: HITS, ...(input.signal ? { signal: input.signal } : {}) });
    const seen = shownTo(services);
    return found.filter((hit) => seen.get(`${input.agent.id}|${hit.id}`) !== hit.version).map((hit) => {
      const head = headOf(services, hit);
      return head ? { ...hit, head } : hit;
    });
  } catch {
    return [];
  }
}

/** The hits as the call reads them: id · kind · title – description (why it was found) – how it begins. */
export function hitLines(hits: readonly Hit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((hit) => `- ${hit.id} · ${hit.kind} · ${flat(hit.title, 120)}${hit.description ? ` – ${flat(hit.description, DESCRIPTION_CHARS)}` : ''} (${hit.why})${hit.head ? ` – begins: ${hit.head}` : ''}`);
  return ['What the word search found in the agent\'s knowledge for this (id · kind · title – description · why – how it begins):', ...lines].join('\n');
}

/**
 * The call's picks as hints (hints.ts), in the order picked: `chosen` holds its entries ({id, line} – the line is its own sentence
 * of what the entry changes in this turn). An id not among `hits` or without a line shows nothing. A secret opens by its handles
 * (find/secrets.ts: names and handles, never a value), every other entry by knowledge.open with its id; lines and handles are
 * redacted. Each hinted entry counts as shown to the agent in its version.
 */
export function hintsOf(services: RuntimeServices, agentId: string, chosen: readonly unknown[], hits: readonly Found[]): MemoryHint[] {
  const offered = new Map(hits.map((hit) => [hit.id, hit]));
  const seen = shownTo(services);
  const out = new Map<string, MemoryHint>();
  for (const entry of chosen) {
    if (out.size >= HINTS) break;
    const id = String((entry as { id?: unknown } | null)?.id ?? '');
    const hit = offered.get(id);
    const line = flat(redact(services, String((entry as { line?: unknown } | null)?.line ?? '')), HINT_CHARS - 2); // flat adds " …" to a cut line
    if (!hit || !line || out.has(id)) continue;
    const open = hit.kind === 'secret' ? redact(services, hit.handles ?? `secret://${id.slice('secret:'.length)}`) : `knowledge.open "${id}"`;
    out.set(id, { id, line, open });
    seen.set(`${agentId}|${id}`, hit.version);
  }
  return [...out.values()];
}

/** The newest finished run of the agent's own lane: its work stays whole (the coming message often goes on from it). */
function newestFinished(services: RuntimeServices, agentId: string): string | undefined {
  try { return services.runs.list(agentId, RECENT_RUNS).find((run) => !run.splitId && run.endedAt)?.id; } catch { return undefined; }
}

/** The ITEMS biggest items still whole in the agent's record, oldest first, each with how it starts; none without a ledger. */
export function contextItems(services: RuntimeServices, agentId: string, thread: string): ContextItem[] {
  const ledger = services.ledger;
  if (!ledger) return [];
  try {
    const newest = newestFinished(services, agentId);
    const open = ledger.items(agentId, thread).filter((row) => row.state === 'keep' && !row.nested && row.pinnedUntil === undefined && LISTED.has(row.kind)
      && row.tokens >= ITEM_TOKENS && !(newest && row.runId === newest));
    const out: ContextItem[] = [];
    for (const item of open.sort((a, b) => b.tokens - a.tokens)) {
      if (out.length >= ITEMS) break;
      const original = ledger.original(agentId, thread, item.itemId);
      if (!original || original.pruned) continue;
      out.push({ item, head: redact(services, flat(original.text, HEAD_CHARS)) });
    }
    return out.sort((a, b) => a.item.order - b.item.order);
  } catch {
    return [];
  }
}

/** The items as the call reads them: id · kind · tokens · age · title – how it starts. */
export function itemLines(items: readonly ContextItem[], now: number): string {
  if (!items.length) return '';
  const lines = items.map(({ item, head }) => `- ${item.itemId} · ${item.kind} · ${item.tokens.toLocaleString('en-US')} tokens · ${ageText(item.createdAt, now)} · ${flat(item.title, 120)}${head ? ` – starts: ${head}` : ''}`);
  return ['The biggest items still whole in the main AI\'s context (id · kind · tokens · age · title – how it starts), oldest first:', ...lines].join('\n');
}

/**
 * The call's marks. `answers` holds one entry per item it was shown ({id, done, note}); an item whose job it calls done is
 * condensed – its note, then leanText of the original –, every other one stays whole. The note stays unless it names a value
 * that stands neither in the original nor in `shown`, the text the call read (context-tools.ts inventedValues; measured
 * 15.–17.11.2026: 418 of 2,472 notes were dropped for a value the call had taken from the chat it was shown). Only items it
 * was shown. Returns how many.
 */
export function markItems(services: RuntimeServices, agentId: string, thread: string, items: readonly ContextItem[], answers: unknown, shown = ''): number {
  const ledger = services.ledger;
  const listed = new Map(items.map((entry) => [entry.item.itemId, entry.item]));
  const condense = Array.isArray(answers) ? answers.filter((entry) => (entry as { done?: unknown } | null)?.done === true) : [];
  if (!ledger || !condense.length) return 0;
  const marks: LedgerMark[] = [];
  const done = new Set<string>();
  for (const entry of condense) {
    const id = String((entry as { id?: unknown })?.id ?? '');
    if (!listed.has(id) || done.has(id)) continue;
    const original = ledger.original(agentId, thread, id);
    if (!original || original.pruned) continue;
    const source = original.args ? `${original.args}\n${original.text}` : original.text;
    const said = flat(String((entry as { note?: unknown }).note ?? ''), NOTE_CHARS);
    const note = said && !inventedValues(`${source}\n${shown}`, said).length ? said : '';
    marks.push({ itemId: id, state: 'condensed', condensed: redact(services, [note, leanText(source)].filter(Boolean).join('\n')), by: 'subconscious', reason: LOOK_REASON });
    done.add(id);
  }
  if (marks.length) ledger.mark(agentId, thread, marks);
  return marks.length;
}
