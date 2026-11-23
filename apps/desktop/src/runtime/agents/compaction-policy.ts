// Compaction policy (CTX7, B-080; KI-Runde 17.11.2026): how big an agent's context may get and when it is made small.
// Two rules, both in the engine's own token count (SessionBinding.contextTokens – every estimate beside it counts in
// shared/model/context-ledger.ts CHARS_PER_TOKEN, measured against that count):
// - The fold (owner 17.11.2026: "immer mal wieder Compactings … vor allem wenn Schritte aufhören … ein bisschen mehr
//   Thinking"): when a piece of work ends and the context has grown past FOLD_STEP, at FOLD_IDLE whatever the turn did, and
//   after the engine compacted by itself, the agent writes its own hand-over in one more turn on the warm session
//   (agents/context-fold.ts) and the next turn starts from it.
// - The fit (owner 08.11.2026: "keine Verdichtung bei 150k oder 128k … das muss komplett dynamisch sein"): the backstop at the
//   model's window. A session whose context no longer fits (pastFit: above FIT_SHARE of the window) is rebuilt with the oldest
//   tool work hidden – restorable like any mark – and only when even that does not bring it in, it is renewed
//   (session-choice.ts renewSession: dropped binding; the next turn gets the agent's record as text).
// Runde "Halb" 21.11.2026 (live 19.–20.11.: single runs re-read 500–900k tokens per model call, 12 runs above 500k cost 12.6 % of
// everything): inside a run the engines compact near RUN_CEILING themselves (Claude Code `--autocompact`, Codex
// `model_auto_compact_token_limit`), and at a turn's start code sets old tool output aside when that pays back within
// TRIM_PAYBACK_CALLS model calls at the turn model's own prices (trimPays; agents/rebuild.ts cause 'trim').
// Owns: the fit of the window, when a provider's cache counts as cold, the fold's sizes and causes, the run ceiling and the trim.

/**
 * The share of the model's window a session's context may fill between turns (ARCHITECTURE §13). The rest is room for the
 * next turn's own work. Agent turns compact near RUN_CEILING themselves; a session that still lies past the fit (a helper's
 * engine default, a window smaller than the ceiling) gets the oldest tool work hidden here, which leaves the person's words and
 * the recent work in place.
 */
export const FIT_SHARE = 0.8;
/** The window assumed for a model whose window is unknown: the smallest of today's frontier models. */
export const DEFAULT_WINDOW = 200_000;

/** The most context tokens a session carries between turns: FIT_SHARE of the model's window (DEFAULT_WINDOW when unknown). */
export function fitLimit(contextWindow: number | undefined): number {
  return Math.floor(FIT_SHARE * (contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_WINDOW));
}

/**
 * How far an engine's own count of a session may lie above the ledger's estimate of the same session and still be the unit's
 * doing (measured 15.–17.11.2026 per model, at two characters per token: Fable 0.82, Sonnet and Haiku 0.95, Opus 1.04 times
 * the estimate). A rebuild past the fit shrinks its room by that ratio up to this bound (agents/rebuild.ts); what lies beyond
 * it is content the session holds and a rebuild does not replay.
 */
export const UNIT_DRIFT = 1.25;

/** The context no longer fits the model's window with room for the next turn. */
export function pastFit(contextTokens: number | undefined, contextWindow: number | undefined): boolean {
  return (contextTokens ?? 0) > fitLimit(contextWindow);
}

/**
 * A provider's prompt cache lives about an hour: a session resting longer meets a cold cache on its next call, so starting it
 * anew costs nothing extra then. Measured 15.–17.11.2026 (15,439 Claude calls up to 60 min after the call before read their
 * context from the cache, the 4 calls after more than 65 min none; Codex: 31 of 33 runs after a 5–60 min pause started warm).
 */
export const CACHE_COLD_MS = 60 * 60_000;

