// Umzug 21.11.2026 (owner: an agent goes on where it is when its PC is gone): rows.ts handOver asks here where an agent's
// due wakes go (handOverTargets). They wait while the agent's record is still on its way from this PC (agents/move.ts,
// leaving). With none of their PCs online they go to the PC that goes on with the agent (home.ts goesOn: its PC out of
// reach here for TAKEOVER_MS, the online PC with the smallest id among those it is at home on – Agent.homes; part 2: an
// agent without homes waits for its PC) – review H3: a PC that is not that one hands them over the normal way, and that
// PC takes the agent. Part 2 (owner: only with the newest state): this PC takes it only when it held the agent's
// complete, settled record when the contact broke (home.ts settledHere); was the agent at work there or were rows still
// owed, it waits for its PC – one info line, no wake, no note. When this PC is the stand-in, it writes itself as the
// agent's PC through the org service (the row is stamped and travels; the PC it left stays one of its homes), keeps
// whose agent it took and logs one line; the
// arrival (agents/move.ts) writes the one line the agent reads and runs its wakes here. While wakes wait, and while one of
// my PCs is out of reach but not yet for TAKEOVER_MS, a look every RECHECK_MS (and at every device change) – no busy loop;
// once such a PC passes TAKEOVER_MS the schedules are placed again, so an agent's schedule fires on its stand-in (M4).
// When the old PC is online again, the agent hears once that it stays here (no wake for that).
// Owns: that decision, its timer, the taken-from list (kv 'move.taken') and announcing an agent's wakes again. Never:
// cuts a run, dials, or sends a wake itself (rows.ts does).

import type { RuntimeServices } from '../../contracts.ts';
import { KvRepo } from '../../store/kv.ts';
import { clockText, profileZone } from '../../context/time.ts';
import { DevicesRepo } from '../repo.ts';
import { goesOn, homeElsewhere, isCeoPc, links, liveHomes, selfId, standIn, TAKEOVER_MS, watchAwayFrom } from './home.ts';
import { placeSchedules } from './tables.ts';

/** How often waiting agents (and PCs not yet away for TAKEOVER_MS) are looked at again. */
export const RECHECK_MS = 30_000;
/** kv: the agents this PC took over, with the PC they came from. */
export const TAKEN_NS = 'move.taken';

