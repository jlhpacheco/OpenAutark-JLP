// Engine interface: one shape for Codex, Claude Code, ACP agents, HTTP APIs and local models.
// Owns: turn input/output, streaming events and capability flags.
// Never: routing, permissions or persistence – the turn executor (agents/turn.ts) does those.

import type { Account, AccountLimits, Effort, EngineId } from '../../shared/model/providers.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import type { ToolOutput, ToolSpec } from '../tools/types.ts';
import type { SubconsciousTrace, TraceCall } from '../../shared/model/subconscious.ts';

export interface EngineCaps {
  sessions: boolean; // keeps a native session we can resume (only new input per turn)
  dynamicTools: boolean; // accepts our tools natively (codex dynamicTools / API function calling)
  mcp: boolean; // can connect to our MCP hub
  images: boolean;
  rebase: boolean; // renewed near the context limit: compaction + a fresh native session with the full projection
  structured: boolean; // supports output schemas for decisions
  ownTools: boolean; // brings its own shell/file/web tools (codex, claude, acp)
  fork?: boolean; // B-057: can fork a native session of the same account into a new one (Engine.fork – Codex thread/fork, Claude --fork-session)
  rebuild?: boolean; // can start a native session from the context ledger (Engine.rebuild)
  revert?: boolean; // rebuild can keep the session, cut its history before a recorded turn and add the tail (EngineRebuildInput.revert)
  trace?: boolean; // shows EngineTurnInput.trace as real tool calls itself (else the executor puts a tool-call-shaped block into the input)
}

// ---- B-057: native fork of a session (a split starts as its parent with the context it had) ----

/** The parent's native session `parentRef` of this account is copied into a new session; the parent's stays untouched. */
export interface EngineForkInput { runId: string; agentId: string; account: Account; parentRef: string; cwd?: string; model?: string;
  /** B-057 C: fork through this recorded native turn of the parent (Codex thread/fork lastTurnId; later turns stay out); absent: the whole session. */
  lastTurn?: string }
/** The new session's ref (and generation, when the engine numbers them). */
export interface EngineForkResult { ref: string; generation?: number }

// ---- Native rebuild of a session from the context ledger ----

/**
 * One item of the ledger's view a rebuild replays (agents/rebuild-items.ts maps the view onto it). `text` is the original or
 * condensed text; `stamp` a condensed item's restore stamp (appended verbatim). `call`: a tool call with its output – `own`: an
 * engine-native one, else one of ours. `nested`: a call made inside a code-mode script (never replayed); `calls`: on a script
 * call (Codex `exec`), one short line naming the calls it made inside.
 */
export interface RebuildItem {
  itemId: string;
  kind: string; // m | t | s | r | a | f | c (a hand-over: replayed as my own text)
  role: 'user' | 'assistant' | 'tool';
  text: string;
  stamp?: string;
  /** managed (0.3.19): the call ran through Autark's masked shell path (a Codex script call on a thread without native shell) – set per journal row where it was written, never derived from a session's mark. */
  call?: { name: string; args: unknown; callId: string; output: string; own?: boolean; ok?: boolean; managed?: true };
  origin?: { engine?: string; model?: string; accountId?: string };
  reasoning?: { signature?: string; encrypted?: string };
  nested?: boolean;
  calls?: string;
}

export interface EngineRebuildInput {
  runId: string;
  agentId: string;
  account: Account;
  model: string; // provider model id of the coming turn
  cwd: string;
  items: RebuildItem[];
  /** The turn's native dynamic tools (the new session starts with exactly these). */
  tools: ToolSpec[];
  /** Every tool name the turn offers (native and through the hub). */
  toolNames: string[];
  /** The turn's prompt: the new session starts with `stable` as its system prompt; `volatile` goes in its first turn's input. */
  system: { stable: string; volatile: string };
  /** The new session's generation (the superseded one's + 1). */
  generation: number;
  /** This CLI version's probe (agents/rebuild.ts keeps it per version). */
  probe?: RebuildProbe;
  /**
   * caps.revert: keep session `ref`, cut its history before `beforeTurn` (that turn and every later one go) and add `items` –
   * only the tail from that turn on – so the provider's prompt cache keeps the prefix. Throws when the engine refuses; the
   * executor then starts a new session as without it.
   */
  revert?: { ref: string; beforeTurn: string };
}

export interface EngineRebuildResult { ref: string; generation: number; items: number }

