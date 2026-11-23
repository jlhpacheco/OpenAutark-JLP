// Splits (B-057 "Ultra mode", owner 29.10.2026 – an agent splits itself up; B-083, owner 08.11.2026: Ultra is one being):
// a persistent agent starts parts of ITSELF that run in parallel under its own identity, each with one piece of the work;
// their notes and results come back to the agent that split (its origin), whose answer is the one that goes out. A group is
// one `agents.split` call (parts #1 … #N; a part's own agents.split adds parts to its group, at most partsPerCall in all);
// a split is one part. Parts are no agents and no tasks: they run under the agent's id (runs.split_id names them), on their
// own native session thread `split:<splitId>`, never as a chat member of their own. Splitting is the agent's own call
// (owner 08.11.2026: "Die soll es einfach selbst erkennen"); MessageMeta.ultra of older messages stays readable.
// Owns: the split, group and view shapes, the limits, the split thread key and the split.upserted event shape.
// Never: behaviour (runtime/splits/**), a second identity – a split is always its parent agent.

import type { Effort, EngineId } from './providers.ts';
import type { Run } from './runs.ts';
import type { Origin } from './origin.ts';

/** How a part starts: 'brief' (the default, owner 15.11.2026) – a fresh session with only its brief, like a second CLI
 *  session (cheapest, any model); 'fork' – as the parent with the context it had at the split (native fork or text
 *  fallback), for a piece that needs what the parent just learned. */
export type SplitContext = 'fork' | 'brief';
export type SplitStatus = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
export type SplitGroupStatus = 'pending' | 'running' | 'settled' | 'gathered' | 'stopped';
export const SPLIT_TERMINAL: readonly SplitStatus[] = ['done', 'failed', 'stopped', 'skipped'];
/** B-080: runningPerAgent is the one bound on parallel turns – an agent runs at most that many of its parts at once; its own turn and every other lane start at once.
 *  KI-Runde 17.11.2026: a brief holds 12,000 characters – a fresh part knows only its brief, and briefs near 4,000 were squeezed. */
export const SPLIT_LIMITS = { partsPerCall: 12, activeGroupsPerAgent: 3, runningPerAgent: 4, attempts: 2,
  resultChars: 24_000, briefChars: 12_000, titleChars: 80, goalChars: 400, returnsChars: 400 } as const;

/** Halb 21.11.2026: what a fresh part's hardest step asks – the router turns it into a tier and an effort of its own pool
 *  (routing/split-route.ts). A part stores it as its `model` word until it names a model itself (splits/validate.ts). */
export const SPLIT_NEEDS = ['check', 'chain', 'judgment'] as const;
export type SplitNeeds = typeof SPLIT_NEEDS[number];

/** One part as the agent asks for it (agents.split input). B-083: `temperature` (0..2) like model and effort – engines that take one send it. */
export interface SplitPartInput { title: string; brief: string; returns?: string; context?: SplitContext; needs?: SplitNeeds;
  model?: string; effort?: Effort; temperature?: number; after?: number[]; worktree?: boolean; chat?: string }

/** How a split's session was seeded (set at its first start). F26: 'ledger' – from its own copy of its parent's record, condensed by its subconscious (splits/fork.ts). */
export interface SplitFork { how: 'native' | 'ledger' | 'text' | 'fresh'; engine?: EngineId; accountId?: string; parentRef?: string }

/**
 * B-080: the native session the parent's splitting turn ended with, recorded when the group started (runtime/splits/fork.ts
 * recordedParent) – the source of a 'fork' part's native fork, through that turn (`turn`: its native turn id, when the engine
 * names turns). A later turn of the parent that renews or moves that session changes nothing here. FIXES-3 B1: for a turn
 * that still runs (agents.split with wait; Claude Code only – runtime/splits/fork.ts FORKS_IN_TURN) it is the session that
 * turn runs on – Claude Code forks its transcript up to the split's call; `contextTokens` is its size before the turn – and
 * `model` is the model that turn runs on (its run's row names one only at its end).
 */
