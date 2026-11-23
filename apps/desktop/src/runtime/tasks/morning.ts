// The morning pass (Quests round 20.11.2026): once a day at 07:00 in the profile zone, every active agent at home on this
// PC that owns open quests – or holds open to-dos in them – without an active reminder on the quest or its to-dos gets ONE
// wake listing them: "These quests of mine have no next note: …", each quest as it stands (context/quest-text.ts
// questSnapshot: done-when, every owner's open to-dos with their waits and since when, the thread since my last line). Idempotent per agent and local date (kv tasks/morning:<agentId>); missed while the PC was off or asleep,
// it runs a minute after the next start or resume that day. A quest made the same local day is left out – the catch-up
// after a start included (FIXREAL 6b, real run 20.11.: it woke an agent 35 s after it made its first quest); tomorrow's
// pass names it. Nothing else wakes an agent periodically.
// Owns: that pass, its timer and its mark. Never: changes a task or a schedule, or wakes an archived agent.

import type { Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { DueTimer } from '../people/due-timer.ts';
import type { Timers } from '../people/join.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { KvRepo } from '../store/kv.ts';
import { addDays, wallOf, wallTime } from '../../shared/text/when.ts';
import { profileZone } from '../context/time.ts';
import { questSnapshot } from '../context/quest-text.ts';

/** The pass's local clock time (minutes after midnight): 07:00. */
export const MORNING_MINUTES = 7 * 60;
const CATCH_UP_MS = 60_000;
const KV_NS = 'tasks';
const markKey = (agentId: string) => `morning:${agentId}`;

export type MorningDeps = Pick<RuntimeServices, 'tasks' | 'wakes' | 'clock' | 'db' | 'org' | 'settings'> & Partial<Pick<RuntimeServices, 'log' | 'host' | 'people' | 'chats' | 'scheduler'>>;

export class MorningPass {
  private readonly s: MorningDeps;
  private readonly timer: DueTimer;
  private off: (() => void) | undefined;

  constructor(s: MorningDeps, timers: Timers) {
    this.s = s;
    this.timer = new DueTimer(timers, () => s.clock.now(), () => { this.run(); this.arm(); });
  }

  private get t(): TaskServiceImpl { return this.s.tasks as unknown as TaskServiceImpl; }

  start(): void {
    this.arm();
    try { this.off ??= this.s.host?.onPower((event) => { if (event === 'resume' || event === 'unlock') { this.timer.stop(); this.arm(); } }); } catch { /* a host without power events */ }
  }

  stop(): void {
    this.timer.stop();
    this.off?.();
    this.off = undefined;
  }

  /** One pass now (only at or after today's 07:00); returns how many agents were woken. */
  run(now = this.s.clock.now()): number {
    const zone = profileZone(this.s);
    const today = wallOf(now, zone).date;
    if (now < wallTime(today, MORNING_MINUTES, zone)) return 0;
    const kv = new KvRepo(this.s.db);
    let woken = 0;
    for (const agent of this.agentsHere()) {
      if (kv.get<string>(KV_NS, markKey(agent.id)) === today) continue;
      kv.set(KV_NS, markKey(agent.id), today, now);
      let quests: Task[];
      try { quests = this.t.repo.questsWithoutNote(agent.id); } catch (error) { this.s.log?.warn('morning pass: quests not read', { agentId: agent.id, error: String(error) }); continue; }
      quests = quests.filter((quest) => wallOf(quest.createdAt, zone).date !== today); // made today: no nudge before tomorrow
      if (!quests.length) continue;
      const note = ['These quests of mine have no next note:', ...quests.flatMap((quest) => {
        const view = this.s.tasks.get(quest.id);
        return view ? ['', ...questSnapshot(this.s, view, agent.id, zone)] : [];
      })].join('\n');
      this.s.wakes.wake({ agentId: agent.id, reason: 'schedule', note, coalesceKey: 'morning', dueAt: now });
      woken++;
    }
    return woken;
  }

  /** Today's 07:00 when it is ahead; a minute from now when today's pass is still missing for an agent; else tomorrow's. */
  private arm(): void {
    const now = this.s.clock.now();
    const zone = profileZone(this.s);
    const today = wallOf(now, zone).date;
    const at = wallTime(today, MORNING_MINUTES, zone);
    if (now < at) { this.timer.arm(at); return; }
    const kv = new KvRepo(this.s.db);
    const missing = this.agentsHere().some((agent) => kv.get<string>(KV_NS, markKey(agent.id)) !== today);
    this.timer.arm(missing ? now + CATCH_UP_MS : wallTime(addDays(today, 1), MORNING_MINUTES, zone));
  }

  /** The active agents at home on this PC. */
  private agentsHere() {
    try { return this.s.org.list().filter((agent) => agent.archivedAt === undefined && !homeElsewhere(this.s, agent.id)); } catch { return []; }
  }
}
