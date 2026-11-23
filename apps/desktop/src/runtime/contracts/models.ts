// Runtime service contracts: models, routing, decisions, accounts, engines, knowledge, skills, modes. Re-exported by ../contracts.ts (import from there).
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { Bus } from '../bus.ts';
import type { Db } from '../db/database.ts';
import type { Host } from '../host.ts';
import type { Engine } from '../engines/types.ts';
import type { ToolContext, ToolDef, ToolOutput, ToolSpec } from '../tools/types.ts';
import type { Agent, AgentTemplate, OrgNode, Space } from '../../shared/model/org.ts';
import type {
  Conversation, ConversationSettings, ConversationSummary, Member, Message, MessageMeta, SendMessageInput, StatusLine,
} from '../../shared/model/chat.ts';
import type {
  CreateTaskInput, Schedule, Task, TaskFilter, TaskResult, TaskStatus, TaskView,
} from '../../shared/model/tasks.ts';
import type { Handoff, KnowledgeHit, KnowledgeItem, KnowledgeListFilter, KnowledgeQuery, ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import type {
  Account, AccountLimits, DetectionReport, Effort, EngineId, ModelInfo, ProviderId, RouteDecision, UsageSummary,
} from '../../shared/model/providers.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { SplitNeeds } from '../../shared/model/splits.ts';
import type { AgentActivity, Run, RunItem, WakeReason } from '../../shared/model/runs.ts';
import type { FileRef, Settings, SettingsPatch } from '../../shared/model/system.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { ActionDescription } from '../tools/types.ts';

// ------------------------------------------------------------------ models, routing, decisions

export interface DecisionRequest {
  question: string;
  type: 'choice' | 'score' | 'predicate';
  options?: string[]; // for choice
  context?: string; // compact state
  /** 'agent' (addition RT9): an agent's own decide tool call (tools/builtin/decide.ts). */
  purpose: 'route' | 'responder' | 'retrieval' | 'skill' | 'classify' | 'verify' | 'other' | 'agent';
  /** Addition (F05): the request's deadline over all backend attempts; when it passes the running call is
   * aborted and the answer is none (confidence 0, by 'timeout'). Absent = the hub's per-attempt limit only. */
  timeoutMs?: number;
  /** Addition (RT9): the caller's stop (a stopped turn): the running backend call is aborted, no further
   * backend is tried and the answer is none (confidence 0, by 'stopped'). */
  signal?: AbortSignal;
}

export interface DecisionResult {
  choice?: string;
  score?: number;
  value?: boolean;
  confidence: number;
  by: string; // backend/model
  /** Addition (RT9), choice requests only (DecisionHub sets it): what the answer means – see DecisionOutcome. */
  outcome?: DecisionOutcome;
}

/**
 * Addition (RT9): 'choice' = an option with confidence ≥ 0.55; 'none_fit' = the model picked
 * "none" with confidence ≥ 0.55; 'unsure' = lower confidence, an unknown option, a timeout or no
 * backend (a low-confidence `choice` is kept as a lean).
 */
export type DecisionOutcome = 'choice' | 'none_fit' | 'unsure';

export interface DecisionService {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  available(): boolean;
}

export interface ModelCatalog {
  list(): ModelInfo[];
  get(id: string): ModelInfo | undefined;
  refresh(options?: { force?: boolean }): Promise<void>;
  recent(agentId?: string): string[];
}

export interface RouteRequest {
  agent: Agent;
  conversationId?: string;
  taskId?: string;
  mode: ModeInfo;
  text?: string; // what the turn is asked (for category inference; B-080: the person's newest line, else the task)
  /** Decision → LLM return rule. `explicit` (addition R3-R): the agent itself asked for this model/effort
   * (model.set request) – it then beats default pins and weak priors, but never policy bounds.
   * Additions (RT2, routing/previous.ts): `asked` = what the request named, 'model' or 'effort'
   * (absent = both); an effort-only request leaves the model to the usual rules. `category` = the
   * category of the run `previous` comes from: its effort is carried only within that category, and
   * after a change of category its model only while it scores within 0.3 of the best candidate.
   * B-048 E4.2 (ROUTING hunk, routing/need.ts): `need` = the agent asked for a kind of model instead of
   * a concrete one, relative to `from` (the model it ran on); the router resolves it (`modelId` = the
   * model model.set named in its answer, kept while it still meets the need).
   * B-080: a requested temperature is no routing input – it rides on TurnPlan.temperature (agents/turn-types.ts).
   * B-083: `by`/`why` – whose the effort in force is when it is not my own model.set: my subconscious's for this turn
   * ("my subconscious: <why>") or my task's from its giver ("effort from my task – <why>"), agents/next-route.ts.
   * 17.11.2026 (the model settles): `now` – my own model.set with now: true, the one request that moves the model
   * inside a live session. `effort` without a request is my settled effort on that model – the one my newest turn there
   * ran at without anyone asking; absent: none to carry, the default applies. */
  previous?: {
    modelId: string; effort?: Effort; explicit?: boolean; asked?: 'model' | 'effort'; category?: string;
    need?: { kind: 'stronger' | 'cheaper' | 'faster' | 'vision' | 'long_context'; from?: string }; by?: 'subconscious' | 'task'; why?: string; now?: true;
    /** 17.11.2026: the model I am on stands in for one that could not run (the run's route says so) – it is not my settled
     *  model, so at a boundary my kind decides again (routing/router.ts, agents/next-route.ts). */
    standIn?: true;
    /** The model I am on when the request names another (agents/next-route.ts): the turn stays there off a boundary and while the named one cannot run (routing/router.ts). */
    from?: string;
  };
  /** 17.11.2026 (agents/boundary.ts): false – the turn goes on in its live session and runs on the model that session is
   *  on, only its effort moves; true or absent – its context starts anew anyway (no session, a cold cache, a fold; a
   *  preview, a helper call), so the model is free to change (routing/router.ts). */
  boundary?: boolean;
  exclude?: string[]; // models/accounts that just failed
  needs?: { vision?: boolean; computerUse?: boolean; structured?: boolean; tier?: ModelInfo['tier'] };
  /** B-057 S10: a split's turn (routing/split-route.ts) – its own model/effort beats the agent's pin and fixed effort; plan pacing.
   *  17.11.2026: `fresh` – the first turn of a part that starts from its brief and names no model: `previous.modelId` is its
   *  origin's model, where it runs unless that is above what executing needs (routing/kind.ts). Halb 21.11.2026: `needs` –
   *  what a fresh part's hardest step asks; the cost mode the router picks its kind default with (routing/split-route.ts). */
  split?: { splitId: string; fresh?: true; needs?: SplitNeeds };
}

export interface Router {
  route(request: RouteRequest): Promise<RouteDecision>;
}

export interface AccountService {
  list(): Account[];
  get(id: string): Account | undefined;
  detect(force?: boolean): Promise<DetectionReport>;
  /** Addition (RT7), optional so simple fakes stay valid: the last detection's report, no scan. */
  lastDetection?(): DetectionReport | undefined;
  add(input: { provider: ProviderId; label?: string; apiKey?: string; baseUrl?: string }): Promise<Account>;
  update(id: string, patch: Partial<Pick<Account, 'label' | 'priority' | 'enabled' | 'credits' | 'extraUsage' | 'thisPcOnly'>>): Account;
  /** 17.11.2026: a plan login on offer (DetectionReport.found) becomes an account here only by the person's word (accounts/adoption.ts); optional so simple fakes stay valid. */
  useFound?(key: string, options?: { thisPcOnly?: boolean }): Promise<Account>;
  declineFound?(key: string): Promise<void>;
  login(id: string): Promise<{ started: boolean; url?: string }>;
  logout(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  install(provider: 'claude' | 'codex'): Promise<void>;
  /** Healthy accounts able to run `engine`, best first (plans before paying keys, the week that resets first, priority, headroom). */
  candidates(engine: EngineId, model?: string): Account[];
  markLimited(id: string, until: number, limits?: AccountLimits): void;
  updateLimits(id: string, limits: AccountLimits): void;
  /** A turn found the account signed out ('needs_login') or its CLI missing ('error'); true when its state changed. */
  markUnavailable(id: string, state: 'needs_login' | 'error'): boolean;
  usage(refresh?: boolean): Promise<UsageSummary[]>;
  apiKey(id: string): Promise<string | undefined>; // decrypted only for HTTP engines in-process
  /** Shutdown: ends the open sign-in processes and windows; later checks store nothing (optional so simple fakes stay valid). */
  dispose?(): Promise<void>;
  /** Reads one account's state and limits now, in the monitor's queue (B-075: a login that came from another PC; optional so simple fakes stay valid). */
  checkNow?(id: string): Promise<void>;
}

export interface EngineRegistry {
  get(id: EngineId): Engine;
  all(): Engine[];
}

// ------------------------------------------------------------------ knowledge

export interface KnowledgeService {
  search(query: KnowledgeQuery): Promise<KnowledgeHit[]>;
  save(item: Partial<KnowledgeItem> & { title: string; body: string; scope: KnowledgeItem['scope']; createdBy: string }): KnowledgeItem;
  /** Correction: expires the old row and links the new one (bi-temporal history). */
  correct(id: string, patch: { body?: string; title?: string; validTo?: number }, by: string): KnowledgeItem;
  expire(id: string, by: string, reason?: string): void;
  get(id: string): KnowledgeItem | undefined;
  /** Addition (CTX5): `kinds` narrows to several kinds. */
  list(filter: KnowledgeListFilter & { kinds?: readonly string[] }): Promise<KnowledgeItem[]>;
  /** Addition (B-044), optional so simple fakes stay valid: the kinds current rows carry (the browser's kind chips). */
  kinds?(): Promise<KnowledgeItem['kind'][]>;
  history(id: string): KnowledgeItem[];
  pinned(agentId: string, conversationId?: string): KnowledgeItem[];
  /** Addition (CTX5): pins/unpins the current version in place (a prompt flag – no new version). */
  pin(id: string, pinned: boolean, by: string): KnowledgeItem;
  /** Addition (CTX5): deletes the whole correction chain of `id` (rows, FTS) in one transaction and emits
   * `knowledge.removed`. Only for the person's request (owner RPC knowledge.forget) – agents expire or correct instead. */
  forget(id: string, by: string): { ids: string[] };
}

export interface SkillService {
  /** One skill per name, as `viewerId`'s route resolves it (own, managers up the chain, shared, built in). */
  list(viewerId?: string): SkillInfo[];
  get(name: string, viewerId?: string): { info: SkillInfo; body: string } | undefined;
  save(input: { name: string; description: string; body: string; ownerAgentId?: string }): SkillInfo;
  remove(name: string): void;
  /** Skills index (name + description) an agent may use in a mode. */
  indexFor(agent: Agent, mode: ModeInfo): SkillInfo[];
}

export interface ModeService {
  list(): ModeInfo[];
  get(key: string): ModeInfo;
}
