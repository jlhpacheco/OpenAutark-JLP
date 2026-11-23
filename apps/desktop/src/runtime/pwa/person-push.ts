// The push rules for employees (people of the organisation, 'per_…'): a new message in a chat they are a member of
// reaches their devices (PushService.sendToPerson – only devices holding that person's live token) – not their own
// lines, not quiet ones (status lines, silent messages), each message once, when it is final (an agent's answer
// streams first); and a task notice for them ('person.notice': work given to them, its due time, the end of work they
// gave – runtime/tasks/give.ts tell). No phone switch gates it. A line in a task's thread is titled with its task
// (tasks/thread.ts); its tap opens the task.
// Owns: those rules. Never: pushes to the owner (notify/service.ts does) or to a person outside the chat.

import type { RuntimeServices } from '../contracts.ts';
import { isTaskThread, type Message } from '../../shared/model/chat.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { previewText } from '../../shared/text/chat-names.ts';
import type { PushService } from './push.ts';

/** Message ids pushed lately (an edited final message is not pushed again). */
const REMEMBERED = 500;

type Deps = Pick<RuntimeServices, 'bus' | 'chats' | 'log'> & Partial<Pick<RuntimeServices, 'tasks'>>;

/** The people (not the author) who are members of the message's chat right now. */
function recipients(s: Deps, message: Message): string[] {
  try {
    return s.chats.members(message.conversationId)
      .filter((member) => !member.leftAt && isPersonId(member.memberId) && member.memberId !== message.authorId)
      .map((member) => member.memberId);
  } catch {
    return [];
  }
}

/** Starts the rule; returns its stop. */
export function pushPeopleMessages(s: Deps, push: Pick<PushService, 'sendToPerson'>): () => void {
  const sent = new Set<string>();
  const onMessage = (message: Message): void => {
    if (message.state !== 'final' || message.silent || message.kind === 'status' || sent.has(message.id)) return;
    const people = recipients(s, message);
    if (!people.length) return;
    sent.add(message.id);
    if (sent.size > REMEMBERED) sent.delete(sent.values().next().value as string);
    let title = 'New message';
    try {
      const id = message.conversationId;
      title = (isTaskThread(id) ? s.tasks?.get(id)?.title : s.chats.get(id)?.title) || title;
    } catch { /* the default title */ }
    const body = previewText(message.body, message.attachments ?? []);
    for (const personId of people) {
      push.sendToPerson(personId, { kind: message.priority === 'important' ? 'important' : 'reply', title, body, conversationId: message.conversationId })
        .catch((error: unknown) => s.log.warn('push to a person failed', { personId, error: String(error) }));
    }
  };
  const offCreated = s.bus.on('message.created', onMessage);
  const offUpdated = s.bus.on('message.updated', onMessage);
  const offNotice = s.bus.on('person.notice', ({ personId, ...message }) => {
    push.sendToPerson(personId, message).catch((error: unknown) => s.log.warn('push to a person failed', { personId, error: String(error) }));
  });
  return () => { offCreated(); offUpdated(); offNotice(); };
}
