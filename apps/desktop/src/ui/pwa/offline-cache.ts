// This device's copy of what the app last showed (Sicher-Runde 19.11.2026, D1/D2 – "am Handy nur My Day, keine Knöpfe,
// wenn der PC keine Verbindung hat"): on a phone or in a browser the frame and everything store.loadAll loaded – the
// session, settings, chats list (not messages), agents, to-dos, the open tasks (quests with their to-dos), activity,
// accounts, drafts, the PC's system info and the calendar window – is kept in IndexedDB (pwa/idb.ts, key OFFLINE_KEY) and
// brought back at the next start before the PC answers, so a cold start without the PC opens the whole app with its last
// data; `cachedAt` (lib/store.ts) marks it and the status line says "as of 14:02" (shell/connection-line.ts) until a
// live load replaces it. Written only from live data (loaded, not from the copy, the connection open), at most every
// WRITE_GAP_MS and at once when the page goes to the background (Android may end the process there). A phone the PC
// removed (4403) drops its copy.
// Owns: the copy's shape, its check on reading, applying it to the signals and keeping it current. Never: holds tokens or
// secret values (settings and accounts carry secret ids only), messages or files, writes while the shown data is the
// copy itself, or runs in the desktop window (its runtime is local).

import { batch, effect } from '@preact/signals';
import type { SessionInfo } from '../../shared/api/methods.ts';
import type { Attachment, ConversationSummary } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Account } from '../../shared/model/providers.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Settings, SystemInfo } from '../../shared/model/system.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { calendarWindow } from '../lib/day-store.ts';
import type { CalendarWindow } from '../lib/day-store.ts';
import { rpc } from '../lib/rpc.ts';
import { session } from '../lib/session.ts';
import {
  accounts, activity, agents, archivedAgents, cachedAt, conversations, draftFiles, drafts, loaded, secretDrafts, settings,
  systemInfo, tasks, todos,
} from '../lib/store.ts';
import { idbDelete, idbGet, idbSet } from './idb.ts';

/** The copy's IndexedDB key (the store also holds the record widget's unsent takes). */
export const OFFLINE_KEY = 'offline';
/** Bumped when the shape changes: an older copy is then not used (2: Quests round 20.11.2026 – tasks with kind/at,
 *  no briefing, no handed-off list). */
export const OFFLINE_VERSION = 2;
/** At most one write per this many ms while things change (agents' activity changes often). */
export const WRITE_GAP_MS = 4_000;

export interface OfflineCopy {
  v: typeof OFFLINE_VERSION;
  /** When it was written (the data was live then). */
  at: number;
  session: SessionInfo | null;
  settings: Settings | null;
  systemInfo: SystemInfo | null;
  conversations: ConversationSummary[];
  agents: Agent[];
  archivedAgents: Agent[];
  todos: TaskView[];
  tasks: TaskView[];
  activity: AgentActivity[];
  accounts: Account[];
  drafts: Record<string, string>;
  secretDrafts: Record<string, string[]>;
  draftFiles: Record<string, Attachment[]>;
  calendarWindow: CalendarWindow | null;
}

