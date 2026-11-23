// Owns: a small durable input marker and the one note a turn after cut-off work starts with: when my last turn here was
// cut off and why, then what it already did (the recap of unfinished runs, context/recent-actions.ts) when this engine
// cannot know it. What arrived since comes below as ordinary chat lines and notes. A short retry with unchanged input
// gets the recap only, when there is one. turn-prepare drops the wake note that says the same (INTERRUPTED_NOTE).
// Never: invents a tool call, infers that a connection recovered, schedules retries, or repeats message bodies.

import { createHash } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import type { Run, RunItem } from '../../shared/model/runs.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { recapScope, unfinishedRuns } from '../context/recent-actions.ts';
import { CLOSED_ERROR } from '../runs/journal.ts';
import { CRASH_ERROR } from '../store/runs.ts';
import { KvRepo } from '../store/kv.ts';
import type { TurnPlan, TurnRequest } from './turn-types.ts';
import { displayZone, dueText } from '../context/time.ts';
import { noteLabel } from './note-label.ts';

export const BRIEF_INTERRUPTION_MS = 60_000;
const INPUT = 'turnInput';
type Services = Pick<RuntimeServices, 'db' | 'runs' | 'chats' | 'clock' | 'secrets' | 'log'>;
interface InputMark { runId: string; lastSeq: number; taskKey?: string; notesAt: number }
const keyOf = (plan: TurnPlan) => `${plan.agent.id}:${plan.thread}`;

function taskKey(plan: TurnPlan): string | undefined {
  const task = plan.task;
  return task ? createHash('sha256').update(JSON.stringify([task.title, task.notes, task.doneWhen, task.assigneeKind, task.assigneeId, task.priority, task.at])).digest('hex') : undefined;
}

/** One latest marker per thread; no bodies, prompts or credentials are copied into it. */
export function recordTurnInput(s: Services, plan: TurnPlan, request: TurnRequest, lastSeq: number): void {
  try {
    const mark: InputMark = { runId: request.runId, lastSeq, taskKey: taskKey(plan), notesAt: Math.max(0, ...request.notes.map(note => note.at)) };
    new KvRepo(s.db).set(INPUT, keyOf(plan), mark, s.clock.now());
  } catch (error) {
    s.log.warn('interruption input marker not recorded', { runId: request.runId, error: String(error) });
  }
}

/** Why a run was cut, in a few words (redacted, one line). */
function cutWhy(s: Services, run: Run): string {
  if (run.error === CRASH_ERROR || run.error === CLOSED_ERROR) return 'the app restarted';
  return s.secrets.redact(run.error || 'it was interrupted').replace(/\s+/g, ' ').slice(0, 300);
}

/** When a run was cut: its last recorded activity for a restart, else its end. */
function cutAt(s: Services, run: Run, items: RunItem[]): number {
  const lastActivity = items.at(-1)?.createdAt ?? run.startedAt ?? s.clock.now();
  return run.error === CRASH_ERROR || run.error === CLOSED_ERROR ? lastActivity : run.endedAt ?? lastActivity;
}

/**
 * The one note about cut-off work for this turn, or undefined: `[note · now] My last turn here was cut off at <time>
 * (<why>).` (left at "cut off." after a short retry with unchanged input), then `recap` – what it already did, when this
 * engine cannot know it.
 */
export function interruptionNote(s: Services, plan: TurnPlan, request: TurnRequest, lastSeq: number, timezone?: string, recap?: string): string | undefined {
  const cut = lastCut(s, plan, request, lastSeq);
  if (!cut && !recap) return undefined;
  const zone = displayZone(timezone);
  const when = cut ? ` at ${dueText(cut.at, zone, s.clock.now())} (${cut.why})` : '';
  return [`${noteLabel(s.clock.now(), timezone)} My last turn here was cut off${when}.`, recap].filter(Boolean).join('\n');
}

/** The latest cut and why; undefined without one, or after a short retry with unchanged input. */
function lastCut(s: Services, plan: TurnPlan, request: TurnRequest, lastSeq: number): { at: number; why: string } | undefined {
  try {
    const runs = unfinishedRuns(s, recapScope(plan), request.runId)
      .filter(run => run.id !== request.runId && ['failed', 'interrupted', 'unknown'].includes(run.status));
    const active = request.interruption ? s.runs.get(request.runId) : undefined;
    if (active && request.interruption) runs.unshift({ ...active, status: 'failed', endedAt: request.interruption.at, error: request.interruption.reason });
    if (!runs.length) return undefined;
    const latest = runs[0];
    const items = s.runs.items(latest.id);
    const stored = new KvRepo(s.db).get<InputMark>(INPUT, keyOf(plan));
    const mark = stored?.runId === latest.id ? stored : undefined;
    const oldest = runs.at(-1)!;
    const first = cutAt(s, oldest, oldest.id === latest.id ? items : s.runs.items(oldest.id));
    const since = latest.startedAt ?? first;
    const messages = plan.conversationId ? s.chats.messages(plan.conversationId, { beforeSeq: lastSeq + 1, limit: 60 })
      .filter(message => message.seq > (mark?.lastSeq ?? plan.memberCursor) && message.authorId !== plan.agent.id
        && (message.kind !== 'status' || (isAgentNotice(message) && message.meta.status?.details?.by !== plan.agent.id))
        && (mark !== undefined || message.createdAt > since)) : [];
    const notes = request.notes.filter(note => note.at > (mark?.notesAt ?? since) && (note.reason ?? request.reason) !== 'retry');
    const changed = messages.length > 0 || notes.length > 0 || Boolean(mark?.taskKey && mark.taskKey !== taskKey(plan));
    if (!changed && s.clock.now() - first < BRIEF_INTERRUPTION_MS) return undefined;
    return { at: cutAt(s, latest, items), why: cutWhy(s, latest) };
  } catch (error) {
    s.log.warn('interruption note not assembled', { runId: request.runId, error: String(error) });
    return undefined;
  }
}
