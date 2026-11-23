// Words about a task for notes, lines and the agents' task texts: who gave it (giverOf), the names a note uses
// (namesFor – the owner's profile name, a colleague's, an agent's) and what a wait waits on (waitWords).
// Owns: those small reads. Never: wakes anyone or writes a task.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';

/** Who gave the task (the last giver, else its maker). */
export function giverOf(task: Pick<Task, 'createdBy' | 'assignedBy'>): string {
  return task.assignedBy ?? task.createdBy;
}

export interface NoteNames { nameOf(id: string): string; zone: string }

/** What a waiting task waits on, in words ("Felix", "2 tasks", "something outside"). */
export function waitWords(task: Pick<Task, 'waitingOn'>, names: Pick<NoteNames, 'nameOf'>): string {
  const wait = task.waitingOn;
  if (!wait) return 'nothing';
  if (wait.on === 'who') return wait.who ? names.nameOf(wait.who) : 'someone';
  if (wait.on === 'task') return `${wait.ids?.length ?? 0} task${wait.ids?.length === 1 ? '' : 's'}`;
  return 'something outside';
}

/** The person's name for notes: the owner's own name, a colleague's, an agent's (HUMAN_ID → the profile name). */
export function namesFor(s: Pick<RuntimeServices, 'org' | 'settings'> & Partial<Pick<RuntimeServices, 'people'>>, zone: string): NoteNames {
  const owner = (() => { try { return s.settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; } })();
  return {
    zone,
    nameOf: (id: string) => id === HUMAN_ID ? owner : id.startsWith('per_') ? s.people?.nameOf(id) ?? 'a colleague' : s.org?.get(id)?.name ?? id,
  };
}
