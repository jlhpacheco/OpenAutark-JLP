// Owner moves of tasks:
// - an agent that is given a task joins the task's chat, so its chat tools work there – when the person, the system or a
//   member of that chat gives it; a chat-free task has no chat to join; out of a 1:1 or a chat a person is in, work
//   handed on by a member or the person moves into the giver's 1:1 with the receiver instead (chat/direct.ts
//   keepsItsMembers, routeOwner) – only the system still seats an archived agent's successor there;
// - an archived agent's unfinished tasks are given to its successor (tasks/give.ts): the agent named when it was
//   archived, else its next active manager, else a manager agent of its space, else a company-wide manager; a task of
//   the archived agent's 1:1 goes to the successor's own 1:1 with that partner. With no manager left a task waits on the
//   person;
// - the responsible manager owns work "team" could not place (tasks/give.ts pickOwner);
// - a person's Stop pauses the work on a task (waiting on them: "Paused by you"); their line in its chat, Resume, or
//   giving it on ends the pause; a line of the person or colleague a task waits on opens it (onPersonLine). The person
//   ending or removing a task stops a turn still running on it.
// Owns: picking the successor / responsible manager, moving the work's chat, and the pause rules.
// Never: archives agents (org/service.ts does, then emits 'agent.removed'), finishes a task, or hands work to an
// archived agent.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { PAUSED_REASON, isFinished, isPaused, type Task } from '../../shared/model/tasks.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { OrgService, RuntimeServices } from '../contracts.ts';
import { keepsItsMembers, workRoomFor } from '../chat/direct.ts';
import type { TaskServiceImpl } from './service.ts';
import { giveTask, nameOf, tell } from './give.ts';


type OrgView = Pick<OrgService, 'get' | 'list' | 'managers'>;

const isManager = (agent: Agent) => agent.mode === 'manager' || agent.template === 'manager';

/** Only the human, the system or a (current) member of the chat may bring an agent into it (no chat: nobody is brought in). */
export function mayBringIn(t: TaskServiceImpl, conversationId: string | undefined, by: string): boolean {
  return Boolean(conversationId) && (by === HUMAN_ID || by === SYSTEM_ID || t.s.chats.members(conversationId!).some(member => member.memberId === by));
}

/**
 * Adds a new agent owner to the task's chat. Only the human, the system or a member brings an agent in; no-op for
 * members, unknown or archived agents, assignments by outside agents and a 1:1 (B-078 D7: it stays two). Work a
 * member or the person hands on out of a chat a person is in never seats anyone – workRoomFor moves it to the giver's
 * 1:1 with the receiver, and when no room can be made the task stays in its chat with nobody seated; only the system
 * still takes a seat there (an archived agent's successor).
 */
export function joinChat(t: TaskServiceImpl, conversationId: string | undefined, agentId: string, by: string): void {
  if (!conversationId) return; // B-054: a chat-free task – nobody joins anything
  const chat = t.s.chats.get(conversationId);
  if (!chat || chat.settings.direct) return;
  if (keepsItsMembers(t.s, chat) && by !== SYSTEM_ID) return; // a chat a person is in keeps its members, also when no work room was found
  const members = t.s.chats.members(conversationId);
  if (members.some(member => member.memberId === agentId)) return;
  if (!mayBringIn(t, conversationId, by)) return;
  const agent = t.s.org?.get(agentId);
  if (t.s.org && (!agent || agent.archivedAt)) return; // assign() reports unknown agents itself
  t.s.chats.setMembers(conversationId, { add: [agentId] }, by);
}

/**
 * Who takes over an archived agent's work: its next active manager, else a manager agent of
 * its space, else one without a space, else a top-level manager of another space.
 */
export function successorFor(org: OrgView, agentId: string): Agent | undefined {
  const boss = org.managers(agentId).find(agent => agent.id !== agentId && !agent.archivedAt);
  if (boss) return boss;
  return rankedManagers(org, org.get(agentId)?.spaceId, agentId)[0];
}

