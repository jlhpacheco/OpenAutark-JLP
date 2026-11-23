// What a due schedule does, per kind (Quests round 20.11.2026: message and reminder – a repeat lives in the reminder's
// spec, a person's ring in the to-do's own `at`):
//  * message  → a normal chat post by the owner (as if typed then), meta.via 'schedule' ("Send later");
//  * reminder → wakes the owning agent with its own first-person note (no chat post) – B-080 (live: 14 reminder runs
//               in a chat its agent had left when B-078 D7 moved the task): in its task's chat while the agent is a
//               member there, else the one it was set in. The note is the wake's; the quest as it stands comes with the
//               turn (the agent's context reads the reminder's task).
// B-044: also the one quiet "Scheduled" chat line when a post is created (announceCreated). Reminder wakes carry the
// origin schedule:<id>.
// Owns: those effects. Never: computes times or touches the schedules table.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Schedule } from '../../shared/model/tasks.ts';
import { cleanOrigin, scheduleSource, type Origin } from '../../shared/model/origin.ts';

/** B-054: why a schedule's wake exists – 'Reminder', or 'Schedule' for a post. */
export function scheduleOrigin(schedule: Pick<Schedule, 'id' | 'kind' | 'title'>): Origin {
  return cleanOrigin({ source: scheduleSource(schedule.id), label: schedule.kind === 'reminder' ? 'Reminder' : 'Schedule' })!;
}

export type FireDeps = Pick<RuntimeServices, 'chats' | 'tasks' | 'wakes'> & Partial<Pick<RuntimeServices, 'notifications' | 'log'>>;

/** Thrown when a schedule can never fire again (its chat or owner is gone). */
export class ScheduleGone extends Error {}

/**
 * B-080: where a reminder wakes – its task's chat now (the work moved, e.g. B-078 D7) while its owner is a member there,
 * else the chat it was set in (a manager's reminder on a report's task stays in the manager's own chat).
 */
function reminderChat(schedule: Schedule, s: FireDeps): string | undefined {
  if (!schedule.taskId) return schedule.conversationId;
  try {
    const chat = s.tasks.get(schedule.taskId)?.conversationId;
    if (chat && s.chats.members(chat).some((member) => member.memberId === schedule.ownerId && !member.leftAt)) return chat;
  } catch { /* the reminder's own chat */ }
  return schedule.conversationId;
}

export function fireSchedule(schedule: Schedule, occurrence: number, s: FireDeps): void {
  const ownerKind = schedule.ownerId === HUMAN_ID ? 'human' : 'agent';
  switch (schedule.kind) {
    case 'message': {
      if (!schedule.conversationId || !s.chats.get(schedule.conversationId)) throw new ScheduleGone('chat removed');
      s.chats.send({
        conversationId: schedule.conversationId,
        body: schedule.payload.body ?? schedule.title,
        mentions: schedule.payload.mentions,
        priority: schedule.payload.priority,
        silent: schedule.payload.silent === true,
        authorId: schedule.ownerId,
        authorKind: ownerKind,
        taskId: schedule.taskId,
        meta: { via: 'schedule', scheduleId: schedule.id, plannedAt: occurrence, ...(schedule.payload.ultra === true && ownerKind === 'human' ? { ultra: true as const } : {}) }, // B-057: a person's suggestion only
      });
      return;
    }
    case 'reminder': {
      if (ownerKind !== 'agent') throw new ScheduleGone('reminders belong to agents');
      s.wakes.wake({
        agentId: schedule.ownerId, reason: 'schedule', conversationId: reminderChat(schedule, s), taskId: schedule.taskId,
        note: schedule.payload.note ?? schedule.title, coalesceKey: `sch:${schedule.id}`, origin: scheduleOrigin(schedule),
      });
      return;
    }
  }
}

/**
 * B-044: the one quiet chat line when a post is scheduled – the person's and the agents'
 * alike (reminders stay private). The UI shows it as "Scheduled · <when>" (details.nextAt),
 * linking to Chat details › Scheduled. A failed line never fails the schedule.
 */
export function announceCreated(schedule: Schedule, s: Pick<RuntimeServices, 'chats'>): void {
  if (!schedule.conversationId || schedule.kind === 'reminder') return;
  const details = { scheduleId: schedule.id, ...(schedule.nextAt !== undefined ? { nextAt: schedule.nextAt } : {}) };
  s.chats.status(schedule.conversationId, { type: 'schedule_created', text: `Scheduled · ${schedule.title}`, details }, { authorId: schedule.ownerId, taskId: schedule.taskId });
}
