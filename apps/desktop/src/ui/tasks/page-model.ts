// The Tasks page's lists, pure (Quests round 20.11.2026): the quests on the left (with the person's to-dos first, then
// the AI's, "Other" for the person's to-dos without a quest) with a colour from the quest's id, "For you" (the person's
// open to-dos: overdue and today first, then Later), "Done today", and "At work" – per quest who else is on which to-do
// (an agent, a colleague, the team), what it waits on, and the next note an agent left itself about it (a reminder).
// Owns: these selections, their order and the At work summary line. Never: the store, rpc, the DOM or a clock – callers
// pass the tasks, the time and the day's bounds in the person's zone.

import { HUMAN_ID } from '../../shared/ids.ts';
import { isLater, onForYouList } from '../../shared/model/todo-later.ts';
import type { Schedule, Task } from '../../shared/model/tasks.ts';

/** How many quest colours there are (tokens.css --wf-c1 … --wf-c8, the mockup's eight). */
export const HUES = 8;

/** A quest's colour (1…HUES), the same on every device: a hash of its id. */
export function questHue(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return ((hash >>> 0) % HUES) + 1;
}

export const isOpen = (task: Pick<Task, 'status'>): boolean => task.status === 'open' || task.status === 'waiting';
/** The person's own (this device's person: no assignee id, or 'human'). */
export const isMine = (task: Pick<Task, 'assigneeKind' | 'assigneeId'>): boolean => task.assigneeKind === 'human' && (!task.assigneeId || task.assigneeId === HUMAN_ID);
/** Who else has a to-do: its agent's or colleague's id, 'team' while Autark has not picked one yet. */
export const doerOf = (task: Pick<Task, 'assigneeKind' | 'assigneeId'>): string => (task.assigneeKind === 'team' || !task.assigneeId ? 'team' : task.assigneeId);

/** The to-dos of every quest in `index`, by quest id. */
export function childrenOf(index: ReadonlyMap<string, Task>): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const task of index.values()) {
    if (!task.parentId) continue;
    const list = out.get(task.parentId);
    if (list) list.push(task); else out.set(task.parentId, [task]);
  }
  return out;
}

export interface QuestLine { quest: Task; hue: number; mine: number; open: number }

/** The left column: open quests with the person's open to-dos ("With you"), the rest ("AI only"), and "Other". */
export function questLines(index: ReadonlyMap<string, Task>, children: ReadonlyMap<string, Task[]> = childrenOf(index)): { withYou: QuestLine[]; aiOnly: QuestLine[]; other: number } {
  const withYou: QuestLine[] = [];
  const aiOnly: QuestLine[] = [];
  let other = 0;
  for (const task of index.values()) {
    if (task.kind === 'quest') {
      if (!isOpen(task)) continue;
      const open = (children.get(task.id) ?? []).filter(isOpen);
      const line = { quest: task, hue: questHue(task.id), mine: open.filter(isMine).length, open: open.length };
      (line.mine ? withYou : aiOnly).push(line);
    } else if (isOpen(task) && isMine(task) && !(task.parentId && index.get(task.parentId)?.kind === 'quest')) other++;
  }
  const newest = (a: QuestLine, b: QuestLine) => b.quest.createdAt - a.quest.createdAt || a.quest.id.localeCompare(b.quest.id);
  return { withYou: withYou.sort(newest), aiOnly: aiOnly.sort(newest), other };
}

/** The quests a to-do can move into: the open ones in the quest column's order (with the person's to-dos first). */
export function questChoices(index: ReadonlyMap<string, Task>): Array<Pick<Task, 'id' | 'title'>> {
  const lists = questLines(index);
  return [...lists.withYou, ...lists.aiOnly].map((line) => ({ id: line.quest.id, title: line.quest.title }));
}

/** "For you" in order: what is due (overdue and today, timed ones by their time, then the rest by age) and Later. */
export function forYou<T extends Task>(todos: readonly T[], now: number, dayEnd: number, otherOnly = false): { now: T[]; later: T[] } {
  const out = { now: [] as T[], later: [] as T[] };
  for (const task of todos) {
    if (!onForYouList(task) || (otherOnly && task.parentId)) continue; // a quest of the person's is a quest, not a to-do (onForYouList)
    (isLater(task, now, dayEnd) ? out.later : out.now).push(task);
  }
  const key = (task: T) => task.at ?? dayEnd - 1;
  const order = (a: T, b: T) => key(a) - key(b) || a.createdAt - b.createdAt;
  out.now.sort(order);
  out.later.sort(order);
  return out;
}

/** "Done today": the person's own to-dos finished since `dayStart`, in the order they were done. */
export function doneToday<T extends Task>(finished: readonly T[], dayStart: number): T[] {
  return finished
    .filter((task) => task.kind !== 'quest' && task.status === 'done' && isMine(task) && (task.completedAt ?? 0) >= dayStart)
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
}

