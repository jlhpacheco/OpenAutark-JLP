// calendar.add (B-041 – a clicked free slot, then typed or dictated; Quests round 20.11.2026): the marked range is the
// time, the first line the title (more lines are its notes). It is a to-do unless the caller says 'event' (kind 'auto' =
// to-do – no guessing from words). An event is a local row with its title. A to-do is the person's line at that time –
// the one intake, tasks/quick.ts (their own chat-free to-do with `at`/`minutes` from the range, sorted by their
// assistant; with settings.day.aiHelps off it is "Only me" – sorted too, never handed to an agent – as every line
// there). An agent's event may not cover a timed
// event or a to-do the person placed. Resent with the same clientId it answers what the first one made.
// Owns: that flow. Never: a model call, a to-do made for the person by an agent here (agents use the task tools), or task
// text on a row.

import { WorkforceError } from '../../shared/errors.ts';
import type { CalendarAddInput, CalendarEvent } from '../../shared/model/calendar.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { CalendarServiceImpl } from './service.ts';
import { ownerOf, setByOf } from './rules.ts';
import { todoRow } from './repo.ts';
import { quickCreate } from '../tasks/quick.ts';

const MIN = 60_000;
/** An event's length when neither the range nor the text gives one. */
export const DEFAULT_EVENT_MIN = 60;
/** Client ids of events the service remembers (a resend answers the same row; to-dos dedupe by their task's client id). */
const RECENT_MAX = 100;

/** What a slot click says. */
export interface Slot { kind: 'event' | 'todo'; title: string; startAt: number; endAt?: number }

/** The slot's kind, title and span (pure). */
export function readSlot(input: CalendarAddInput): Slot {
  const line = input.text.trim().split(/\r?\n/)[0].trim(); // the first line names it; more lines are its notes
  if (!line) throw new WorkforceError('bad_request', 'Type what goes into the calendar.');
  const slot: Slot = { kind: input.kind === 'event' ? 'event' : 'todo', title: excerpt(line, 120), startAt: input.startAt };
  if (input.endAt !== undefined) slot.endAt = input.endAt;
  return slot;
}

/** calendar.add (see the header). */
export async function addFromSlot(calendar: CalendarServiceImpl, input: CalendarAddInput, by: string): Promise<{ event: CalendarEvent; task?: TaskView }> {
  const s = calendar.s;
  const slot = readSlot(input);
  const ownerId = ownerOf(by);
  const setBy = setByOf(by);
  const text = input.text.trim();
  if (slot.kind === 'event') {
    const notes = text.includes('\n') ? { notes: text } : {}; // several lines: the whole text stays with it
    const sent = input.clientId ? calendar.recentEvents.get(`${by}:${input.clientId}`) : undefined;
    const before = sent ? calendar.repo.get(sent) : undefined;
    if (before) return { event: before };
    const endAt = slot.endAt ?? slot.startAt + DEFAULT_EVENT_MIN * MIN;
    if (setBy === 'agent') calendar.refuseFixed(ownerId, { startAt: slot.startAt, endAt });
    const event = calendar.insert({ ...calendar.fresh(ownerId, 'event', setBy, by, slot.startAt, endAt), title: slot.title, ...notes });
    if (input.clientId) remember(calendar.recentEvents, `${by}:${input.clientId}`, event.id);
    return { event };
  }
  if (!isHumanActor(by)) throw new WorkforceError('bad_request', 'An agent gives the person a to-do with a time through its task tools.');
  const minutes = slot.endAt !== undefined ? Math.max(1, Math.round((slot.endAt - slot.startAt) / MIN)) : undefined;
  const { org, chats, wakes } = s;
  if (!org || !chats || !wakes) throw new WorkforceError('unavailable', 'The Tasks page is not available yet.');
  const { task } = await quickCreate({ ...s, org, chats, wakes }, { text, at: slot.startAt, ...(minutes !== undefined ? { minutes } : {}), ...(input.clientId ? { clientId: input.clientId } : {}) }, by);
  const event = task ? todoRow(task) : undefined;
  if (!task || !event) throw new WorkforceError('internal', 'The to-do was not made.');
  return { event, task };
}

function remember(recent: Map<string, string>, key: string, id: string): void {
  recent.delete(key);
  recent.set(key, id);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
}
