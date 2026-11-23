// day.* – COMPATIBILITY ONLY (0.3.16/0.3.17 clients: a cached PWA page, an old phone UI). B-041 My day became the Tasks page
// (Quests round 20.11.2026): the line is tasks.quickCreate, the planner, the morning briefing and DayService are gone, so
// the four old methods answer on today's primitives and nothing more – no service, no scheduler, no new permission:
//   day.add       – every non-empty line is the person's own to-do through the one intake (tasks/quick.ts, no `target`, so
//                   it is never handed to anyone); `date` is checked and not kept (to-dos have no day-only window any more).
//   day.plan      – no planner any more: an empty result (nothing placed, moved or unplanned).
//   day.briefing  – there is no briefing any more: null, which the old page reads as "none".
//   day.handedOff – what the person gave that others own, as before (open, plus done since last evening).
// Scope exactly as in 0.3.17: the owner and devices holding 'todo'; external agents have none. Devices act as the owner ('human').
// Owns: parameter checks and these four answers. Never: a rule of its own, a write other than the person's own to-dos.

import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import '../../../shared/api/methods-day.ts'; // the method shapes (module augmentation)
import { isLocalDate } from '../../../shared/model/calendar.ts';
import { DAY_BOUNDARY_HOUR, clockMinutes, daySettingsOf } from '../../../shared/model/day-settings.ts';
import { UNFINISHED, type TaskView } from '../../../shared/model/tasks.ts';
import { addDays, wallOf, wallTime } from '../../../shared/text/when.ts';
import { quickCreate } from '../../tasks/quick.ts';
import { bad, input, oneOf, onlyKeys, optBool, optNum, optText, text, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const PLAN_MODES = ['plan', 'replan'] as const;
const MAX_TEXT = 8000;
const MAX_ITEMS = 50;

/** A local calendar day 'YYYY-MM-DD' that exists. */
function date(o: Obj): string {
  const value = text(o, 'date', { max: 10 });
  if (!isLocalDate(value)) bad('date', 'a day as YYYY-MM-DD');
  return value;
}

function zoneOf(ctx: HandlerContext): string {
  try {
    const tz = ctx.services.settings?.get().profile.timezone;
    if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; }
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** "Since last evening": the end of the working hours of the day before the current day (the day turns at DAY_BOUNDARY_HOUR). */
function lastEvening(ctx: HandlerContext): number {
  const tz = zoneOf(ctx);
  const now = wallOf(ctx.services.clock.now(), tz);
  const today = now.minutes < DAY_BOUNDARY_HOUR * 60 ? addDays(now.date, -1) : now.date;
  const end = clockMinutes(daySettingsOf(ctx.services.settings?.get()).workEnd) ?? 18 * 60;
  return wallTime(addDays(today, -1), end, tz);
}

/** Work the person gave that someone else owns (an agent, a colleague) – a top-level task. */
function isHandedOff(task: TaskView): boolean {
  if ((task.assignedBy ?? task.createdBy) !== HUMAN_ID || task.parentId) return false;
  return !(task.assigneeKind === 'human' && (task.assigneeId === undefined || task.assigneeId === HUMAN_ID));
}

export function register(table: HandlerTable): void {
  table.add('day.add', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'private', 'clientId', 'date']);
    if (o.date !== undefined && o.date !== null) date(o); // checked, not kept (see the header)
    const all = text(o, 'text', { max: MAX_TEXT, multiline: true });
    const lines = all.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, MAX_ITEMS);
    if (!lines.length) throw new WorkforceError('bad_request', 'Type what you want to do.');
    const priv = optBool(o, 'private');
    const clientId = optText(o, 'clientId', { max: 100 });
    const tasks: TaskView[] = [];
    for (const [index, line] of lines.entries()) {
      const made = await quickCreate(ctx.services, { text: line, ...(priv !== undefined ? { private: priv } : {}), ...(clientId ? { clientId: `day:${clientId}#${index}` } : {}) }, HUMAN_ID);
      tasks.push(made.task);
    }
    return { tasks };
  }, TODO);

  table.add('day.plan', (params) => {
    const o = input(params);
    onlyKeys(o, ['date', 'mode']);
    const day = date(o);
    oneOf(o, 'mode', PLAN_MODES);
    return { date: day, placed: [], moved: [], unplanned: [], staleSources: [] };
  }, TODO);

  table.add('day.briefing', (params) => {
    const o = input(params);
    onlyKeys(o, ['date']);
    date(o);
    return null;
  }, TODO);

  table.add('day.handedOff', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['since']);
    const since = optNum(o, 'since', { min: 0 }) ?? lastEvening(ctx);
    const tasks = ctx.services.tasks;
    const open = tasks.list({ status: [...UNFINISHED], limit: 1000 }).filter(isHandedOff);
    const done = tasks.list({ completedSince: since, limit: 200 }).filter((task) => task.status === 'done' && isHandedOff(task));
    return [...open, ...done];
  }, TODO);
}
