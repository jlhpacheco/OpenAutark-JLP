// The one intake of a person's line (Quests round 20.11.2026, tasks.quickCreate – the Tasks page's line, a clicked calendar
// slot, the phone's to-do button, the float bar, a colleague's device): what they typed or said stands at once as their own
// chat-free to-do (title = first line, notes = the rest – todo-draft.ts –, a plain "Done" widget, the files kept on its
// row) – in the quest they picked, at the time they confirmed (`at`/`minutes`; the UI cut that phrase from the text). Their
// assistant (day/assistant.ts) is woken once with the line, the times in it they did not confirm and the open work it is
// about, and sorts it: who does what (the person, an agent, or both as two to-dos in one quest), which quest, the time
// when one is open – each change one event line in the to-do's thread. "Only me" (owner 20.11.: "this one needs me", not
// privacy – `private` on the row; the line's own choice, else Settings › day.aiHelps off) stays the person's: the assistant
// sorts it into a quest or sets its time and never hands it on. A retried post (same
// clientId) answers the first to-do and wakes nobody again.
// Send to…: a line with a `target` other than "me" is handed straight to that agent, branch, team or person (handOver) –
// then it goes with `target`, `priority`, `spaceId`, the picked quest and its files; a time and length go with it to a
// colleague, and into the notes of agent work (agent work has no `at`).
// Owns: that flow and the "Only me" default. Never: gives the line to anyone but the person (outside Send to…), guesses a
// time or a widget, or calls a model.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import type { CreateTaskInput, TaskView } from '../../shared/model/tasks.ts';
import type { QuickTaskParams, QuickTaskResult } from '../../shared/model/task-center.ts';
import type { RuntimeServices } from '../contracts.ts';
import { wakeAssistant } from '../day/assistant.ts';
import { dayZone } from '../day/clock.ts';
import { todoWhen } from '../context/time.ts';
import { directChat } from '../people/direct-chat.ts';
import type { CreateOptions } from './create.ts';
import { TaskRepo } from './repo.ts';
import { restNotes } from './todo-draft.ts';

export const MAX_QUICK_TEXT = 8000;

type Deps = Pick<RuntimeServices, 'db' | 'clock' | 'chats' | 'tasks' | 'org' | 'wakes'> & Partial<Pick<RuntimeServices, 'settings' | 'people' | 'log'>>;
/** The line as the service gets it: the files already resolved to stored attachments. */
export type QuickInput = Omit<QuickTaskParams, 'attachments'> & { attachments?: Attachment[] };
type CreatingTasks = {
  create(input: CreateTaskInput & { createdBy: string }, options?: CreateOptions): TaskView;
  createTo(input: Omit<CreateTaskInput, 'assigneeKind' | 'assigneeId'> & { createdBy: string }, to: string, options?: CreateOptions & { team?: string }): Promise<TaskView>;
};

/** The files a to-do was posted with (its row's files; empty for any other task). */
export function quickFiles(db: Deps['db'], taskId: string): Attachment[] {
  try { return new TaskRepo(db).get(taskId)?.files ?? []; } catch { return []; }
}

/** tasks.quickCreate: the person's line as their own to-do now, their assistant told (see the header). */
export async function quickCreate(s: Deps, input: QuickInput, by: string): Promise<QuickTaskResult> {
  const text = input.text.trim();
  const attachments = input.attachments ?? [];
  if (!text && !attachments.length) throw new WorkforceError('bad_request', 'Type what should be done.');
  if (text.length > MAX_QUICK_TEXT) throw new WorkforceError('bad_request', 'That is too long for one to-do.');
  const clientId = input.clientId ? `qt:${by}:${input.clientId}` : undefined;
  const sent = clientId ? new TaskRepo(s.db).byClientId(clientId) : undefined;
  if (sent) return { task: s.tasks.get(sent.id) ?? (sent as TaskView) };
  const title = excerpt(text.split(/\r?\n/)[0].trim() || attachments[0]?.name || 'Files', 120);
  const notes = text ? restNotes(text, title) : '';
  if (input.target && input.target.kind !== 'me') return { task: await handOver(s, input, { title, notes, attachments, clientId }, by) };
  const onlyMe = input.private ?? !aiHelps(s); // the line's own choice wins (the UI always sends it)
  const task = (s.tasks as unknown as CreatingTasks).create({
    origin: ORIGINS.todoList, title, notes, widget: { type: 'confirm', instructions: title },
    assigneeKind: 'human', ...(isPersonId(by) ? { assigneeId: by } : {}), createdBy: by,
    ...(input.at !== undefined ? { at: input.at } : {}), ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
    ...(input.quest ? { parentId: input.quest } : {}), ...(onlyMe ? { private: true } : {}), ...(attachments.length ? { files: attachments } : {}),
  }, clientId ? { clientId } : {});
  const assistantId = wakeAssistant(s, isPersonId(by) ? by : HUMAN_ID, [{ taskId: task.id, text, timed: input.at !== undefined }], 'tasks.quickCreate');
  return { task: s.tasks.get(task.id) ?? task, ...(assistantId ? { assistantId } : {}) };
}

/** "Only me" by default is off while the assistant helps with the lines (Settings › day.aiHelps, default on; unreadable: on). */
function aiHelps(s: Deps): boolean {
  try { return daySettingsOf(s.settings?.get()).aiHelps; } catch { return true; }
}

/** Send to… (see the header): the person's pick – an agent, a manager's branch, a team or (the owner's) a colleague in their 1:1. */
async function handOver(s: Deps, input: QuickInput, line: { title: string; notes: string; attachments: Attachment[]; clientId?: string }, by: string): Promise<TaskView> {
  const tasks = s.tasks as unknown as CreatingTasks;
  const target = input.target!;
  const options = line.clientId ? { clientId: line.clientId } : {};
  const fields = { title: line.title, notes: line.notes, createdBy: by, ...(input.priority !== undefined ? { priority: input.priority } : {}), ...(input.quest ? { parentId: input.quest } : {}) };
  if (target.kind === 'person') {
    const person = target.id.trim();
    const when = { ...(input.at !== undefined ? { at: input.at } : {}), ...(input.minutes !== undefined ? { minutes: input.minutes } : {}) };
    const files = line.attachments.length ? { files: line.attachments } : {};
    return tasks.createTo({ ...fields, ...when, ...files, conversationId: directChat(s, HUMAN_ID, person) }, person, { ...options, anchorWith: { authorId: HUMAN_ID, attachments: line.attachments } });
  }
  // Agent work has no time of its own: the one the person gave stays in the notes, with whose it is.
  const given = input.at !== undefined ? `Time the person gave it: ${todoWhen({ at: input.at, ...(input.minutes !== undefined ? { minutes: input.minutes } : {}) }, dayZone(s), s.clock.now())}` : '';
  const own = { ...fields, notes: [line.notes, given].filter(Boolean).join('\n\n'), origin: ORIGINS.intake, ...(input.spaceId ? { spaceId: input.spaceId } : {}), ...(line.attachments.length ? { files: line.attachments } : {}) };
  if (input.spaceId && !s.org.spaces().some((space) => space.id === input.spaceId)) throw new WorkforceError('not_found', 'Space not found.', { details: { spaceId: input.spaceId } });
  if (target.kind === 'team') return tasks.createTo(own, 'team', { ...options, team: target.id });
  const agent = s.org.get(target.id);
  if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: target.id } });
  return tasks.createTo(own, agent.id, options);
}
