// Calendar tools for agents (Quests round 20.11.2026: two instead of seven). calendar.list reads the person's days –
// appointments from their connected calendars (untrusted data, marked like web results – calendar/agent-view.ts), their
// to-dos with a time, and with `minutes` the free gaps of that length within working hours, per day –; with `who`
// (B-078 D20: colleagues per_…, 'owner' on an employee's PC, rooms room:…, calendar/members.ts) the busy times and the
// gaps they share; titles go only to the one person who alone reads the turn (calendar/team.ts). An appointment I set for
// the person is their to-do with a time (tasks.add), moved or removed with tasks.update. calendar.connect lists, adds,
// syncs or removes connected calendars (ICS, Google). Times in the person's zone (tools/builtin/util.ts parseWhen).
// Owns: these tool definitions. Never: writes an appointment itself, or writes to an outside calendar (the sources' mirror does).

import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { WHEN_PROPERTY, failure, json } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { isLocalDate } from '../../../shared/model/calendar.ts';
import { addDays, wallOf, wallTime } from '../../../shared/text/when.ts';
import '../../contracts/calendar.ts';
import { agentEntry, spanText, turnPerson, UNTRUSTED_NOTE } from '../../calendar/agent-view.ts';
import { resolveMember, roomId, rooms, whoList, type Member } from '../../calendar/members.ts';
import { freeTogether, membersBusy } from '../../calendar/team.ts';
import { profileZone } from '../../context/time.ts';
import { GOOGLE_ICS_WAY } from '../../calendar/sources/google.ts';
import { authorName, clip, defineTool, internal, parseWhen, readChat } from './util.ts';

const DAY = 24 * 60 * 60_000;
const MAX_LIST_DAYS = 31;
const MAX_GAP_DAYS = 7;
const MAX_FREE = 8;
const WHO = {
  anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, minItems: 1, maxItems: 12 }],
  description: '"human" (the person, default), a colleague\'s per_… id, "owner" (on an employee\'s PC: the CEO) or a room:… id; one or a list.',
};

/** The members `who` names (default: the person), or why not. */
function membersOf(ctx: ToolContext, who: unknown): Member[] | ToolOutput {
  const ids = who === undefined ? [HUMAN_ID] : whoList(who);
  if (typeof ids === 'string') return failure(ids);
  return ids.map((id) => resolveMember(ctx.services, id, (person) => authorName(ctx, person)));
}

const isOutput = (value: unknown): value is ToolOutput => typeof value === 'object' && value !== null && 'content' in value;

/** A refusal of the service as a tool result (its message is meant for the agent). */
function refused(error: unknown): ToolOutput {
  if (error instanceof WorkforceError && ['conflict', 'bad_request', 'not_found'].includes(error.code)) return failure(error.message);
  throw error;
}

/** [from, to) the call names: from its start of day (default today), to the end of a bare date (default the day after from). */
function rangeOf(args: { from?: string; to?: string }, now: number, tz: string): { from: number; to: number } | string {
  const from = args.from?.trim() ? parseWhen(args.from, now, tz) : wallTime(wallOf(now, tz).date, 0, tz);
  if (from === undefined) return `I cannot read from "${clip(args.from ?? '', 60)}".`;
  const end = args.to?.trim();
  const to = !end ? wallTime(addDays(wallOf(from, tz).date, 2), 0, tz) : isLocalDate(end) ? wallTime(addDays(end, 1), 0, tz) : parseWhen(end, now, tz);
  if (to === undefined || to <= from) return 'Give to as a time after from.';
  if (to - from > MAX_LIST_DAYS * DAY) return `Read at most ${MAX_LIST_DAYS} days at once.`;
  return { from, to };
}

/** The free gaps of `minutes` on each day of the range (up to MAX_GAP_DAYS), for everyone named together. */
async function gapsOf(ctx: ToolContext, members: Member[], range: { from: number; to: number }, minutes: number, tz: string) {
  const now = ctx.services.clock.now();
  const days: Array<{ date: string; free: Array<{ start: string; end: string; when: string }> }> = [];
  const unreachable = new Map<string, string>();
  for (let date = wallOf(range.from, tz).date; wallTime(date, 0, tz) < range.to && days.length < MAX_GAP_DAYS; date = addDays(date, 1)) {
    const found = await freeTogether(ctx.services, members, date, minutes, now, tz, ctx.signal);
    found.unreachable.forEach((member) => unreachable.set(member.name, member.why));
    days.push({ date, free: found.free.slice(0, MAX_FREE).map((gap) => ({ start: new Date(gap.startAt).toISOString(), end: new Date(gap.endAt).toISOString(), when: spanText(gap.startAt, gap.endAt, tz) })) });
  }
  return { free: days, ...(unreachable.size ? { unreachable: [...unreachable].map(([name, why]) => `${name}: ${why}`) } : {}) };
}