/** A rebuild tier's probe for one CLI version: cheap, model-free (Codex: start, inject, list, delete; Claude: resume a written transcript). */
export interface RebuildProbe {
  version: string;
  ok: boolean;
  reason?: string;
  /** Codex: 'count' – thread/items/list lists injected items before a turn (the rebuild checks them); 'accepted' – it does not. */
  verify?: 'count' | 'accepted';
  /** Claude: 'path' – `--resume <transcript.jsonl>`; 'project' – the app's own home with a fixed CLAUDE_CODE_PROJECT_DIR_NAME. */
  tier?: 'path' | 'project';
  /** Codex: thread/inject_items takes code mode's custom_tool_call items – an `exec` call replays natively (else a note). */
  custom?: boolean;
  at: number;
}

export type TurnInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; mime: string }
  | { type: 'file'; path: string; name: string; mime: string; text?: string }
  // MM10: a recording for the model to hear (media.listen). Only the compatible chat adapter
  // sends it (input_audio, WAV/MP3 ≤ 10 MB); every other engine renders it as a note (its name, and
  // the path for engines with their own tools), plus `text` when given.
  | { type: 'audio'; path: string; name: string; mime: string; text?: string };

/**
 * The cached part of the input as the engine reports it, next to `inputTokens`, which stays the total of all input: Codex's
 * `cachedInputTokens` (thread/tokenUsage/updated), Claude's and the Anthropic API's cache reads and cache writes. Absent: not reported.
 */
export interface CacheTokens { cachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }

export type EngineEvent =
  | { type: 'text'; delta: string }
  | { type: 'commentary'; text: string }
  // D5: provider-visible reasoning summary only (never raw or invented thoughts). `id` names the
  // engine's reasoning block (Codex item id, Claude message:index …); without one a block ends at
  // the next non-reasoning event. A section break inside a block arrives as a '\n\n' delta.
  | { type: 'reasoning'; delta: string; id?: string }
  // The block ended; `text` (when given) is the engine's authoritative full text of that block.
  // `signature`: Claude's signature of that thinking block.
  | { type: 'reasoning_end'; id?: string; text?: string; signature?: string }
  | { type: 'plan'; steps: Array<{ text: string; status: 'pending' | 'active' | 'done' }> }
  // own = engine-native tool; `title` = the engine's own human line for the call (ACP), when it has one;
  // `nested` (B-049 F9): a call a code-mode script runs inside one engine call (Codex `exec`) – the model sees only the
  // script and what it printed, not this call's output; `parent`: that script call's id when known
  | { type: 'tool_start'; callId: string; name: string; args: unknown; own: boolean; title?: string; nested?: boolean; parent?: string; managed?: true }
  // `output`: an engine-native tool's full output text, bounded (Codex command output and file diffs, Claude
  // tool_result content) for the run journal.
  | { type: 'tool_end'; callId: string; ok: boolean; summary: string; output?: string }
  // costUsd: what the engine reports (Claude Code: the session's running total); modelCalls: the turn's model calls so far,
  // from an engine that counts them in its stream (Claude Code's message_start).
  | ({ type: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number; costUsd?: number; modelCalls?: number } & CacheTokens)
  | { type: 'limits'; limits: AccountLimits }
  | { type: 'status'; note: string } // short live status ("running tests")
  // B-080: the engine started a fresh native session for this turn (Claude Code --session-id at its system/init, Codex after
  // thread/start) – the executor binds it at once, so a kill or restart mid-turn resumes it instead of starting over.
  | { type: 'session'; ref: string; generation: number }
  // B-080: Engine.setModel switched the running turn to `model` (provider id) at `effort`. FIXES-3 C1: Claude Code says so once
  // a request runs on it; Codex when it applied the switch (turn/settings/update), before its next request – open under C1.
  | { type: 'model'; model: string; effort: Effort }
  // B-080: the engine's own background work (a Claude Code background shell) started or ended; the turn lasts while
  // it runs, and the stall watch counts it as a call in flight (agents/stall-watch.ts).
  | { type: 'background'; id: string; running: boolean }
  // KI-Runde 17.11.2026: the engine compacted the session's history by itself in this turn – its own count before and after and how
  // long it took, where it reports them (Claude Code compact_boundary, Codex contextCompaction); the executor journals it as a run note.
  | { type: 'compacted'; before?: number; after?: number; ms?: number };

