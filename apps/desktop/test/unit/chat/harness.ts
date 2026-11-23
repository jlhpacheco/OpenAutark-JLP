// Test harness for package A2 (chats, delivery, tasks, ownership, wakes, schedules):
// in-memory SQLite + migrations, a manual clock, fake org/notifications/dispatcher/decisions
// and fake timers. Services are wired late-bound like the composition root does. B-080: an optional fake run journal
// (fakeJournal) for the loop guard's worked-line check.

import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../fakes.ts';
import { ChatServiceImpl } from '../../../src/runtime/chat/service.ts';
import { DeliveryServiceImpl } from '../../../src/runtime/chat/delivery.ts';
import { TaskServiceImpl } from '../../../src/runtime/tasks/service.ts';
import { TaskWatcher } from '../../../src/runtime/tasks/watch.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { SchedulerImpl, type Timers } from '../../../src/runtime/schedules/scheduler.ts';
import type { DecisionService, Dispatcher, NotificationService, OrgService, RunJournal, RuntimeServices, Subconscious } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { EventMap, EventName } from '../../../src/shared/api/events.ts';
import type { AgentActivity, Run, RunItem, WakeReason } from '../../../src/shared/model/runs.ts';
import type { ActionCategory } from '../../../src/runtime/tools/types.ts';
import type { PowerEvent } from '../../../src/shared/api/host-bridge.ts';

export function agent(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, name, role: '', avatar: { kind: 'initials', value: name.slice(0, 2) }, instructions: '', mode: 'general', skills: [],
    modelPolicy: {} as Agent['modelPolicy'], status: 'idle',
    createdBy: 'human', createdAt: 0, updatedAt: 0, ...extra,
  };
}

export class FakeOrg {
  agents = new Map<string, Agent>();
  add(a: Agent): Agent { this.agents.set(a.id, a); return a; }
  get(id: string) { return this.agents.get(id); }
  require(id: string) { const a = this.agents.get(id); if (!a) throw new Error('missing ' + id); return a; }
  list() { return [...this.agents.values()]; }
  managers(id: string): Agent[] {
    const out: Agent[] = [];
    let current = this.agents.get(id);
    while (current?.managerId && out.length < 20) {
      const manager = this.agents.get(current.managerId);
      if (!manager) break;
      out.push(manager);
      current = manager;
    }
    return out;
  }
  canManage() { return true; }
}

export class FakeTimers implements Timers {
  pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  private seq = 0;
  set(fn: () => void, ms: number) { const id = ++this.seq; this.pending.push({ fn, ms, id }); return id; }
  clear(handle: unknown) { this.pending = this.pending.filter(t => t.id !== handle); }
  /** The single armed timer (asserts there is at most one). */
  only() { if (this.pending.length > 1) throw new Error(`more than one timer armed: ${this.pending.length}`); return this.pending[0]; }
  fire() { const timer = this.only(); if (!timer) throw new Error('no timer armed'); this.pending = []; timer.fn(); }
}

/** One tool call of a fake run (fakeJournal): ours with its category, or engine-native (`own`). */
export interface FakeCall { name: string; category?: ActionCategory; own?: boolean; ok?: boolean; nested?: boolean }

/**
 * B-080: a fake run journal for delivery's worked-line check (chat/worked.ts): `add` records a run with its trigger and
 * tool calls (journaled as the registry and the engines do: a tool_call, then its tool_result). `runs` goes into
 * harness({ runs }).
 */
export function fakeJournal() {
  const runs = new Map<string, { run: Run; items: RunItem[] }>();
  let seq = 0;
  const add = (runId: string, trigger: WakeReason, calls: FakeCall[] = []) => {
    const items: RunItem[] = [];
    calls.forEach((call, index) => {
      const callId = `${runId}_c${index}`;
      const data = { callId, ...(call.own ? { own: true } : { category: call.category }), ...(call.nested ? { nested: true } : {}) };
      items.push({ id: `ri_${++seq}`, runId, seq, kind: 'tool_call', name: call.name, data, createdAt: 0 });
      if (call.ok !== undefined) items.push({ id: `ri_${++seq}`, runId, seq, kind: 'tool_result', name: call.name, data: { callId, ok: call.ok }, createdAt: 0 });
    });
    runs.set(runId, { run: { id: runId, agentId: 'ag_any', trigger, status: 'running' }, items });
    return runId;
  };
  const journal = { get: (runId: string) => runs.get(runId)?.run, items: (runId: string) => runs.get(runId)?.items ?? [] } as unknown as RunJournal;
  return { runs: journal, add };
}

export function harness(options: { decisions?: DecisionService; subconscious?: Partial<Subconscious>; maxPerMinute?: number; runs?: RunJournal } = {}) {
  const db = new Db(':memory:');
  migrate(db);
  const bus = new Bus(error => { throw error; });
  const clock = new ManualClock(Date.UTC(2026, 9, 17, 9, 0, 0));
  const org = new FakeOrg();
  const notified: Array<Parameters<NotificationService['notify']>[0]> = [];
  const urgent: Array<{ agentId: string; conversationId: string; taskId?: string }> = [];
  const running: AgentActivity[] = []; // T10: turns the fake dispatcher reports as running (activity())
  const events: Array<{ event: EventName; data: unknown }> = [];
  bus.onAny((event, data) => events.push({ event, data }));
  const timers = new FakeTimers();
  const powerListeners: Array<(event: PowerEvent) => void> = [];

  const services = {
    db, bus, clock,
    org: org as unknown as OrgService,
    notifications: { notify: input => notified.push(input) } satisfies NotificationService,
    dispatcher: {
      urgent: async (agentId: string, conversationId: string, taskId?: string) => { urgent.push(taskId ? { agentId, conversationId, taskId } : { agentId, conversationId }); },
      activity: () => [...running],
    } as unknown as Dispatcher,
    decisions: options.decisions,
    subconscious: options.subconscious as Subconscious | undefined,
    host: { onPower: (listener: (event: PowerEvent) => void) => { powerListeners.push(listener); return () => {}; } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...(options.runs ? { runs: options.runs } : {}),
  } as unknown as RuntimeServices;

  const wakes = new WakeQueueImpl({ db, clock });
  services.wakes = wakes;
  const chats = new ChatServiceImpl(services, { liveGapMs: 0 }); // every live-bar announcement at once (chat/live.ts)
  services.chats = chats;
  const delivery = new DeliveryServiceImpl(services, { maxPerMinute: options.maxPerMinute });
  services.delivery = delivery;
  const tasks = new TaskServiceImpl(services);
  services.tasks = tasks;
  const ownership = new TaskWatcher(services, { set: () => 0, clear: () => {} }); // passes run when a test calls ownership.pass()
  services.ownership = ownership;
  const scheduler = new SchedulerImpl(services, { timers });
  services.scheduler = scheduler;

  const of = <E extends EventName>(event: E) => events.filter(e => e.event === event).map(e => e.data as EventMap[E]);
  const wakeRows = () => db.all<{ agent_id: string; reason: string; conversation_id: string | null; task_id: string | null; note: string | null; due_at: number }>(
    'SELECT agent_id, reason, conversation_id, task_id, note, due_at FROM wakes ORDER BY due_at, agent_id');
  return { db, bus, clock, org, notified, urgent, running, events, of, timers, powerListeners, services, wakes, chats, delivery, tasks, ownership, scheduler, wakeRows };
}

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
