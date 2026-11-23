// Hints from my memory (Runde „Halb“ 21.11.2026, owner: "Memories … geben einfach einen kurzen Einstieg da rein, das nicht zu
// vergessen"): the call before a turn (route-turn.ts) picks word-search hits and says in one line of its own what each changes in
// this turn; the turn's live block shows them as "## From my memory" (context/prompt-volatile.ts), one line each with how to
// open the entry – knowledge.open "<id>", or a secret's handles (never a value). Nothing goes in as a tool pair: the main AI
// opens an entry itself when it needs the rest. Before, every opened entry stood whole in the context and was read again on
// every later model call.
// Store: kv, per agent and thread – `now` the hints of the turn being built (beforeTurn writes them on every turn, so a turn
// without hints shows none), `next` what a call beside a started turn picked; the next turn takes it into its `now`.
// The lines themselves are made from the call's picks in look.ts (hintsOf).
// Owns: the hint shape, its caps, its section text and that store. Never: holds a secret's value, or more than HINTS lines.

import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';

/** One hint as the turn shows it: the call's line and how the entry opens. */
export interface MemoryHint { id: string; line: string; open: string }

/** At most this many hints a turn. */
export const HINTS = 6;
/** A hint's line at most (the call's own sentence). */
export const HINT_CHARS = 200;
const NS = 'subconscious_hints';
/** A hint kept for a next turn that never came within a day is about something else by now. */
const KEPT_MS = 24 * 60 * 60_000;

/** "## From my memory" with one line per hint; '' without any. */
export function hintsSection(hints: readonly MemoryHint[]): string {
  return hints.length ? ['## From my memory', ...hints.slice(0, HINTS).map((hint) => `- ${hint.line} (${hint.open})`)].join('\n') : '';
}

const keyOf = (agentId: string, thread: string, slot: 'now' | 'next') => `${agentId}:${thread}:${slot}`;
type Kept = { hints: MemoryHint[]; at: number };

function read(kv: KvRepo, key: string, now: number): MemoryHint[] {
  const kept = kv.get<Kept>(NS, key);
  return kept && now - kept.at <= KEPT_MS && Array.isArray(kept.hints) ? kept.hints : [];
}

const merged = (lists: MemoryHint[][]): MemoryHint[] => [...new Map(lists.flat().map((hint) => [hint.id, hint])).values()].slice(0, HINTS);

/** This turn's hints: `fresh` from the call it waited for, then what a call beside my last turn kept for it. Never throws. */
export function startHints(services: RuntimeServices, agentId: string, thread: string, fresh: readonly MemoryHint[]): void {
  try {
    const kv = new KvRepo(services.db);
    const now = services.clock.now();
    const next = read(kv, keyOf(agentId, thread, 'next'), now);
    kv.delete(NS, keyOf(agentId, thread, 'next'));
    const hints = merged([[...fresh], next]);
    if (hints.length) kv.set(NS, keyOf(agentId, thread, 'now'), { hints, at: now } satisfies Kept, now);
    else kv.delete(NS, keyOf(agentId, thread, 'now'));
  } catch { /* no store: the turn shows no hints */ }
}

/** What a call beside a started turn picked: it reaches the thread's next turn. Never throws. */
export function keepHints(services: RuntimeServices, agentId: string, thread: string, hints: readonly MemoryHint[]): void {
  if (!hints.length) return;
  try {
    const kv = new KvRepo(services.db);
    const now = services.clock.now();
    const key = keyOf(agentId, thread, 'next');
    kv.set(NS, key, { hints: merged([read(kv, key, now), [...hints]]), at: now } satisfies Kept, now);
  } catch { /* no store: nothing kept */ }
}

/** The hints of the turn being built for this agent and thread (none without a store). */
export function turnHints(services: RuntimeServices, agentId: string, thread: string): MemoryHint[] {
  try { return read(new KvRepo(services.db), keyOf(agentId, thread, 'now'), services.clock.now()); } catch { return []; }
}

/** The person's Forget: a kept hint that mentions it is gone. Never throws. */
export function forgetHints(services: RuntimeServices, match: (text: string) => boolean): void {
  try {
    const kv = new KvRepo(services.db);
    for (const row of kv.list<Kept>(NS)) if (match(JSON.stringify(row.value))) kv.delete(NS, row.key);
  } catch { /* nothing kept */ }
}
