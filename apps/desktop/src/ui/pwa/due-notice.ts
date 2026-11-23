// Due notices on the phone (17.11.2026, the owner: three stacked cards "Due: 2 minutes at the PC …", "Due: Recording …" that "bleiben viel zu lange, nervenvoll"):
// the runtime pushes one notice per to-do that falls due (runtime/tasks/watch.ts "Due: <title>", kind 'todo', each under its own tag). The worker keeps ONE
// of them – the tag "due" – that names what is due now ("Due: Call the tax office", then "3 to-dos due" with their titles), replaces the earlier one quietly
// instead of stacking, and closes it by itself after DUE_SHOW_MS (a tap on it still opens the Tasks page). Pure: it decides the text and the data; sw-notify.ts shows it.
// Owns: what a Due notice says and how long it stays. Never: shows, closes or sends anything.

import type { PushPayload } from './sw-notify.ts';

/** How long a Due notice stays before the worker closes it. */
export const DUE_SHOW_MS = 6_000;
/** The one tag every Due notice shares. */
export const DUE_TAG = 'due';
/** Titles kept in the grouped notice. */
const MAX_ITEMS = 5;
/** What the runtime puts in front of a due to-do's title. */
const DUE_PREFIX = /^Due: /;

/** True for the push of a to-do that fell due (kind 'todo', "Due: …"). */
export function isDuePush(payload: Pick<PushPayload, 'kind' | 'title' | 'clear'>): boolean {
  return !payload.clear && payload.kind === 'todo' && typeof payload.title === 'string' && DUE_PREFIX.test(payload.title);
}

export interface DueData { due: true; items: string[]; stamp: number }

/** The titles a Due notice already open stands for (its data), oldest first. */
export function dueItems(data: unknown): string[] {
  const items = (data as { due?: unknown; items?: unknown } | null)?.items;
  return (data as { due?: unknown } | null)?.due === true && Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
}

/** The grouped notice: this push joins the titles already open (each once, the newest five); one title keeps its own text, more say how many. */
export function groupDue(payload: PushPayload, open: readonly string[], now: number): { payload: PushPayload; data: DueData } {
  const title = (payload.title ?? '').replace(DUE_PREFIX, '').trim();
  const items = [...open.filter((item) => item !== title), ...(title ? [title] : [])].slice(-MAX_ITEMS);
  const many = items.length > 1;
  return {
    payload: { ...payload, tag: DUE_TAG, title: many ? `${items.length} to-dos due` : payload.title, body: many ? items.join(' · ') : payload.body ?? '' },
    data: { due: true, items, stamp: now },
  };
}
