// What the four task tools share (Quests round 20.11.2026, tasks.ts, tasks-list.ts, tasks-remind.ts): the task an id
// names (a miss names my open work), who `for` names, a time read in the person's zone, the
// one refusal of a time on agent work (CONTRACT point 1, in code: my work and my colleagues' start now), the one check of
// a time on a person's to-do (FIXREAL 1, real run 20.11.: three slots nobody asked for would have rung – it comes from
// their words this turn or from their assistant; a time from their words stands on one to-do per quest – FIXREAL2), the quest a to-do goes into by default (only the quest my turn is
// about – FIXREAL 4), what every write answers, and the person's line kept with the work it started – a to-do or quest
// made in a turn a person's line started gets that line as a quoted entry in its own thread (CONTRACT point 2; the
// runtime does it, I do nothing for it) – whole when everyone in that thread reads the chat it came from, else only its
// link (R1.1: a 1:1 stays private).
// Owns: those helpers and the refusal texts of a time. Never: changes a task itself.

import type { ToolContext } from '../types.ts';
import { WHEN_PROPERTY } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { UNFINISHED, type Task, type TaskView } from '../../../shared/model/tasks.ts';
import { isTaskThread } from '../../../shared/model/chat.ts';
import { findTimes, wallOf } from '../../../shared/text/when.ts';
import { nameOf } from '../../tasks/give.ts';
import { LINE_ELSEWHERE, readQuote, threadEvent, threadOf, type KeptQuote } from '../../tasks/thread.ts';
import { personalAssistant } from '../../day/assistant.ts';
import { dayName, dueText, profileZone } from '../../context/time.ts';
import { isQuest, ownerOf, personLineOf, personLinesOf } from '../../context/quest-text.ts';
import { clip, parseWhen } from './util.ts';
import { namedMembers } from './chat-joins.ts';

/** The refusal of a time on agent work (CONTRACT point 1). */
export const AGENT_TIME = "My work and my colleagues' start now; a time belongs to the person's day, or it is a date the world sets – that goes into notes with its source.";
/** The refusal of a time on a person's to-do that neither their words nor their assistant gave (it would ring). */
export const PERSON_TIME = 'A time on their list comes from their words or their assistant; my suggestion goes into the notes.';
/** The refusal of a time on a quest. */
export const QUEST_TIME = 'A quest is a goal and holds no time; I put the time on the to-do it belongs to.';
/** The refusal of a length on a day without a clock (it would make a slot at 00:00 that rings at midnight). */
export const DAY_LENGTH = 'A day without a clock has no length; I give a length with a clock time.';

const MINUTE = 60_000;

/**
 * A time on `owner`'s to-do (a person's) stands when I am their assistant – I plan their day (day/assistant.ts) – or when
 * the person's lines this turn started from name it (shared/text/when.ts findTimes, read as of when they wrote): a phrase
 * with a clock its moment, a day alone that day as a day (its start, no clock of mine added – "bis Freitag" is Friday,
 * not Friday 12:00). A time from their words is one to-do's (REAL-2 S2Q: "bis Freitag" stood on all four tax steps and
 * each would ring on Friday): it stands on one open to-do of theirs per quest (`place.quest`), outside a quest on one per
 * turn – `place.id` is the to-do itself. Undefined: it stands; else the refusal, with the times their words do name or
 * where the time already stands.
 */
export function personTimeRefused(ctx: ToolContext, owner: string, at: number, place: { quest?: string; id?: string } = {}): string | undefined {
  if (personalAssistant(ctx.services, owner)?.id === ctx.agent.id) return undefined;
  const zone = profileZone(ctx.services);
  const phrases = personLinesOf(ctx.services, ctx.agent.id, ctx.conversationId).flatMap((line) => findTimes(line.body, line.createdAt, zone));
  const wall = wallOf(at, zone);
  const named = phrases.find((phrase) => phrase.allDay ? wallOf(phrase.at, zone).date === wall.date && wall.minutes === 0 : Math.abs(phrase.at - at) < MINUTE);
  const now = ctx.services.clock.now();
  if (named) {
    const taken = holderOf(ctx, owner, at, place);
    return taken ? `${named.allDay ? dayName(at, zone, now) : dueText(at, zone, now)} already stands on "${clip(taken, 80)}"; the steps before it carry no time unless their words give one – my suggestion goes into the notes.` : undefined;
  }
  const words = phrases.map((phrase) => `"${phrase.text}" = ${phrase.allDay ? `${dayName(phrase.at, zone, now)} (the day)` : dueText(phrase.at, zone, now)}`);
  return words.length ? `${PERSON_TIME} Their words name ${words.join(', ')}.` : PERSON_TIME;
}

