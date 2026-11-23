// Calendar rows (migration 068 calendar_events; B-041 track A1; Quests round 20.11.2026): SQL for the members' local
// calendar and the mirrored rows of connected sources (shared/model/calendar.ts CalendarEvent) – and the to-dos with a
// time, read from their tasks as rows of kind 'todo' (todoRow: id = taskId = the task's, no title and no notes – the view
// reads the task; never stored): an open one of a person at its `at` for `minutes` (else DEFAULT_MINUTES) – open agent work
// has no row (it has no time of its own, Quests round 20.11.2026) –, a done one at the time it was done (the logbook); a day without a time (shared/model/day-settings.ts isDayOnly) is an all-day row of that day,
// so the Google mirror writes an all-day event and it blocks no hour. A row of a hidden source (calendar_sources.visible = 0) is left out of the window and the busy
// spans. Also used by the sources sync (track G) for its mirrored rows (bySource, bySeries, byExternal, deleteBySource)
// and by the Google mirror (inRange, get – the to-do rows included).
// Owns: SQL for calendar_events, the to-do rows' read and the staleness read of calendar_sources. Never: emits events,
// writes tasks, stores task text, or decides who may change a row (runtime/calendar/service.ts).

import { bool, int, type Db } from '../db/database.ts';
import { nul, opt } from '../store/rows.ts';
import { DEFAULT_MINUTES, LOCAL_SOURCE_ID, type CalendarEvent } from '../../shared/model/calendar.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isDayOnly } from '../../shared/model/day-settings.ts';
import { addDays, wallOf, wallTime } from '../../shared/text/when.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import { toTask } from '../tasks/repo.ts';

type Row = Record<string, unknown>;

/** Rows of the app itself, or of a source the person shows (alias `e`). */
const SHOWN = `(e.source_id = '${LOCAL_SOURCE_ID}' OR e.source_id IN (SELECT id FROM calendar_sources WHERE visible = 1))`;
const MIN = 60_000;
/** A to-do row is at most this long, so a window looks this far back for one that reaches into it. */
const LONGEST_MS = 24 * 60 * MIN;

