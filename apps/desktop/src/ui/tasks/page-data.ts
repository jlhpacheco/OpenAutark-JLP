// The Tasks page's data in the client (Quests round 20.11.2026): one index of every task the page can show by id –
// the open work of the store (lib/store.ts `tasks`: quests and lone to-dos with their to-dos as steps, plus to-do rows
// task events brought; `todos`: the person's own) and what finished since the start of today (loaded here once per
// connection with includeSteps, then kept by task events – the store keeps only open work). A live row always wins
// over the copy in its quest's steps; a removed task leaves both. Also: which tasks a turn runs on right now.
// Owns: the finished-today window, the removed ids and the index. Never: a second copy of open work, renders, or polls.

import { computed, signal } from '@preact/signals';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { activity, tasks, todos } from '../lib/store.ts';

/** Tasks finished (done or dropped) since `finishedSince`, every level – Done today, a quest's done to-dos, the AI's day. */
export const finished = signal<TaskView[]>([]);
/** Ids task.removed named since the page's data was loaded (a quest's step copy may still hold them). */
const removed = signal<ReadonlySet<string>>(new Set());
let finishedSince = 0;
let wired = false;

function upsertFinished(view: TaskView): void {
  const rest = finished.peek().filter((task) => task.id !== view.id);
  const done = view.status === 'done' || view.status === 'dropped';
  if (done && (view.completedAt ?? view.updatedAt) >= finishedSince) finished.value = [...rest, view];
  else if (rest.length !== finished.peek().length) finished.value = rest;
}

async function loadFinished(): Promise<void> {
  if (!can('tasks.list')) { finished.value = []; return; }
  try {
    finished.value = await rpc.call('tasks.list', { status: ['done', 'dropped'], completedSince: finishedSince, includeSteps: true, limit: 500 });
  } catch { /* keep what is shown */ }
}

/** Loads what finished since `since` (the start of the person's today) and follows task events; again on every reconnect. */
export function watchFinished(since: number): void {
  if (!wired) {
    wired = true;
    rpc.on('task.upserted', upsertFinished);
    rpc.on('task.removed', ({ id }) => {
      removed.value = new Set([...removed.peek(), id]);
      if (finished.peek().some((task) => task.id === id)) finished.value = finished.peek().filter((task) => task.id !== id);
    });
    rpc.onOpen(() => { removed.value = new Set(); void loadFinished(); });
  }
  if (since === finishedSince && finished.peek().length) return;
  finishedSince = since;
  void loadFinished();
}

/** Every task the page can show, by id: quests' step copies first, then the live rows over them. */
export const taskIndex = computed(() => {
  const index = new Map<string, Task>();
  const gone = removed.value;
  const put = (task: Task) => { if (!gone.has(task.id)) index.set(task.id, task); };
  for (const task of tasks.value) for (const step of task.steps ?? []) put(step);
  for (const task of finished.value) for (const step of task.steps ?? []) put(step);
  for (const task of finished.value) put(task);
  for (const task of tasks.value) put(task);
  for (const task of todos.value) put(task);
  return index;
});

/** The tasks a turn runs on right now (the live activity). */
export const runningTasks = computed(() => {
  const ids = new Set<string>();
  for (const run of activity.value) if (run.taskId) ids.add(run.taskId);
  for (const task of tasks.value) if (task.running) ids.add(task.id);
  return ids;
});
