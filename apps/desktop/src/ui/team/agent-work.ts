// The pure rules of an agent's Work page (#/team/<agentId>/work, AgentWork.tsx; owner feedback 16.11.2026 F11: "Show work"
// shows what the agent does right now, only its really active tasks, and the run live):
//   * Now – one card per run of the agent in the live activity (store `activity`), in start order; a split's parts sit
//     on the card of the run that split, or – once that run ended and the parts still work – on one card of their own;
//   * Active tasks – its open quests and to-dos (a to-do in anyone's quest too) that really are at work: a turn runs on
//     one now, or it moved (a status change, a new plan or fact, a give, a finished to-do, a turn that moved it –
//     ledger.movedAt) within the last 24 h. An open one that has not moved for longer is "older open", its waiting ones
//     apart – both folded on the page; done and dropped never. Each list the newest move first. Agent work has no time
//     (Quests round 20.11.2026): a line says where the task sits among the quests (questLine), never a date;
//   * the last run while nothing runs, from the activity log's loaded page;
//   * whether the page sits at its end, so the log follows new steps there and stays put when scrolled up.
// Owns: those rules. Never: imports the store, rpc or the DOM, or says more than the runtime reported.

import type { AgentActivity, Run } from '../../shared/model/runs.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { movedAt } from '../../shared/model/task-stuck.ts';
import { ownedBy } from '../tasks/work-model.ts';

/** A Now card: the agent's own run (absent when only parts of an ended run still work) and its running split parts. */
export interface NowCard { key: string; run?: AgentActivity; parts: AgentActivity[]; startedAt: number }

/** The agent's live runs as Now cards, the oldest first – the same order as the log, so nothing reorders while it works. */
export function nowCards(active: readonly AgentActivity[], agentId: string): NowCard[] {
  const mine = active.filter((entry) => entry.agentId === agentId);
  const cards = new Map<string, NowCard>();
  for (const entry of mine) if (!entry.split) cards.set(entry.runId, { key: entry.runId, run: entry, parts: [], startedAt: entry.startedAt });
  for (const entry of mine) {
    if (!entry.split) continue;
    const key = cards.has(entry.split.parentRunId) ? entry.split.parentRunId : `split:${entry.split.groupId}`;
    const card = cards.get(key) ?? { key, parts: [], startedAt: entry.startedAt };
    card.parts.push(entry);
    card.startedAt = Math.min(card.startedAt, entry.startedAt);
    cards.set(key, card);
  }
  for (const card of cards.values()) card.parts.sort((a, b) => a.split!.idx - b.split!.idx);
  return [...cards.values()].sort((a, b) => a.startedAt - b.startedAt);
}

type Listed = Pick<Task, 'status' | 'assigneeKind' | 'assigneeId' | 'ledger' | 'createdAt'> & { running?: boolean };

/** How long a move keeps an open task among the active ones. */
export const ACTIVE_MS = 24 * 3600_000;

/** An open task at work: a turn runs on it now, or it moved within ACTIVE_MS. */
export function isActive(task: Listed, now: number): boolean {
  return task.status === 'open' && (task.running === true || now - movedAt(task) < ACTIVE_MS);
}

/** The agent's active tasks, its older open ones and its waiting ones, each the newest move first. */
export function activeTasks<T extends Listed>(list: readonly T[], agentId: string, now = Date.now()): { open: T[]; older: T[]; waiting: T[] } {
  const mine = list.filter((task) => ownedBy(task, agentId)).sort((a, b) => movedAt(b) - movedAt(a));
  return {
    open: mine.filter((task) => isActive(task, now)),
    older: mine.filter((task) => task.status === 'open' && !isActive(task, now)),
    waiting: mine.filter((task) => task.status === 'waiting'),
  };
}

/** A plan's progress, "2 of 5 steps" ("✓ " marks a done step, tasks.update plan); undefined without a plan. */
export function planProgress(plan: readonly string[] | undefined): string | undefined {
  if (!plan?.length) return undefined;
  const done = plan.filter((line) => line.startsWith('✓')).length;
  return `${done} of ${plan.length} ${plan.length === 1 ? 'step' : 'steps'}`;
}

type Placed = Pick<Task, 'id' | 'kind' | 'parentId' | 'status' | 'title'>;

/**
 * Where a task sits among the quests: a quest's "Quest · 2 of 5 to-dos done" (its dropped to-dos left out), a to-do's
 * "In <quest>"; undefined for a to-do without a quest or whose quest is not among `every` (every task known, by id).
 */
export function questLine(task: Placed, every: ReadonlyMap<string, Placed>): string | undefined {
  if (task.kind === 'quest') {
    const todos = [...every.values()].filter((entry) => entry.parentId === task.id && entry.status !== 'dropped');
    return `Quest · ${todos.filter((entry) => entry.status === 'done').length} of ${todos.length} ${todos.length === 1 ? 'to-do' : 'to-dos'} done`;
  }
  const quest = task.parentId ? every.get(task.parentId) : undefined;
  return quest ? `In ${quest.title}` : undefined;
}

/** The last run that ended among the log's loaded runs (start order), for the idle line. */
export function lastEnded<R extends Pick<Run, 'status' | 'endedAt'>>(runs: readonly R[]): R | undefined {
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    if (run.status !== 'running' && run.status !== 'queued' && run.endedAt !== undefined) return run;
  }
  return undefined;
}

/** Within this many pixels of its end a scroller counts as at the end (fractional scroll positions at display scales). */
export const END_SLACK = 24;

/** The scroller shows its end: the log follows new steps from here. */
export function atEnd(box: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= END_SLACK;
}
