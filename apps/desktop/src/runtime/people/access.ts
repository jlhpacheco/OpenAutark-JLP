// What a person may read and use (F-52) – the one rule set behind every person call and every event
// a person's device receives:
//  * chats: only chats where the person is an active member; messages from the time they joined,
//    unless the chat shares its whole history (settings.history 'full');
//  * tasks: assigned to them, created or assigned by them, or in a chat they belong to – there, like
//    messages, only tasks made from their join on unless the chat shares its whole history ("Only me" hides nothing);
//  * files: attached to a message they may read, the image avatars of active agents and people, and
//    the files they uploaded themselves (person_uploads);
//  * agents: to work with (add to chats, give tasks): active agents of the spaces their scopes name
//    ('all' includes agents without a space); to see as colleagues additionally the agents of their
//    chats, their own manager and the agents reporting to them (visibleAgents).
// The owner (CEO) sees every chat, people's own chats included.
// F13: a person with the role 'ceo' (isCeo) also reads every company chat from its start (companyChat: every chat but
// an app-owned one, people's own chat and the owner's own chats – his default 1:1s, the owner alone or with one other;
// a bridged outside contact does not count), the tasks of those chats and every chat-free task but the owner's own to-dos
// (readsTask), the files of those chats, and works with every agent and space (their scopes are always all,
// people/service.ts). A chat that began as the owner's own opens to a CEO from its third member's join (companySince).
// The owner's own agents (ownersOwnAgent) keep their setup and SYSTEM.md from a CEO. mayReadMessage and mayReadTask stay
// a member's rule: an employee's PC holds its person's own chats (devices/sync/tables.ts), the company view is the
// CEO's phone and browser (chatAccess, readsTask, readableTasksSql, mayReadFile).
// Owns: these checks (SQL reads, the org's spaces). Never: writes, events or a check based on what a client claims.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Conversation, ConversationSettings, Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { OrgService } from '../contracts.ts';
import type { Db } from '../db/database.ts';

type MemberRow = { conversation_id: string; joined_at: number; read_seq: number };

/** The person's active membership of a chat, if any. */
export function membership(db: Db, personId: string, conversationId: string): { joinedAt: number; readSeq: number } | undefined {
  const row = db.get<MemberRow>('SELECT conversation_id, joined_at, read_seq FROM members WHERE conversation_id = ? AND member_id = ? AND left_at IS NULL', [conversationId, personId]);
  return row ? { joinedAt: Number(row.joined_at), readSeq: Number(row.read_seq) } : undefined;
}

/** Ids of the chats the person is an active member of. */
export function chatIdsOf(db: Db, personId: string): Set<string> {
  return new Set(db.all<MemberRow>('SELECT conversation_id FROM members WHERE member_id = ? AND left_at IS NULL', [personId]).map((row) => String(row.conversation_id)));
}

/** From when the person sees a chat's messages (0 = its whole history). */
export function visibleFrom(chat: Pick<Conversation, 'settings'>, joinedAt: number): number {
  return chat.settings.history === 'full' ? 0 : joinedAt;
}

/** F13: the person holds the role 'ceo' (stored with their scopes, people/repo.ts) and still has access. */
export function isCeo(db: Db, personId: string): boolean {
  try {
    return Boolean(db.get(`SELECT 1 FROM people WHERE id = ? AND status <> 'revoked' AND json_extract(scopes, '$.role') = 'ceo'`, [personId]));
  } catch {
    return false; // a database without the table
  }
}

/** The owner is an active member of the chat (alias c). */
const OWNER_IN = `EXISTS (SELECT 1 FROM members o WHERE o.conversation_id = c.id AND o.member_id = '${HUMAN_ID}' AND o.left_at IS NULL)`;

/**
 * F13: a company chat (alias c) – not app-owned; not people's own (marked, or without the owner and with a member who is
 * no CEO); not the owner's own (his marked default 1:1, or one he is in with
 * at most one other). A bridged outside contact ('ext:…') is the chat's channel, not a partner (chat/members-change.ts).
 */
const COMPANY_CHAT = `json_extract(c.settings, '$.system') IS NULL AND COALESCE(json_extract(c.settings, '$.peopleChat'), 0) = 0
  AND NOT (${OWNER_IN} AND (COALESCE(json_extract(c.settings, '$.direct'), 0) = 1
    OR (SELECT COUNT(*) FROM members n WHERE n.conversation_id = c.id AND n.left_at IS NULL AND n.member_id NOT LIKE 'ext:%') <= 2))
  AND (${OWNER_IN} OR NOT EXISTS (SELECT 1 FROM members p WHERE p.conversation_id = c.id AND p.left_at IS NULL AND substr(p.member_id, 1, 4) = 'per_'
    AND NOT EXISTS (SELECT 1 FROM people q WHERE q.id = p.member_id AND json_extract(q.scopes, '$.role') = 'ceo')))`;

