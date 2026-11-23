// Whether a PC an agent is at home on holds its complete, settled record (Umzug part 2, 21.11.2026 – owner: "natürlich
// nur, wenn der neueste Stand von dem PC schon synchronisiert ist"). Three ops of 'sync.ledger' between my own PCs:
// - 'busy' {agentId}: the PC an agent runs on says so to every online PC the agent is at home on (Agent.homes) the
//   moment a run of it starts there – before the run's first row.
// - 'settled' {agentId, head, state}: that PC says it once no run of the agent is queued or running there (the last one
//   over for SETTLE_AFTER_MS, so what it wrote is in the file sync's manifest) and the PC it tells has acknowledged every
//   row of the agent up to `head` (the highest `changed` of its rows there); `state` names the agent's chats, tasks and
//   files there (settled-state.ts, review R3 M1) – said again whenever it changes; when the link to that PC goes, the
//   receiver compares it with its own (`held`).
// - 'resettle': a PC whose link to me just came up dropped what I had announced (it may be from before the link was
//   down) and asks me to say it again.
// The receiver keeps the last 'settled' per PC and agent (kv home.ts SETTLED_NS); 'busy', any newer row of that agent
// from that PC (ledger.ts take) and that PC's next link-up clear it. home.ts goesOn reads it: a PC goes on with an agent
// whose PC is gone only when the agent was settled here when the contact broke. Review R3 H3: nothing kept outlives
// this runtime (cleared at its start) or a sleep (a jump of the clock between two ticks clears it and asks every PC
// again), and each is kept with the link it came on (home.ts linkMark). L1: every 'busy' and 'settled' carries a counter
// `n`; an older one that arrives late is left out, and one that did not go is said again at the next tick.
// Owns: these announcements (what was said to whom, in memory) and the kept "settled". Never: sends a row, decides a
// takeover, or tells a PC the agent is not at home on.

import type { RuntimeServices } from '../../contracts.ts';
import { KvRepo } from '../../store/kv.ts';
import { awake, homeElsewhere, isCeoPc, linkMark, linkNow, SETTLED_NS, type KeptSettled } from './home.ts';
import { LEDGER_METHOD, onlinePeers } from './ledger-fetch.ts';
import { standing, Standing } from './settled-state.ts';

/** A PC on an older version has no such op: it is told again only after this long. */
export const SAY_AGAIN_MS = 30_000;
/** How long after an agent's last run ended it counts as settled: the file sync has looked at what the run wrote (its 1 s gather). */
export const SETTLE_AFTER_MS = 3_000;

export interface SettledDeps {
  /** Up to which `changed` that PC acknowledged the agent's rows (ledger.ts since). */
  acked(peer: string, agentId: string): number;
  /** Whether that PC's link-up got to the record and no push to it is in flight. */
  ready(peer: string): boolean;
}

/** What a PC was told last about an agent: busy, settled with a head and a state, or that it has no such op (since when). */
type Said = 'busy' | { head: number; state: string } | { olderAt: number };
const same = (a: Said | undefined, b: Said): boolean => a === b
  || (typeof a === 'object' && typeof b === 'object' && 'head' in a && 'head' in b && a.head === b.head && a.state === b.state);

export class Settled {
  private readonly s: RuntimeServices;
  private readonly deps: SettledDeps;
  private readonly kv: KvRepo;
  private readonly standing: Standing;
  private readonly said = new Map<string, Said>();
  /** Per `from/agent`: the counter of the last announcement taken. */
  private readonly seen = new Map<string, number>();
  private n = 0;

  constructor(s: RuntimeServices, deps: SettledDeps) {
    this.s = s;
    this.deps = deps;
    this.kv = new KvRepo(s.db);
    this.standing = new Standing(s);
    this.kv.deletePrefix(SETTLED_NS, ''); // a new runtime: what an earlier one kept may be older than the record of the PC that said it
    awake(s.db, s.clock.now());
  }

  /** Says 'busy' the moment a run of an agent I run starts; follows each link coming and going. Returns the off switch. */
  attach(): () => void {
    const offs = [
      this.s.bus.on('run.upserted', (run) => {
        if (run.status !== 'running' && run.status !== 'queued') return;
        for (const peer of this.homes(run.agentId)) this.say(peer, run.agentId, 'busy');
      }),
      this.s.bus.on('device.upserted', (device) => {
        if (device.kind !== 'pc' || device.self) return;
        linkNow(this.s.db, device.id, device.status === 'online', this.s.clock.now());
        if (device.status !== 'online') { this.forget(device.id); this.broke(device.id); }
      }),
      this.standing.attach(),
    ];
    return () => { for (const off of offs) off(); };
  }

  /** `peer`'s link came up here: what it announced before may be older than its record – it goes, and that PC says it again. */
  linkUp(peer: string): void {
    if (!isCeoPc(this.s.db, peer)) return;
    this.kv.deletePrefix(SETTLED_NS, `${peer}/`);
    this.forget(peer); // it may have dropped what I said too: said again at the next tick
    void this.s.devices.call(peer, LEDGER_METHOD, { op: 'resettle' }).catch(() => undefined); // an older version has no such op: nothing is settled from it
  }

  /** A removed PC: what it announced goes. */
  drop(peer: string): void {
    this.kv.deletePrefix(SETTLED_NS, `${peer}/`);
    this.forget(peer);
  }

