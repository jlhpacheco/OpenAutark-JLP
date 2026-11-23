// Shared shapes of one agent turn (dispatcher ↔ turn executor ↔ its phases).
// B-054: a turn carries its wakes' origin (TurnRequest.origin) and its thread (TurnPlan.thread, threadKey in
// shared/model/origin.ts) – native sessions and turn state are keyed by the thread: 13.11.2026 the agent's one main
// thread, a split's part its own.
// Owns: request/plan/attempt/outcome types, plus `effectful` – whether a tool call did something (the ownership loop's
// progress signal, tasks/next.ts).
// Never: other behaviour.

import type { CacheTokens, Engine, EngineTurnResult } from '../engines/types.ts';
import type { PromptParts, RouteRequest } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { Account, RouteDecision } from '../../shared/model/providers.ts';
import type { AgentActivity, RunStatus, WakeReason } from '../../shared/model/runs.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { Origin } from '../../shared/model/origin.ts';
import type { SplitTurn } from '../../shared/model/splits.ts'; // B-057
import type { SubconsciousTrace } from '../../shared/model/subconscious.ts';
import type { ActionCategory, ToolSpec } from '../tools/types.ts';
import { CODE_EXEC, CODE_WAIT } from '../engines/code-mode.ts'; // B-080: the script wrapper is no work in itself
import type { SessionBinding } from './sessions.ts';
import type { Held } from './volatile-delta.ts';
import type { SessionStart } from './session-key.ts'; // S2

/** One tool call of a turn: our tools with their category, engine-native ones by name. */
export interface ToolUse {
  name: string;
  /** Category of one of our tools; undefined for engine-native tools (judged by name). */
  category?: ActionCategory;
  native: boolean;
  /** False when the call failed or was refused; undefined while unknown. */
  ok?: boolean;
}

/** Engine-native tools that only look (Claude/Codex/ACP agent names). */
const LOOKS = /^(read|view|grep|glob|ls|list|search|find|web_?search|web_?fetch|fetch|todo_?read|notebook_?read)$/i;

/**
 * True when the call did something (it can change something, or it is task work) and did not fail.
 * B-080: Codex code mode's script wrapper (`exec`, `wait`) counts by the calls it makes – the nested shell and our tools
 * are journaled as their own calls –, so a script that only read is no work.
 */
export function effectful(use: ToolUse): boolean {
  if (use.ok === false) return false;
  if (use.native && (use.name === CODE_EXEC || use.name === CODE_WAIT)) return false;
  if (use.native) return !LOOKS.test(use.name.replace(/^mcp__\w+__/, ''));
  return use.category !== 'read' && (use.category !== 'think' || /^(tasks|schedules|agents|human)\./.test(use.name));
}

/** Live handles the dispatcher uses while a turn runs (steer, cursor bookkeeping). */
export interface TurnControl {
  engine?: Engine;
  /** Highest message seq included in this turn's input. */
  lastSeq: number;
  /** Highest seq steered into the running turn (advanced together with lastSeq). */
  steeredSeq: number;
  /** 07.11.2026: other chats' lines folded into this turn (dispatch-steer.ts steerOther), by chat: the highest seq folded and whether the waiting line was written there. */
  others?: Map<string, { seq: number; told?: boolean }>;
  /** Why the dispatcher aborted the turn (the first abort decides): the human pressed Stop or
   *  Cancel, an important message took over, or the runtime shuts down. */
  stopKind?: StopKind;
}

export type StopKind = 'human' | 'urgent' | 'shutdown';

export interface TurnRequest {
  runId: string;
  agentId: string;
  conversationId?: string;
  taskId?: string;
  reason: WakeReason;
  /** B-054: what started the run (the wake group's origin: a mail, a schedule, task news …); absent on plain chat and task wakes. */
  origin?: Origin;
  /** B-054 fix: the note of the outside event that origin came from (WakeGroup.originNote). */
  originNote?: string;
  notes: Array<{ text: string; at: number; reason?: WakeReason }>;
  /** Runde „Halb“ 21.11.2026: other chats due at the turn's start, riding along – their notes; their unseen lines come with them (agents/turn-riders.ts). */
  riders?: Array<{ conversationId: string; notes: Array<{ text: string; at: number; reason?: WakeReason }> }>;
  /** An earlier attempt in this same run failed; the next input can explain its retry. */
  interruption?: { at: number; reason: string };
  signal: AbortSignal;
  control: TurnControl;
  /** Short live status ("running tests"). */
  onStatus?(note: string): void;
  /** A tool call (ours or engine-native) started (true) or ended (false) – the turn's tool boundaries (dispatch-boundary.ts). */
  onTool?(callId: string, running: boolean): void;
  /** B-048 E4.5: what the turn runs on – at route time and again after a renewal, rebuild or failover (turn.ts bindTurn). */
  onRoute?(route: TurnRoute): void;
  /** B-057: set on a split's turn (reason 'split', its lane – no conversationId, no taskId; thread `split:<id>`). */
  split?: SplitTurn;
}

