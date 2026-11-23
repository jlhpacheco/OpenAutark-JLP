// Activity, pure: one row per member – people and agents side by side – with what they finished today, what they are on
// right now, how much is open and how much is stuck; plus the totals line. Robin's "Dashboard über alles, was alle machen":
// the owner's admin overview. Counted are to-dos (Quests round 20.11.2026: a quest is a goal, its to-dos are the work):
// each to-do once, in a quest or not – a quest's to-dos are read from its steps, so a colleague's to-do in someone else's
// quest counts for the colleague. Stuck is the one rule of the views (shared/model/task-stuck.ts stuckOf: nothing moved
// for two days unless its time is ahead, paused, no owner). Working now: an agent's live run (its task's title – a to-do
// or a quest –, else what started it, the origin's label, else the run's note, else "Working"; the live note beside it
// when it says more; its own turn, never one of its splits); a person's open to-do whose time on their calendar is now
// (`at` for `minutes`, the calendar's default length without). Work nobody owns yet (an older PC's row the watcher still
// places) is a row of its own ({ id: 'team', kind: 'team' } – "No owner yet").
// Owns: these rules (unit-tested in test/unit/team-view/activity-model.test.ts). Never: imports the store, rpc or the DOM,
// or loads anything – callers pass the store's tasks, the done store and the live runs in.

import { HUMAN_ID } from '../../shared/ids.ts';
import { DEFAULT_MINUTES } from '../../shared/model/calendar.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { everyTask, isFinished, type Task, type TaskView } from '../../shared/model/tasks.ts';
import { stuckOf } from '../../shared/model/task-stuck.ts';
import { finishedAt } from '../tasks/work-model.ts';

/** A member's row – or, kind 'team' (id 'team', the owner filter for no owner), the work nobody owns yet. */
export interface ActivityMember { id: string; kind: 'person' | 'agent' | 'team' }

/** The "No owner yet" row's member. */
export const NO_OWNER: ActivityMember = Object.freeze({ id: 'team', kind: 'team' });

export interface ActivityNow {
  title: string;
  /** The live run's own words when they differ from the title ("Reading the invoice"). */
  note?: string;
  taskId?: string;
  conversationId?: string;
}

export interface ActivityRow {
  member: ActivityMember;
  doneToday: number;
  now?: ActivityNow;
  open: number;
  stuck: number;
}

export interface ActivityInput {
  /** The store's open tasks (quests carry their to-dos as steps). */
  open: readonly TaskView[];
  /** The caller's to-dos. */
  todos: readonly TaskView[];
  /** Finished tasks loaded so far (the done store, loaded from `dayStart`). */
  done: readonly TaskView[];
  /** Live runs (store.activity). */
  live: readonly AgentActivity[];
  now: number;
  /** Start of today (local midnight in the profile's zone). */
  dayStart: number;
}

const MIN = 60_000;

/** True when `task` is given to the human `personId` ('human' = the caller, whose own to-dos may carry no id). */
function assignedToPerson(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, personId: string): boolean {
  return task.assigneeKind === 'human' && (task.assigneeId ?? HUMAN_ID) === personId;
}

/** True when `task` belongs to `member`: an agent's by assignee id, a person's by theirs. */
export function ownedByMember(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, member: ActivityMember): boolean {
  if (member.kind === 'team') return task.assigneeKind === 'team';
  return member.kind === 'agent' ? task.assigneeKind === 'agent' && task.assigneeId === member.id : assignedToPerson(task, member.id);
}

/** A person's open to-do whose time on the calendar is now – `at` for `minutes` (DEFAULT_MINUTES without). */
export function onCalendarNow(task: Pick<Task, 'status' | 'at' | 'minutes'>, now: number): boolean {
  return task.status === 'open' && task.at !== undefined && task.at <= now && now < task.at + (task.minutes ?? DEFAULT_MINUTES) * MIN;
}

function nowOf(member: ActivityMember, mine: readonly Task[], every: ReadonlyMap<string, Task>, input: ActivityInput): ActivityNow | undefined {
  if (member.kind === 'agent') {
    const run = input.live.find((entry) => entry.agentId === member.id && !entry.split); // a split is not the agent's own work
    if (!run) return undefined;
    const label = (run.taskId ? every.get(run.taskId)?.title : undefined) ?? run.origin?.label; // a chat-free run without a task says what started it
    const title = label || run.note || 'Working';
    return {
      title, ...(label && run.note && run.note !== title ? { note: run.note } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}), conversationId: run.conversationId,
    };
  }
  const busy = mine.filter((task) => onCalendarNow(task, input.now)).sort((a, b) => b.at! - a.at! || b.updatedAt - a.updatedAt)[0];
  return busy ? { title: busy.title, taskId: busy.id, ...(busy.conversationId ? { conversationId: busy.conversationId } : {}) } : undefined;
}

/** One row per member, in the order given. */
export function activityRows(members: readonly ActivityMember[], input: ActivityInput): ActivityRow[] {
  const every = everyTask(input.open, input.todos, input.done);
  const todos = [...every.values()].filter((task) => task.kind !== 'quest');
  const open = todos.filter((task) => !isFinished(task.status));
  return members.map((member) => {
    const mine = open.filter((task) => ownedByMember(task, member));
    const doneToday = todos.filter((task) => task.status === 'done' && ownedByMember(task, member) && finishedAt(task) >= input.dayStart).length;
    const now = nowOf(member, mine, every, input);
    return { member, doneToday, ...(now ? { now } : {}), open: mine.length, stuck: mine.filter((task) => stuckOf(task, input.now)).length };
  });
}

export interface ActivityTotals { doneToday: number; working: number; open: number; stuck: number }

/** The line above the rows: done today, members working now, open and stuck work across everyone. */
export function activityTotals(rows: readonly ActivityRow[]): ActivityTotals {
  return rows.reduce<ActivityTotals>((sum, row) => ({
    doneToday: sum.doneToday + row.doneToday,
    working: sum.working + (row.now ? 1 : 0),
    open: sum.open + row.open,
    stuck: sum.stuck + row.stuck,
  }), { doneToday: 0, working: 0, open: 0, stuck: 0 });
}
