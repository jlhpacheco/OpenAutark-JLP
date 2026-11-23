// Test rig for connect requests: PCs in one process, each with its identity, DeviceMesh (dials go
// nowhere – only what the connect flow stores matters) and RemoteService; POSTs go straight to the
// other PC's handler (JSON round trip), LAN hello probes to a shared fake LAN, timers are fired by hand.
// F17: peer methods (remote/mirror.ts) go straight to the other PC's registered handler, checked by link kind as the
// mesh does, while the two PCs are `up` (link / up / down stand in for the mesh's links).
// Eine-ID 22.11.2026: `treesOf` opens a PC's two ID trees (remote/code.ts) – only where a test needs them, so the other
// PCs answer as before; `bodies` keeps what a PC sent, `edit` changes an answer it receives (an older PC, a forged one);
// `connectYes` connects and gives the person's yes where the answer asks for it (review H1).
// Owns: the rig only.

import type { Db } from '../../../src/runtime/db/database.ts';
import { openCodes } from '../../../src/runtime/remote/code.ts';
import type { Bus } from '../../../src/runtime/bus.ts';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh, type LinkKind } from '../../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import type { Candidate, HelloAnswer } from '../../../src/runtime/devices/discovery.ts';
import { RemoteService, type RemoteDeps } from '../../../src/runtime/remote/service.ts';
import type { Timers } from '../../../src/runtime/remote/requests.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RemoteIncoming, RemoteOutgoing, RemoteState } from '../../../src/shared/model/remote.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

/** One-shot timers fired by hand. */
export class HandTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown { const id = this.next++; this.pending.set(id, { fn, ms }); return id; }
  clear(handle: unknown): void { this.pending.delete(handle as number); }
  /** Runs the timers set for at most `ms`. */
  fire(ms: number): void { for (const [id, timer] of [...this.pending]) if (timer.ms <= ms) { this.pending.delete(id); timer.fn(); } }
}

export interface Pc {
  name: string;
  address: string;
  identity: DeviceIdentity;
  mesh: DeviceMesh;
  remote: RemoteService;
  repo: DevicesRepo;
  clock: ManualClock;
  timers: HandTimers;
  paired: Array<{ id: string; side: 'joiner' | 'inviter'; personId?: string }>;
  states: RemoteState[];
  shown: RemoteIncoming[];
  /** The notices once a PC is linked here (RemoteDeps.linked). */
  notes: Array<{ title: string; body: string }>;
  /** The people whose employee PC was accepted here (RemoteDeps.admitted). */
  admitted: string[];
  findable: boolean;
  hello?: HelloAnswer;
  /** Who POSTs arrive from (the target's per-address limit). */
  from: string;
  /** POSTs from this PC that get lost on the way (a network failure). */
  drop?: (body: Record<string, unknown>) => boolean;
  /** Every POST this PC sent (kinds), and the bodies. */
  sent: string[];
  bodies: Array<Record<string, unknown>>;
  /** Changes an answer this PC receives (by the kind it asked). */
  edit?: (kind: string, reply: Record<string, unknown>) => Record<string, unknown>;
  db: Db;
  bus: Bus;
  /** The peer methods registered here (remote/mirror.ts) and the PCs whose link is up (rig: link / up / down). */
  handlers: Map<string, { handler: PeerHandler; kinds: readonly LinkKind[] }>;
  online: Set<string>;
  /** Every peer method this PC called (`method → device id`). */
  calls: string[];
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

export class Lan {
  readonly pcs = new Map<string, Pc>();

