// A task's thread (Quests round 20.11.2026, owner: "pro einzelnen Task einen Chat …, also einen Verlauf"): the history of
// one quest or to-do – a conversation whose id IS the task id (`task_…`), so an agent writes there with
// <chat to="task_…"> and its lines arrive labelled with that id. Made on demand – the first time someone writes there, an
// event line is posted or the person opens the task; two PCs that make it write the same id (sync merges the rows).
// Members: the people the task concerns (its owner, maker or giver when that is a person, and the people of the chat it
// was handed over in who read it), its owner as lead when that is an agent, and the agents that made or gave it; a
// person's to-do that names no agent at all has that person's assistant (day/assistant.ts) as lead, so their line there
// reaches someone (R2.1) – an "Only me" one too: it is theirs to do, and the AI helps around it; an agent joins when it
// writes there. Every later call adds who is missing and makes the current owner lead (after a give) – quietly; nobody is
// removed. Whoever joins later reads its whole history (settings.history 'full') – but a person's line quoted there from
// a chat the joining person does not read keeps only its link (keepQuotesFor). It is no list row
// (chat/conversation-repo.ts list skips `task_…` ids) and is named by its task (chat/titles.ts); a person's line there
// wakes the task's owner with the task (chat/delivery-route.ts). Event lines (given, waiting, done, closed …) are quiet
// status lines: no wake, no push, drawn small.
// Owns: finding and making a task's thread, its members and lead, its event lines, which of its quoted lines a person
// reads, which threads hold news for a person, and removing a task's thread. Never: changes the task or takes anyone out
// of its thread.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { Conversation, Message, StatusLine } from '../../shared/model/chat.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import { chatAccess, readsTask } from '../people/access.ts';
import { activePerson } from '../people/repo.ts';
import { personalAssistant } from '../day/assistant.ts';

type ThreadDeps = Pick<RuntimeServices, 'db' | 'chats' | 'tasks'> & Partial<Pick<RuntimeServices, 'org' | 'log'>>;

/** The owner, or a colleague still in the organisation. */
const isPerson = (s: ThreadDeps, id: string | undefined): id is string => id === HUMAN_ID || (id !== undefined && isPersonId(id) && Boolean(activePerson(s.db, id)));

/** An active agent of the org (never the person, a colleague, the system or a bridged contact). */
function isAgent(s: ThreadDeps, id: string | undefined): id is string {
  if (id === undefined || id === HUMAN_ID || id === SYSTEM_ID || isPersonId(id) || id.startsWith('ext:')) return false;
  const agent = s.org?.get(id);
  return agent !== undefined && !agent.archivedAt;
}

/** The people the task concerns: its owner, maker or giver when a person, and its chat's people who read it. */
function peopleOf(s: ThreadDeps, task: Task): string[] {
  const parties = [task.assigneeKind === 'human' ? task.assigneeId ?? HUMAN_ID : undefined, task.createdBy, task.assignedBy].filter((id) => isPerson(s, id));
  const chat = task.conversationId ? s.chats.members(task.conversationId) : [];
  const readers = chat.filter((member) => member.kind === 'human' && !member.leftAt && isPerson(s, member.memberId)
    && (member.memberId === HUMAN_ID || readsTask(s.db, member.memberId, task))).map((member) => member.memberId);
  return [...new Set([...parties, ...readers])];
}

/**
 * The agents of the thread – its owner (the lead), the ones that gave or made it, and `joining` – and its lead. A person's
 * to-do none of them is an agent of gets that person's assistant as lead.
 */
function agentsOf(s: ThreadDeps, task: Task, joining?: string): { agents: string[]; lead?: string } {
  const owner = task.assigneeKind === 'agent' && isAgent(s, task.assigneeId) ? task.assigneeId : undefined;
  const agent = (id: string | undefined): id is string => isAgent(s, id);
  const parties = [owner, task.assignedBy, task.createdBy].filter(agent);
  const helper = !parties.length && task.assigneeKind === 'human' && s.org ? personalAssistant({ org: s.org }, task.assigneeId ?? HUMAN_ID)?.id : undefined;
  const agents = [...parties, helper, joining].filter(agent);
  const lead = owner ?? agents[0]; // a party, else the assistant, else the one joining
  return { agents: [...new Set(agents)], ...(lead ? { lead } : {}) };
}

/**
 * The thread of task `taskId`, found or made now (see the header). `by` opens it: an agent, or a colleague who reads the
 * task, joins it; an unknown task – or one the colleague does not read – is 'not_found'.
 */
export function threadOf(s: ThreadDeps, taskId: string, by: string = SYSTEM_ID): Conversation {
  const task = s.tasks.get(taskId);
  if (!task) throw new WorkforceError('not_found', `Task ${taskId} not found.`, { details: { taskId } });
  const agentBy = isAgent(s, by) ? by : undefined;
  if (isPersonId(by) && !readsTask(s.db, by, task)) throw new WorkforceError('not_found', 'Task not found.', { details: { taskId } });
  const people = [...new Set([...peopleOf(s, task), ...(isPersonId(by) ? [by] : [])])];
  const { agents, lead } = agentsOf(s, task, agentBy);
  const found = s.chats.get(taskId);
  if (found) {
    settle(s, found, [...people, ...agents], lead, by);
    return s.chats.get(taskId) ?? found;
  }
  const colleagues = people.filter((id) => isPersonId(id));
  return s.chats.create({
    id: taskId, title: '', agentIds: agents, people: colleagues, createdBy: by,
    humans: people.includes(HUMAN_ID) || (!agents.length && !colleagues.length), // nobody else: the person (who reads every task)
    ...(lead ? { lead } : {}),
    ...(spaceOf(s, task) ? { spaceId: spaceOf(s, task) } : {}),
    settings: { history: 'full' },
  });
}

