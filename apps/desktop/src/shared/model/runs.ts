// Run model: what agents actually did (turns, tool calls, effects). Used for the agent
// insight view, audit, cost accounting, recovery and routing outcome statistics.
// B-054: a run is started by an origin (shared/model/origin.ts); it has a chat only when its origin is one.
// B-083 (owner 08.11.: "was sie gerade … nimmt … und dass es wirklich auch stimmt"): a turn's temperature – the agent's own
// request, else the person's suggestion – rides on its activity, its run's route and its chat row, with whether its engine
// really sent it (an HTTP engine whose model samples with one) or the model samples at its own setting (the value is then
// the agent's stance for the step); the row carries it in one shown form (shownTemperature).
// B-089 (11.11.2026: what a run costs, written down): a run keeps its cached input and its model calls, its route where
// its effort came from (EffortBy) – so a change to the token economy can be proven from the app's own database.
// Owns: shapes and the shown form of a temperature. Never: invents inner thoughts – only provider-visible summaries.

import type { Effort, EngineId } from './providers.ts';
import type { Origin } from './origin.ts';

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'unknown';

export type WakeReason =
  | 'message' // new message for the agent
  | 'task' // task assigned/claimable/news
  | 'schedule' // a reminder fired
  | 'answer' // human answered a widget/approval
  | 'child' // a delegated agent finished
  | 'retry' // ownership loop retry
  | 'review' // manager review / heartbeat
  | 'manual'
  | 'event' // B-054: something outside happened (a new mail, a connector or webhook push) – the origin says what
  | 'split' // B-057: the run of a split (shared/model/splits.ts) – never a queued wake
  | 'fold'; // KI-Runde 17.11.2026: the run in which an agent writes its hand-over when its context is folded (runtime/agents/context-fold.ts) – never a queued wake

export interface Run {
  id: string;
  agentId: string;
  conversationId?: string;
  taskId?: string;
  trigger: WakeReason;
  engine?: EngineId;
  model?: string;
  effort?: Effort;
  accountId?: string;
  deviceId?: string;
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** B-089: the part of inputTokens the provider served from its cache, over the turn's attempts (absent: not reported). */
  cachedTokens?: number;
  /** Package C (17.11.2026): the part of inputTokens the turn wrote into the provider's cache (absent: not reported). */
  cacheWriteTokens?: number;
  /** B-089: how many model requests the turn made (absent: its engine gives no count – never a guess). */
  modelCalls?: number;
  costUsd?: number;
  error?: string;
  summary?: string; // one line ("edited timeline, rendered preview")
  /** B-083: `temperature` – the turn's (absent: none), `temperatureSent` – its engine put it on the wire.
   *  B-089: `effortBy` – where the turn's effort came from (absent: an older run, or a route that did not say).
   *  17.11.2026: `standIn` – the model this turn ran on stands in for the one it should have run on, which could not run
   *  (routing/router.ts); such a model is not the agent's settled one, so its next boundary lets its kind decide again. */
  route?: { reason: string; by: string; category: string; temperature?: number; temperatureSent?: boolean; effortBy?: EffortBy; standIn?: true };
  origin?: Origin; // B-054: what started it (runs.source/source_label); absent on chat and task runs without one
  splitId?: string; // B-057: the split this run worked for (runs.split_id, shared/model/splits.ts); absent on every other run
}

export type RunItemKind = 'tool_call' | 'tool_result' | 'reasoning' | 'plan' | 'effect' | 'approval' | 'note' | 'error';

export interface RunItem {
  id: string;
  runId: string;
  seq: number;
  kind: RunItemKind;
  name?: string; // tool name
  data: Record<string, unknown>; // truncated; big outputs are blob refs
  effectStatus?: 'none' | 'pending' | 'confirmed' | 'unknown' | 'failed';
  idemKey?: string;
  createdAt: number;
}