export interface EngineTurnInput {
  runId: string;
  agentId: string;
  account: Account;
  model: string; // provider model id
  effort: Effort;
  /** B-078 (D14, D16): the sampling temperature 0..2 the agent asked for (model.set). http/compatible.ts sends it; http/openai.ts and
   *  http/anthropic.ts send it to models that take one and drop it for reasoning/thinking models (engines/http/temperature.ts);
   *  the Codex and ACP CLIs ignore it. B-083: openai.ts sends it to a reasoning model only at effort none
   *  (GPT-6 Sol/Luna, 6.1 Terra, gpt-5.1+); compatible.ts drops it for Gemini 3+ and follows anthropicTemperature (only at
   *  effort none) / openAiTemperature for gateway ids. Owner 09.11.: thinking is never turned off for it – Claude takes a
   *  temperature only without thinking, so Claude Code sends none and the Anthropic API only to the older models that run
   *  without thinking anyway (http/anthropic.ts anthropicTemperature). */
  temperature?: number;
  /** Resume target (engines with sessions); `contextTokens`: the engine's own count of it after its last request (Codex tells a repeat of that request's usage by it). */
  session?: { ref: string; generation: number; contextTokens?: number };
  /** `stable`: the system prompt, the same text for every session of an agent while its key holds. `volatile`: the live context
   *  for this turn (all of it on a new or rebuilt session, what changed on a resumed one) – every engine sends it as the first
   *  block of this turn's input (shared.ts contextText), never in a system prompt or instructions. */
  system: { stable: string; volatile: string };
  input: TurnInputItem[]; // only what is new for this turn (or the full projection for stateless engines)
  tools: ToolSpec[]; // our workforce tools for this turn
  callTool: (name: string, args: unknown, callId: string) => Promise<ToolOutput>;
  mcp?: { url: string; token: string }; // our MCP hub for CLI engines
  cwd: string; // agent workspace directory
  outputSchema?: Record<string, unknown>; // structured output (decisions)
  onEvent: (event: EngineEvent) => void;
  signal: AbortSignal;
  /** A turn that changes nothing (helpers): Codex opens a read-only sandbox, ACP rejects permission requests. */
  readOnly?: boolean;
  /**
   * KI-Runde 17.11.2026: the caller keeps this lean, tool-less conversation for more turns – a call's voice, which says one
   * line at a time for as long as the call runs (decision/engine-runner.ts createChatOpener). The engine answers with its
   * session, holds it open between the turns and takes the next line on it; an engine that cannot leaves `session` out,
   * and every line is its own turn.
   */
  keep?: true;
  /** What the subconscious shows this turn: real tool calls with outputs in the main AI's history, as if it had made them (each engine's injectTrace). */
  trace?: SubconsciousTrace;
}

export interface EngineTurnResult {
  text: string; // final assistant text (markdown)
  session?: { ref: string; generation: number; turn?: string }; // turn: B-049 F7 – the native turn id (Codex), recorded per run
  stop: 'done' | 'interrupted' | 'error' | 'limit';
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number } & CacheTokens;
  contextTokens?: number;
  contextWindow?: number; // the model's context window as the engine reports it (Codex, Claude)
  structured?: unknown; // parsed JSON when outputSchema was given
  // For 'error'/'limit' (rate_limited carries retryAfterMs). `details.rebase: true` = the native
  // session cannot continue (context full, thread gone): the executor renews it.
  error?: WorkforceErrorData;
  /** Files the engine produced (MM2: Codex image generation); stored and attached to the final message. */
  files?: EngineFile[];
  /** B-049 F6: the engine compacted the native session's history during this turn (Codex contextCompaction, Claude Code
   *  compact_boundary) – the volatile sections sent earlier may be gone from it, so the next turn sends them all again. */
  compacted?: boolean;
  /** This engine or version could not take input.trace as real tool calls: it went as a tool-call-shaped block in the input (engines/trace-text.ts). */
  traceAsText?: string;
}

/** One engine-produced file: inline bytes (base64 or a data: URL) or a saved file inside the workspace. */
export interface EngineFile {
  name: string;
  mime?: string;
  dataBase64?: string;
  path?: string;
}

export interface EngineModel {
  model: string;
  name: string;
  efforts: Effort[];
  defaultEffort?: Effort;
  vision?: boolean;
  contextTokens?: number;
  hidden?: boolean;
}

export interface AccountCheck {
  state: Account['state'];
  plan?: string;
  email?: string;
  limits?: AccountLimits;
  message?: string;
}

/** What a kept conversation opens with (Engine.keepOpen): the account, model and effort, its stable part and its folder. */
export type KeepOpenInput = Pick<EngineTurnInput, 'account' | 'model' | 'effort' | 'system' | 'cwd'>;

