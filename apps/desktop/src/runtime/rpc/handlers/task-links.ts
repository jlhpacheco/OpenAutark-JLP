// RPC handler: "Share to chat…" (tasks.share, B-054, shared/api/methods-task-links.ts) – registered by handlers/tasks.ts:
// the person posts a live reference (a kind 'task' message, no text) of the task into an open chat ("Only me" ones too:
// the mark says who does it, it hides nothing).
// Owns: param checks. Never: changes the task, or moves it to a chat.

import '../../../shared/api/methods-task-links.ts'; // the method shape (module augmentation)
import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { SystemChat } from '../../../shared/model/chat.ts';
import type { TaskView } from '../../../shared/model/tasks.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { id, input, notFound, onlyKeys, optText } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const TASKS = { capability: 'tasks' } as const;
/** The app-owned chats that held task records before B-054: inert, never shown as a place of a task. */
const ANCHOR_CHATS: ReadonlySet<SystemChat> = new Set<SystemChat>(['todo', 'inbox']);

/** "Share to chat…": a reference into `conversationId` (the kind 'task' message). */
function share(services: RuntimeServices, task: TaskView, conversationId: string, clientId: string | undefined) {
  const chat = services.chats.get(conversationId) ?? notFound('Chat', { conversationId });
  if (chat.archivedAt !== undefined || (chat.settings.system && ANCHOR_CHATS.has(chat.settings.system))) {
    throw new WorkforceError('bad_request', 'Choose an open chat to share this task in.', { details: { conversationId } });
  }
  return services.chats.send({
    conversationId: chat.id, body: task.title, kind: 'task', taskId: task.id, authorId: HUMAN_ID, authorKind: 'human',
    ...(clientId ? { clientId } : {}),
  });
}

/** Registers tasks.share; `taskOf` is tasks.ts's owner-visible task lookup. */
export function registerTaskLinks(table: HandlerTable, taskOf: (services: RuntimeServices, taskId: string) => TaskView): void {
  table.add('tasks.share', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'conversationId', 'clientId']);
    const task = taskOf(ctx.services, id(o));
    return share(ctx.services, task, id(o, 'conversationId'), optText(o, 'clientId', { max: 100 }));
  }, TASKS);
}
