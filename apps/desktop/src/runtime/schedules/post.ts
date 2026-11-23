// What a person's scheduled post stores (messages.schedule, schedules.update – T11): a chat message (kind 'message':
// body, @mentions, its level – 'important', or B-050 K4 'silent': posted quietly, payload.silent). Work a post asks for is
// a line in the chat like any other: whoever reads it there makes the to-do (Quests round 20.11.2026 – the "Post as task"
// routine went; its rows became plain repeating messages, migration 110).
// Rewording keeps the kind. Owner 21.11.2026 (Settings › Scheduled: "alles bearbeiten"): the person rewords every scheduled
// message – an agent's too, posted under the agent's name as before – and an agent's reminder (its note and title).
// Owns: body → { kind, title, payload } and the payload of a reworded post or reminder.
// Never: computes times, creates schedules or tasks.

import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Schedule } from '../../shared/model/tasks.ts';

/** The level of a scheduled post (B-050 K4: the three message levels). */
export type PostPriority = 'normal' | 'important' | 'silent';
export const POST_PRIORITIES: readonly PostPriority[] = ['normal', 'important', 'silent'];

type Payload = Schedule['payload'];

/** A new post of the person: a message. */
export function scheduledPost(body: string, options: { mentions?: string[]; priority?: PostPriority; ultra?: boolean } = {}): {
  kind: 'message'; title: string; payload: Payload;
} {
  const payload: Payload = options.mentions?.length ? { body, mentions: options.mentions } : { body };
  if (options.priority === 'important') payload.priority = 'important';
  if (options.priority === 'silent') payload.silent = true;
  if (options.ultra) payload.ultra = true; // B-057: Ultra suggested for this message (a rewording keeps it: the scheduler merges key by key)
  return { kind: 'message', title: excerpt(body, 60), payload };
}

/**
 * The title and payload patch of a reworded post (or a reminder's note). The scheduler merges payloads key by key, so
 * every key this owns is set (undefined drops it from the stored JSON).
 */
export function rewordPost(schedule: Schedule, change: { body?: string; priority?: PostPriority; mentions?: string[] }): { title: string; payload: Payload } {
  if (schedule.kind === 'reminder') {
    if (change.priority !== undefined || change.mentions !== undefined) {
      throw new WorkforceError('bad_request', 'A reminder has only its note to change.', { details: { scheduleId: schedule.id } });
    }
    const note = change.body ?? schedule.payload.note ?? schedule.title;
    return { title: excerpt(note, 60), payload: { note } };
  }
  const stored = schedule.payload;
  const body = change.body ?? stored.body ?? schedule.title;
  const priority = change.priority ?? (stored.silent ? 'silent' : stored.priority);
  const next = scheduledPost(body, { mentions: change.mentions ?? stored.mentions, priority });
  const payload: Payload = { ...next.payload, priority: priority === 'important' ? 'important' : undefined, silent: priority === 'silent' ? true : undefined };
  payload.mentions = next.payload.mentions;
  return { title: next.title, payload };
}
