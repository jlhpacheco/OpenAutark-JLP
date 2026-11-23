// The ONE menu of a task (a quest on the Tasks page – its detail and its row in the quest column –, the task bubble in a
// chat): Open (not where it is open already) · Open in chat · Rename… (its detail with the caret in the title) · Give
// to… (me, "Team – Autark picks", the agents and – in the owner's session – the people; tasks.give) · Resume · Done ·
// Reopen · Drop · Delete. Closing a quest (Done or Drop) ends its open to-dos with it – the confirmation says how many.
// Owner 19.11.2026: "zum Erstellen, zum Löschen". Text only.
// Owns: which items a task offers and what each one sends. Never: draws the menu (lib/context-menu.tsx) or settles an
// agent's to-do as verified (Done is the person's own work, or closing a quest).

import type { MenuSection } from '../lib/popover.tsx';
import type { TaskView } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { confirm } from '../lib/dialog.tsx';
import { rpc } from '../lib/rpc.ts';
import { agents, removeById, tasks, todos } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { recipientGroups } from './center-model.ts';
import { recipientPeople } from './RecipientMenu.tsx';
import { canOpenChat, openTaskDetail, openTaskInChat } from './jump.ts';
import { applyTask } from './page-actions.ts';
import { closeDetail, openDetail, renaming, selected, type PageScope } from './page-state.ts';
import { isFinished, ownerOf } from './work-model.ts';
import { canResume } from './waiting.ts';

async function run(call: () => Promise<TaskView | void>, failTitle: string): Promise<void> {
  try {
    const view = await call();
    if (view) applyTask(view);
  } catch (error) {
    toastError(error, failTitle);
  }
}

/** A quest's open to-dos (they end with it). */
function openTodos(task: TaskView): number {
  return task.kind === 'quest' ? (task.steps ?? []).filter((step) => !isFinished(step.status)).length : 0;
}

const noun = (task: TaskView) => (task.kind === 'quest' ? 'quest' : 'task');
const endsToo = (task: TaskView) => { const open = openTodos(task); return open ? ` Its ${open === 1 ? 'open to-do ends' : `${open} open to-dos end`} with it.` : ''; };

async function finishTask(task: TaskView, status: 'done' | 'dropped'): Promise<void> {
  const ask = status === 'dropped' || openTodos(task) > 0;
  if (ask && !(await confirm({ title: status === 'done' ? `Close this ${noun(task)} as done?` : `Drop this ${noun(task)}?`, body: `${task.title}.${endsToo(task)}`, confirmLabel: status === 'done' ? 'Done' : `Drop ${noun(task)}` }))) return;
  await run(() => rpc.call('tasks.finish', { id: task.id, ...(status === 'dropped' ? { status } : {}), clientId: newId('up') }), status === 'done' ? 'Could not complete' : 'Could not drop it');
}

async function deleteTask(task: TaskView): Promise<void> {
  const body = task.kind === 'quest' ? 'The quest and its to-dos are removed.' : task.conversationId ? 'The task message and its steps are removed from the chat.' : 'The task and its steps are removed.';
  if (!(await confirm({ title: `Delete this ${noun(task)}?`, body, confirmLabel: 'Delete', danger: true }))) return;
  await run(async () => {
    await rpc.call('tasks.delete', { id: task.id });
    removeById(tasks, task.id);
    removeById(todos, task.id);
    for (const scope of ['main', 'pane'] as const) if (selected(scope) === task.id) closeDetail(scope);
  }, 'Could not delete');
}

const give = (task: TaskView, to: string) => run(() => rpc.call('tasks.give', { id: task.id, to }), 'Could not give it');

/**
 * "Give to…" for every unfinished task: me, "Team – Autark picks" one owner now, then the agents and – in the owner's
 * session – the active people; the current owner is left out.
 */
function giveTo(task: TaskView): MenuSection[] {
  if (isFinished(task.status)) return [];
  const owner = ownerOf(task);
  const mine = owner.kind === 'human';
  const groups = recipientGroups(agents.value, recipientPeople(true));
  const current = (id: string) => 'id' in owner && owner.id === id;
  const pick = (list: ReadonlyArray<{ label: string; hint?: string; target: { kind: string; id: string } }>) => list
    .filter((recipient) => recipient.target.kind === 'agent' || recipient.target.kind === 'person')
    .filter((recipient) => !current(recipient.target.id))
    .map((recipient) => ({ label: recipient.label, hint: recipient.hint, onSelect: () => void give(task, recipient.target.id) }));
  const sections: MenuSection[] = [
    { title: 'Give to…', items: [
      ...(mine ? [] : [{ label: 'Me', onSelect: () => void give(task, 'human') }]),
      { label: 'Team – Autark picks', onSelect: () => void give(task, 'team') },
      ...pick(groups.agents),
    ] },
    { title: 'People', items: pick(groups.people) },
  ];
  return sections.filter((section) => section.items.length > 0);
}

/** `scope`: the Tasks page the menu opens on (its detail opens there; "Open" is left out – a click opens it). */
export function taskMenu(task: TaskView, scope?: PageScope): MenuSection[] {
  const finished = isFinished(task.status);
  const mine = ownerOf(task).kind === 'human';
  const open = (id: string) => (scope ? openDetail(scope, id) : openTaskDetail(id));
  const reopen = () => void run(() => rpc.call('tasks.update', { id: task.id, patch: { status: 'open' } }), 'Could not reopen');
  return [
    { items: [
      ...(scope ? [] : [{ label: 'Open', onSelect: () => openTaskDetail(task.id) }]),
      ...(canOpenChat(task.conversationId) ? [{ label: 'Open in chat', onSelect: () => openTaskInChat(task) }] : []),
      { label: 'Rename…', onSelect: () => { renaming.value = task.id; open(task.id); } },
    ] },
    ...giveTo(task),
    { items: [
      ...(canResume(task) ? [{ label: 'Resume', onSelect: () => void run(() => rpc.call('tasks.update', { id: task.id, patch: { status: 'open' } }), 'Could not resume') }] : []),
      ...(!finished && (task.kind === 'quest' || (mine && !task.widget)) ? [{ label: 'Done', onSelect: () => void finishTask(task, 'done') }] : []),
      ...(finished ? [{ label: 'Reopen', onSelect: reopen }] : [{ label: 'Drop', onSelect: () => void finishTask(task, 'dropped') }]),
      { label: 'Delete', danger: true, onSelect: () => void deleteTask(task) },
    ] },
  ];
}
