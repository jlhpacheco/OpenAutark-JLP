// Context ledger (B-048 E1, back 01.11.2026): every unit of an agent's working context in a thread (13.11.2026: its main
// thread spans every chat) has a short, stable id – m<n> a chat message it saw, t<n> a tool call with its output (ours or engine-native), s<n> a loaded
// skill text, r<n> a reasoning summary, a<n> the agent's own text (commentary or answer), f<n> file content
// read, c<n> a checkpoint: the hand-over the agent wrote to itself when its context was folded (agents/context-fold.ts) –
// pinned, shown whole in every view, and everything of its own work before it is hidden by 'fold'.
// <n> counts per (agent, thread) – messages on their own, t/s/r/a/f/c together – and is never reused. A row keeps its title and its
// condensed text for good, so an id never dangles; the original (a message, a run item, a blob) is kept
// at least 14 days after it was condensed or hidden, within 64 MB per (agent, thread).
// B-049 F9: a NESTED item is a call a code-mode script ran inside one engine call (Codex `exec`: the model saw only
// the script and what it printed, never this call's output) – its engine call id starts with "exec-" (Codex names
// every call made inside an exec script so; checked against the rollouts and codex-cli 0.165). It stays in the ledger
// (context.restore returns its output) but costs nothing in the live context and is never replayed on its own.
// Owns: the shapes, the id rules, the token estimate (two characters per token, KI-Runde 17.11.2026), the live-context cost (a
// nested item 0), the nested-call rule, the title cap and the restore stamp of a condensed item. Never: storage or
// capture (runtime/context/ledger/*).

export type LedgerKind = 'message' | 'tool' | 'skill' | 'reasoning' | 'assistant' | 'file' | 'checkpoint';
export type LedgerState = 'keep' | 'condensed' | 'hidden';
/**
 * Who set a mark: the subconscious, the agent itself, or a restore; 'window' (B-080): the fit of the model's window hid the
 * oldest tool work, or the lean history set finished work aside (context/ledger/window.ts); 'fold' (KI-Runde 17.11.2026):
 * the agent's own work before its hand-over, hidden when its context was folded (context/ledger/service.ts fold).
 */
export type MarkBy = 'subconscious' | 'agent' | 'restore' | 'window' | 'fold';

/** Id letter per kind. */
export const KIND_PREFIX: Readonly<Record<LedgerKind, string>> = { message: 'm', tool: 't', skill: 's', reasoning: 'r', assistant: 'a', file: 'f', checkpoint: 'c' };
const ITEM_ID = /^([mtsrafc])([1-9]\d{0,11})$/;

/** Titles are at most this long. */
export const TITLE_CHARS = 120;
/** A restore pins the restored items for this many of the agent's turns in the chat (the subconscious leaves them alone). */
export const PIN_TURNS = 3;

export interface LedgerOrigin {
  /** Engine that produced the item (codex, claude, an HTTP engine …); none for chat messages. */
  engine?: string;
  /** Catalog model id of the producing turn. */
  model?: string;
}

/** One ledger row as callers read it. */
export interface LedgerItem {
  agentId: string;
  conversationId: string;
  itemId: string;
  kind: LedgerKind;
  /** The run that captured it (for an m item: the turn that delivered the message). */
  runId?: string;
  /** Monotonic position per (agent, chat). */
  order: number;
  createdAt: number;
  /** Estimate of what the item costs in context as captured (characters / CHARS_PER_TOKEN; rows from before 17.11.2026 were rescaled by migration 109, ×3/2). */
  tokens: number;
  title: string;
  state: LedgerState;
  condensed?: string;
  /** Set only while the pin holds (a turn count of the ledger; expired pins read as unset). */
  pinnedUntil?: number;
  origin: LedgerOrigin;
  /** Where the original is: 'msg:<message id>', 'item:<run item id>' (the journal row; a big tool output is a blob it names). */
  ref?: string;
  /** The original is gone (retention); title and condensed text stay. */
  pruned?: boolean;
  markedBy?: MarkBy;
  markReason?: string;
  /** B-049 F9: a call a code-mode script ran inside one engine call – 0 tokens of the live context (liveTokens), never condensed or hidden. */
  nested?: boolean;
}

/** What a capture hands to record(). */
export interface NewLedgerItem {
  kind: LedgerKind;
  runId?: string;
  title?: string;
  /** The text as the agent holds it – estimates `tokens` when that is not given. */
  text?: string;
  tokens?: number;
  /** Where the original is (see LedgerItem.ref); a second record with the same ref updates that row. */
  ref?: string;
  origin?: LedgerOrigin;
  /** Size of an original kept in a blob (counts toward the retention budget); 0 when it lives elsewhere. */
  bytes?: number;
  createdAt?: number;
}

