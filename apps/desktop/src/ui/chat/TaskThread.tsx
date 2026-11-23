// A task's own thread in its detail (Quests 20.11.2026, owner: "pro einzelnen Task einen Chat …, also einen Verlauf"):
// the person's and the AI's lines about this quest or to-do and its quiet event lines (given, waiting, done … – status
// lines, drawn small), with the chat's composer as one slim line ("Write to <lead> about this…" – dictation, files,
// recordings) and the live bar of whoever works there.
// It makes sure the thread exists – chats.thread with the task's id, found or made (runtime/tasks/thread.ts) – and shows
// it with ThreadPanel.tsx (loads the page, keeps its topic while shown, marks it read).
// Owns: that hand-over. Never: places itself in a page (the task detail does) or draws a line itself.

import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { conversationMap, conversations, upsertById } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { toastError } from '../lib/toasts.ts';
import { ThreadPanel } from './ThreadPanel.tsx';

export function TaskThread(props: { taskId: string }) {
  const { taskId } = props;
  const failed = useSignal<string | null>(null);

  useEffect(() => {
    let shown = true;
    rpc.call('chats.thread', { taskId }).then((thread) => { if (shown) upsertById(conversations, thread); }, (error: unknown) => {
      if (!shown) return;
      failed.value = taskId;
      toastError(error, 'The history of this task could not be opened');
    });
    return () => { shown = false; };
  }, [taskId]);

  if (conversationMap.value.has(taskId)) return <div class="task-thread"><ThreadPanel threadId={taskId} slim /></div>;
  return <div class="task-thread">{failed.value === taskId ? <EmptyState>No history here.</EmptyState> : <Spinner />}</div>;
}
