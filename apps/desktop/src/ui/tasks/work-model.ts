// The owner rules every task surface shares (re-exported by tasks/model.ts): who owns a task (an agent, the person, a
// colleague, nobody yet), the owner filter of an agent's page and of "At work" (?owner=), which tasks count as the
// team's work rather than the viewer's own to-dos (Team's activity counts), when a finished task finished, and what a
// result's evidence chip opens (B-080).
// Owns: these rules. Never: imports the store, rpc or the DOM, or reads a clock – callers pass data and the time in.

import { isFinished, type Task } from '../../shared/model/tasks.ts';
import { onForYouList } from '../../shared/model/todo-later.ts';

export { isFinished };

export function finishedAt(task: Pick<Task, 'completedAt' | 'updatedAt'>): number { return task.completedAt ?? task.updatedAt; }

/** F-52: 'person' – another human of the organisation (on a person's device the CEO is the person 'owner'). */
export type Owner = { kind: 'team' } | { kind: 'agent'; id: string } | { kind: 'human' } | { kind: 'person'; id: string };

export function ownerOf(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): Owner {
  if (task.assigneeKind === 'human') return task.assigneeId && task.assigneeId !== 'human' ? { kind: 'person', id: task.assigneeId } : { kind: 'human' };
  if (task.assigneeKind === 'agent' && task.assigneeId) return { kind: 'agent', id: task.assigneeId };
  return { kind: 'team' };
}

/** The owner filter (?owner=, O5): 'team' (no owner), an agent or person id, or anyone (undefined). */
export function ownedBy(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, owner: string | undefined): boolean {
  return !owner || (owner === 'team' ? task.assigneeKind === 'team' : task.assigneeId === owner);
}

/** `keepOwn`: also count the viewer's own to-dos – a person's device does. */
export interface WorkScope { keepOwn?: boolean }

type Listed = Pick<Task, 'parentId' | 'assigneeKind' | 'assigneeId' | 'status' | 'waitingOn'>;

/** The team's work: top-level, and not one of the viewer's own to-dos – on their list when open (onForYouList), any finished one. */
export function onWork(task: Listed, scope: WorkScope = {}): boolean {
  if (task.parentId) return false;
  if (scope.keepOwn) return true;
  return isFinished(task.status) ? ownerOf(task).kind !== 'human' : !onForYouList(task);
}

const WEB = /^https?:\/\//i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|\/|\\\\)/i; // C:\… or C:/…, /…, \\server\…
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** B-080: what a result's evidence chip opens (ResultView.tsx) – a link, an image path, another path – or nothing (a static chip). */
export function evidenceTarget(ref: string | undefined): { kind: 'link' | 'image' | 'path'; ref: string } | undefined {
  const value = ref?.trim() ?? '';
  if (WEB.test(value)) return { kind: 'link', ref: value };
  if (!ABSOLUTE.test(value)) return undefined;
  return { kind: IMAGE.test(value) ? 'image' : 'path', ref: value };
}
