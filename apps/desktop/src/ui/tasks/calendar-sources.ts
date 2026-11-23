// The connected calendars the Tasks page shows (Google, ICS; calendar.sources – reloaded on the owner's
// 'calendar.sources' event while a view shows them) and which of them the person switched off (their events stay out
// of the calendar). A room's calendar is listed in Settings › Calendar only.
// Owns: these signals and the show/hide call. Never: connects a calendar (the AI does, from the quest column's
// "Connect a calendar…") or renders.

import { computed, signal } from '@preact/signals';
import type { CalendarSource } from '../../shared/model/calendar.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';

/** The connected calendars (empty where they may not be read). */
export const sources = signal<CalendarSource[]>([]);
/** Sources the person switched off: their events are not shown. */
export const hiddenSources = computed(() => new Set(sources.value.filter((source) => !source.visible).map((source) => source.id)));

async function loadSources(): Promise<void> {
  if (!can('calendar.sources')) return;
  try { sources.value = (await rpc.call('calendar.sources')).filter((source) => !source.ownerId.startsWith('room:')); } catch { /* keep what is shown */ }
}

let users = 0;
let off: (() => void) | undefined;
/** A view that shows the sources: loads them and follows 'calendar.sources' while one is mounted. */
export function watchSources(): () => void {
  users++;
  if (users === 1) {
    void loadSources();
    off = rpc.on('calendar.sources', () => { void loadSources(); });
  }
  return () => {
    users--;
    if (users === 0) { off?.(); off = undefined; }
  };
}

/** Shows or hides a connected calendar (owner only: calendar.updateSource). */
export async function setSourceVisible(source: CalendarSource, visible: boolean): Promise<void> {
  const before = sources.peek();
  sources.value = before.map((entry) => (entry.id === source.id ? { ...entry, visible } : entry));
  try {
    const saved = await rpc.call('calendar.updateSource', { id: source.id, visible });
    sources.value = sources.peek().map((entry) => (entry.id === saved.id ? saved : entry));
  } catch (error) {
    sources.value = before;
    toastError(error, 'Could not change the calendar');
  }
}