export interface Engine {
  readonly id: EngineId;
  readonly caps: EngineCaps;
  /** Models this account can run (catalog only; entitlement is proven by a completed turn). */
  listModels(account: Account): Promise<EngineModel[]>;
  /**
   * Login state, plan and limits – via official status calls, never by reading tokens. `details` (B-044,
   * Codex): also the banked resets' credit details (the person opened the limits, or a reset was used);
   * without it a background read asks for the count only (accounts/limits.ts mergeLimits keeps stored details).
   * `background`: the monitor's own read – Claude Code then reuses a recent signed-in `auth status` (claude/status.ts).
   */
  checkAccount(account: Account, options?: { details?: boolean; background?: boolean }): Promise<AccountCheck>;
  run(input: EngineTurnInput): Promise<EngineTurnResult>;
  /** Steer a running turn with extra input (important messages). */
  steer?(runId: string, text: string): Promise<boolean>;
  /**
   * B-080 (model.set now): the running turn goes on with `model` (provider id) at `effort` from its next request, and the
   * turn's events say so ('model' – when, per engine, its comment says); false when it cannot (no turn running here, not
   * started yet, the engine refused).
   */
  setModel?(runId: string, model: string, effort: Effort): Promise<boolean>;
  /** A call of the subconscious into a running turn's history, as a real tool call and its output (the turn's own input.trace is for its start). */
  tell?(runId: string, call: TraceCall): Promise<boolean>;
  /** LEAN: an engine with a start-up cost (a server process per account) says whether this account's is up now; absent = no start-up cost. */
  warm?(account: Account): boolean;
  /** LEAN: starts this account's server ahead of a likely helper call (no model call); it idles out as usual. */
  prewarm?(account: Account): Promise<void>;
  /**
   * KI-Runde 17.11.2026 (decision 7.1): opens a `keep` conversation before its first line – the session starts with its system
   * prompt and waits; the first line brings the ref it answers. Absent: the first line opens the session.
   */
  keepOpen?(input: KeepOpenInput): Promise<{ ref: string; generation: number }>;
  /** Free processes (idle kill / shutdown). */
  dispose(): Promise<void>;
  /**
   * Wave 2 (privacy, optional): deletes one native session the app started, through the provider's
   * official API (Codex: app-server `thread/delete`); 'missing' when the provider has it no more.
   * B-048 E2: Claude Code deletes the transcript the app wrote and the CLI's own transcript of that session id.
   */
  deleteSession?(account: Account, ref: string): Promise<'deleted' | 'missing'>;
  /**
   * 0.3.19 (managed shell, engines/managed-session.ts): whether `ref` may resume natively – this process opened or wrote it, or
   * its mark (managed_paths) still matches the native transcript exactly under a verified masker and CLI version. False: the
   * caller starts the session anew from the filtered history. Absent: every ref may resume (engines without a native shell).
   */
  managedResume?(account: Account, ref: string): Promise<boolean>;
  /** caps.rebuild: starts a new native session holding `items` as its history; throws when it cannot (the executor falls back). */
  rebuild?(input: EngineRebuildInput): Promise<EngineRebuildResult>;
  /** The CLI version the rebuild probe is kept for (undefined: unknown – the probe runs every process). */
  rebuildVersion?(account: Account): Promise<string | undefined>;
  /** The cheap, model-free probe of the rebuild for this CLI version. */
  probeRebuild?(account: Account, cwd: string): Promise<RebuildProbe>;
  /** B-057 (caps.fork): a new native session holding the parent session's history; throws when it cannot (the split falls back). */
  fork?(input: EngineForkInput): Promise<EngineForkResult>;
  /** B-057 (splits/release.ts): a released split session leaves a shared process's memory (Codex app-server: thread/unsubscribe); its stored history stays for the session sweep. Never starts a process. */
  unload?(account: Account, ref: string): Promise<void>;
  /** Live test C4 ("Stop all work", agents/work-stop.ts): every background command the engine's loaded sessions left running ends (Codex: thread/backgroundTerminals/clean). Never starts a process; resolves to the sessions cleaned. */
  stopBackground?(): Promise<number>;
  /**
   * Wave 2 (privacy, optional): deletes every session history of the account's config home through
   * the provider's official CLI (Claude Code: `claude purge --all --yes`); callers allow it only for
   * the app's own isolated homes (privacy/native-history.ts).
   */
  purgeHistories?(account: Account): Promise<{ purged: boolean; message?: string }>;
  /**
   * Owner 07.11.2026 (Codex): this account's app-server lent for a request of its own – the plan's dictation refreshes its
   * login with it (voice/plan-transcribe.ts); throws when the server cannot start.
   */
  realtime?(account: Account): Promise<RealtimeLink>;
}

/** Engine.realtime: requests to the account's server and a hold against its idle shutdown. */
export interface RealtimeLink {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Marks the session as running, so the server does not idle out under it; returns its end. */
  hold(): () => void;
}