/** What the signals hold now, as a copy written at `at`. */
export function currentCopy(at: number): OfflineCopy {
  return {
    v: OFFLINE_VERSION, at,
    session: session.peek(), settings: settings.peek(), systemInfo: systemInfo.peek(),
    conversations: conversations.peek(), agents: agents.peek(), archivedAgents: archivedAgents.peek(),
    todos: todos.peek(), tasks: tasks.peek(), activity: activity.peek(), accounts: accounts.peek(),
    drafts: drafts.peek(), secretDrafts: secretDrafts.peek(), draftFiles: draftFiles.peek(),
    calendarWindow: calendarWindow.peek(),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
const record = <T>(value: unknown): Record<string, T> => (isObject(value) ? value as Record<string, T> : {});

function readSession(value: unknown): SessionInfo | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  return (kind === 'owner' || kind === 'device' || kind === 'person') && Array.isArray(value.allowedMethods) && Array.isArray(value.capabilities)
    ? value as unknown as SessionInfo : null;
}

function readWindow(value: unknown): CalendarWindow | null {
  if (!isObject(value) || typeof value.from !== 'number' || typeof value.to !== 'number') return null;
  return isObject(value.list) && Array.isArray(value.list.events) ? value as unknown as CalendarWindow : null;
}

/** A stored value as a copy, or null when it is none of this version (missing parts read as empty). */
export function readCopy(value: unknown): OfflineCopy | null {
  if (!isObject(value) || value.v !== OFFLINE_VERSION || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  return {
    v: OFFLINE_VERSION, at: value.at,
    session: readSession(value.session),
    settings: isObject(value.settings) ? value.settings as unknown as Settings : null,
    systemInfo: isObject(value.systemInfo) ? value.systemInfo as unknown as SystemInfo : null,
    conversations: list(value.conversations), agents: list(value.agents), archivedAgents: list(value.archivedAgents),
    todos: list(value.todos), tasks: list(value.tasks), activity: list(value.activity), accounts: list(value.accounts),
    drafts: record(value.drafts), secretDrafts: record(value.secretDrafts), draftFiles: record(value.draftFiles),
    calendarWindow: readWindow(value.calendarWindow),
  };
}

/** Shows the copy – only while nothing live is loaded (a live load that came first wins). True when applied. */
export function applyCopy(copy: OfflineCopy): boolean {
  if (loaded.peek()) return false;
  batch(() => {
    session.value = copy.session;
    settings.value = copy.settings;
    systemInfo.value = copy.systemInfo;
    conversations.value = copy.conversations;
    agents.value = copy.agents;
    archivedAgents.value = copy.archivedAgents;
    todos.value = copy.todos;
    tasks.value = copy.tasks;
    activity.value = copy.activity;
    accounts.value = copy.accounts;
    drafts.value = { ...copy.drafts, ...drafts.peek() };
    secretDrafts.value = { ...copy.secretDrafts, ...secretDrafts.peek() };
    draftFiles.value = { ...copy.draftFiles, ...draftFiles.peek() };
    calendarWindow.value = copy.calendarWindow;
    cachedAt.value = copy.at;
    loaded.value = true;
  });
  return true;
}

/** At start (main.tsx, before the PC answers): the stored copy, when there is one. True when it is shown. */
export async function restoreOfflineCopy(read: () => Promise<unknown> = () => idbGet<unknown>(OFFLINE_KEY)): Promise<boolean> {
  const copy = readCopy(await read().catch(() => undefined));
  return copy ? applyCopy(copy) : false;
}

export interface WatchOptions {
  write?: (copy: OfflineCopy) => Promise<void>;
  forget?: () => Promise<void>;
  gapMs?: number;
  now?: () => number;
}

/**
 * Keeps the stored copy current: after a change of the live data, one write within `gapMs` (with what is there then),
 * at once when the page is hidden or left; the copy is dropped when this phone was removed (4403). Returns the stop.
 */
export function watchOfflineCopy(options: WatchOptions = {}): () => void {
  const write = options.write ?? ((copy) => idbSet(OFFLINE_KEY, copy));
  const forget = options.forget ?? (() => idbDelete(OFFLINE_KEY));
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const live = () => loaded.peek() && cachedAt.peek() === null && rpc.status.peek() === 'open';
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (live()) void write(currentCopy(now())).catch(() => undefined);
  };
  const stopData = effect(() => {
    void [session.value, settings.value, systemInfo.value, conversations.value, agents.value, archivedAgents.value, todos.value,
      tasks.value, activity.value, accounts.value, drafts.value, secretDrafts.value, draftFiles.value, calendarWindow.value,
      loaded.value, cachedAt.value, rpc.status.value];
    if (!live() || timer) return;
    timer = setTimeout(flush, options.gapMs ?? WRITE_GAP_MS);
  });
  const stopRemoved = effect(() => { if (rpc.refused.value === 4403) void forget().catch(() => undefined); });
  const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
  const page = typeof document !== 'undefined' && typeof window !== 'undefined';
  if (page) { document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', flush); }
  return () => {
    stopData();
    stopRemoved();
    if (timer) clearTimeout(timer);
    timer = null;
    if (page) { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flush); }
  };
}