/**
 * F13 (alias c): from when a CEO reads a company chat – its start, or, when it began as the owner's own (he and one other,
 * before the third joined), from the third member's join, as that member sees it; its start when it shares its whole history.
 */
const COMPANY_SINCE = `CASE WHEN json_extract(c.settings, '$.history') = 'full' THEN 0 ELSE COALESCE((
  SELECT CASE WHEN x.joined_at > o.joined_at THEN x.joined_at ELSE 0 END FROM members x
    JOIN members o ON o.conversation_id = x.conversation_id AND o.member_id = '${HUMAN_ID}' AND o.left_at IS NULL
  WHERE x.conversation_id = c.id AND x.left_at IS NULL AND x.member_id NOT LIKE 'ext:%' ORDER BY x.joined_at LIMIT 1 OFFSET 2), 0) END`;

/** F13: from when a CEO reads this company chat (COMPANY_SINCE); undefined when it is no company chat. */
export function companySince(db: Db, conversationId: string): number | undefined {
  const row = db.get<{ since: number }>(`SELECT ${COMPANY_SINCE} AS since FROM conversations c WHERE c.id = ? AND ${COMPANY_CHAT}`, [conversationId]);
  return row ? Number(row.since) : undefined;
}

/** F13: is this a company chat a CEO reads (see COMPANY_CHAT)? */
export function companyChat(db: Db, conversationId: string): boolean {
  return companySince(db, conversationId) !== undefined;
}

/** F13: the ids of every company chat (a CEO's chat list). */
export function companyChatIds(db: Db): Set<string> {
  return new Set(db.all<{ id: string }>(`SELECT c.id FROM conversations c WHERE ${COMPANY_CHAT}`).map((row) => String(row.id)));
}

/**
 * How the person reads a chat: from when (0 = its whole history) and their membership, if any; undefined = not at all.
 * A member reads from their join on unless the chat shares its whole history; F13: a CEO reads a company chat from its
 * start, or from when it stopped being the owner's own (companySince).
 */
export function chatAccess(db: Db, personId: string, chat: Pick<Conversation, 'id' | 'settings'>): { from: number; member?: { joinedAt: number; readSeq: number } } | undefined {
  const member = membership(db, personId, chat.id);
  const own = member ? visibleFrom(chat, member.joinedAt) : undefined;
  const since = isCeo(db, personId) ? companySince(db, chat.id) : undefined;
  if (since !== undefined) return { from: own === undefined ? since : Math.min(own, since), ...(member ? { member } : {}) };
  return member ? { from: own!, member } : undefined;
}

function fullHistory(settingsJson: unknown): boolean {
  try { return (JSON.parse(String(settingsJson)) as ConversationSettings).history === 'full'; } catch { return false; }
}

/** May the person see this message (member now, and it is from their visible time on)? A member's rule (see the header). */
export function mayReadMessage(db: Db, personId: string, chat: Pick<Conversation, 'id' | 'settings'>, message: Pick<Message, 'createdAt'>): boolean {
  const member = membership(db, personId, chat.id);
  return Boolean(member && message.createdAt >= visibleFrom(chat, member.joinedAt));
}

type ReadableTask = Pick<Task, 'conversationId' | 'assigneeKind' | 'assigneeId' | 'createdBy' | 'assignedBy' | 'createdAt'>;

/** Tasks the person may read as a member: theirs, made or handed on by them, or of one of their chats from their visible time on. */
export function mayReadTask(db: Db, personId: string, task: ReadableTask): boolean {
  if (task.assigneeKind === 'human' && task.assigneeId === personId) return true;
  if (task.createdBy === personId || task.assignedBy === personId) return true;
  if (!task.conversationId) return false; // a chat-free task (B-054): only its parties read it
  const row = db.get<{ joined_at: number; settings: string }>(
    'SELECT m.joined_at, c.settings FROM members m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.member_id = ? AND m.left_at IS NULL',
    [task.conversationId, personId],
  );
  return Boolean(row) && (fullHistory(row!.settings) || task.createdAt >= Number(row!.joined_at));
}

/** The person's read of a task on their devices: a member's rule (mayReadTask), and F13 a CEO's company tasks. */
export function readsTask(db: Db, personId: string, task: ReadableTask): boolean {
  if (mayReadTask(db, personId, task)) return true;
  if (!isCeo(db, personId)) return false;
  if (task.conversationId) {
    const since = companySince(db, task.conversationId);
    return since !== undefined && task.createdAt >= since;
  }
  return !(task.assigneeKind === 'human' && (task.assigneeId === undefined || task.assigneeId === HUMAN_ID)); // never the owner's own to-do
}