/**
 * Who picks up team work in a chat without a lead (e.g. the hidden To-do chat): the manager
 * the successor ranking prefers for that space (top-level first), else a secretary, else the
 * oldest top-level agent, else any active agent. Undefined only when there is no agent at all.
 */
export function responsibleManager(org: OrgView, spaceId?: string): Agent | undefined {
  const manager = rankedManagers(org, spaceId, undefined, !spaceId)[0];
  if (manager) return manager;
  const rank = (agent: Agent) => (agent.mode === 'secretary' || agent.template === 'secretary' ? 0 : 1) * 2 + (org.managers(agent.id).length ? 1 : 0);
  return org.list()
    .filter(agent => !agent.archivedAt)
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
}

/**
 * Active managers ranked for a space: same space, no space, top-level elsewhere (shallow first
 * within a rank; `topFirst` puts the shallowest first across ranks).
 */
function rankedManagers(org: OrgView, space: string | undefined, exclude?: string, topFirst = false): Agent[] {
  return org.list()
    .filter(agent => agent.id !== exclude && !agent.archivedAt && isManager(agent))
    .map(agent => {
      const depth = org.managers(agent.id).length;
      const rank = space && agent.spaceId === space ? 0 : !agent.spaceId ? 1 : depth === 0 ? 2 : 3;
      return { agent, rank, depth };
    })
    .filter(entry => entry.rank < 3) // a sub-manager of another space is not responsible here
    .sort((a, b) => (topFirst ? a.depth - b.depth : 0) || a.rank - b.rank || a.depth - b.depth
      || a.agent.createdAt - b.agent.createdAt || a.agent.id.localeCompare(b.agent.id))
    .map(entry => entry.agent);
}

/**
 * B-078 D7: moves a task (with its steps in the same chat) into `chatId` – the receiver's work room when the task's
 * chat is a 1:1 it is not in. Its anchor message stays where the work was handed over; rev is bumped so a stale copy
 * cannot write over it. No event: the assign or mutate that follows announces the task.
 * B-080 (live: 14 reminder runs in a chat their agent had left): the schedules of the task and its steps that were set
 * in the task's chat move with it; one set for another chat stays where it posts. Each moved schedule is announced
 * ('schedule.upserted': the other PCs and the chat's Schedules pane follow).
 */
export function moveTaskChat(s: Pick<RuntimeServices, 'db' | 'clock'> & Partial<Pick<RuntimeServices, 'bus' | 'scheduler'>>, taskId: string, chatId: string): void {
  const moved = s.db.tx(() => {
    const where = `conversation_id = (SELECT conversation_id FROM tasks WHERE id = ?)
         AND task_id IN (SELECT id FROM tasks WHERE id = ? OR parent_id = ?)`;
    const schedules = s.db.all<{ id: string }>(`SELECT id FROM schedules WHERE ${where}`, [taskId, taskId, taskId]).map((row) => row.id);
    s.db.run(`UPDATE schedules SET conversation_id = ? WHERE ${where}`, [chatId, taskId, taskId, taskId]);
    s.db.run(
      `UPDATE tasks SET conversation_id = ?, rev = rev + 1, updated_at = ?
       WHERE id = ? OR (parent_id = ? AND conversation_id = (SELECT conversation_id FROM tasks WHERE id = ?))`,
      [chatId, s.clock.now(), taskId, taskId, taskId]);
    return schedules;
  });
  for (const id of moved) {
    const schedule = s.scheduler?.get(id);
    if (schedule) s.bus?.emit('schedule.upserted', schedule);
  }
}

/**
 * B-078 D7: brings a new agent owner to a task given by `by`: into the task's chat (joinChat), or – out of a 1:1 or a
 * chat a person is in that the agent is not in – the task moves into `by`'s own 1:1 with the agent (workRoomFor), so its wakes and answers land
 * where it is a member. Returns the chat the task is in now. For tasks/service.ts assign (before its mutate).
 */
