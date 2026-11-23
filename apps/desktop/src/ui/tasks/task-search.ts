// The Tasks page's search (the magnifier in its head; on a phone in the top row): while it holds words the list shows
// every quest and to-do they find – what the page knows (open work and what finished today, by the shared stem rule,
// shared/text/normalize.ts matchesQuery), plus older ones the runtime finds (tasks.list search, asked once the typing
// pauses) – open ones first, then the newest. A hit opens its detail like any row.
// Owns: the search state, its header data and the hits. Never: renders, or keeps the hits beyond the open search.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { matchesQuery } from '../../shared/text/normalize.ts';
import type { HeaderSearchState } from '../lib/header.tsx';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { isOpen } from './page-model.ts';

export const taskSearch = signal({ open: false, query: '' });

/** The search as header data (the page's head and the phone's top row share it). */
export function searchState(): HeaderSearchState {
  const state = taskSearch.value;
  return {
    label: 'Search tasks', open: state.open, query: state.query, placeholder: 'Search quests and to-dos',
    onQuery: (query) => { taskSearch.value = { ...taskSearch.peek(), query }; },
    onOpenChange: (open) => { taskSearch.value = open ? { ...taskSearch.peek(), open } : { open: false, query: '' }; },
  };
}

/** Hits for `query` among `known`, merged with `found` (the runtime's), open ones first, then the newest. */
export function searchHits(known: Iterable<Task>, found: readonly Task[], query: string): Task[] {
  if (!query.trim()) return [];
  const byId = new Map<string, Task>();
  for (const task of known) if (matchesQuery(`${task.title} ${task.notes}`, query)) byId.set(task.id, task);
  for (const task of found) if (!byId.has(task.id)) byId.set(task.id, task);
  return [...byId.values()].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt - a.updatedAt).slice(0, 60);
}

/** The runtime's hits for the query, asked 300 ms after the typing stops. */
export function useFound(query: string): Task[] {
  const [found, setFound] = useState<Task[]>([]);
  useEffect(() => {
    const words = query.trim();
    if (!words || !can('tasks.list')) { setFound([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      rpc.call('tasks.list', { search: words, includeSteps: true, limit: 40 }).then((list) => { if (live) setFound(list); }, () => undefined);
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  return found;
}
