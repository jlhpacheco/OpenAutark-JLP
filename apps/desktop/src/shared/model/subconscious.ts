// The calls a turn's trace carries into the main AI's history as real tool calls with their output (owner 01.11.2026) – what a run
// kept for the thread, e.g. timeout decisions a native turn could not take in, or a note under the subconscious's own tool. An empty
// trace shows nothing. Runde „Halb“ 21.11.2026: the entries the subconscious picks before a turn are no calls any more – they reach
// the turn as one-line hints in its live block ("## From my memory", subconscious/hints.ts).
// Owns: the trace shape, its size cap and the ids of its calls. Never: runs anything or knows an engine's wire format.

/** The name a note of the subconscious stands under in the main AI's history: the tool it has in its list. */
export const NOTE_CALL = 'subconscious';

/** One call the subconscious made that matters for the agent. */
export interface TraceCall {
  tool: string;
  args: Record<string, unknown>;
  output: string;
  /** When a kept call was kept (absent until then): an old note or hit is not shown any more. */
  at?: number;
}

/** The calls shown to the main AI before its turn's model call (empty = nothing to show). */
export interface SubconsciousTrace {
  calls: TraceCall[];
}

/** The most a trace may cost the main AI's context, in tokens (a token ≈ 4 characters). */
export const TRACE_TOKENS = 600;
/** B-080 wave 3: sizes only the trace's text; never compared with an engine's count (that unit is context-ledger.ts CHARS_PER_TOKEN). */
const TRACE_CHARS_PER_TOKEN = 4;
/** Below this many characters left a call is dropped rather than cut to nothing. */
const MIN_OUTPUT_CHARS = 80;
const CUT = ' … [cut]';

/** True when the trace has something to show. */
export function hasTrace(trace: SubconsciousTrace | undefined): trace is SubconsciousTrace {
  return Boolean(trace?.calls.length);
}

/** The trace within `maxTokens`: earlier calls first, the call that does not fit cut (and saying so), later ones dropped. */
export function capTrace(trace: SubconsciousTrace, maxTokens = TRACE_TOKENS): SubconsciousTrace {
  let left = maxTokens * TRACE_CHARS_PER_TOKEN;
  const calls: TraceCall[] = [];
  for (const call of trace.calls) {
    left -= call.tool.length + JSON.stringify(call.args).length;
    if (left < MIN_OUTPUT_CHARS) break;
    const output = call.output.trim();
    calls.push({ ...call, output: output.length > left ? `${output.slice(0, left - CUT.length).trimEnd()}${CUT}` : output });
    left -= output.length;
  }
  return { calls };
}

/** What every call id of a trace starts with (the ledger finds the subconscious's calls by it). */
export const TRACE_CALL_PREFIX = 'sc_';

/** A stable id for the n-th call of a trace in a run: letters, digits, '_' and '-' only, valid on every provider API. */
export function traceCallId(runId: string, index: number): string {
  const base = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'turn';
  return `${TRACE_CALL_PREFIX}${base}_${index}`;
}