/** One to-do of someone else: `who` is doerOf (an agent's or colleague's id, or 'team'). */
export interface WorkLine { task: Task; who: string; running: boolean }
export interface WorkGroup { key: string; quest?: Task; hue: number; lines: WorkLine[]; note?: Schedule }

/** The next active reminder about the quest or one of its to-dos (the agent's own note), if any. */
export function nextNote(schedules: readonly Schedule[], ids: ReadonlySet<string>): Schedule | undefined {
  let best: Schedule | undefined;
  for (const item of schedules) {
    if (item.kind !== 'reminder' || !item.active || !item.taskId || !ids.has(item.taskId) || item.nextAt === undefined) continue;
    if (!best || item.nextAt < (best.nextAt ?? Infinity)) best = item;
  }
  return best;
}

/**
 * "At work" opened: per quest (newest first; "Other" last) the to-dos of everyone but the person – agents, colleagues
 * and the team (work the person gave on) –, running ones first, and what they finished since `dayStart`, with the
 * quest's next note. `owner`: only that one's lines.
 */
export function atWork(
  index: ReadonlyMap<string, Task>, running: ReadonlySet<string>, schedules: readonly Schedule[], dayStart: number, owner?: string,
  children: ReadonlyMap<string, Task[]> = childrenOf(index),
): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const task of index.values()) {
    if (task.kind === 'quest' || isMine(task)) continue;
    const who = doerOf(task);
    if (owner && who !== owner) continue;
    if (!isOpen(task) && !(task.status === 'done' && (task.completedAt ?? 0) >= dayStart)) continue;
    const quest = task.parentId ? index.get(task.parentId) : undefined;
    const key = quest?.kind === 'quest' ? quest.id : '';
    let group = groups.get(key);
    if (!group) {
      group = { key, ...(key ? { quest } : {}), hue: key ? questHue(key) : 0, lines: [] };
      groups.set(key, group);
    }
    group.lines.push({ task, who, running: running.has(task.id) });
  }
  const rank = (line: WorkLine) =>(line.running ? 0 : isOpen(line.task) ? 1 : 2);
  const list = [...groups.values()];
  for (const group of list) {
    group.lines.sort((a, b) => rank(a) - rank(b) || a.task.createdAt - b.task.createdAt);
    const about = group.quest ? [group.key, ...(children.get(group.key) ?? []).map((task) => task.id)] : group.lines.map((line) => line.task.id);
    const note = nextNote(schedules, new Set(about));
    if (note) group.note = note;
  }
  return list.sort((a, b) => (a.quest ? 0 : 1) - (b.quest ? 0 : 1) || (b.quest?.createdAt ?? 0) - (a.quest?.createdAt ?? 0));
}

/** The closed bar's line: "23 open to-dos in 12 quests · 3 running now · next: Clara at 11:00". */
export function workSummary(groups: readonly WorkGroup[],next: { name: string; clock: string } | undefined): string {
  let open = 0;
  let runs = 0;
  let quests = 0;
  for (const group of groups) {
    const count = group.lines.filter((line) => isOpen(line.task)).length;
    open += count;
    runs += group.lines.filter((line) => line.running).length;
    if (count && group.quest) quests++;
  }
  if (!open && !runs) return next ? `Nothing open · next: ${next.name} at ${next.clock}` : 'Nothing open right now';
  const parts = [`${open} open ${open === 1 ? 'to-do' : 'to-dos'}${quests ? ` in ${quests} ${quests === 1 ? 'quest' : 'quests'}` : ''}`];
  if (runs) parts.push(`${runs} running now`);
  if (next) parts.push(`next: ${next.name} at ${next.clock}`);
  return parts.join(' · ');
}

/** The soonest active reminder from now on (the summary's "next"). */
export function soonestNote(schedules: readonly Schedule[], now: number): Schedule | undefined {
  let best: Schedule | undefined;
  for (const item of schedules) {
    if (item.kind !== 'reminder' || !item.active || item.nextAt === undefined || item.nextAt < now) continue;
    if (!best || item.nextAt < (best.nextAt ?? Infinity)) best = item;
  }
  return best;
}

/** A quest's progress: its to-dos done of all (dropped ones left out). */
export function questProgress(todos: readonly Task[]): { done: number; total: number } {
  const counted = todos.filter((task) => task.status !== 'dropped');
  return { done: counted.filter((task) => task.status === 'done').length, total: counted.length };
}

/** The assistant the input line woke for new to-dos (tasks.quickCreate's answer): who, when, which. */
export interface Told { agentId: string; at: number; ids: readonly string[] }

/** A small allowance for the clocks of this device and the PC that runs the agent. */
const CLOCK_SLACK_MS = 5_000;

/** The agent sorting this to-do now: the told assistant while a run of it that started after it was told is live. */
export function sortingAgent(told: Told | null, taskId: string, activity: ReadonlyArray<{ agentId: string; startedAt: number }>): string | undefined {
  if (!told || !told.ids.includes(taskId)) return undefined;
  return activity.some((run) => run.agentId === told.agentId && run.startedAt >= told.at - CLOCK_SLACK_MS) ? told.agentId : undefined;
}