/** The title of another open to-do of `owner` that holds `at` – in quest `place.quest`, or without a quest one this turn made or changed. */
function holderOf(ctx: ToolContext, owner: string, at: number, place: { quest?: string; id?: string }): string | undefined {
  let scope: string | number | undefined = place.quest; // the quest, else the turn's start
  if (scope === undefined) { try { scope = ctx.services.runs.get(ctx.runId)?.startedAt; } catch { scope = undefined; } }
  if (scope === undefined) return undefined; // outside a quest with the turn's start unknown
  const row = ctx.services.db.get<{ title: string }>(
    `SELECT title FROM tasks WHERE assignee_kind = 'human' AND COALESCE(assignee_id, 'human') = ? AND status IN ('open', 'waiting') AND "at" = ?
       AND id IS NOT ? AND ${place.quest ? 'parent_id = ?' : 'parent_id IS NULL AND updated_at >= ?'} ORDER BY created_at LIMIT 1`,
    [owner, at, place.id ?? null, scope]);
  return row?.title;
}

/** A person's id ('human' or a colleague's per_…). */
export const isPerson = (id: string): boolean => id === HUMAN_ID || isPersonId(id);

/** My open work in one line, for an id that did not fit. */
function myOpenWork(ctx: ToolContext): string {
  let open: TaskView[] = [];
  try { open = ctx.services.tasks.list({ assigneeKind: 'agent', assigneeId: ctx.agent.id, status: [...UNFINISHED], includeSteps: true, limit: 5 }); } catch { open = []; }
  return open.length ? `My open work: ${open.map((task) => `${task.id} "${clip(task.title, 60)}"`).join(', ')} (tasks.list has all).` : 'I have nothing open (tasks.list shows the work).';
}

/** The line of a call without an id in a turn about no task of its own (a chat line's turn – turnTask). */
export const NO_TURN_TASK = 'This turn is about no quest or to-do of its own, so I name one by its id.';

/** The task an id names; a miss – or no id in a turn about none – names my open work. */
export function requireTask(ctx: ToolContext, id: string | undefined): TaskView {
  const task = id ? ctx.services.tasks.get(id.trim()) : undefined;
  if (task) return task;
  throw new WorkforceError('not_found', id ? `No quest or to-do "${id}" for me. ${myOpenWork(ctx)}` : askForId(ctx));
}

/** What a call without an id answers in a turn about no task of its own: that line and my open work. */
export const askForId = (ctx: ToolContext): string => `${NO_TURN_TASK} ${myOpenWork(ctx)}`;

/** Who `for` names: "me", "team", "person" (the owner), or a member's id (a name that fits nobody comes back with who exists). */
export function receiverOf(ctx: ToolContext, raw: string | undefined): string | { refused: string } {
  const value = raw?.trim() || 'me';
  const lower = value.toLowerCase();
  if (['me', 'self', 'myself'].includes(lower)) return ctx.agent.id;
  if (lower === 'team') return 'team';
  if (lower === 'person' || lower === 'human') return HUMAN_ID;
  const named = namedMembers(ctx, [value]);
  return typeof named === 'string' ? { refused: named } : named[0];
}

/**
 * A time as WHEN_PROPERTY says, in the person's zone (undefined: none given; null: "" clears); an unreadable one is
 * refused. `day`: it names a day without a clock ("2026-11-27", "Freitag") – `at` is that day's start.
 */
