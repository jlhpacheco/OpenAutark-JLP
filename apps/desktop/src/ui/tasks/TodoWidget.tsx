// A to-do's tool in its detail (owner 19.11.2026: "direkt in den Task arbeiten"): the widget the asker chose from the
// catalog – record audio or video (the big teleprompter only while recording, tasks.css), upload, choice, form,
// confirm, checklist, review, timer – through the chat's own AskBlock, an agent's mini-app (AppTodo.tsx), "Open
// browser" for a browser agent's confirm (BrowserTodo.tsx), else one "Done"; a finished one says when. "Can't do…"
// replaces it with one line why (the asker hears it). F07 take guard: while its recorder records or holds an unsent
// take, closing the detail, declining or removing asks "Discard recording?" first.
// Owns: the tool's body, the reason line, the take guard and the menu's handlers. Never: the detail's frame.

import { useEffect, useState } from 'preact/hooks';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { newId } from '../../shared/ids.ts';
import { AskBlock } from '../blocks/AskBlock.tsx';
import { targetKey } from '../blocks/ask.ts';
import { discardTake, heldTakes } from '../blocks/ui/media-devices.ts';
import { dayZone } from '../lib/day-store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, confirm } from '../lib/ui.tsx';
import { AppTodoBody } from './AppTodo.tsx';
import { BrowserTodo, BrowserTodoNote, handBackQuietly, useBrowserTodo } from './BrowserTodo.tsx';
import { applyTask, decline, removeOwn } from './page-actions.ts';
import { declining, openDetail, renaming, type PageScope } from './page-state.ts';
import { withoutRepeat } from './repeats-title.ts';
import { askTargetOf, todoLabel } from './todo-model.ts';
import type { TodoMenuHandlers } from './todo-menu.ts';
import { doneText } from './when-text.ts';

/** The record widget's draft key behind a to-do (AskBlock keys its widget by the target). */
export function takeKeyOf(task: Pick<Task, 'id'>): string {
  return targetKey(askTargetOf(task));
}

/** F07: this to-do's recorder is recording or holds an unsent take. */
export function holdsTake(task: Pick<Task, 'id' | 'widget'>, held: ReadonlySet<string> = heldTakes.value): boolean {
  return task.widget?.type === 'record' && held.has(takeKeyOf(task));
}

const DISCARD_TAKE = { title: 'Discard recording?', body: 'It has not been sent yet.', confirmLabel: 'Discard', danger: true };

/** Before a guarded to-do's detail closes, or it is declined or removed: "Discard recording?" – the take goes then. */
export async function letGoOfTake(task: Pick<Task, 'id' | 'widget'>): Promise<boolean> {
  if (!holdsTake(task)) return true;
  const ok = await confirm(DISCARD_TAKE);
  if (ok) discardTake(takeKeyOf(task));
  return ok;
}

/** "Mark done" on a mini-app to-do: told apart from a real wf.complete result (the takes the app registered still go, X03). */
const MARKED_DONE_ANSWER = { done: true, manual: true, note: 'Marked done by hand (not finished in the app)' };

/** What the menu's settling items do for `task` on a page. */
export function todoHandlers(task: Task, scope: PageScope): TodoMenuHandlers {
  return {
    onDecline: () => { declining.value = task.id; openDetail(scope, task.id); },
    onMarkDone: () => void (async () => {
      try { applyTask(await rpc.call('tasks.finish', { id: task.id, answer: MARKED_DONE_ANSWER, clientId: newId('up') })); handBackQuietly(task.id); } catch (error) { toastError(error, 'Could not complete'); }
    })(),
    onRemove: () => void letGoOfTake(task).then((ok) => (ok ? removeOwn(task) : undefined)),
    onRename: () => { renaming.value = task.id; openDetail(scope, task.id); },
  };
}

/** "Can't do…": one line why (optional), in place of the tool; the asker hears it. */
function DeclineReason(props: { task: Task; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (busy || !(await letGoOfTake(props.task))) return;
    setBusy(true);
    if (await decline(props.task, reason.trim())) { handBackQuietly(props.task.id); props.onClose(); } else setBusy(false);
  };
  return (
    <form class="todo-tool todo-decline" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input class="input" type="text" value={reason} maxLength={500} autoFocus disabled={busy}
        placeholder="Why not? (optional)" aria-label="Why you can't do this"
        onInput={(event) => setReason((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Escape') props.onClose(); }} />
      <div class="w-actions">
        <Button type="submit" variant="primary" busy={busy}>Send</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>Cancel</Button>
      </div>
    </form>
  );
}

/** A to-do without a widget: one "Done". */
function PlainDone(props: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try { applyTask(await rpc.call('tasks.finish', { id: props.task.id, clientId: newId('up') })); } catch (error) { toastError(error, 'Could not complete'); }
    setBusy(false);
  };
  return <div class="w-actions"><Button variant="primary" busy={busy} onClick={() => void done()}>Done</Button></div>;
}

export function TodoWidget(props: { task: TaskView; now: number }) {
  const { task } = props;
  const browser = useBrowserTodo(task);
  const reason = declining.value === task.id;
  const finished = task.status === 'done' || task.status === 'dropped';
  useEffect(() => { if (finished) handBackQuietly(task.id); }, [finished, task.id]);
  if (task.assigneeKind !== 'human') return null; // an agent's to-do: its thread says how it goes
  if (finished) {
    const when = task.completedAt ? doneText(task.completedAt, props.now, dayZone.value) : 'done';
    return <p class="todo-tool todo-finished">{task.status === 'dropped' ? 'Dropped' : `${when[0].toUpperCase()}${when.slice(1)}`}{task.result?.summary ? ` · ${task.result.summary}` : ''}</p>;
  }
  if (reason) return <DeclineReason task={task} onClose={() => { declining.value = null; }} />;
  const app = appWidgetOf(task.widget);
  return (
    <div class={`todo-tool${!task.widget || task.widget.type === 'confirm' ? ' plain' : ''}`}>
      {browser ? <BrowserTodo task={task} target={browser} /> : <BrowserTodoNote task={task} />}
      {app ? <AppTodoBody task={task} widget={app} />
        : task.widget
          ? <AskBlock block={withoutRepeat(task.widget, todoLabel(task))} target={askTargetOf(task)} bare authorId={task.createdBy} onAnswered={() => handBackQuietly(task.id)} />
          : <PlainDone task={task} />}
    </div>
  );
}