const listCalendar = defineTool<{ from?: string; to?: string; who?: string | string[]; minutes?: number }>({
  name: 'calendar.list',
  description: "Reads the person's days: appointments from their connected calendars, to-dos with a time, and the free gaps of a given length.",
  inputSchema: {
    type: 'object',
    properties: {
      from: { ...WHEN_PROPERTY, description: `Default today's start. ${String(WHEN_PROPERTY.description)}` },
      to: { ...WHEN_PROPERTY, description: 'A bare date means its end; default the end of the day after from.' },
      who: WHO,
      minutes: { type: 'integer', minimum: 5, maximum: 720, description: 'The free gaps of this length within working hours, per day (for several people: the ones they share).' },
    },
    additionalProperties: false,
  },
  category: 'read',
  describe: () => internal('Read the calendar'),
  async run(args, ctx) {
    const calendar = ctx.services.calendar;
    if (!calendar) return failure('The calendar is not available.');
    const tz = profileZone(ctx.services);
    const range = rangeOf(args, ctx.services.clock.now(), tz);
    if (typeof range === 'string') return failure(range);
    const members = membersOf(ctx, args.who);
    if (isOutput(members)) return members;
    const gaps = args.minutes ? await gapsOf(ctx, members, range, args.minutes, tz) : {};
    const span = { tz, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() };
    const only = members.length === 1 ? members[0] : undefined;
    if (!only || only.where !== 'here' || only.ownerId !== turnPerson(ctx.services.db, readChat(ctx))) {
      const busy = await membersBusy(ctx.services, members, range.from, range.to, tz, ctx.signal);
      return json({ ...span, members: busy, ...gaps, note: 'Busy times: I read titles only of the person whose calendar it is, in a turn only they read.' });
    }
    const list = calendar.list(only.ownerId, range.from, range.to);
    const entries = list.events.map((row) => {
      const task = row.taskId ? ctx.services.tasks.get(row.taskId) : undefined;
      return agentEntry(row, task, list.tz);
    });
    const untrusted = entries.some((entry) => entry.source === 'connected');
    return json({ ...span, tz: list.tz, entries, ...gaps, ...(untrusted ? { note: UNTRUSTED_NOTE } : {}),
      ...(list.staleSources.length ? { stale: 'A connected calendar was not synced for over a day; it may miss appointments.' } : {}) });
  },
});

/**
 * The person's connected calendars (ICS addresses, Google), set up by the agent: list them, add an ICS address (Google's
 * "secret address in iCal format" works too), remove one, sync now, or start the Google sign-in – its link goes to the
 * person, who confirms in the browser. Never shows an address or token. 'google' without the person's own Google client
 * answers with the iCal way (GOOGLE_ICS_WAY).
 */
const connectCalendar = defineTool<{ action: 'list' | 'add_ics' | 'remove' | 'sync' | 'google'; url?: string; label?: string; sourceId?: string; room?: string }>({
  name: 'calendar.connect',
  description: "Lists, adds, syncs or removes the person's and the rooms' connected calendars; once added, a calendar shows on the Tasks page and calendar.list reads it. A Google calendar connects through its secret address in iCal format (Google Calendar › Settings › the calendar › Integrate calendar), which I read where that Google account is signed in – the person's pane or their Chrome; add_ics takes it.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add_ics', 'remove', 'sync', 'google'], description: "list (also room ids), add_ics, remove, sync, or google: a sign-in link for the person when this app has their own Google client (list: google.configured)." },
      url: { type: 'string', maxLength: 2000, description: "An https ICS address – Google's secret iCal address works." },
      label: { type: 'string', maxLength: 80 }, sourceId: { type: 'string', maxLength: 100, description: 'For remove or sync; sync without it: all.' },
      room: { type: 'string', minLength: 1, maxLength: 80, description: 'The room it belongs to.' },
    },
    required: ['action'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => ({ summary: `Connected calendars: ${args.action}${args.label ? ` "${clip(args.label, 60)}"` : ''}`, reversible: true, external: args.action !== 'list' }),
  async run(args, ctx) {
    const sources = ctx.services.calendarSources;
    if (!sources) return failure('Connected calendars are not available.');
    const shown = (list: readonly { id: string; kind: string; label: string; status: string; visible: boolean; lastSyncAt?: number; error?: string }[]) =>
      list.map(({ id, kind, label, status, visible, lastSyncAt, error }) => ({ id, kind, label, status, visible, ...(lastSyncAt ? { lastSync: new Date(lastSyncAt).toISOString() } : {}), ...(error ? { error } : {}) }));
    try {
      switch (args.action) {
        case 'list': {
          const known = rooms(ctx.services.db).map((room) => ({ id: room.id, name: room.name, sources: shown(sources.list(room.id)) }));
          return json({ sources: shown(sources.list(HUMAN_ID)), ...(known.length ? { rooms: known } : {}), google: sources.google() });
        }
        case 'add_ics': {
          if (!args.url?.trim()) return failure('Give url: the calendar\'s https ICS address.');
          const room = args.room === undefined ? undefined : roomId(args.room);
          if (args.room !== undefined && !room) return failure('Give room as a name with letters or digits ("Meeting room 2").');
          const input = { url: args.url.trim(), ...(args.label || args.room ? { label: args.label || args.room!.trim() } : {}), ...(room ? { room } : {}) };
          const source = await sources.addIcs(input, HUMAN_ID);
          return json({ ok: true, source: shown([source])[0], ...(room ? { room, note: 'Rooms are read-only ICS calendars here.' } : {}) });
        }
        case 'remove':
          if (!args.sourceId) return failure('Give sourceId (action "list" shows them).');
          await sources.remove(args.sourceId, HUMAN_ID);
          return json({ ok: true });
        case 'sync': return json({ ok: true, sources: shown(await sources.sync(args.sourceId, 'agent')) });
        case 'google':
          if (!sources.google().configured) return failure(`${GOOGLE_ICS_WAY} add_ics takes it.`);
          return json({ ok: true, link: (await sources.connectGoogle()).authUrl, note: 'I send this link to the person; the calendar appears once they confirm.' });
      }
    } catch (error) { return refused(error); }
  },
});

export const calendarTools: ToolDef[] = [listCalendar, connectCalendar];
