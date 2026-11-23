// Pure helpers behind the task card in a chat and the steps of a task: status labels, progress text and the steps. The
// owner rules live in tasks/work-model.ts, the person's to-do helpers (widget icons, "Show as…") in tasks/todo-model.ts,
// the For-you time rules (the list clock's next change, the "Later" choices) in tasks/todo-time.ts – callers import
// each from its own module (no re-exports here).
// Owns: these rules (unit-tested in test/unit/ui/tasks-model.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in, so tests run in Node.

import type { Task, TaskStatus, TaskView } from '../../shared/model/tasks.ts';

/** The stored states; "Working" is a live run (TaskView.running), "Paused" a wait on the person (isPaused). An unknown state (a newer PC's) shows as it is. */
export const STATUS_LABELS: Record<TaskStatus, string> = { open: 'Open', waiting: 'Waiting', done: 'Done', dropped: 'Dropped' };

// ------------------------------------------------------------------ progress, steps

export function progressLabel(progress: { done: number; total: number }): string {
  return progress.total ? `${progress.done} of ${progress.total}` : '';
}

export function progressPercent(progress: { done: number; total: number }): number {
  return progress.total ? Math.round((Math.min(progress.done, progress.total) / progress.total) * 100) : 0;
}

/** A human may tick steps that are theirs (T14); agents' steps show their state only. */
export function canToggleStep(step: Pick<Task, 'assigneeKind' | 'status'>): boolean {
  return step.assigneeKind === 'human' && step.status !== 'dropped';
}

/** Steps in checklist order. */
export function orderedSteps<T extends Pick<Task, 'sort' | 'createdAt'>>(steps: T[]): T[] {
  return steps.slice().sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

/** Replaces one step inside its parent view and recomputes the progress. */
export function withStep(parent: TaskView, step: Task): TaskView {
  const known = parent.steps.some((entry) => entry.id === step.id);
  const steps = known ? parent.steps.map((entry) => (entry.id === step.id ? step : entry)) : [...parent.steps, step];
  return { ...parent, steps, progress: { done: steps.filter((entry) => entry.status === 'done').length, total: steps.length } };
}

export function withoutStep(parent: TaskView, stepId: string): TaskView {
  const steps = parent.steps.filter((entry) => entry.id !== stepId);
  return { ...parent, steps, progress: { done: steps.filter((entry) => entry.status === 'done').length, total: steps.length } };
}