export interface TakeoverDeps {
  /** The line the agent reads in its next turn here (agents/move.ts noteMove). */
  note(agentId: string, text: string): void;
  /** Its record is still on its way from this PC: its wakes wait (agents/move.ts). */
  leaving(agentId: string): boolean;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

const attached = new WeakMap<object, Takeover>();

/** The agent's due wakes are announced again: the dispatcher or rows.ts handOver takes them where it runs now. */
export function announceWakes(s: RuntimeServices, agentId: string): void {
  try {
    const wakes = s.wakes.claim(agentId);
    if (wakes.length) s.wakes.release(wakes.map((wake) => wake.id), s.clock.now(), true);
  } catch (error) {
    s.log.warn('wakes not announced again', { agentId, error: String(error) });
  }
}

/**
 * rows.ts handOver: where an agent's due wakes go – `targets` (its PC or my CEO PCs that are online), the stand-in when
 * none is online and another PC goes on with it; undefined: they stay here for now (its record is still on its way, or
 * nobody goes on with it yet – this PC looks again, and takes it when it is the stand-in).
 */
export function handOverTargets(s: RuntimeServices, agentId: string, targets: string[]): string[] | undefined {
  const takeover = attached.get(s);
  if (takeover?.deps.leaving(agentId)) return undefined;
  if (targets.length) return targets;
  const to = takeover ? standIn(s, agentId) : undefined;
  if (to && to !== selfId(s.db)) return [to];
  takeover?.held(agentId);
  return undefined;
}

/** The line an agent reads when it goes on here because its PC `home` is gone. */
export function goneLine(s: RuntimeServices, home: string): string {
  const devices = new DevicesRepo(s.db);
  const record = devices.get(home);
  const name = record?.name ?? home;
  const me = devices.self()?.name ?? 'this PC';
  const zone = profileZone(s);
  const seen = record?.lastSeenAt ?? s.clock.now();
  return `My PC ${name} has not been reachable since ${clockText(seen, zone)}; my record was complete here, so I go on on ${me}. `
    + `Files and programs that only ${name} has are out of reach until it is back.`;
}

const realTimers = {
  set: (fn: () => void, ms: number) => { const handle = setTimeout(fn, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Takeover {
  readonly deps: TakeoverDeps;
  private readonly s: RuntimeServices;
  private readonly since: number;
  private readonly waiting = new Set<string>();
  /** My PCs out of reach here whose schedules are not placed again yet (they pass TAKEOVER_MS). */
  private readonly away = new Set<string>();
  /** Agents that wait for their PC because their record was not complete here, with that PC (the one log line each). */
  private readonly staying = new Map<string, string>();
  private timer?: unknown;

  constructor(s: RuntimeServices, deps: TakeoverDeps) {
    this.s = s;
    this.deps = deps;
    this.since = s.clock.now();
  }

  /** Answers rows.ts and listens to device changes; returns the off switch. */
  attach(): () => void {
    attached.set(this.s, this);
    watchAwayFrom(this.s.db, this.since);
    try { for (const { record, link } of links(this.s.db)) if (link.kind === 'ceo' && !this.s.devices.online(record.id)) this.away.add(record.id); } catch { /* no devices */ }
    const off = this.s.bus.on('device.upserted', (device) => {
      if (device.kind !== 'pc' || device.self) return;
      if (device.status === 'online') { this.away.delete(device.id); for (const [id, pc] of this.staying) if (pc === device.id) this.staying.delete(id); this.back(device.id); } else if (isCeoPc(this.s.db, device.id)) this.away.add(device.id);
      this.recheck();
    });
    this.rearm();
    return () => {
      off();
      this.disarm();
      if (attached.get(this.s) === this) attached.delete(this.s);
    };
  }

  /** The agent's due wakes found no online PC to go to, and this PC is the one that would go on with it (or nobody yet). */
  held(agentId: string): void {
    this.waiting.add(agentId);
    this.check(agentId);
    this.rearm();
  }

  /** Every waiting agent once more, and the schedules of agents whose PC is now away long enough (the timer, a device change). */
  recheck(): void {
    for (const id of [...this.waiting]) this.check(id);
    const now = this.s.clock.now();
    for (const pc of [...this.away]) {
      const record = new DevicesRepo(this.s.db).get(pc);
      if (!record || this.s.devices.online(pc)) { this.away.delete(pc); continue; }
      if (now - Math.max(record.lastSeenAt ?? 0, this.since) < TAKEOVER_MS) continue;
      this.away.delete(pc);
      try { placeSchedules(this.s); } catch (error) { this.s.log.warn('schedules not placed', { error: String(error) }); }
    }
    this.rearm();
  }

  private rearm(): void {
    if (!this.waiting.size && !this.away.size) { this.disarm(); return; }
    if (this.timer !== undefined) return;
    this.timer = (this.deps.timers ?? realTimers).set(() => { this.timer = undefined; this.recheck(); }, RECHECK_MS);
  }

  private disarm(): void {
    if (this.timer !== undefined) (this.deps.timers ?? realTimers).clear(this.timer);
    this.timer = undefined;
  }

  /** Takes the agent when this PC is its stand-in, hands its wakes on when another is; drops it when there is nothing to wait for. */
  private check(agentId: string): void {
    const s = this.s;
    try {
      const agent = s.org.get(agentId);
      const home = agent && !agent.archivedAt ? homeElsewhere(s, agentId) : undefined;
      const now = s.clock.now();
      const due = s.wakes.list(agentId).some((wake) => !wake.claimedAt && wake.dueAt <= now);
      // Back, gone, at home nowhere else, a home this PC never linked (the CEO PC that knows it decides) or nothing due: not mine to take.
      if (!agent || !home || !due || !agent.homes?.length || s.devices.online(home) || !isCeoPc(s.db, home)) { this.waiting.delete(agentId); return; }
      const { to, soon, unsettled } = goesOn(s, agentId);
      if (soon) return; // not away long enough yet
      this.waiting.delete(agentId);
      if (unsettled && this.staying.get(agentId) !== home) {
        this.staying.set(agentId, home);
        s.log.info('agent waits for its PC, its record was not complete here', { agentId, pc: home });
      }
      if (!to) return; // it waits for its PC, or for one of its homes to come online (that PC's link-up takes its wakes)
      if (to !== selfId(s.db)) { announceWakes(s, agentId); return; } // rows.ts hands them to that PC (handOverTargets)
      new KvRepo(s.db).set(TAKEN_NS, agentId, home, now);
      s.log.info('agent taken over', { agentId, from: home });
      // This PC (no deviceId), and the PC it left stays one of its homes; stamped, it travels.
      s.org.update(agentId, { deviceId: undefined, homes: liveHomes(s.db, [...agent.homes, home]) }, { by: 'system', reason: 'takeover' });
    } catch (error) {
      s.log.warn('takeover not checked', { agentId, error: String(error) });
    }
  }

  /** `pc` is online again: each agent this PC took from it and still runs hears once that it stays here. */
  private back(pc: string): void {
    const s = this.s;
    try {
      const kv = new KvRepo(s.db);
      const name = new DevicesRepo(s.db).get(pc)?.name ?? pc;
      const me = new DevicesRepo(s.db).self()?.name ?? 'this PC';
      for (const { key: agentId, value: from } of kv.list<string>(TAKEN_NS)) {
        if (from !== pc) continue;
        kv.delete(TAKEN_NS, agentId);
        if (s.org.get(agentId) && !homeElsewhere(s, agentId)) this.deps.note(agentId, `${name} is reachable again; I stay on ${me}.`);
      }
    } catch (error) {
      s.log.warn('takeover return not noted', { pc, error: String(error) });
    }
  }
}