export function timeOf(ctx: ToolContext, raw: string | undefined, name: string): { at: number | null | undefined; day?: true } | { refused: string } {
  if (raw === undefined) return { at: undefined };
  if (!raw.trim()) return { at: null };
  const now = ctx.services.clock.now();
  const zone = profileZone(ctx.services);
  const at = parseWhen(raw, now, zone);
  if (at === undefined) return { refused: `I cannot read ${name} "${clip(raw, 80)}": ${String(WHEN_PROPERTY.description)}` };
  const found = findTimes(raw.trim(), now, zone);
  return found.length === 1 && found[0].allDay && found[0].at === at ? { at, day: true } : { at };
}

/**
 * The quest a to-do goes into: its id, the quest of a to-do id, none ("none"), else the quest my turn is about (its lone
 * to-do becomes one) – when the turn began in the thread of that quest or one of its to-dos, or from a note or wake on it.
 * A turn from a line in a chat has none: delivery ties such a turn to the work that waits on its writer (to resume it),
 * and a new ask there is not that work's (FIXREAL 4, real run D4).
 */
export function questOf(ctx: ToolContext, raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === 'none') return undefined;
  if (value) {
    const named = requireTask(ctx, value);
    return isQuest(named) || !named.parentId ? named.id : named.parentId;
  }
  const turn = turnTask(ctx);
  return turn ? questOfTask(turn) : undefined;
}

/** A task's quest: itself when it is one or stands alone (a lone to-do that gets a to-do becomes a quest, tasks/quests.ts). */
const questOfTask = (task: TaskView): string => (isQuest(task) ? task.id : task.parentId ?? task.id);

/**
 * The task my turn is about – the default of an id in tasks.update and tasks.remind, and of the quest in tasks.add
 * (FIXREAL second round): the turn's own task when the turn began in the thread of it, its quest or one of that quest's
 * to-dos, or from a note or wake on it; none for a turn from a line in a chat.
 */
export function turnTask(ctx: ToolContext): TaskView | undefined {
  const turn = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : undefined;
  return turn && turnOn(ctx, questOfTask(turn)) ? turn : undefined;
}

/** My turn began in the thread of quest `questId` or one of its to-dos, or from a note or wake on it (not a chat line). */
function turnOn(ctx: ToolContext, questId: string): boolean {
  const chat = ctx.conversationId;
  if (chat && isTaskThread(chat)) {
    const thread = ctx.services.tasks.get(chat);
    return thread?.id === questId || thread?.parentId === questId;
  }
  let trigger: string | undefined;
  try { trigger = ctx.services.runs.get(ctx.runId)?.trigger; } catch { trigger = undefined; }
  return trigger !== 'message';
}

/** What every write answers: the task, its kind, owner, state and quest. */
export function answer(ctx: ToolContext, task: Task, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const owner = ownerOf(task);
  return {
    ok: true, taskId: task.id, kind: task.kind, owner: owner === ctx.agent.id ? 'me' : `${nameOf(ctx.services, owner)} (${owner})`, status: task.status,
    ...(task.parentId ? { quest: task.parentId } : {}), ...extra,
  };
}

/** Every person of task `taskId`'s thread (made now) reads the line `quote` names where it was written (tasks/thread.ts readQuote). */
function threadReads(ctx: ToolContext, taskId: string, quote: KeptQuote): boolean {
  const s = ctx.services;
  try {
    threadOf(s, taskId);
    return readQuote(s, s.chats.members(taskId).filter((member) => member.kind === 'human' && !member.leftAt).map((member) => member.memberId), quote);
  } catch { return false; }
}

/**
 * The person's line this turn took, kept as a quoted entry in the new task's thread (a quiet line linked to the
 * original): whole when every person of that thread reads the chat it was written in, else only its link – its words
 * stay where they were written (a person who joins later: tasks/thread.ts keeps it the same way). Nothing when no
 * person's line started the turn; a failure never fails the call (threadEvent logs it).
 */
export function keepPersonLine(ctx: ToolContext, taskId: string): void {
  const line = personLineOf(ctx.services, ctx.agent.id, ctx.conversationId);
  if (!line) return;
  const quote: KeptQuote = { conversationId: line.conversationId, messageId: line.id, seq: line.seq, authorId: line.authorId, at: line.createdAt };
  const text = threadReads(ctx, taskId, quote) ? line.body : LINE_ELSEWHERE;
  threadEvent(ctx.services, taskId, { type: 'note', text, details: { taskId, quote } }, line.authorId);
}