/** Live activity shown in group headers and the agent row ("who is working"). */
export interface AgentActivity {
  agentId: string;
  runId: string;
  conversationId?: string;
  taskId?: string;
  note: string; // short live status line
  startedAt: number;
  // B-048 E4.5 (ACTIVITY-UI): what the run runs on right now – set at route time and again after a
  // failover or a session renewal/rebuild (agents/turn.ts bindTurn → dispatch-runs.ts), absent while routing.
  model?: string; // catalog model id (RouteDecision.modelId)
  modelName?: string; // display name
  effort?: Effort;
  engine?: EngineId;
  /** B-083: the turn's temperature (absent: none) and whether its engine sends it (false: the model samples at its own setting). */
  temperature?: number;
  temperatureSent?: boolean;
  origin?: Origin; // B-054: what started the run (the agent page shows its label when there is no task)
  /** B-057: set when the run is a split's (its lane `<agentId>#<splitId>`); the agent's main turn has none. */
  split?: { id: string; groupId: string; idx: number; of: number; parentRunId: string; title: string };
  /** Tool calls waiting for their output right now (absent: none) – the subconscious never wakes then (subconscious/wake.ts). */
  toolCalls?: number;
  /** F10 (16.11.2026): the run is on another of the person's PCs (devices/sync/live.ts) – only in what windows and phones hear; absent: on this PC. */
  deviceId?: string;
  /** 22.11.2026: the run is a context fold (agents/context-fold.ts) – the live bar says so instead of its step. */
  fold?: true;
}

/** Addition (RT2): `Run.route.by` of a turn that the agent's own model.set request shaped (its
 * model or effort). The return rule skips such runs, so a request holds for one step – or for
 * the turns of its task until the task is done – and routing then returns to the choice before. */
export const ROUTE_BY_REQUEST = 'request';

/**
 * B-089 (11.11.2026): where a turn's effort came from (routing/previous.ts startEffortBy) – the agent's own request, the
 * agent's fixed effort, the previous turn's kept effort, or the default (policy or category; an older run may hold 'chat'). Stored as runs.route.effortBy, carried on the route as RouteDecision.effortBy.
 */
export type EffortBy = 'request' | 'agent' | 'previous' | 'default';

declare module './providers.ts' {
  interface RouteDecision {
    /** B-089: where `effort` came from before clamping (absent: a route built without startEffortBy). */
    effortBy?: EffortBy;
    /** 17.11.2026: this model stands in for the one the turn should have run on, which cannot run now (routing/router.ts). */
    standIn?: true;
  }
}

/**
 * Addition (PR9, runtime/models/pricing.ts): how a run's cost was judged. Only pay-per-use
 * connections (API key, env key, a Claude Code/Codex API-key login) cost real money – their
 * `costUsd` is booked as the agent's spend: 'provider' = the provider or engine reported it
 * (OpenRouter usage.cost, Claude Code's total_cost_usd), 'list-price' = tokens × Artificial
 * Analysis list prices, 'prior-price' = tokens × the curated price in model-priors.json,
 * 'unpriced' = no price is known (amount 0 – a price is never invented). 'plan' = a subscription
 * plan: no charge, `notionalUsd` = what the turn would have cost at list price ("plan, no
 * charge"); 'free' = a local runtime or a server without a key.
 */
export type CostBasis = 'provider' | 'list-price' | 'prior-price' | 'unpriced' | 'plan' | 'free';

/** Addition (PR9): merged into Run above – the cost basis and the plan's notional list-price cost. */
export interface Run {
  costBasis?: CostBasis;
  notionalUsd?: number;
}

/** B-083: marks a temperature the model does not take – it samples at its own setting, the value is the agent's stance. */
export const STANCE_MARK = '≈';

/** B-083: a temperature as text – "0.3", "0.25", "1.0". */
export function temperatureText(value: number): string {
  const text = String(Math.round(value * 100) / 100);
  return text.includes('.') ? text : `${text}.0`;
}

/** B-083: the shown form a temperature takes (MessageMeta.temperature): "0.3" where the engine sends it, else "≈0.3". */
export function shownTemperature(value: number, sent: boolean | undefined): string {
  return `${sent ? '' : STANCE_MARK}${temperatureText(value)}`;
}

declare module './chat.ts' {
  interface MessageMeta {
    /** B-083: on a run's finished row, the temperature the turn ran with, in its shown form (agents/turn-finish.ts). */
    temperature?: string;
  }
}
