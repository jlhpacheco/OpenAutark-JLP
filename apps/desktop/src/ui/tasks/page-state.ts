// The Tasks page's view state (Quests round 20.11.2026): what is open – a to-do's or quest's detail (in the main zone
// the route's #/tasks/<id>, so Back closes it and a notification or search hit opens it; in the side pane a selection
// of its own, so the pane never moves the main zone), the day shown (the route's ?date=, else today), Day | Week,
// List | Calendar of a one-column page, "At work" and "Done today" open or closed, "Other" only, the one the route's
// ?owner= narrows "At work" to, the to-do whose detail opens on its "Can't do" reason line, the task whose title takes
// the caret ("Rename…"), and each page's input line (its text, files, addressee and "Only me" survive a switch to another
// view; a calendar slot click reads it).
// Owns: these signals and the selection rule. Never: data (page-data.ts, lib/store.ts), renders, or decides lists.

import { signal, type Signal } from '@preact/signals';
import type { Attachment } from '../../shared/model/chat.ts';
import type { QuickTaskTarget } from '../../shared/model/task-center.ts';
import { back, formatRoute, navigate, route } from '../lib/router.ts';
import { NO_CHOICE, type PhraseChoice } from './input-model.ts';

/** Where the page is drawn: the main zone (the route) or the side pane (its own state). */
export type PageScope = 'main' | 'pane';

export const calendarSpan = signal<'day' | 'week'>('day');
/** "At work" is open (the calendar's AI lane shows with it). */
export const workOpen = signal(false);
export const doneOpen = signal(false);
/** "Other" in the quest column: For you shows only to-dos without a quest. */
export const otherOnly = signal(false);
/** A one-column page shows the list or the calendar. */
export const oneColumn = signal<'list' | 'calendar'>('list');
/** The to-do whose detail shows the "Can't do" reason line (the menu's "Can't do…" opens it so). */
export const declining = signal<string | null>(null);
/** The task whose detail puts the caret into its title (the menu's "Rename…"). */
export const renaming = signal<string | null>(null);
/** The side pane's own selection and day. */
const paneSelected = signal<string | null>(null);
const paneDate = signal<string | null>(null);

/** The route's part of the page: the open task, the day, the one "At work" is narrowed to. */
export function routePart(): { task?: string; date?: string; owner?: string } {
  const current = route.value;
  return current.view === 'tasks' ? { task: current.task, date: current.date, owner: current.owner } : {};
}

/** The id whose detail is open (a to-do or a quest), or null. */
export function selected(scope: PageScope): string | null {
  return scope === 'pane' ? paneSelected.value : routePart().task ?? null;
}

/** The detail entry openTask pushed (switching to another task replaces it; closing it goes back). */
let pushed: string | null = null;

/** Opens a to-do's or quest's detail – where the calendar was; the list stays where it is. */
export function openDetail(scope: PageScope, id: string): void {
  if (scope === 'pane') { paneSelected.value = id; return; }
  const current = route.peek();
  if (current.view !== 'tasks') { pushed = null; navigate({ view: 'tasks', task: id }); return; } // from elsewhere: closing shows the page
  if (current.task === id) return;
  const next = { ...current, task: id };
  const switched = !!current.task;
  if (switched && pushed !== formatRoute(current)) pushed = null;
  else pushed = formatRoute(next);
  navigate(next, { replace: switched });
}

/** Closes the detail: the calendar again (Back when the detail was pushed from the page). */
export function closeDetail(scope: PageScope): void {
  if (scope === 'pane') { paneSelected.value = null; return; }
  const current = route.peek();
  if (current.view !== 'tasks' || !current.task) return;
  const wasPushed = pushed === formatRoute(current);
  pushed = null;
  if (wasPushed) back();
  else { const { task: _closed, ...rest } = current; navigate(rest, { replace: true }); }
}

/** The day shown (YYYY-MM-DD), else null for today. */
export function shownDay(scope: PageScope): string | null {
  return scope === 'pane' ? paneDate.value : routePart().date ?? null;
}

/** Shows `date` (null: today) – the route's ?date= in the main zone. */
export function showDay(scope: PageScope, date: string | null): void {
  if (scope === 'pane') { paneDate.value = date; return; }
  const current = route.peek();
  const base = current.view === 'tasks' ? current : { view: 'tasks' as const };
  const { date: _old, ...rest } = base;
  navigate(date ? { ...rest, date } : rest, { replace: true });
}

/** Clears the route's ?owner= ("At work" for everyone again). */
export function clearOwner(): void {
  const current = route.peek();
  if (current.view !== 'tasks' || !current.owner) return;
  const { owner: _owner, ...rest } = current;
  navigate(rest, { replace: true });
}

/** A signal's toggle (the folds). */
export function toggle(flag: Signal<boolean>): void { flag.value = !flag.value; }

/**
 * The input line of a page: its text, what the person did with its time phrases, its field, whether "+" in the quest
 * column made it name a quest, and what its own + set – files for the new to-do, whom it goes to (Send to…), and "Only
 * me" (null: as the settings' "AI helps" says).
 */
export interface Line {
  text: Signal<string>;
  choice: Signal<PhraseChoice>;
  field: { current: HTMLTextAreaElement | null };
  questMode: Signal<boolean>;
  files: Signal<Attachment[]>;
  target: Signal<QuickTaskTarget | undefined>;
  onlyMe: Signal<boolean | null>;
}

const newLine = (): Line => ({
  text: signal(''), choice: signal(NO_CHOICE), field: { current: null }, questMode: signal(false),
  files: signal([]), target: signal(undefined), onlyMe: signal(null),
});

const lines: Record<PageScope, Line> = { main: newLine(), pane: newLine() };

export function lineOf(scope: PageScope): Line { return lines[scope]; }

/** After a line was added: empty again, its choices gone. */
export function clearLine(line: Line): void {
  line.text.value = '';
  line.choice.value = NO_CHOICE;
  line.files.value = [];
  line.target.value = undefined;
  line.onlyMe.value = null;
}