  /** Each agent in `mine` (the agents this PC runs) that is at home on other PCs: each of them online hears where it stands, once. */
  tick(mine: readonly string[]): void {
    const now = this.s.clock.now();
    if (!awake(this.s.db, now)) { // the clock jumped (this PC slept): nothing kept or said before counts, every PC says it again
      this.kv.deletePrefix(SETTLED_NS, '');
      this.said.clear();
      this.seen.clear();
      for (const peer of onlinePeers(this.s)) void this.s.devices.call(peer, LEDGER_METHOD, { op: 'resettle' }).catch(() => undefined);
    }
    for (const agentId of mine) {
      const peers = this.homes(agentId);
      if (!peers.length) continue;
      if (this.open(agentId)) { for (const peer of peers) this.say(peer, agentId, 'busy'); continue; }
      const ended = Number(this.s.db.get<{ t: number | null }>('SELECT MAX(ended_at) AS t FROM runs WHERE agent_id = ?', [agentId])?.t ?? 0);
      if (now - ended < SETTLE_AFTER_MS) continue;
      const head = Number(this.s.db.get<{ n: number | null }>('SELECT MAX(changed) AS n FROM context_items WHERE agent_id = ?', [agentId])?.n ?? 0);
      const ready = peers.filter((peer) => this.deps.ready(peer) && this.deps.acked(peer, agentId) >= head);
      if (!ready.length) continue;
      const state = this.standing.of(agentId);
      for (const peer of ready) this.say(peer, agentId, { head, state });
    }
  }

  /** 'busy', 'settled' or 'resettle' from one of my PCs. */
  receive(message: Record<string, unknown>, from: string): { ok: true } {
    if (message.op === 'resettle') { this.forget(from); return { ok: true }; }
    const agentId = typeof message.agentId === 'string' ? message.agentId : '';
    const key = `${from}/${agentId}`;
    if (typeof message.n === 'number') {
      if (message.n <= (this.seen.get(key) ?? 0)) return { ok: true }; // an older one that arrived late
      this.seen.set(key, message.n);
    }
    // Only the PC the agent runs on, as this PC knows it, says where its record stands.
    if (message.op === 'settled' && typeof message.head === 'number' && typeof message.state === 'string' && this.s.org.get(agentId) && homeElsewhere(this.s, agentId) === from) {
      const now = this.s.clock.now();
      const kept: KeptSettled = { head: message.head, state: message.state, mark: linkMark(this.s.db, from, now) };
      this.kv.set(SETTLED_NS, key, kept, now);
    } else {
      this.kv.delete(SETTLED_NS, key);
    }
    return { ok: true };
  }

  /** The contact to `pc` broke: each "settled" kept from it now says whether this PC's state of that agent was the one it named. */
  private broke(pc: string): void {
    try {
      for (const { key, value, updatedAt } of this.kv.list<KeptSettled>(SETTLED_NS, `${pc}/`)) {
        if (value.held === undefined) this.kv.set(SETTLED_NS, key, { ...value, held: value.state === standing(this.s.db, key.slice(pc.length + 1)) }, updatedAt);
      }
    } catch (error) {
      this.s.log.warn('settled state not compared', { pc, error: String(error) });
    }
  }

  /** A newer row of `agentId` came from `from`: what that PC announced before is over. */
  rows(from: string, agentId: string): void {
    this.kv.delete(SETTLED_NS, `${from}/${agentId}`);
  }

  /** The online PCs of mine `agentId` is at home on besides this one – none unless this PC runs it. */
  private homes(agentId: string): string[] {
    try {
      const homes = this.s.org.get(agentId)?.homes;
      if (!homes?.length || homeElsewhere(this.s, agentId)) return [];
      return onlinePeers(this.s).filter((peer) => homes.includes(peer));
    } catch {
      return [];
    }
  }

  /** Whether a run of `agentId` is queued or running on this PC. */
  private open(agentId: string): boolean {
    return Boolean(this.s.db.get(`SELECT 1 AS hit FROM runs WHERE agent_id = ? AND status IN ('queued', 'running') LIMIT 1`, [agentId]));
  }

  /** What `peer` was told and what was taken from it no longer counts (its link went or came up). */
  private forget(peer: string): void {
    for (const map of [this.said, this.seen]) for (const key of [...map.keys()]) if (key.startsWith(`${peer}/`)) map.delete(key);
  }

  /** Tells `peer` where `agentId` stands unless it heard exactly that last; one that did not go is said again at the next tick. */
  private say(peer: string, agentId: string, what: 'busy' | { head: number; state: string }): void {
    const key = `${peer}/${agentId}`;
    const last = this.said.get(key);
    if (same(last, what)) return;
    if (typeof last === 'object' && 'olderAt' in last && this.s.clock.now() - last.olderAt < SAY_AGAIN_MS) return;
    this.said.set(key, what);
    const n = ++this.n;
    const message = what === 'busy' ? { op: 'busy', agentId, n } : { op: 'settled', agentId, n, head: what.head, state: what.state };
    void this.s.devices.call(peer, LEDGER_METHOD, message).catch((error: unknown) => {
      if (this.said.get(key) !== what) return;
      if (/Unknown record sync request/.test(String((error as Error)?.message ?? error))) this.said.set(key, { olderAt: this.s.clock.now() });
      else this.said.delete(key);
    });
  }
}