export function routeOwner(t: TaskServiceImpl, task: Pick<Task, 'id' | 'conversationId'>, agentId: string, by: string): string | undefined {
  const chatId = task.conversationId;
  const chat = chatId ? t.s.chats.get(chatId) : undefined;
  if (chatId && chat && keepsItsMembers(t.s, chat) && mayBringIn(t, chatId, by)) {
    let room: string | undefined;
    try {
      room = workRoomFor(t.s, chatId, by, agentId);
    } catch (error) {
      t.s.log?.warn('no work room for the new owner', { taskId: task.id, error: String(error) }); // the task stays in its chat
    }
    if (room && room !== chatId) { moveTaskChat(t.s, task.id, room); return room; }
  }
  joinChat(t, chatId, agentId, by);
  return chatId;
}

/**
 * B-078 D7: where an archived agent's successor works on a task of the 1:1 the archived agent had with someone:
 * the successor's own 1:1 with that partner (chat/direct.ts workRoomFor); any other chat, or a 1:1 the successor is
 * in, stays as it is.
 */
function successorRoom(t: TaskServiceImpl, task: Task, goneId: string, successorId: string): string | undefined {
  const chatId = task.conversationId;
  const chat = chatId ? t.s.chats.get(chatId) : undefined;
  if (!chatId || !chat?.settings.direct) return chatId;
  const others = t.s.chats.members(chatId).filter((member) => member.leftAt === undefined && member.memberId !== goneId).map((member) => member.memberId);
  const partner = (chat.settings.directPair ?? others).find((id) => id !== goneId);
  if (!partner || partner === successorId) return chatId;
  try {
    return workRoomFor(t.s, chatId, partner, successorId);
  } catch (error) {
    t.s.log?.warn('no work room for the successor', { taskId: task.id, error: String(error) });
    return chatId;
  }
}

/** 'agent.removed' (and the watcher, for a task an archived agent still holds): its unfinished work goes to its successor. */
export function handOver(t: TaskServiceImpl, agentId: string): void {
  const org = t.s.org;
  const gone = org?.get(agentId);
  if (!org || !gone?.archivedAt) return;
  const owned = t.repo.openFor(agentId);
  if (!owned.length) return;
  const successor = successorFor(org, agentId);
  for (const task of owned) {
    t.s.wakes.cancel(agentId, { taskId: task.id });
    try {
      if (!successor) { waitOnPerson(t, task, gone.name); continue; }
      // a task of the archived agent's 1:1 goes to the successor's own 1:1 with that partner
      const room = successorRoom(t, task, gone.id, successor.id);
      if (room && room !== task.conversationId) moveTaskChat(t.s, task.id, room);
      giveTask(t, task.id, { kind: 'agent', id: successor.id }, SYSTEM_ID, { fact: `Taken over from ${gone.name} (archived).` });
    } catch (error) {
      t.s.log?.warn('task handover failed', { taskId: task.id, agentId, error: String(error) });
    }
  }
}

/** No manager can take it over: it waits on the person, who hears of it once. */
function waitOnPerson(t: TaskServiceImpl, task: Task, previous: string): void {
  const why = `Owner archived: ${previous}`;
  if (task.status === 'waiting' && task.waitingOn?.on === 'who' && task.waitingOn.who === HUMAN_ID && task.waitingOn.why === why) return;
  t.emit(t.mutate(task.id, (draft) => {
    draft.status = 'waiting';
    draft.waitingOn = { on: 'who', who: HUMAN_ID, why, since: t.s.clock.now() };
    draft.ledger = { ...draft.ledger, facts: [...(draft.ledger.facts ?? []), `${previous} was archived; no manager could take this over.`].slice(-20) };
  }));
  tell(t.s, HUMAN_ID, { kind: 'blocker', title: excerpt(task.title, 80), body: why, conversationId: task.conversationId, taskId: task.id });
}

