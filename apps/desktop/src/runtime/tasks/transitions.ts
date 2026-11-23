// What an ended task means for the work around it:
//  - pieceEnded: a to-do of a quest ended – the quest's agent owner hears it (reason 'child', under the quest's key) with
//    who finished it, its result and evidence, "I had asked: …" when that owner gave it, and what is still open; when it
//    was the last open one, the note starts "Every to-do of <quest> is done – it is done when <doneWhen>." (once – also
//    for the owner's own to-do someone else ended; never for the owner's own act). A quest never waits by itself on
//    its to-dos; a person-owned quest gets nothing. endWaitOn: a wait on the one who ended it ends with it (for an
//    answered ask too, whose asker hears the person's own line instead).
//  - endNote: the note the giver of a finished task hears ("I had asked: …").
//  - waitIn: the agent's one task that waits on whoever writes – in that chat, or anywhere when it is our 1:1
//    (chat/delivery-route.ts gives their line that task; calls/talker-prompt.ts names the one waiting on a person).
// Owns: those notes and that read. Never: wakes the one who ended it, a finished or paused parent, or archived owners.

import { HUMAN_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { isFinished, isPaused, type Task, type TaskResult, type TaskView } from '../../shared/model/tasks.ts';
import type { TaskService } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { nameOf, tell } from './give.ts';
import { giverOf } from './names.ts';

const EVIDENCE_CAP = 8;

function verificationLabel(result: TaskResult | undefined): string {
  switch (result?.verification) {
    case 'verified': return 'verified';
    case 'reported_by_human': return 'reported by the person';
    default: return result?.verificationNote ? `claimed; ${excerpt(result.verificationNote, 120)}` : 'claimed, not checked yet';
  }
}

/** How a finished task ended, for whoever hears it: the result, its evidence, and the brief beside it. */
export function endNote(task: Task, asked: boolean): string[] {
  const lines: string[] = [];
  if (task.doneWhen) lines.push(`${asked ? 'I had asked' : 'Done when'}: ${excerpt(task.doneWhen, 200)}`);
  if (task.result?.summary) lines.push(`${task.status === 'dropped' ? 'Why' : 'Result'}: ${excerpt(task.result.summary, 1200)}`);
  const evidence = (task.result?.evidence ?? []).slice(0, EVIDENCE_CAP);
  if (evidence.length) lines.push(`Evidence:\n${evidence.map((item) => `- ${excerpt(item.label, 160)}${item.ref ? `: ${excerpt(item.ref, 300)}` : ''}`).join('\n')}`);
  return lines;
}

/** A piece ended: the owner of its task hears it (true when someone was told). */
export function pieceEnded(t: TaskServiceImpl, piece: Task, by: string): boolean {
  if (!piece.parentId) return false;
  const parent = t.repo.get(piece.parentId);
  if (!parent || isFinished(parent.status) || isPaused(parent) || parent.assigneeKind !== 'agent' || !parent.assigneeId) return false;
  const owner = parent.assigneeId;
  const open = t.repo.children(parent.id).filter((item) => item.id !== piece.id && !isFinished(item.status));
  const own = piece.assigneeKind === 'agent' && piece.assigneeId === owner;
  if (owner === by || (own && open.length)) return false; // it knows, or it was its own to-do and more are open
  const who = nameOf(t.s, piece.assigneeId ?? 'human');
  const word = piece.status === 'dropped' ? 'dropped' : `finished (${verificationLabel(piece.result)})`;
  const lines = [`${who} ${word} "${excerpt(piece.title, 120)}", a to-do of my quest "${excerpt(parent.title, 120)}".`, ...endNote(piece, giverOf(piece) === owner)];
  if (open.length) lines.push(`Still open: ${open.slice(0, 6).map((item) => `"${excerpt(item.title, 60)}" (${nameOf(t.s, item.assigneeId ?? 'human')})`).join(', ')}.`);
  else lines.unshift(lastTodoNote(parent)); // the last one: the quest is ready to close
  endWaitOn(t, parent, piece, by);
  tell(t.s, owner, { reason: 'child', taskId: parent.id, conversationId: parent.conversationId, note: lines.join('\n') });
  return true;
}

/** The first line the quest's owner reads when its last open to-do ended. */
export function lastTodoNote(quest: Pick<Task, 'title' | 'doneWhen'>): string {
  const when = quest.doneWhen?.trim();
  return `Every to-do of "${excerpt(quest.title, 120)}" is done${when ? ` – it is done when ${excerpt(when, 300).replace(/\.+$/, '')}.` : '.'}`;
}

/** A wait on the one who ended a piece ends with it – an answered ask too (its line is the news; answer-receipt.ts wakes the asker). */
export function endWaitOn(t: TaskServiceImpl, parent: Task | undefined, piece: Task, by: string): void {
  if (!parent || isPaused(parent) || parent.status !== 'waiting' || parent.waitingOn?.on !== 'who') return;
  if (parent.waitingOn.who === (piece.assigneeId ?? HUMAN_ID)) t.update(parent.id, { status: 'open' }, by);
}

/**
 * The agent's only task that waits on `who` (a person, colleague or agent) – in the chat, or in any chat when it is our
 * 1:1 (`direct`); without `who`, the one waiting on a person in the chat (undefined for none or several).
 */
export function waitIn(tasks: Pick<TaskService, 'list'>, conversationId: string, agentId: string, who?: string, direct = false): TaskView | undefined {
  const waiting = tasks.list({ ...(direct && who ? {} : { conversationId }), assigneeKind: 'agent', assigneeId: agentId, status: ['waiting'], includeSteps: true, limit: 50 })
    .filter((task) => task.waitingOn?.on === 'who' && !isPaused(task) && (who === undefined ? task.waitingOn.who === HUMAN_ID || isPersonId(task.waitingOn.who) : task.waitingOn.who === who));
  return waiting.length === 1 ? waiting[0] : undefined;
}
