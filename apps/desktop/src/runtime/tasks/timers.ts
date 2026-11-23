// The widget of a human to-do and its time (F02, Quests round 20.11.2026: the ring is the to-do's own `at` – the watcher
// pushes the person then, tasks/watch.ts – and no schedule row rings any more):
//  * prepareWidget (pure): an agent's widget goes through the catalog's validation with coercion (invalid → a precise
//    'bad_request' the agent gets back, with the type's catalog signature); widgets the runtime built itself (typed
//    to-dos, "Show as…", the verifier's review to-do) are kept as they are. A timer's duration ("PT10M") becomes an
//    absolute `at` from the creation time (the duration stays for display), a wall time is read in the person's zone
//    (tools/builtin/util.ts parseWhen), and that time is the to-do's `at`;
//  * nextRepeat: a repeating timer (repeat daily | weekdays | weekly) ticked off – its next time at the same clock time;
//  * snoozeUntil: a legacy snooze answer ({event:'snoozed', minutes?|until?}) → when.
// Owns: those rules. Never: arms agent tasks, or creates a schedule for a to-do.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { specFor, type UiBlock } from '../../shared/blocks/catalog.ts';
import { validateBlock } from '../../shared/blocks/validate.ts';
import { isAskBlock } from './widgets.ts';
import { parseWhen } from '../tools/builtin/util.ts';

const DAY_MS = 86_400_000;

/**
 * The widget as stored and the time it implies. `by` is who made it: an agent's widget is
 * validated; the person's and the system's are the runtime's own. `zone` is the person's (day/clock.ts dayZone).
 */
export function prepareWidget(widget: UiBlock, from: number, by: string, zone: string): { widget: UiBlock; at?: number } {
  let block = widget;
  if (by !== HUMAN_ID && by !== SYSTEM_ID) {
    const checked = validateBlock(widget);
    if (!checked.ok) {
      const shape = specFor(String(checked.type ?? widget.type))?.signature; // B-080: the catalog's signature, e.g. checklist{items:[text|{text,done?}]}
      throw new WorkforceError('bad_request', `Invalid ${widget.type ?? 'widget'} widget: ${checked.error}.${shape ? ` Its shape: ${shape}` : ''}`, { details: { param: 'widget' } });
    }
    if (!isAskBlock(checked.block)) throw new WorkforceError('bad_request', `A to-do needs an ask widget, not "${checked.block.type}".`, { details: { param: 'widget' } });
    const { todo: _ingestOnly, ...rest } = checked.block; // "todo" only steers ingestBlocks
    block = rest as UiBlock;
  }
  if (block.type !== 'timer') return { widget: block };
  const at = parseWhen(block.at, from, zone) ?? parseWhen(block.duration, from, zone);
  if (at === undefined) return { widget: block };
  return { widget: { ...block, at: new Date(at).toISOString() }, at };
}

/** The repeat of a timer widget, if it has one. */
export function repeatOf(widget: UiBlock | undefined): 'daily' | 'weekdays' | 'weekly' | undefined {
  const repeat = widget?.type === 'timer' ? widget.repeat : undefined;
  return repeat === 'daily' || repeat === 'weekdays' || repeat === 'weekly' ? repeat : undefined;
}

/** The next time of a repeating to-do after `now`, at the clock time of `at` (this process's zone). */
export function nextRepeat(repeat: 'daily' | 'weekdays' | 'weekly', at: number, now: number): number {
  let next = at;
  for (let guard = 0; guard < 800 && next <= now; guard++) {
    const date = new Date(next);
    date.setDate(date.getDate() + (repeat === 'weekly' ? 7 : 1));
    next = date.getTime();
    if (next > now) break;
  }
  if (next <= now) next = now + DAY_MS; // a time years back: tomorrow
  while (repeat === 'weekdays' && (new Date(next).getDay() === 0 || new Date(next).getDay() === 6)) {
    const date = new Date(next);
    date.setDate(date.getDate() + 1);
    next = date.getTime();
  }
  return next;
}

/** A legacy snooze answer ({event:'snoozed', minutes?|until?}) → when; undefined for other answers. */
export function snoozeUntil(answer: unknown, now: number): number | undefined {
  const value = answer && typeof answer === 'object' ? answer as Record<string, unknown> : undefined;
  if (value?.event !== 'snoozed') return undefined;
  if (typeof value.until === 'number' && Number.isFinite(value.until)) return value.until;
  if (typeof value.until === 'string' && Number.isFinite(Date.parse(value.until))) return Date.parse(value.until);
  const minutes = typeof value.minutes === 'number' && value.minutes > 0 ? Math.min(value.minutes, 7 * 24 * 60) : 10;
  return now + minutes * 60_000;
}