  /**
   * `linked: false`: no linked notice wired (a composition without it still links). `deps`: more RemoteDeps (the
   * people hooks of F13, the company name of F09).
   */
  async add(name: string, address: string, options: { findable?: boolean; linked?: false; deps?: Partial<RemoteDeps> } = {}): Promise<Pc> {
    const db = memoryDb();
    const bus = recordingBus().bus;
    const clock = new ManualClock();
    const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock, name });
    const timers = new HandTimers();
    const mesh = new DeviceMesh({ db, identity, clock, log: silentLog, bus, timers, dial: async () => { throw new Error('no network in this rig'); } });
    mesh.updateSelf({ addresses: [address] });
    const pc = {
      name, address, identity, mesh, repo: new DevicesRepo(db), db, clock, timers, paired: [], states: [], shown: [], notes: [], admitted: [], sent: [], bodies: [],
      findable: options.findable ?? true, from: address.replace(/^http:\/\/|:\d+$/g, ''), bus, handlers: new Map(), online: new Set<string>(), calls: [],
    } as unknown as Pc;
    const add = mesh.add.bind(mesh);
    mesh.add = (info, opts) => { pc.paired.push({ id: info.id, side: opts.side, ...(opts.personId ? { personId: opts.personId } : {}) }); return add(info, opts); };
    bus.on('remote.updated', (state) => pc.states.push(state));
    const peers: RemoteDeps['mesh'] = {
      selfInfo: () => mesh.selfInfo(),
      add: (info, opts) => mesh.add(info, opts),
      list: () => mesh.list().map((device) => (pc.online.has(device.id) ? { ...device, status: 'online' as const } : device)),
      register: (method, handler, kinds = ['ceo', 'employer']) => { pc.handlers.set(method, { handler, kinds }); },
      call: (deviceId, method, params) => this.call(pc, deviceId, method, params),
    };
    pc.remote = new RemoteService({
      ...options.deps,
      identity, clock, bus, log: silentLog, mesh: peers, timers,
      findable: () => pc.findable,
      responder: { answer: (hello) => { pc.hello = hello; } },
      lan: async () => [...this.pcs.values()].filter((other) => other !== pc && other.hello).map((other) => other.hello!()).filter((found): found is Candidate => Boolean(found)),
      notify: (view) => pc.shown.push(view),
      admitted: (personId) => { pc.admitted.push(personId); },
      ...(options.linked === false ? {} : { linked: (note: { title: string; body: string }) => { pc.notes.push(note); } }),
      post: async (target, body) => {
        const other = [...this.pcs.values()].find((entry) => entry.address === target);
        const kind = String((body as { kind?: unknown }).kind);
        pc.sent.push(kind);
        pc.bodies.push(json(body as Record<string, unknown>));
        if (!other || pc.drop?.(body as Record<string, unknown>)) throw new Error('unreachable');
        const reply = json(await other.remote.handle(json(body as Record<string, unknown>), { address: pc.from }) as Record<string, unknown>);
        return pc.edit ? pc.edit(kind, reply) : reply;
      },
      wellKnownAt: async (target) => {
        const other = [...this.pcs.values()].find((entry) => entry.address === target);
        return other ? other.remote.wellKnown() : undefined;
      },
    });
    pc.remote.refresh();
    this.pcs.set(address, pc);
    return pc;
  }

  /** Stores `b` on `a` and `a` on `b` as a proven link: my own PCs, or `b` as the PC of `personId` here on `a`. */
  async link(a: Pc, b: Pc, as: { personId?: string } = {}): Promise<void> {
    a.mesh.add(b.mesh.selfInfo(), { side: 'inviter', ...(as.personId ? { personId: as.personId } : {}) });
    b.mesh.add(a.mesh.selfInfo(), { side: 'joiner', joinedAs: as.personId ? 'employee' : 'ceo' });
    await settle(); // the rig's failed dials have reported 'offline'
  }

  /** The link between `a` and `b` comes up (both ends are live, then each hears 'device.upserted' online) or goes. */
  up(a: Pc, b: Pc): void { this.flip(a, b, true); }
  down(a: Pc, b: Pc): void { this.flip(a, b, false); }

  private flip(a: Pc, b: Pc, on: boolean): void {
    for (const [pc, other] of [[a, b], [b, a]]) {
      if (on) pc.online.add(other.identity.deviceId); else pc.online.delete(other.identity.deviceId);
    }
    for (const [pc, other] of [[a, b], [b, a]]) {
      const device = pc.mesh.list().find((entry) => entry.id === other.identity.deviceId);
      if (device) pc.bus.emit('device.upserted', { ...device, status: on ? 'online' : 'offline' });
    }
  }

  /** A peer call as the mesh makes it: only over an up link, only to a method registered for that link's kind. */
  async call(from: Pc, deviceId: string, method: string, params: unknown): Promise<unknown> {
    from.calls.push(`${method} → ${deviceId}`);
    const to = [...this.pcs.values()].find((other) => other.identity.deviceId === deviceId);
    if (!to || !from.online.has(deviceId) || !to.online.has(from.identity.deviceId)) throw new WorkforceError('unavailable', 'The linked device is offline.');
    const entry = to.handlers.get(method);
    if (!entry) throw new WorkforceError('not_found', `Unknown device method ${method}.`);
    const record = to.repo.get(from.identity.deviceId);
    const kind: LinkKind = record?.personId ? 'employee' : record?.joinedAs === 'employee' ? 'employer' : 'ceo';
    if (!record || !entry.kinds.includes(kind)) throw new WorkforceError('forbidden', 'This link does not run that method on this PC.');
    try {
      return json(await entry.handler(json(params), from.identity.deviceId, new AbortController().signal));
    } catch (error) {
      throw error instanceof WorkforceError ? new WorkforceError(error.code, error.message) : error; // as it crosses the link
    }
  }
}

/** Connect, and – where the answer would make `pc` one of someone's devices (review H1 'confirm') – the person's yes. */
export async function connectYes(pc: Pc, input: { target: string; name?: string }): Promise<RemoteOutgoing> {
  const out = await pc.remote.connect(input);
  return out.status === 'confirm' ? pc.remote.confirm() : out;
}

/** Opens the PC's two ID trees (the company's, my own), as the meeting-server part does at start. */
export const treesOf = (pc: Pc) => openCodes(pc.db, pc.identity, () => pc.clock.now());

export const linkedIds = (pc: Pc) => pc.repo.list({ kinds: ['pc'] }).filter((device) => !device.self && device.status !== 'revoked').map((device) => device.id);
