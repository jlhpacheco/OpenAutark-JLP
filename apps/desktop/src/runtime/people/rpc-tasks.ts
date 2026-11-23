// What a person's device may call, part 3: tasks. A person's For you holds their own to-dos (assigneeKind 'human',
// assigneeId = them); they read the tasks of their chats and those they own, made or gave; they create and give work
// with the one give path (tasks/give.ts) – to themselves ("me"), a colleague, the owner, "team" or an agent of their
// spaces (scope assignAgents) – where people/task-rules.ts lets them; they change, give on or drop only work that is
// theirs (they own it, made it or gave it) and finish what they own – recorded as theirs ('reported_by_human', by their
// id), never as the owner's answer or approval; a form asking for a password or key is never theirs to answer (secrets
// go into the owner's vault). Ids are seen from the person's perspective.
// tasks.quickCreate (the Tasks page's line, the to-do button): one quick task with the person's own uploads as files –
// their own to-do at once, sorted by their assistant (in a quest they read, at a time and length; "Only me": they do it,
// it is never handed to an agent) or, with Send to…, for an agent, a branch or a
// team they may give to (people/task-rules.ts decides). A quest is made with tasks.create (kind), a to-do moved into one
// or timed with tasks.update (parentId, at, minutes).
// F13: a CEO reads the company's work (people/access.ts readsTask) and changes, gives on and drops it like the owner;
// they finish as done what is not another human's to-do (people answer their own).
// Owns: these person variants. Never: the owner's handlers, or a change to work that is not theirs.

import { WorkforceError } from '../../shared/errors.ts';
import type { Person } from '../../shared/model/people.ts';
import { TASK_KINDS, type TaskFilter, type TaskStatus, type TaskView } from '../../shared/model/tasks.ts';
import type { TaskPatch } from '../tasks/service.ts';
import { formsOf } from '../secrets/capture.ts';
import { MAX_DECLINE_REASON, declineAnswer } from '../tasks/decline.ts';
import { bad, capJson, id, input, notFound, onlyKeys, optBool, optId, oneOf, optNum, optObj, optOneOf, optStrings, optText, text, type Obj } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { quickCreate } from '../tasks/quick.ts';
import { attachmentsOf } from '../rpc/handlers/chats.ts';
import { chatAccess, membership, readsTask, uploadedBy } from './access.ts';
import { realId, viewTaskFor } from './perspective.ts';
import { caller } from './rpc-base.ts';
import { mayChange } from './task-rules.ts';

const STATUSES: readonly TaskStatus[] = ['open', 'waiting', 'done', 'dropped'];
const MAX_NOTES = 50_000;
const MAX_MINUTES = 24 * 60;

function readable(ctx: HandlerContext, person: Person, taskId: string): TaskView {
  const task = ctx.services.tasks.get(taskId);
  if (!task || !readsTask(ctx.services.db, person.id, task)) notFound('Task', { taskId });
  return task!;
}

/** Work the person changes: theirs (owned, made or given by them), F13 for a CEO any work they read – else refused. */
function changeable(task: TaskView, person: Person): TaskView {
  if (person.role !== 'ceo' && !mayChange(person.id, task)) throw new WorkforceError('forbidden', 'Only your own tasks can be changed.', { details: { taskId: task.id } });
  return task;
}

/** Who `to` names in the person's view ("me", "team", the CEO, a colleague, an agent) → the stored id. */
function toOf(person: Person, o: Obj): string {
  const to = optText(o, 'to', { max: 120 }) ?? 'me';
  if (to === 'me' || to === 'team') return to === 'me' ? person.id : 'team';
  return realId(person.id, to);
}

function filterOf(person: Person, params: unknown): TaskFilter {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'status', 'assigneeKind', 'assigneeId', 'spaceId', 'search', 'includeSteps', 'limit', 'completedSince']);
  const status = optStrings(o, 'status', { maxItems: STATUSES.length, max: 20 });
  if (status?.some((value) => !(STATUSES as readonly string[]).includes(value))) bad('status', STATUSES.join(', '));
  const assigneeId = optId(o, 'assigneeId');
  return {
    conversationId: optId(o, 'conversationId'), status: status as TaskStatus[] | undefined, assigneeKind: optOneOf(o, 'assigneeKind', ['team', 'agent', 'human'] as const),
    assigneeId: assigneeId === undefined ? undefined : realId(person.id, assigneeId), search: optText(o, 'search', { max: 200, allowEmpty: true }),
    includeSteps: optBool(o, 'includeSteps'), limit: optNum(o, 'limit', { min: 1, max: 1000 }), completedSince: optNum(o, 'completedSince', { min: 0 }),
    readableByPerson: person.id,
  };
}

