// CalendarService (B-041 track A1, Quests round 20.11.2026): the members' local calendar – appointments (stored rows),
// the to-dos with a time read from their tasks (calendar/repo.ts todoRow: the person's own, and on the owner's calendar
// the agents' to-dos on the AI lane), slot clicks (calendar.add, runtime/calendar/add.ts – an appointment, or the
// person's line as a to-do at that time), moves (rev-checked; an event moved by the person is pinned: setBy 'person'; a
// to-do row moved moves the to-do's `at`/`minutes`), removal (an event goes; a to-do only loses its time), the busy spans
// of a member, the window with the agents' runs (calendar/agent-runs.ts), the zone and the sources not synced for > 24 h.
// Every change of a row – a to-do's time too (a task.upserted listener) – is sent as 'calendar.upserted' /
// 'calendar.removed' and handed to the sources' mirror hook (onLocalChange). Built by compose/calendar.ts.
// Owns: calendar rows and their events. Never: task text copies (a to-do row has no title), writes a read-only source's
// row, or polls.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { LOCAL_SOURCE_ID, type CalendarAddInput, type CalendarEvent, type CalendarList, type CalendarSetBy } from '../../shared/model/calendar.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { CalendarService } from '../contracts/calendar.ts';
import { addFromSlot } from './add.ts';
import { agentRuns } from './agent-runs.ts';
import { CalendarRepo, todoOwner, todoRow } from './repo.ts';
import { busySpans, conflicts, setByOf, type Span } from './rules.ts';

export type CalendarDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'settings' | 'tasks'>
  & Partial<Pick<RuntimeServices, 'log' | 'scheduler' | 'org' | 'chats' | 'subconscious' | 'wakes'>>;

export type LocalChange = CalendarEvent | { removed: string };

const STALE_MS = 24 * 60 * 60_000;
const MIN = 60_000;
/** Done to-dos older than this are no longer followed for their removal (the mirror's window looks back 7 days). */
const FOLLOW_DONE_MS = 60 * 24 * 60 * 60_000;

/** The profile zone all day math uses (the process zone when settings cannot be read). */
export function profileZone(s: Pick<RuntimeServices, 'settings'>): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try { return s.settings.get().profile.timezone || fallback; } catch { return fallback; }
}

export class CalendarServiceImpl implements CalendarService {
  readonly s: CalendarDeps;
  readonly repo: CalendarRepo;
  private readonly listeners = new Set<(change: LocalChange) => void>();
  /** The to-dos that have a row now, with whose calendar it is in (their row's going is sent as removed). */
  private readonly shown = new Map<string, string>();
  /** Events made from a slot click lately, by `<by>:<clientId>` (calendar/add.ts: a resend answers the same row). */
  readonly recentEvents = new Map<string, string>();
  private offs: Array<() => void> = [];

  constructor(s: CalendarDeps) {
    this.s = s;
    this.repo = new CalendarRepo(s.db, () => profileZone(s)); // a day-only to-do's row spans the person's day
  }