/** SQL condition (alias t) for the tasks a person may read – the same rule as readsTask. */
export function readableTasksSql(personId: string): { sql: string; params: string[] } {
  return {
    sql: `((t.assignee_kind = 'human' AND t.assignee_id = ?) OR t.created_by = ? OR t.assigned_by = ?
      OR EXISTS (SELECT 1 FROM members m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = t.conversation_id AND m.member_id = ? AND m.left_at IS NULL
          AND (t.created_at >= m.joined_at OR json_extract(c.settings, '$.history') = 'full'))
      OR (EXISTS (SELECT 1 FROM people p WHERE p.id = ? AND p.status <> 'revoked' AND json_extract(p.scopes, '$.role') = 'ceo')
        AND CASE WHEN t.conversation_id IS NULL THEN NOT (t.assignee_kind = 'human' AND COALESCE(t.assignee_id, '${HUMAN_ID}') = '${HUMAN_ID}')
          ELSE EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND ${COMPANY_CHAT} AND t.created_at >= ${COMPANY_SINCE}) END))`,
    params: [personId, personId, personId, personId, personId],
  };
}

/** The video a stored blob is the light copy of (media.preview_file_id), if it is one. */
function previewOriginal(db: Db, id: string): string | undefined {
  try { return db.get<{ f: string }>('SELECT file_id AS f FROM media WHERE preview_file_id = ? LIMIT 1', [id])?.f; } catch { return undefined; }
}

/** A stored file the person may fetch: attached to a message of one of their chats from their visible time on, or an avatar. */
export function mayReadFile(db: Db, personId: string, fileId: string, options: { ownUploads?: boolean; viaCopy?: boolean } = {}): boolean {
  if (!/^[0-9a-f]{64}$/i.test(fileId)) return false;
  const id = fileId.toLowerCase();
  // 17.11.2026: a video's light copy may be read by whoever may read the video - one step only (`viaCopy`: the video is not sent on again, so a ring of rows ends)
  const original = options.viaCopy ? undefined : previewOriginal(db, id);
  if (original && original !== id) return mayReadFile(db, personId, original, { ...options, viaCopy: true });
  const rows = db.all<{ settings: string; joined_at: number; created_at: number }>(
    `SELECT c.settings, m.joined_at, msg.created_at FROM messages msg
       JOIN members m ON m.conversation_id = msg.conversation_id AND m.member_id = ? AND m.left_at IS NULL
       JOIN conversations c ON c.id = msg.conversation_id
     WHERE msg.attachments <> '[]' AND EXISTS (SELECT 1 FROM json_each(msg.attachments) a WHERE json_extract(a.value, '$.fileId') = ?) LIMIT 20`,
    [personId, id],
  );
  if (rows.some((row) => fullHistory(row.settings) || Number(row.created_at) >= Number(row.joined_at))) return true;
  if (isCeo(db, personId) && db.get( // F13: attached in a company chat
    `SELECT 1 FROM messages msg JOIN conversations c ON c.id = msg.conversation_id
     WHERE msg.attachments <> '[]' AND ${COMPANY_CHAT} AND msg.created_at >= ${COMPANY_SINCE}
       AND EXISTS (SELECT 1 FROM json_each(msg.attachments) a WHERE json_extract(a.value, '$.fileId') = ?) LIMIT 1`,
    [id],
  )) return true;
  return avatarFile(db, id) || (options.ownUploads !== false && uploadedBy(db, personId, id));
}

/** The person uploaded this file (into `conversationId`, when given – people/uploads.ts). */
export function uploadedBy(db: Db, personId: string, fileId: string, conversationId?: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(fileId)) return false;
  try {
    return Boolean(conversationId === undefined
      ? db.get('SELECT 1 FROM person_uploads WHERE person_id = ? AND file_id = ? LIMIT 1', [personId, fileId.toLowerCase()])
      : db.get('SELECT 1 FROM person_uploads WHERE person_id = ? AND file_id = ? AND conversation_id = ? LIMIT 1', [personId, fileId.toLowerCase(), conversationId]));
  } catch {
    return false; // a database without the table
  }
}

/**
 * A readable file as the person knows it – the name and time of their own latest upload of
 * it, else of an attachment of it they may read – never the name and time it was first stored under by
 * someone else (identical bytes share one stored file). An avatar keeps the stored ref.
 */