export function registerPersonTasks(table: HandlerTable): void {
  table.addPerson('todos.list', (params, ctx) => {
    const person = caller(ctx);
    return ctx.services.tasks.todos(optNum(input(params), 'limit', { min: 1, max: 200 }) ?? 50, person.id).map((task) => viewTaskFor(ctx.services, person.id, task));
  });
  table.addPerson('tasks.list', (params, ctx) => {
    const person = caller(ctx);
    return ctx.services.tasks.list(filterOf(person, params)).filter((task) => readsTask(ctx.services.db, person.id, task)).map((task) => viewTaskFor(ctx.services, person.id, task));
  });
  table.addPerson('tasks.get', (params, ctx) => {
    const person = caller(ctx);
    return viewTaskFor(ctx.services, person.id, readable(ctx, person, id(input(params))));
  });
  table.addPerson('tasks.create', async (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['conversationId', 'kind', 'title', 'notes', 'plan', 'to', 'at', 'minutes', 'priority', 'doneWhen', 'parentId', 'clientId']);
    const conversationId = optId(o, 'conversationId');
    const chat = conversationId ? ctx.services.chats.get(conversationId) : undefined;
    const reads = chat ? chatAccess(ctx.services.db, person.id, chat) : undefined;
    if (conversationId && !reads) notFound('Chat', { conversationId });
    if (chat && reads && !reads.member) ctx.services.chats.setMembers(chat.id, { add: [person.id] }, person.id); // F13: a CEO giving work in a company chat joins it, as when writing there
    const parentId = optId(o, 'parentId');
    if (parentId) readable(ctx, person, parentId);
    const priority = optNum(o, 'priority', { min: 0, max: 2 });
    const view = await ctx.services.tasks.createTo({
      ...(conversationId ? { conversationId } : {}), kind: optOneOf(o, 'kind', TASK_KINDS), minutes: optNum(o, 'minutes', { min: 1, max: MAX_MINUTES }),
      title: text(o, 'title', { max: 300 }), notes: optText(o, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }),
      plan: optStrings(o, 'plan', { maxItems: 20, max: 300 }), at: optNum(o, 'at', { min: 0 }),
      priority: priority === undefined ? undefined : ([0, 1, 2] as const)[priority], doneWhen: optText(o, 'doneWhen', { max: 2000, multiline: true }),
      parentId, clientId: optText(o, 'clientId', { max: 100 }), createdBy: person.id,
    }, toOf(person, o));
    return viewTaskFor(ctx.services, person.id, view);
  });
  table.addPerson('tasks.quickCreate', async (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['text', 'attachments', 'target', 'priority', 'at', 'minutes', 'quest', 'private', 'clientId']);
    const raw = optObj(o, 'target');
    if (raw) onlyKeys(raw, ['kind', 'id'], 'target');
    const kind = raw ? oneOf(raw, 'kind', ['me', 'agent', 'branch', 'team'] as const) : undefined; // a colleague: through tasks.create
    const target = kind ? { kind, id: kind === 'me' ? person.id : text(raw!, 'id', { max: 120 }) } : undefined;
    const attachments = attachmentsOf(ctx.services, o.attachments);
    if (attachments.some((file) => !uploadedBy(ctx.services.db, person.id, file.fileId))) bad('attachments', 'files you uploaded');
    const priority = optNum(o, 'priority', { min: 0, max: 2 });
    const minutes = optNum(o, 'minutes', { min: 1, max: MAX_MINUTES });
    const onlyMe = optBool(o, 'private');
    const quest = optId(o, 'quest');
    if (quest) readable(ctx, person, quest);
    const { task } = await quickCreate(ctx.services, {
      text: optText(o, 'text', { max: 8000, multiline: true, allowEmpty: true }) ?? '', attachments, ...(target ? { target } : {}),
      priority: priority === undefined ? undefined : ([0, 1, 2] as const)[priority], at: optNum(o, 'at', { min: 0 }), clientId: optText(o, 'clientId', { max: 100 }),
      ...(minutes !== undefined ? { minutes } : {}), ...(quest ? { quest } : {}), ...(onlyMe !== undefined ? { private: onlyMe } : {}),
    }, person.id);
    return { task: viewTaskFor(ctx.services, person.id, task) };
  });
  table.addPerson('tasks.update', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'rev', 'patch']);
    const task = changeable(readable(ctx, person, id(o)), person);
    const raw = input(o.patch);
    onlyKeys(raw, ['title', 'notes', 'at', 'minutes', 'priority', 'doneWhen', 'plan', 'status', 'parentId'], 'patch');
    const patch: TaskPatch = {};
    if ('title' in raw) patch.title = text(raw, 'title', { max: 300 });
    if ('notes' in raw) patch.notes = optText(raw, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }) ?? '';
    if ('at' in raw) patch.at = optNum(raw, 'at', { min: 0 }) ?? null;
    if ('minutes' in raw) patch.minutes = optNum(raw, 'minutes', { min: 1, max: MAX_MINUTES }) ?? null;
    if ('parentId' in raw) { const quest = optId(raw, 'parentId'); if (quest) readable(ctx, person, quest); patch.parentId = quest ?? null; }
    if ('priority' in raw) { const value = optNum(raw, 'priority', { min: 0, max: 2 }) ?? 0; patch.priority = ([0, 1, 2] as const)[value]; }
    if ('doneWhen' in raw) patch.doneWhen = optText(raw, 'doneWhen', { max: 2000, multiline: true });
    if ('plan' in raw) patch.plan = optStrings(raw, 'plan', { maxItems: 20, max: 300 }) ?? [];
    if (optOneOf(raw, 'status', ['open'] as const)) patch.status = 'open';
    return viewTaskFor(ctx.services, person.id, ctx.services.tasks.update(task.id, patch, person.id, optNum(o, 'rev', { min: 0 })));
  });
  table.addPerson('tasks.undo', (params, ctx) => { // 17.11.2026: takes back the latest logged change of work that is theirs (tasks/changes.ts)
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'changeId']);
    const task = changeable(readable(ctx, person, id(o)), person);
    return viewTaskFor(ctx.services, person.id, ctx.services.tasks.undo(task.id, person.id, optText(o, 'changeId', { max: 40 })));
  });
  table.addPerson('tasks.give', async (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'to', 'note']);
    const task = readable(ctx, person, id(o));
    const to = toOf(person, o);
    // their own work, or an older PC's work without an owner in a chat they are in (they take it)
    const legacy = to === person.id && task.assigneeKind === 'team' && !!task.conversationId && membership(ctx.services.db, person.id, task.conversationId) !== undefined;
    if (!legacy) changeable(task, person);
    return viewTaskFor(ctx.services, person.id, await ctx.services.tasks.give(task.id, to, person.id, { note: optText(o, 'note', { max: 4000, multiline: true }) }));
  });
  table.addPerson('tasks.finish', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'status', 'answer', 'note', 'clientId']);
    const task = readable(ctx, person, id(o));
    const status = optOneOf(o, 'status', ['done', 'dropped'] as const) ?? 'done';
    const owned = task.assigneeKind === 'human' && task.assigneeId === person.id;
    const ceo = person.role === 'ceo'; // F13: like the owner – done for anything but another human's to-do
    if (status === 'done' ? !(owned || (ceo && task.assigneeKind !== 'human')) : !(ceo || mayChange(person.id, task))) {
      throw new WorkforceError('forbidden', 'Only your own to-dos and tasks can be finished here.', { details: { taskId: task.id } });
    }
    capJson('answer', o.answer, 256 * 1024);
    const note = optText(o, 'note', { max: 2000, multiline: true });
    const clientId = optText(o, 'clientId', { max: 100 });
    if (task.widget && status === 'done') {
      // Secrets go into the owner's vault and to agents: only the owner enters them (asks for them go to the owner).
      if (formsOf(ctx.services, { taskId: task.id }).length) {
        throw new WorkforceError('forbidden', 'This form asks for a password or key. Only the owner of the organisation enters those.', { details: { taskId: task.id, reason: 'owner_secret' } });
      }
      const typed = o.answer !== undefined ? o.answer : { done: true, ...(note ? { note } : {}) };
      const view = ctx.services.tasks.answer({ taskId: task.id, answer: typed, by: person.id, clientId });
      return viewTaskFor(ctx.services, person.id, view ?? readable(ctx, person, task.id));
    }
    return viewTaskFor(ctx.services, person.id, ctx.services.tasks.finish(task.id, { status, summary: note?.trim() || (status === 'done' ? 'Done' : 'Dropped') }, person.id));
  });
  table.addPerson('todos.decline', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'reason', 'clientId']);
    const task = readable(ctx, person, id(o));
    if (task.assigneeId !== person.id || !task.widget) throw new WorkforceError('forbidden', 'Only your own to-dos can be declined.', { details: { taskId: task.id } });
    const reason = optText(o, 'reason', { max: MAX_DECLINE_REASON, allowEmpty: true });
    const view = ctx.services.tasks.answer({ taskId: task.id, answer: declineAnswer(reason), by: person.id, clientId: optText(o, 'clientId', { max: 100 }), decline: true });
    return viewTaskFor(ctx.services, person.id, view ?? readable(ctx, person, task.id));
  });
}