/**
 * B-048 E4.5: the route fields of AgentActivity (catalog model id, display name, effort, engine); B-080: `accountId` – the
 * account the turn runs on (an in-turn model switch stays on it, dispatch-runs.ts setModelInTurn), never shown; B-083:
 * `temperature`/`temperatureSent` – the turn's temperature and whether its engine sends it.
 */
export type TurnRoute = Required<Pick<AgentActivity, 'model' | 'modelName' | 'effort' | 'engine'>> & Pick<AgentActivity, 'temperature' | 'temperatureSent'> & { accountId?: string };

export interface TurnPlan {
  agent: Agent;
  mode: ModeInfo;
  task?: TaskView;
  conversationId?: string;
  /** B-054: what started the run (TurnRequest.origin). */
  origin?: Origin;
  /** threadKey of the turn (MAIN_THREAD, or a part's `split:<id>`) – the key of its session, turn state and ledger. */
  thread: string;
  memberCursor: number;
  /** Reply to a spoken call line; typed messages and task turns stay in the chat. */
  callId?: string;
  /** B-080: what this turn is asked – the routing category's text (the person's newest line, else the task); undefined: the mode's own category. */
  focus?: string;
  /** What the subconscious shows this turn, as real tool calls in the main AI's history (subconscious/service.ts beforeTurn). */
  trace?: SubconsciousTrace;
  /** The model I am on with my last effort there; `explicit` when a request is in force on it (model.set, my task's or my subconscious's effort), `asked`/`category` as in RouteRequest. */
  previous?: RouteRequest['previous'];
  /** 17.11.2026: whether the turn's context starts anew anyway (agents/boundary.ts, asked once in planTurn) – RouteRequest.boundary; absent on a part's later plans that did not ask. */
  boundary?: boolean;
  /** The `at` of the model I asked for (next-route.ts) when this turn could apply it – at a boundary, or at once with now; turn.ts ends that one as its engine starts. */
  nextModelAt?: number;
  /** B-078/B-080: the temperature (0..2) the agent's model.set request in force asked for (next step over task) – engines that take one send it. */
  temperature?: number;
  /** B-080: the `at` of the next-step model.set request this turn read (next-route.ts) – turn.ts deletes that one as its engine starts; one written since holds for the next turn. */
  nextStepAt?: number;
  needsVision: boolean;
  /** No connected model can read images: the turn runs without them and the agent is told. */
  imagesHidden?: boolean;
  /** B-057: the split this turn works for (TurnRequest.split). */
  split?: SplitTurn;
}

export interface RoutedTurn {
  route: RouteDecision;
  engine: Engine;
  account: Account;
  model: string; // provider model id
  modelName: string; // display name for meta/status lines
  contextWindow?: number;
  session?: SessionBinding;
  prompt: PromptParts;
  /** Our tools passed natively to the engine (buildTurn: the same offer the prompt key covers). */
  tools?: ToolSpec[];
  /** S2: the tool names the MCP hub serves this turn (its lease) – the same offer the prompt key covers. */
  hubTools?: string[];
  /** sha256 of the stable prompt + sorted offered tool names; saved with the session (SES2). */
  promptKey?: string;
  /** S2: what the session that starts (or is accepted) this turn holds – recorded with its binding once it exists (turn-finish.ts). */
  sessionStart?: SessionStart;
  input: Array<{ type: 'text'; text: string } | { type: 'image'; path: string; mime: string }>;
  lastSeq: number;
  /** B-049 F6: the volatile sections – and (S2) the stable texts – the session holds once this turn finishes (turn-finish records them; volatile-delta.ts). */
  volatileSent?: Held;
  /** B-057 S6: the split parts whose results ("Split results") are in this turn's input (gathered when it ends 'done'). */
  splitParts?: string[];
  /** The subconscious's calls for this turn (TurnPlan.trace), handed to the engine (EngineTurnInput.trace). */
  trace?: SubconsciousTrace;
}

export interface AttemptResult {
  result: EngineTurnResult;
  streamed: string;
  reasoning: string;
  toolCalls: number;
  /** What ran (our tools with their category, engine-native by name) – the progress signal. */
  tools?: ToolUse[];
  /** The engine's latest plan ('plan' events), for ledger.plan. */
  plan?: string[];
  /** How many steps of that plan are done. */
  planDone?: number;
  /** inputTokens: all input; the cached part beside it as the engine's result reported it (CacheTokens). */
  usage: { inputTokens: number; outputTokens: number; costUsd?: number; contextTokens?: number } & CacheTokens;
  /** After a failover (mergeAttempts) `usage` sums both attempts (run, budget); this is the final
   *  attempt's own usage – the model outcome's cost, like `ms`, is per attempt. */
  lastUsage?: AttemptResult['usage'];
  /** Package C: the running total the engine reported for the session this attempt ended on (finishTurn keeps it with that session's binding). */
  costTotal?: { ref: string; usd: number };
  ms: number;
}

export interface TurnOutcome {
  runId: string;
  status: RunStatus | 'skipped';
  messageId?: string;
  error?: string;
}