/** The space a chat-free task names, else its handover chat's. */
function spaceOf(s: ThreadDeps, task: Task): string | undefined {
  return task.spaceId ?? (task.conversationId ? s.chats.get(task.conversationId)?.spaceId : undefined);
}

/**
 * Adds the members `wanted` that are missing and makes `lead` the lead – quietly (the event line says it). A person who
 * joins never reads a line quoted here from a chat they do not read: that line keeps only its link (keepQuotesFor).
 */
function settle(s: ThreadDeps, chat: Conversation, wanted: string[], lead: string | undefined, by: string): void {
  const members = s.chats.members(chat.id);
  const missing = wanted.filter((id) => !members.some((member) => member.memberId === id && !member.leftAt));
  const leads = lead !== undefined && !members.some((member) => member.memberId === lead && member.role === 'lead');
  keepQuotesFor(s, chat.id, missing);
  if (missing.length || leads) s.chats.setMembers(chat.id, { add: missing, ...(lead ? { lead } : {}) }, by, { quiet: true });
}

/** The text of a person's line kept in a thread whose people do not all read the chat it was written in (its link stays). */
export const LINE_ELSEWHERE = 'Asked in another chat – the words stay there.';

/** A person's line kept in a thread (tools/builtin/tasks-util.ts keepPersonLine): where, which line, whose, when. */
export interface KeptQuote { conversationId: string; messageId: string; seq: number; authorId: string; at: number }

/** Every one of `people` reads the line `quote` names in the chat it was written in (the owner reads every chat). */
export function readQuote(s: Pick<RuntimeServices, 'db' | 'chats'>, people: readonly string[], quote: Pick<KeptQuote, 'conversationId' | 'at'>): boolean {
  const chat = s.chats.get(quote.conversationId);
  return people.every((id) => {
    if (id === HUMAN_ID) return true;
    const access = chat ? chatAccess(s.db, id, chat) : undefined;
    return access !== undefined && typeof quote.at === 'number' && quote.at >= access.from;
  });
}

/**
 * Before the people among `joining` read the thread: each line quoted there whole from a chat one of them does not read
 * gives way to its link-only line (same quote, LINE_ELSEWHERE) – its words stay where they were written (R1.1).
 */
function keepQuotesFor(s: ThreadDeps, threadId: string, joining: readonly string[]): void {
  const people = joining.filter((id) => isPersonId(id));
  if (!people.length) return;
  for (const line of s.chats.messages(threadId, { limit: 500 })) {
    const status = line.kind === 'status' ? line.meta.status : undefined;
    const quote = status?.details?.quote as KeptQuote | undefined;
    if (!status || !quote || status.text === LINE_ELSEWHERE || readQuote(s, people, quote)) continue;
    s.chats.removeMessage(line.id, SYSTEM_ID);
    s.chats.status(threadId, { ...status, text: LINE_ELSEWHERE }, { authorId: line.authorId, taskId: threadId });
  }
}

/**
 * A quiet event line in the task's thread (made when missing): a status line – no wake, no push, never unread – by `by`
 * (shown as the system when `by` is no member). Undefined when it could not be written (logged, never thrown).
 */
export function threadEvent(s: ThreadDeps, taskId: string, line: string | StatusLine, by: string = SYSTEM_ID): Message | undefined {
  try {
    threadOf(s, taskId);
    const status: StatusLine = typeof line === 'string' ? { type: 'note', text: line, details: { taskId } } : line;
    return s.chats.status(taskId, status, { authorId: by, taskId });
  } catch (error) {
    s.log?.warn('task thread event failed', { taskId, error: String(error) });
    return undefined;
  }
}

/** The tasks whose thread holds lines `memberId` has not read – not their own, no quiet or status line (the dot on a task). */
export function threadNews(s: Pick<RuntimeServices, 'db'>, memberId: string): string[] {
  return s.db.all<{ id: string }>(
    `SELECT m.conversation_id AS id FROM members m
     WHERE m.member_id = ? AND m.left_at IS NULL AND m.conversation_id LIKE 'task\\_%' ESCAPE '\\'
       AND EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = m.conversation_id AND x.seq > m.read_seq
         AND x.silent = 0 AND x.state != 'streaming' AND x.author_id != m.member_id)`,
    [memberId],
  ).map((row) => row.id);
}

/** A removed task takes its thread along (nothing happens when it has none). */
export function dropThread(s: Pick<RuntimeServices, 'chats'>, taskId: string): void {
  if (s.chats.get(taskId)) s.chats.remove(taskId);
}
