// Who an agent's ask goes to in a chat with people: an ask block (choice, form, record …), a mini-app to-do of an
// agent's message or a task with a widget lands on the For you of the human who wrote last before it – a person of the
// organisation who is still a member, or the owner. A form that asks for a password or key always goes to the owner
// (people/task-rules.ts rule 4). In chats without people nothing changes (the owner). Agents name a person themselves
// with tasks.add {for}.
// Owns: that choice (SQL reads only). Never: creates or assigns tasks.

import type { Db } from '../db/database.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { secretFields } from '../secrets/capture.ts';

/** The person an agent's ask at `seq` goes to, or undefined for the owner. */
export function askTarget(db: Db, conversationId: string, seq: number, widget?: UiBlock): string | undefined {
  if (secretFields(widget).length) return undefined;
  try {
    const row = db.get<{ author_id: string }>(
      `SELECT author_id FROM messages WHERE conversation_id = ? AND seq < ? AND author_kind = 'human' AND kind IN ('text', 'task', 'answer') ORDER BY seq DESC LIMIT 1`,
      [conversationId, seq],
    );
    if (!row || !isPersonId(row.author_id)) return undefined; // the owner reads every chat and answers there
    const member = db.get<{ member_id: string }>('SELECT member_id FROM members WHERE conversation_id = ? AND member_id = ? AND left_at IS NULL', [conversationId, row.author_id]);
    return member ? row.author_id : undefined;
  } catch {
    return undefined;
  }
}
