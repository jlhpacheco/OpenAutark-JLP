// RPC contract part (B-041, Quests round 20.11.2026): the Tasks page's calendar (shared/model/calendar.ts). Handlers: runtime/rpc/handlers/calendar.ts,
// delegating to services.calendar / services.calendarSources ('unavailable' while one is missing). Tiers: the
// person's own rows (list, add, move, remove) with 'todo' – a To-do-only phone plans its day too; reading the
// connected calendars with 'settings'; adding, changing, syncing and connecting them stays with the owner (an ICS
// address and the Google sign-in are credentials of this PC). No person variants in this build (a colleague's
// own calendar comes later). Merged into Methods by module augmentation (methods.ts is at its size limit).
// Owns: these method shapes. Never: behaviour.

import type { CalendarEvent, CalendarList, CalendarSource } from '../model/calendar.ts';
import type { TaskView } from '../model/tasks.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** 'todo': the owner's rows overlapping [from, to) (at most 62 days) – events, their to-dos with a time, done ones at the time
     *  they were done, the agents' to-dos on the AI lane – with the tasks those rows show, the agents' runs, the zone and stale
     *  sources; with `agentId` only that agent's to-dos and runs, capped for it alone (the agent page's Day). */
    'calendar.list': { params: { from: number; to: number; agentId?: string }; result: CalendarList };
    /** 'todo': a click into a free slot – 'auto' lets the text decide; a to-do is the person's line at that time (tasks.quickCreate's flow). */
    'calendar.add': { params: { text: string; startAt: number; endAt?: number; kind?: 'auto' | 'todo' | 'event'; clientId?: string }; result: { event: CalendarEvent; task?: TaskView } };
    /** 'todo': moves a row made on `rev` ('conflict' when it changed since): an event becomes the person's (pinned), a to-do gets that time. */
    'calendar.move': { params: { id: string; startAt: number; endAt: number; rev: number }; result: CalendarEvent };
    /** 'todo': removes an event; a to-do only loses its time (the to-do stays). */
    'calendar.remove': { params: { id: string }; result: void };
    /** 'settings': the connected calendars (no addresses, no tokens). */
    'calendar.sources': { params: void; result: CalendarSource[] };
    /** Owner: a read-only calendar by its ICS address (stored in the vault, bound to its host); `room` (a room's name or room:… id): it belongs to that room. */
    'calendar.addIcs': { params: { url: string; label?: string; room?: string }; result: CalendarSource };
    /** Owner: a source's label, visibility or colour. */
    'calendar.updateSource': { params: { id: string; label?: string; visible?: boolean; color?: string }; result: CalendarSource };
    /** Owner: removes a source and its mirrored rows. */
    'calendar.removeSource': { params: { id: string }; result: void };
    /** Owner: syncs one source now (or all). */
    'calendar.sync': { params: { id?: string }; result: CalendarSource[] };
    /** Owner: Google configured / connected; `waiting` while the consent is open, `error` the last connect failure. */
    'calendar.google': { params: void; result: { configured: boolean; connected: boolean; sourceId?: string; waiting?: boolean; error?: string } };
    /** Owner: starts the Google consent in the system browser (loopback + PKCE); the source appears once it completes. */
    'calendar.connectGoogle': { params: { clientId?: string }; result: { authUrl: string } };
  }
}

export {};