export function toEvent(row: Row): CalendarEvent {
  const event: CalendarEvent = {
    id: String(row.id), ownerId: String(row.owner_id), kind: String(row.kind) as CalendarEvent['kind'], startAt: Number(row.start_at), endAt: Number(row.end_at),
    sourceId: String(row.source_id), setBy: String(row.set_by) as CalendarEvent['setBy'], state: String(row.state) as CalendarEvent['state'],
    createdBy: String(row.created_by), rev: Number(row.rev), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
  const taskId = opt<string>(row.task_id);
  const title = opt<string>(row.title);
  const notes = opt<string>(row.notes);
  const tz = opt<string>(row.tz);
  const externalId = opt<string>(row.external_id);
  const etag = opt<string>(row.etag);
  if (taskId) event.taskId = taskId;
  if (title !== undefined) event.title = title;
  if (notes !== undefined) event.notes = notes;
  if (tz) event.tz = tz;
  if (externalId) event.externalId = externalId;
  if (etag) event.etag = etag;
  if (bool(row.all_day)) event.allDay = true;
  if (bool(row.read_only)) event.readOnly = true;
  return event;
}

/** Whose calendar a task's row is in: the person it is for ('human' or per_…), else the agent that owns it. */
export function todoOwner(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): string | undefined {
  if (task.assigneeKind === 'human') return isPersonId(task.assigneeId) ? task.assigneeId! : HUMAN_ID;
  return task.assigneeKind === 'agent' ? task.assigneeId : undefined;
}

/** A to-do's calendar row (never stored): a person's open one at its `at` (a day without a time all that day in `zone`),
 *  a done one at the time it was done; none without either, for open agent work, or dropped. */
export function todoRow(task: Task, zone?: string): CalendarEvent | undefined {
  const ownerId = todoOwner(task);
  if (!ownerId || task.kind !== 'todo' || task.status === 'dropped' || (task.assigneeKind === 'agent' && task.status !== 'done')) return undefined;
  const startAt = task.status === 'done' ? task.completedAt : task.at;
  if (startAt === undefined) return undefined;
  const day = task.status !== 'done' && isDayOnly(task, zone);
  const length = day ? wallTime(addDays(wallOf(startAt, zone).date, 1), 0, zone) - startAt : Math.min(Math.max((task.minutes ?? DEFAULT_MINUTES) * MIN, MIN), LONGEST_MS);
  return {
    id: task.id, ownerId, kind: 'todo', taskId: task.id, startAt, endAt: startAt + length, sourceId: LOCAL_SOURCE_ID,
    setBy: isHumanActor(task.createdBy) ? 'person' : 'agent', state: task.status === 'done' ? 'done' : 'planned',
    createdBy: task.createdBy, rev: task.rev, createdAt: task.createdAt, updatedAt: task.updatedAt, ...(day ? { allDay: true } : {}),
  };
}

/** The SQL that picks a member's tasks (alias `t`): the person's own, a colleague's, or an agent's. */
function whose(ownerId: string): { sql: string; params: string[] } {
  if (ownerId === HUMAN_ID) return { sql: `t.assignee_kind = 'human' AND (t.assignee_id IS NULL OR t.assignee_id = 'human')`, params: [] };
  if (isPersonId(ownerId)) return { sql: `t.assignee_kind = 'human' AND t.assignee_id = ?`, params: [ownerId] };
  return { sql: `t.assignee_kind = 'agent' AND t.assignee_id = ?`, params: [ownerId] };
}

export class CalendarRepo {
  readonly db: Db;
  /** The person's zone (a day-only to-do's row spans that day there); none: the process zone. */
  readonly zone: () => string | undefined;
  constructor(db: Db, zone: () => string | undefined = () => undefined) { this.db = db; this.zone = zone; }

  /** A stored row, else the to-do row of the task with that id. */
  get(id: string): CalendarEvent | undefined {
    const row = this.db.get<Row>('SELECT * FROM calendar_events WHERE id = ?', [id]);
    if (row) return toEvent(row);
    const task = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', [id]);
    return task ? todoRow(toTask(task), this.zone()) : undefined;
  }

  insert(event: CalendarEvent): void {
    this.db.run(
      `INSERT INTO calendar_events (id, owner_id, kind, task_id, title, notes, start_at, end_at, all_day, tz, source_id, external_id, etag, set_by, state,
         read_only, created_by, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.ownerId, event.kind, nul(event.taskId), nul(event.title), nul(event.notes), event.startAt, event.endAt, int(event.allDay === true), nul(event.tz),
        event.sourceId, nul(event.externalId), nul(event.etag), event.setBy, event.state, int(event.readOnly === true), event.createdBy, event.rev,
        event.createdAt, event.updatedAt],
    );
  }

  /** Writes a changed row that was read at `rev` (event.rev is its new one); false when it changed meanwhile. */
  save(event: CalendarEvent, rev: number): boolean {
    return this.db.run(
      `UPDATE calendar_events SET title = ?, notes = ?, start_at = ?, end_at = ?, all_day = ?, tz = ?, external_id = ?, etag = ?, set_by = ?, state = ?,
         read_only = ?, rev = ?, updated_at = ? WHERE id = ? AND rev = ?`,
      [nul(event.title), nul(event.notes), event.startAt, event.endAt, int(event.allDay === true), nul(event.tz), nul(event.externalId), nul(event.etag), event.setBy,
        event.state, int(event.readOnly === true), event.rev, event.updatedAt, event.id, rev],
    ).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM calendar_events WHERE id = ?', [id]).changes > 0;
  }

  /** The member's shown rows overlapping [from, to) – events and to-do rows – by start. */
  inRange(ownerId: string, from: number, to: number): CalendarEvent[] {
    const events = this.db.all<Row>(
      `SELECT e.* FROM calendar_events e WHERE e.owner_id = ? AND e.start_at < ? AND e.end_at > ? AND ${SHOWN} ORDER BY e.start_at, e.end_at, e.id`,
      [ownerId, to, from],
    ).map(toEvent);
    const todos = this.todosInRange(ownerId, from, to).map((entry) => entry.row);
    return [...events, ...todos].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt || a.id.localeCompare(b.id));
  }

  /** A member's to-dos whose row overlaps [from, to) (open with a time, done in the window), with their rows – every agent's with `null`. */
  todosInRange(ownerId: string | null, from: number, to: number): Array<{ task: Task; row: CalendarEvent }> {
    const member = ownerId === null ? { sql: `t.assignee_kind = 'agent'`, params: [] } : whose(ownerId);
    const rows = this.db.all<Row>(
      `SELECT t.* FROM tasks t WHERE ${member.sql} AND t.kind = 'todo' AND (
         (t.status IN ('open', 'waiting') AND t."at" < ? AND t."at" > ?) OR (t.status = 'done' AND t.completed_at < ? AND t.completed_at > ?))
       ORDER BY COALESCE(t.completed_at, t."at"), t.id LIMIT 1000`,
      [...member.params, to, from - LONGEST_MS, to, from - LONGEST_MS],
    );
    const out: Array<{ task: Task; row: CalendarEvent }> = [];
    for (const raw of rows) {
      const task = toTask(raw);
      const row = todoRow(task, this.zone());
      if (row && row.startAt < to && row.endAt > from) out.push({ task, row });
    }
    return out;
  }

  /** A mirrored row by its source and the source's own id (sources sync). */
  byExternal(sourceId: string, externalId: string): CalendarEvent | undefined {
    const row = this.db.get<Row>('SELECT * FROM calendar_events WHERE source_id = ? AND external_id = ?', [sourceId, externalId]);
    return row ? toEvent(row) : undefined;
  }

  /** Every mirrored row of a source (also outside any window – a sync drops the ones that vanished). */
  bySource(sourceId: string): CalendarEvent[] {
    return this.db.all<Row>('SELECT * FROM calendar_events WHERE source_id = ? ORDER BY start_at, id', [sourceId]).map(toEvent);
  }

  /** Rows of a source whose external id is `externalId` or one of its instances ("<id>_<time>", Google's recurring events). */
  bySeries(sourceId: string, externalId: string): CalendarEvent[] {
    const like = `${externalId.replace(/[\\%_]/g, (char) => `\\${char}`)}\\_%`;
    return this.db.all<Row>(`SELECT * FROM calendar_events WHERE source_id = ? AND (external_id = ? OR external_id LIKE ? ESCAPE '\\')`, [sourceId, externalId, like]).map(toEvent);
  }

  /** Removes every row of a source (a removed connection); the removed ids. */
  deleteBySource(sourceId: string): string[] {
    const ids = this.db.all<{ id: string }>('SELECT id FROM calendar_events WHERE source_id = ?', [sourceId]).map((row) => row.id);
    this.db.run('DELETE FROM calendar_events WHERE source_id = ?', [sourceId]);
    return ids;
  }

  /** Shown sources of the owner not synced since `before` (a source never synced counts from when it was added). */
  staleSources(ownerId: string, before: number): string[] {
    return this.db.all<{ id: string }>(
      'SELECT id FROM calendar_sources WHERE owner_id = ? AND visible = 1 AND COALESCE(last_sync_at, created_at) < ? ORDER BY created_at, id', [ownerId, before],
    ).map((row) => row.id);
  }
}