  /** Follows the to-dos' times (called once by compose/calendar.ts). */
  start(): void {
    if (this.offs.length) return;
    try {
      const since = this.s.clock.now() - FOLLOW_DONE_MS;
      for (const row of this.s.db.all<{ id: string; assignee_kind: string; assignee_id: string | null }>(
        `SELECT id, assignee_kind, assignee_id FROM tasks WHERE kind = 'todo' AND (("at" IS NOT NULL AND status IN ('open', 'waiting')) OR (status = 'done' AND completed_at > ?))`, [since])) {
        const owner = todoOwner({ assigneeKind: row.assignee_kind as Task['assigneeKind'], ...(row.assignee_id ? { assigneeId: row.assignee_id } : {}) });
        if (owner) this.shown.set(row.id, owner);
      }
    } catch (error) { this.s.log?.warn('calendar: the to-dos with a time were not read', { error: String(error) }); }
    this.offs = [
      this.s.bus.on('task.upserted', (task) => this.todoChanged(task)),
      this.s.bus.on('task.removed', ({ id }) => { const owner = this.shown.get(id); if (owner) { this.shown.delete(id); this.removed(id, owner, id); } }),
    ];
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  list(ownerId: string, from: number, to: number, agentId?: string): CalendarList {
    const now = this.s.clock.now();
    const todos = agentId !== undefined ? this.repo.todosInRange(agentId, from, to) // one agent's lane: its to-dos and runs
      : ownerId === HUMAN_ID ? this.repo.todosInRange(null, from, to) : []; // the agents work for the owner: their lane
    const events = agentId === undefined ? this.repo.inRange(ownerId, from, to) : [];
    const tasks = new Map<string, Task>(todos.map((entry) => [entry.task.id, entry.task]));
    for (const row of events) if (row.kind === 'todo' && !tasks.has(row.id)) { const task = this.s.tasks.get(row.id); if (task) tasks.set(task.id, task); }
    return {
      events: [...events, ...todos.map((entry) => entry.row)].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)),
      tasks: [...tasks.values()],
      agentRuns: ownerId === HUMAN_ID ? agentRuns(this.s, from, to, agentId) : [],
      tz: profileZone(this.s), staleSources: this.repo.staleSources(ownerId, now - STALE_MS),
    };
  }

  add(input: CalendarAddInput, by: string): Promise<{ event: CalendarEvent; task?: TaskView }> {
    try { return addFromSlot(this, input, by); } catch (error) { return Promise.reject(error); }
  }

  move(id: string, startAt: number, endAt: number, rev: number, by: string): CalendarEvent {
    if (!(endAt > startAt)) throw new WorkforceError('bad_request', 'An entry ends after it starts.');
    const row = this.writable(id);
    if (row.rev !== rev) throw new WorkforceError('conflict', 'This entry changed meanwhile. Reload and try again.', { details: { id, rev: row.rev } });
    if (row.kind === 'todo') {
      if (row.state === 'done') throw new WorkforceError('bad_request', 'A done to-do stays at the time it was done.');
      const task = this.s.tasks.update(id, { at: startAt, minutes: Math.max(1, Math.round((endAt - startAt) / MIN)) }, by, rev);
      return todoRow(task, this.zone()) ?? row;
    }
    return this.save({ ...row, startAt, endAt, setBy: setByOf(by), rev: row.rev + 1, updatedAt: this.s.clock.now() }, rev);
  }

  remove(id: string, by: string): void {
    const row = this.writable(id);
    if (row.kind === 'todo') { this.s.tasks.update(id, { at: null }, by); return; } // the to-do stays, without its time
    this.drop(row);
  }

  busy(ownerId: string, from: number, to: number): Array<{ startAt: number; endAt: number }> {
    return busySpans(this.repo.inRange(ownerId, from, to).filter((row) => row.state !== 'done'));
  }

  onLocalChange(listener: (event: LocalChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ------------------------------------------------------------- shared by add.ts, team.ts and the agent tools

  /** The zone all day math uses. */
  zone(): string { return profileZone(this.s); }

  /** A new local event row (not stored). */
  fresh(ownerId: string, kind: CalendarEvent['kind'], setBy: CalendarSetBy, createdBy: string, startAt: number, endAt: number): CalendarEvent {
    const now = this.s.clock.now();
    return {
      id: newId('cev', now), ownerId, kind, startAt, endAt, tz: this.zone(), sourceId: LOCAL_SOURCE_ID, setBy, state: 'planned', createdBy, rev: 0,
      createdAt: now, updatedAt: now,
    };
  }

  /** Refuses `span` when it covers a timed event or a to-do the person placed ('conflict', with the first one's time). */
  refuseFixed(ownerId: string, span: Span, taskId?: string): void {
    const hit = conflicts(this.repo.inRange(ownerId, span.startAt, span.endAt).filter((row) => row.state !== 'done'), span, taskId)[0];
    if (hit) {
      throw new WorkforceError('conflict', hit.kind === 'event' ? 'That time is taken by an appointment in the calendar.' : 'That time is taken by a to-do the person placed.',
        { details: { eventId: hit.id, startAt: hit.startAt, endAt: hit.endAt } });
    }
  }

  insert(event: CalendarEvent): CalendarEvent {
    this.repo.insert(event);
    return this.changed(event);
  }

  save(event: CalendarEvent, rev: number): CalendarEvent {
    if (!this.repo.save(event, rev)) throw new WorkforceError('conflict', 'This entry changed meanwhile. Reload and try again.', { details: { id: event.id } });
    return this.changed(event);
  }

  drop(row: CalendarEvent): void {
    this.repo.delete(row.id);
    this.removed(row.id, row.ownerId);
  }

  // ------------------------------------------------------------- internals

  /** A row the person may move or remove: it exists and is not from a read-only source. */
  private writable(id: string): CalendarEvent {
    const row = this.repo.get(id);
    if (!row) throw new WorkforceError('not_found', 'Calendar entry not found.', { details: { id } });
    if (row.readOnly) throw new WorkforceError('bad_request', 'This entry comes from a connected calendar that is read-only. Change it there.');
    return row;
  }

  /** A task changed: its row (new, moved, done) or its going is sent. */
  private todoChanged(task: Task): void {
    const row = todoRow(task, this.zone());
    if (row) { this.shown.set(task.id, row.ownerId); this.changed(row); return; }
    const owner = this.shown.get(task.id);
    if (!owner) return;
    this.shown.delete(task.id);
    this.removed(task.id, owner, task.id);
  }

  private changed(event: CalendarEvent): CalendarEvent {
    this.s.bus.emit('calendar.upserted', event);
    this.tell(event);
    return event;
  }

  private removed(id: string, ownerId: string, taskId?: string): void {
    this.s.bus.emit('calendar.removed', taskId ? { id, ownerId, taskId } : { id, ownerId });
    this.tell({ removed: id });
  }

  private tell(change: LocalChange): void {
    for (const listener of [...this.listeners]) {
      try { listener(change); } catch (error) { this.s.log?.warn('calendar mirror listener failed', { error: String(error) }); }
    }
  }
}
