// The rig of the device-mesh tests (mesh.test.ts, mesh-b087.test.ts): PCs with a DeviceMesh each, joined by in-process
// socket pairs and manual backoff timers – no network, no real timers (nothing is left scheduled that a test does not
// fire itself; `fire(ms)` fires only those armed for at most ms, so two PCs' timers one close armed fire in their real
// order). A PC can be switched off (`down`), hold its dials (`hold`), lose its dialed link the way sleep does
// (`cut`), and have its keepalive cut that link (`silence`, close code 4008).
// Owns: this rig only. Never: asserts anything.

import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh, type Timers } from '../../../src/runtime/devices/mesh.ts';
import { SILENT_CLOSE, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from './socket-pair.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { Logger } from '../../../src/runtime/contracts.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from './fakes.ts';

export type ManualTimers = Timers & { fire(upToMs?: number): void; count(): number; delays: number[] };

export interface Node {
  name: string;
  address: string;
  identity: DeviceIdentity;
  mesh: DeviceMesh;
  db: ReturnType<typeof memoryDb>;
  events: Array<{ event: string; data: unknown }>;
  timers: ManualTimers; clock: ManualClock;
  /** What each `accept` of a dial to this PC resolved to ('failed': it threw). */
  accepted: Array<string | undefined>;
  /** Simulates a PC that is switched off: dials to it fail. */
  down: boolean;
  /** Holds this PC's dials until it resolves (a slow network). */
  hold?: Promise<void>;
  /** Drops this PC's last dialed link the way sleep does: the other end closes, this end never hears. */
  cut?: () => void;
  /** This PC's keepalive cuts its last dialed link (http/keepalive.ts): this end hears 4008, the other end a close. */
  silence?: () => void;
}

/** Every PC of the current test by the addresses that reach it. */
export const nodes = new Map<string, Node>();
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function manualTimers(): ManualTimers {
  const queue = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const delays: number[] = [];
  return {
    delays,
    set: (fn, ms) => { delays.push(ms); queue.set(++next, { fn, ms }); return next; },
    clear: (handle) => { queue.delete(handle as number); },
    fire: (upToMs = Infinity) => {
      const due = [...queue].filter(([, timer]) => timer.ms <= upToMs);
      for (const [handle] of due) queue.delete(handle);
      for (const [, timer] of due) timer.fn();
    },
    count: () => queue.size,
  };
}

export async function makeNode(name: string, address: string, log: Logger = silentLog): Promise<Node> {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const { bus, events } = recordingBus();
  const timers = manualTimers();
  const identity = await DeviceIdentity.load({ db, host, clock, name });
  const mesh = new DeviceMesh({
    db, identity, clock, log, bus, timers,
    dial: async (target) => {
      const self = nodes.get(address)!;
      await self.hold;
      const remote = nodes.get(target);
      if (!remote || remote.down) throw new Error('unreachable');
      const [raw, theirs] = socketPair();
      let cut = false;
      const hearing: Array<(code?: number) => void> = [];
      self.cut = () => { cut = true; theirs.close(); };
      self.silence = () => { cut = true; theirs.close(); for (const listener of hearing) listener(SILENT_CLOSE); };
      const mine: SocketLike = { ...raw, onClose: (listener) => { hearing.push(listener); raw.onClose((code) => { if (!cut) listener(code); }); } };
      void remote.mesh.accept(theirs).then((id) => { remote.accepted.push(id); }, () => { remote.accepted.push('failed'); });
      return mine;
    },
  });
  mesh.updateSelf({ addresses: [address] });
  const node: Node = { name, address, identity, mesh, db, events, timers, clock, accepted: [], down: false };
  nodes.set(address, node);
  return node;
}

export const idOf = (node: Node) => node.identity.deviceId;
export const statusOf = (node: Node, other: Node) => node.mesh.list().find((device) => device.id === idOf(other))?.status;
export const linkedBoth = (x: Node, y: Node) => x.mesh.online(idOf(y)) && y.mesh.online(idOf(x));

/** Laptop accepted Tower's connect request (remote/*): both store each other, Tower dials (`connectOnPair: false`: stored only); `low`/`high` order them by device id. */
export async function linkedPair(options: { personOfTower?: string; connectOnPair?: boolean; log?: Logger } = {}) {
  nodes.clear();
  const a = await makeNode('Laptop', 'http://10.0.0.1:47811', options.log);
  const b = await makeNode('Tower', 'http://10.0.0.2:47811', options.log);
  if (options.connectOnPair === false) {
    // Stored, never dialed (as after a restart before start()).
    const store = (node: Node, other: Node) => new DevicesRepo(node.db).upsert({
      id: idOf(other), name: other.name, kind: 'pc', role: 'home', fingerprint: other.identity.fingerprint, publicKey: other.mesh.selfInfo().pub,
      addresses: [other.address], caps: {}, status: 'offline', self: false, pairedAt: 0, lastSeenAt: 0,
    });
    store(a, b);
    store(b, a);
  } else {
    a.mesh.add(b.mesh.selfInfo(), { side: 'inviter', ...(options.personOfTower ? { personId: options.personOfTower } : {}) });
    b.mesh.add(a.mesh.selfInfo(), { side: 'joiner' });
  }
  await settle(); for (const node of [a, b]) node.clock.advance(60_000); // an older pairing (its first minute: mesh-race.test.ts)
  const [low, high] = a.identity.deviceId < b.identity.deviceId ? [a, b] : [b, a];
  return { a, b, low, high };
}

/** A handler on `node` that waits until the test ends it and records whether its signal was aborted. */
export function waiting(node: Node, method: string): { signal?: AbortSignal; seen: boolean; finish: () => void } {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const state: { signal?: AbortSignal; seen: boolean; finish: () => void } = { seen: false, finish: () => finish() };
  node.mesh.register(method, async (_params, _from, signal) => { state.seen = true; state.signal = signal; await done; return { ok: true }; });
  return state;
}
