// Settings › Scheduled (owner 21.11.2026: "alle automatischen Chatnachrichten … ändern, Texte umschreiben, löschen, neue
// hinzufügen – da wählt man den Chat aus"), pure: the person's schedules grouped by their chat (the groups in the order
// of their soonest run), the agents that set up their own (Nachricht 3: "Agenten suchen, auf einen klicken" – by name, a
// search keeps those whose name holds every word typed), the text a schedule says (a message's body, a
// reminder's note), its level, and the schedules.update call of an edit with only what changed – a new text or a new chat
// takes the @mentions of that chat along. The composer's schedule mode reads the same level (chat/composer/schedule-mode.ts).
// Owns: that grouping and that diff. Never: imports the store, rpc or the DOM.

import type { MessageLevel } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { stillRuns, type Schedule, type ScheduleSpec } from '../../shared/model/tasks.ts';
import { byNextRun } from './schedule-state.ts';

export interface ChatGroup { conversationId: string | undefined; schedules: Schedule[] }

/** By chat; inside a chat by the next run (pausing keeps a row in its place), the chats by their first row. */
export function groupByChat(list: readonly Schedule[]): ChatGroup[] {
  const groups = new Map<string | undefined, Schedule[]>();
  for (const schedule of [...list].sort(byNextRun)) {
    const key = schedule.conversationId;
    groups.set(key, [...(groups.get(key) ?? []), schedule]);
  }
  return [...groups].map(([conversationId, schedules]) => ({ conversationId, schedules }));
}

export interface AgentEntry { agentId: string; name: string; count: number; nextAt?: number }

/** Everyone but the person who set something up, by name: how many, and the soonest next run of the ones that still run. */
export function agentEntries(list: readonly Schedule[], nameOf: (id: string) => string, query = ''): AgentEntry[] {
  const entries = new Map<string, AgentEntry>();
  for (const schedule of list) {
    if (schedule.ownerId === HUMAN_ID) continue;
    const entry = entries.get(schedule.ownerId) ?? { agentId: schedule.ownerId, name: nameOf(schedule.ownerId), count: 0 };
    entry.count += 1;
    if (stillRuns(schedule) && schedule.nextAt !== undefined) entry.nextAt = Math.min(entry.nextAt ?? Infinity, schedule.nextAt);
    entries.set(schedule.ownerId, entry);
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...entries.values()].filter((entry) => words.every((word) => entry.name.toLowerCase().includes(word)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What the schedule says: a message's body, a reminder's note (the title when neither is stored). */
export function scheduleText(schedule: Pick<Schedule, 'kind' | 'title' | 'payload'>): string {
  return (schedule.kind === 'reminder' ? schedule.payload.note : schedule.payload.body) ?? schedule.title;
}

/** The message level of a scheduled message. */
export function levelOf(schedule: Pick<Schedule, 'payload'>): MessageLevel {
  return schedule.payload.silent ? 'silent' : schedule.payload.priority === 'important' ? 'important' : 'normal';
}

export interface ScheduleEdit {
  body: string;
  level: MessageLevel;
  /** A message's chat (a reminder stays where it is). */
  conversationId?: string;
  /** Only when the rule changed. */
  spec?: ScheduleSpec;
  /** The @mentions of `body` in the chosen chat. */
  mentions: string[];
}

export interface UpdateParams {
  id: string; conversationId?: string; spec?: ScheduleSpec; body?: string; priority?: MessageLevel; mentions?: string[];
}

/** The schedules.update params of an edit, only what changed; null when nothing did (or the text is empty). */
export function editParams(schedule: Schedule, edit: ScheduleEdit): UpdateParams | null {
  const body = edit.body.trim();
  if (!body) return null;
  const params: UpdateParams = { id: schedule.id };
  if (body !== scheduleText(schedule)) params.body = body;
  if (edit.spec) params.spec = edit.spec;
  if (schedule.kind === 'message') {
    if (edit.level !== levelOf(schedule)) params.priority = edit.level;
    if (edit.conversationId && edit.conversationId !== schedule.conversationId) params.conversationId = edit.conversationId;
    if (params.body !== undefined || params.conversationId) params.mentions = edit.mentions;
  }
  return Object.keys(params).length > 1 ? params : null;
}