/** The person stopped the work: it waits on them ("Paused by you"), quiet 'Paused' line. Undefined when nothing changed. */
export function pauseTask(t: TaskServiceImpl, id: string, by: string): Task | undefined {
  const before = t.require(id);
  if (isFinished(before.status) || isPaused(before)) return undefined;
  const since = t.s.clock.now();
  const task = t.mutate(id, (draft) => {
    draft.status = 'waiting';
    draft.waitingOn = { on: 'who', who: by === SYSTEM_ID ? HUMAN_ID : by, why: PAUSED_REASON, since };
  });
  for (const agentId of new Set([before.assigneeId].filter((id): id is string => Boolean(id)))) t.s.wakes.cancel(agentId, { taskId: id });
  t.line(task, { type: 'note', text: `Paused:${excerpt(task.title, 60)}`, details: { taskId: id, status: task.status } }, by);
  return task;
}

/** Ends a pause: open again, its owner hears it and goes on. Undefined when not paused. */
export function resumeTask(t: TaskServiceImpl, id: string, by: string): Task | undefined {
  const before = t.require(id);
  if (!isPaused(before)) return undefined;
  const now = t.s.clock.now();
  const task = t.mutate(id, (draft) => {
    draft.status = 'open';
    delete draft.waitingOn;
    draft.ledger = { ...draft.ledger, movedAt: now };
  });
  t.line(task, { type: 'note', text: `Resumed:${excerpt(task.title, 60)}`, details: { taskId: id, status: task.status } }, by);
  if (task.assigneeKind === 'agent' && task.assigneeId && by !== task.assigneeId) {
    tell(t.s, task.assigneeId, { reason: 'task', taskId: id, conversationId: task.conversationId, note: `${nameOf(t.s, by)} resumed my task "${excerpt(task.title, 120)}".` });
  }
  return task;
}

/**
 * 'message.created': a typed line of the person (or a colleague) in a chat ends the pause of the work there they paused.
 * An answer resumes only the task its ask belongs to. A scheduled or quiet line changes nothing. (Their line opens agent
 * work that waits on them where it is delivered: chat/delivery-route.ts.)
 */
export function onPersonLine(t: TaskServiceImpl, message: Message): void {
  if (message.silent || message.authorKind !== 'human' || message.meta?.via === 'schedule') return;
  const author = message.authorId;
  if (author !== HUMAN_ID && !isPersonId(author)) return;
  let only: string | undefined;
  if (message.kind === 'answer') {
    const todoId = message.meta?.answer?.taskId ?? message.taskId;
    const todo = todoId ? t.repo.get(todoId) : undefined;
    if (!todo) return;
    only = todo.parentId ?? todo.id;
  } else if (message.kind !== 'text') return;
  for (const task of t.repo.list({ conversationId: message.conversationId, status: ['waiting'], includeSteps: true, limit: 50 })) {
    if (!isPaused(task) || task.waitingOn?.who !== author || (only !== undefined && task.id !== only)) continue;
    try { t.resume(task.id, author); } catch (error) {
      t.s.log?.warn('resuming a paused task failed', { taskId: task.id, error: String(error) });
    }
  }
}

/** The person ended a task (drop, finish, remove): a turn still running on it stops now, its split groups too. */
export function stopRuns(t: TaskServiceImpl, task: Task, by: string): void {
  const dispatcher = t.s.dispatcher;
  if (by !== HUMAN_ID || task.parentId || typeof dispatcher?.activity !== 'function') return;
  try { (t.s as Partial<Pick<RuntimeServices, 'splits'>>).splits?.stop({ taskId: task.id }, by); } catch (error) { t.s.log?.warn('stopping the task\'s splits failed', { taskId: task.id, error: String(error) }); }
  let running: Array<{ agentId: string; conversationId?: string }>;
  try { running = dispatcher.activity().filter(run => run.taskId === task.id); } catch { return; }
  for (const run of running) {
    dispatcher.interrupt(run.agentId, run.conversationId).catch((error: unknown) => {
      t.s.log?.warn('stopping the task turn failed', { taskId: task.id, agentId: run.agentId, error: String(error) });
    });
  }
}
