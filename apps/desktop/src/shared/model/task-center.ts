// The person's line (Quests round 20.11.2026, runtime/tasks/quick.ts – the one intake): their own to-do at once, in a
// quest, at a time they confirmed; their assistant sorts it. Bridge until the old composer goes: a target other than
// 'me' hands the line straight to an agent, a manager's branch, a team or a person of the organisation.
// Joins Methods by module augmentation.
// Owns: the shapes only. Never: behaviour or a second task store.

import type { TaskView } from './tasks.ts';

/**
 * An optional addressee of a quick task: one agent, a manager's branch (`id` = the manager's agent id), a team
 * (`id` = the team name agents carry in Agent.team), one active person of the organisation ('per_…', the owner's
 * quick task only: handed over in the owner's 1:1 chat with her) or 'me' (`id` = 'human': the person's own to-do).
 */
export type QuickTargetKind = 'agent' | 'branch' | 'team' | 'person' | 'me';
export const QUICK_TARGET_KINDS: readonly QuickTargetKind[] = ['agent', 'branch', 'team', 'person', 'me'];
export interface QuickTaskTarget {
  kind: QuickTargetKind;
  id: string;
}

/** `tasks.quickCreate`: the person's line – their to-do now, sorted by their assistant (target: the bridge, see the header). */
export interface QuickTaskParams {
  text: string;
  /** Files uploaded with files.upload (kept with the task). */
  attachments?: Array<{ fileId: string; name?: string; durationMs?: number }>;
  target?: QuickTaskTarget;
  priority?: 0 | 1 | 2;
  /** The space a chat-free task belongs to. */
  spaceId?: string;
  at?: number;
  /** How long the person needs (with at: its length on the calendar). */
  minutes?: number;
  /** The quest the to-do goes into. */
  quest?: string;
  /** "Only me": the person does it themselves; the AI keeps it in view and never takes it over. */
  private?: boolean;
  /** Idempotency key: a retried post returns the task the first one made. */
  clientId?: string;
}

export interface QuickTaskResult {
  task: TaskView;
  /** The assistant that was woken to sort it, when one was. */
  assistantId?: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** 'tasks': the person's line (runtime/tasks/quick.ts) – their to-do now, their assistant woken to sort it ("Only me" too, never handed on). */
    'tasks.quickCreate': { params: QuickTaskParams; result: QuickTaskResult };
  }
}