export interface SplitParentSession { engine: EngineId; accountId?: string; ref: string; contextTokens?: number; turn?: string; model?: string }

/** `ultra`: the person had suggested Ultra on their latest message in the chat when the agent split (MessageMeta.ultra). */
export interface SplitGroup { id: string; agentId: string; parentRunId: string; conversationId?: string; taskId?: string;
  origin?: Origin; thread: string; modeKey?: string; cwd?: string; goal: string; ultra: boolean; status: SplitGroupStatus;
  parts: number; createdAt: number; startedAt?: number; endedAt?: number; gatheredAt?: number; parentSession?: SplitParentSession }

export interface Split { id: string; groupId: string; agentId: string; idx: number /* 1-based */; of: number;
  title: string; brief: string; returns?: string; context: SplitContext; model?: string; effort?: Effort; temperature?: number;
  after: number[]; worktree: boolean; /** The chat this part's work is for (its run's conversation_id). */ chat?: string; status: SplitStatus; attempts: number; error?: string; fork?: SplitFork;
  branch?: { name: string; stat?: string; merged?: 'merged' | 'discarded' | 'conflict' };
  createdAt: number; startedAt?: number; endedAt?: number;
  /** When its result reached my origin (a turn of my origin that showed it ended done) – each part returns on its own. */ gatheredAt?: number }

export type SplitRunView = Pick<Run, 'id' | 'model' | 'effort' | 'engine' | 'status' | 'costUsd' | 'notionalUsd' | 'costBasis'
  | 'summary' | 'error' | 'startedAt' | 'endedAt' | 'inputTokens' | 'outputTokens'>;
/** A split with its newest run (`run`) and how many runs it had (`runs`; a retry is a second run). */
export interface SplitView extends Split { run?: SplitRunView; runs: number }
/** A group with its splits in idx order and the summed cost of their runs. */
export interface SplitGroupView extends SplitGroup { splits: SplitView[]; costUsd?: number; notionalUsd?: number }

/** What a split turn carries (TurnRequest.split / TurnPlan.split / ToolContext.split). */
export interface SplitTurn { splitId: string; groupId: string; idx: number; of: number; title: string; parentRunId: string;
  parentThread: string; parentConversationId?: string; parentTaskId?: string; context: SplitContext; modeKey?: string;
  cwd?: string; model?: string; effort?: Effort; temperature?: number; firstTurn: boolean;
  /** The chat this part's work is for (Split.chat): its run carries it as its conversation_id. */
  chat?: string;
  /** B-080: the group's recorded parent session (SplitGroup.parentSession) – what a 'fork' part forks. */
  parentSession?: SplitParentSession }

/** B-083: how agents.split_tell's journaled summary starts for a part's note to its origin ("My parts" shows the last one). */
export const TOLD_ORIGIN = 'To my origin:';
/** B-086: how the line of what the origin asked of a part starts, beside the part's result (runtime/splits/results.ts askedLine). */
export const ASKED = 'Asked: ';
/** B-080: why a native fork did not fit the worker model's window (runtime/splits/fork.ts, in its run note's fellBack). */
export const PAST_WINDOW = "the parent session exceeds the worker model's limit";

/** The native session thread of a split (never the parent's chat or task thread). */
export function splitThread(splitId: string): string { return `split:${splitId}`; }
export function isSplitThread(thread: string): boolean { return thread.startsWith('split:'); }

declare module './chat.ts' {
  interface MessageMeta {
    /** B-057 (owner 30.10.2026): the person suggested Ultra for this message. B-083: older messages only – the agent sees for itself when parts help. */
    ultra?: true;
  }
  interface SendMessageInput {
    /** B-057: the composer's Ultra cell for this one message – stored as meta.ultra on the person's message (B-083: the cell goes). */
    ultra?: boolean;
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** B-057: a split group or one of its splits changed (topic runs:<agentId>, like run.upserted). */
    'split.upserted': SplitGroupView;
  }
}
