// The input line's time rule, pure (owner 20.11.2026: "morgen … dass am Freitag" must not be read as Friday): the
// time phrases findTimes marks blue in the typed text, and which one becomes the to-do's time – a single phrase with a
// clock time is used at once (its × drops it); a day alone ("Freitag", "morgen") or two or more phrases are offered
// outlined: one click uses one, else the assistant decides when it sorts the line. The same rule serves a to-do's time
// field in its detail. What Enter makes of the line: one to-do per non-empty line (typed or pasted; dictation stays one
// line and the assistant splits it), each title without the used phrase when it stands in that line, its time there; a
// click into a calendar slot gives every line the slot's time instead (the used phrase still leaves its title). A day
// without a time is that day's start without minutes (shared/model/day-settings.ts isDayOnly); a clock time at 00:00
// carries minutes, so it stays a time.
// Owns: that rule, the line's to-dos and a time field's patch. Never: finds times itself (shared/text/when.ts), the
// DOM, rpc or a clock.

import { DEFAULT_MINUTES } from '../../shared/model/calendar.ts';
import { isDayOnly } from '../../shared/model/day-settings.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { stripTime, type TimePhrase } from '../../shared/text/when.ts';

/** A phrase's key across keystrokes (spans move while typing; its words do not). */
export function phraseKey(phrase: Pick<TimePhrase, 'text'>): string {
  return phrase.text.trim().toLowerCase();
}

/** What the person did with the phrases: the one they picked, and the ones they dropped with ×. */
export interface PhraseChoice { picked: string | null; dropped: ReadonlySet<string> }

export const NO_CHOICE: PhraseChoice = { picked: null, dropped: new Set() };

/** The phrase that gives the to-do its time: the picked one, else the only one when it names a clock time and was not dropped. */
export function usedPhrase(phrases: readonly TimePhrase[], choice: PhraseChoice): TimePhrase | undefined {
  if (choice.picked !== null) return phrases.find((phrase) => phraseKey(phrase) === choice.picked);
  const only = phrases.length === 1 ? phrases[0] : undefined;
  return only && !only.allDay && !choice.dropped.has(phraseKey(only)) ? only : undefined;
}

/** Picking a phrase uses it (and takes back an earlier ×); × on the used one drops it. */
export function pick(choice: PhraseChoice, phrase: TimePhrase): PhraseChoice {
  const key = phraseKey(phrase);
  const dropped = new Set(choice.dropped);
  dropped.delete(key);
  return { picked: key, dropped };
}

export function drop(choice: PhraseChoice, phrase: TimePhrase): PhraseChoice {
  const key = phraseKey(phrase);
  return { picked: choice.picked === key ? null : choice.picked, dropped: new Set([...choice.dropped, key]) };
}

/** The time a phrase gives a to-do (`zone`: the person's): a day alone without minutes, a clock time at 00:00 with them. */
export function phraseTime(phrase: TimePhrase, zone?: string): { at: number; minutes?: number } {
  return !phrase.allDay && isDayOnly({ at: phrase.at }, zone) ? { at: phrase.at, minutes: DEFAULT_MINUTES } : { at: phrase.at };
}

export interface LineTodo { title: string; at?: number; minutes?: number }

/** The non-empty lines of the text with where each starts in it. */
function linesOf(text: string): Array<{ line: string; start: number }> {
  const out: Array<{ line: string; start: number }> = [];
  let start = 0;
  for (const part of text.split('\n')) {
    const line = part.endsWith('\r') ? part.slice(0, -1) : part;
    if (line.trim()) out.push({ line, start });
    start += part.length + 1;
  }
  return out;
}

/** The to-dos Enter (or a slot click at `slotAt`) makes of the line – one per non-empty line; empty for an empty line. */
export function lineTodos(text: string, used: TimePhrase | undefined, slotAt?: number, zone?: string): LineTodo[] {
  return linesOf(text).map(({ line, start }) => {
    const here = used && used.start >= start && used.end <= start + line.length ? used : undefined;
    const title = (here ? stripTime(line, { start: here.start - start, end: here.end - start }) : '') || line.trim();
    if (slotAt !== undefined) return { title, at: slotAt, minutes: DEFAULT_MINUTES };
    return here ? { title, ...phraseTime(here, zone) } : { title };
  });
}

/** The hint under the line: how many to-dos Enter makes, or what it will do with the time. */
export function lineHint(text: string, phrases: readonly TimePhrase[], used: TimePhrase | undefined): string {
  if (!text.trim()) return 'A time in your words goes on the calendar · /15:00 works too';
  const lines = linesOf(text).length;
  if (lines > 1) return `${lines} to-dos – one per line`;
  if (used) return 'or click a time in the calendar';
  if (phrases.length > 1) return 'Pick the time you mean – or the assistant decides';
  if (phrases.length === 1) return phrases[0].allDay ? 'Click the day to use it – or the assistant decides' : 'No time – it goes on your list';
  return 'No time – it goes on your list. Click a time in the calendar to place it';
}

/** What a to-do's time field sends (tasks.update): the phrase's time – a clock time keeps the to-do's length –, or none. */
export function timePatch(task: Pick<Task, 'minutes'>, phrase: TimePhrase | null, zone?: string): { at: number | null; minutes: number | null } {
  if (!phrase) return { at: null, minutes: null };
  const time = phraseTime(phrase, zone);
  if (phrase.allDay) return { at: time.at, minutes: null };
  return { at: time.at, minutes: task.minutes ?? time.minutes ?? null };
}