/**
 * The fold's sizes, in the engine's own count of the session. Measured 15.–17.11.2026 (15,801 Claude calls of 17 agents): a
 * call carried 430k tokens on average, a main-lane run makes 13 calls, and a written token costs 40 read ones – so a session
 * written anew at about 60k (prompt and tools about 44k, the hand-over, the chat lines in reach) and read small on every later
 * call has paid for its one write after 40 × 60k / (C − 60k) calls: within one run from FOLD_IDLE on, within three at FOLD_STEP,
 * where the end of a task is the moment the record of that work is no longer needed whole.
 * Replayed on 15,807 real Claude calls of 16.–17.11.2026 at the CLI's own prices (review of 18.11.2026): the two sizes take
 * 43–49 % off the whole bill, and 180,000 for FOLD_IDLE saves $68–77 more over those two days than 250,000 did, because the
 * managers who rarely finish a task sat at 120k–250k for most of their calls; FOLD_STEP barely moves the result (90k, 120k and
 * 160k are within one point of each other).
 */
export const FOLD_STEP = 120_000;
export const FOLD_IDLE = 180_000;

/** A hand-over shorter than this cannot stand for a context of FOLD_STEP tokens: the fold marks nothing and the next trigger tries again. */
export const FOLD_MIN_CHARS = 400;

/**
 * The context an agent turn's engine compacts at inside a run, in that engine's own tokens: a safety net, not a working limit.
 * The owner's word of 08.11.2026 stands – no size decides what an agent keeps while it works ("keine Verdichtung bei 150k oder
 * 128k") – so the net hangs above what normal work reaches (live 19.–20.11.2026: p90 of a model call ≈ 200k) and only catches
 * the runs that grew to 500–900k per call (runs above 300k per call were 18 % of all cost). Below it the trim decides by price.
 */
export const RUN_CEILING = 250_000;
/**
 * Claude Code's `--autocompact` value for an agent turn: the flag sets the compact *window*, and Claude Code compacts about 33k
 * below it, so the value lies that margin above RUN_CEILING (probe 21.11.2026, Claude Code 2.1.329, Haiku: 100,000 compacted at
 * 68–69k, 183,000 at 149–150k; .local/halb-20261121/build/CTX.md).
 */
export const CLAUDE_AUTOCOMPACT = RUN_CEILING + 33_000;

/**
 * The trim (cause 'trim'): from this size on (the engine's own count of the session) a turn's start weighs setting old tool
 * output aside – below it a call re-reads little, and a session just folded or rebuilt (about 60k, see FOLD_STEP) stays below.
 */
export const TRIM_AT = 100_000;
/**
 * The model calls a trim has to pay back in: the owner's live sessions lived 41 calls on average between two rebuilds (662 calls
 * in 16 sessions, 19.–20.11.2026), and about half of a life is still ahead at any moment. With 12 the trim never ran on the
 * first bench day (8 messages, Sonnet): the context stood at 140–146k for the day's last eight calls, the old fold had 47–55k.
 */
export const TRIM_PAYBACK_CALLS = 24;
/** The tool steps the lean view keeps whole even inside open work: the newest ones are what the next steps build on. */
export const KEEP_STEPS = 6;

/**
 * Whether setting `freed` tokens aside pays: the calls of TRIM_PAYBACK_CALLS read them no more at the cached price, while the
 * rebuild writes `rewritten` tokens into the cache once. `writeInReads`: what one written token costs in cached reads for the
 * turn's model (Claude with a one-hour cache 40, Codex – no write surcharge – 10).
 */
export function trimPays(freed: number, rewritten: number, writeInReads: number): boolean {
  return freed > 0 && freed * TRIM_PAYBACK_CALLS >= rewritten * writeInReads;
}

/** Why a fold runs: a task ended ('step'), the size alone ('size'), the engine compacted the session by itself ('engine'). */
export type FoldWhy = 'step' | 'size' | 'engine';

/** Whether the turn that just ended calls for a fold, and why: `tokens` – the engine's count of its session now. */
export function foldWhy(turn: { tokens?: number; finishedTask: boolean; compacted: boolean }): FoldWhy | undefined {
  if (turn.compacted) return 'engine';
  const tokens = turn.tokens ?? 0;
  if (tokens >= FOLD_IDLE) return 'size';
  return turn.finishedTask && tokens >= FOLD_STEP ? 'step' : undefined;
}