export function personFileView<T extends { id: string; name: string; createdAt: number }>(db: Db, personId: string, ref: T): T {
  const id = ref.id.toLowerCase();
  try {
    const own = db.get<{ name: string; created_at: number }>('SELECT name, created_at FROM person_uploads WHERE person_id = ? AND file_id = ? ORDER BY created_at DESC LIMIT 1', [personId, id]);
    if (own) return { ...ref, name: String(own.name), createdAt: Number(own.created_at) };
  } catch { /* a database without the table */ }
  const rows = db.all<{ name: string | null; settings: string; joined_at: number; created_at: number }>(
    `SELECT json_extract(a.value, '$.name') AS name, c.settings, m.joined_at, msg.created_at FROM messages msg
       JOIN members m ON m.conversation_id = msg.conversation_id AND m.member_id = ? AND m.left_at IS NULL
       JOIN conversations c ON c.id = msg.conversation_id, json_each(msg.attachments) a
     WHERE msg.attachments <> '[]' AND json_extract(a.value, '$.fileId') = ? ORDER BY msg.created_at LIMIT 20`,
    [personId, id],
  );
  const seen = rows.find((row) => fullHistory(row.settings) || Number(row.created_at) >= Number(row.joined_at));
  return seen ? { ...ref, name: String(seen.name || 'file'), createdAt: Number(seen.created_at) } : ref;
}

/** The image avatar of an active agent or of a person still in the organisation (the shared UI shows them). */
function avatarFile(db: Db, fileId: string): boolean {
  const image = `json_extract(avatar, '$.kind') = 'image' AND json_extract(avatar, '$.value') = ?`;
  if (db.get(`SELECT 1 FROM agents WHERE archived_at IS NULL AND ${image} LIMIT 1`, [fileId])) return true;
  try { return Boolean(db.get(`SELECT 1 FROM people WHERE status <> 'revoked' AND ${image} LIMIT 1`, [fileId])); } catch { return false; }
}

/** May the person work with this agent (add it to chats, give it tasks)? */
export function mayUseAgent(person: Pick<Person, 'scopes' | 'status'>, agent: Pick<Agent, 'spaceId' | 'archivedAt'> | undefined): boolean {
  if (!agent || agent.archivedAt !== undefined || person.status === 'revoked') return false;
  const spaces = person.scopes.spaces;
  if (spaces === 'all') return true;
  return agent.spaceId !== undefined && spaces.includes(agent.spaceId);
}

/** Which agents the person sees as colleagues: those they may use, those of their chats, their manager and their reports. */
export function visibleAgents(db: Db, person: Pick<Person, 'id' | 'scopes' | 'status' | 'managerId'>): (agent: Pick<Agent, 'id' | 'spaceId' | 'archivedAt' | 'managerId'> | undefined) => boolean {
  const inChats = new Set(db.all<{ member_id: string }>(
    `SELECT DISTINCT b.member_id FROM members a JOIN members b ON b.conversation_id = a.conversation_id
     WHERE a.member_id = ? AND a.left_at IS NULL AND b.left_at IS NULL AND b.kind = 'agent'`, [person.id],
  ).map((row) => String(row.member_id)));
  return (agent) => Boolean(agent) && person.status !== 'revoked'
    && (mayUseAgent(person, agent) || inChats.has(agent!.id) || agent!.id === person.managerId || agent!.managerId === person.id);
}

/**
 * F13: an agent of the owner's own – one in his private space, or one reporting to him (his personal manager, his secretary)
 * that this CEO did not hire. Its setup and place stay as the owner set them and its SYSTEM.md stays his
 * (people/rpc-ceo.ts agents.update, perspective.ts viewAgent).
 */
export function ownersOwnAgent(org: Pick<OrgService, 'spaces'>, ceoId: string, agent: Pick<Agent, 'spaceId' | 'managerId' | 'createdBy'>): boolean {
  if ((agent.managerId === undefined || agent.managerId === HUMAN_ID) && agent.createdBy !== ceoId) return true;
  return agent.spaceId !== undefined && org.spaces().some((space) => space.id === agent.spaceId && space.kind === 'private');
}

/** May the person see this space (the spaces their scopes name)? */
export function maySeeSpace(person: Pick<Person, 'scopes'>, spaceId: string): boolean {
  return person.scopes.spaces === 'all' || person.scopes.spaces.includes(spaceId);
}

/**
 * Unread for a person: visible, non-silent, finished messages after their cursor they did not write – and
 * how many of them are important (B-050 K4: the person's red badge), one query as MessageRepo.unreadCounts.
 */
export function personUnreadCounts(db: Db, personId: string, conversationId: string, readSeq: number, from: number): { unread: number; important: number } {
  const row = db.get<{ n: number; important: number | null }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN priority = 'important' THEN 1 ELSE 0 END) AS important FROM messages
     WHERE conversation_id = ? AND seq > ? AND created_at >= ? AND silent = 0 AND state != 'streaming' AND author_id != ?`,
    [conversationId, readSeq, from, personId],
  );
  return { unread: Number(row?.n ?? 0), important: Number(row?.important ?? 0) };
}