export interface LedgerMark {
  itemId: string;
  state: LedgerState;
  /** Required for 'condensed' unless the item has condensed text already. */
  condensed?: string;
  reason: string;
  by: MarkBy;
  /**
   * B-050 K5: with by 'restore', true pins for good (pinned_until = KEEP_PIN, within KEEP_TOKENS per agent and chat –
   * beyond that the PIN_TURNS pin applies); false ends a pin for good (context.restore keep: false).
   */
  keep?: boolean;
}

/** One entry of the view – what the next native rebuild contains, in order. */
export interface LedgerViewItem {
  itemId: string;
  kind: LedgerKind;
  role: 'user' | 'assistant' | 'tool';
  /** The original (tool outputs capped like a model sees them), or the condensed text with its stamp. */
  text: string;
  /** The restore stamp of a condensed item (also appended to `text`). */
  stamp?: string;
  /** Tool, skill and file items: the call with its (or the condensed) output. `args`: the journal's preview, parsed when it is JSON. */
  /** managed (0.3.19): its journal rows carry the managed-shell row mark (a Codex script call on a thread without native shell). */
  call?: { name: string; args: unknown; callId: string; output: string; own?: boolean; ok?: boolean; managed?: true };
  origin: LedgerOrigin;
  /** Additions to the contract shape: the item's order and its run. */
  order: number;
  runId?: string;
  state: Exclude<LedgerState, 'hidden'>;
  /** B-049 F9: a call made inside a code-mode script (see LedgerItem.nested) – a rebuild never replays it as a call of its own. */
  nested?: boolean;
}

export type LedgerView = LedgerViewItem[];

/**
 * The one unit every size of the platform counts in – the ledger's rows, the fit's room, the fold's thresholds – so they compare
 * like with like against the engine's own count (SessionBinding.contextTokens, which is the real one). Measured 15.–17.11.2026
 * on 252 rebuilt Claude sessions (German text, JSON, paths, ids): the first real call carried 44k + 1.51 × the history's
 * estimate at 3 characters per token, three transcripts counted directly gave 1.89–1.99 characters per real token. At 3 the
 * "80 % fit" of a 1M window let 1.2M real tokens through: a history estimated at 787,902 passed as fitting, and Claude Code
 * compacted 33 freshly rebuilt sessions at their first resume. runtime/context/ledger/window.ts tokensOf counts in it too.
 */
export const CHARS_PER_TOKEN = 2;

/**
 * What a token really is, in characters, on each engine (measured 08.–09.11.2026 against the CLIs' own counts): Claude Code 2,
 * Codex 3.4. Every row is counted in CHARS_PER_TOKEN, so an estimate of that kind is read in the engine's own unit wherever the
 * two are compared – a session's size against its window, the fold's thresholds (runtime/agents/rebuild.ts).
 */
const CHARS_PER_TOKEN_ON: Record<string, number> = { claude: 2, codex: 3.4 };

/** How many tokens of an estimate in CHARS_PER_TOKEN make one token of `engine`'s own count (1 where the units are the same). */
export function engineUnit(engine: string | undefined): number {
  return (CHARS_PER_TOKEN_ON[engine ?? ''] ?? CHARS_PER_TOKEN) / CHARS_PER_TOKEN;
}

/** The token estimate used everywhere in the ledger: two characters per token (CHARS_PER_TOKEN). */
export function estimateTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** B-049 F9: the engine call id prefix of a call made inside a code-mode script (Codex `exec`). */
export const NESTED_CALL_PREFIX = 'exec-';

/** B-049 F9: a call a code-mode script ran (its output reached the script, not the model's context). */
export function isNestedCall(callId: string | undefined | null): boolean {
  return typeof callId === 'string' && callId.startsWith(NESTED_CALL_PREFIX);
}

/** B-049 F9: what an item costs in the live context – its estimate, a nested call nothing. */
export function liveTokens(item: { tokens: number; nested?: boolean | null }): number {
  return item.nested ? 0 : Math.max(0, Number.isFinite(item.tokens) ? item.tokens : 0);
}

/** A well-formed item id: lower-case letter + positive number ('#12' and 'M12' read as 'm12'). */
export function normalizeItemId(value: string): string | undefined {
  const raw = value.trim().toLowerCase().replace(/^#(\d+)$/, 'm$1');
  return ITEM_ID.test(raw) ? raw : undefined;
}

/** One line, at most TITLE_CHARS characters. */
export function ledgerTitle(text: string | undefined, fallback = 'item'): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim() || fallback;
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** The stamp a condensed item carries, verbatim JSON: {"compacted":"t17","was":"1240 tokens","restore":"context.restore"}. */
export function compactStamp(itemId: string, tokens: number, gone = false): string {
  return JSON.stringify({ compacted: itemId, was: `${Math.max(0, Math.round(tokens))} tokens`, ...(gone ? { original: 'gone' } : { restore: 'context.restore' }) });
}
