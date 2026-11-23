// Connecting PCs (Settings › Devices): this PC as other PCs find it – its Remote ID (remote/id.ts),
// name and fingerprint, and whether it accepts connection requests (settings.devices.findable) –,
// the requests other PCs make here (remote/requests.ts, decided by the person) and this PC's own
// request (remote/join.ts). While findable, LAN hello probes are answered (devices/discovery.ts),
// /.well-known/workforce reports `remoteId` and `findable`, and the peer listener stays open.
// `nearby()` lists the PCs on this network that accept requests (remote/nearby.ts).
// Turning requests off ends every open request. stop() ends the LAN answers for good (shutdown).
// B-084 (person code, remote/code.ts): the Remote ID shown, put into the phone's QR and answered for is my person code
// (my own ID while no code is open); a PC accepted here as my own gets my signature, and the LAN hello carries my chain.
// Once a PC is linked – on either side – the person gets one notice (linkedNote): which PC, as what, what it receives
// and where to remove it, so no link made from an agent's devices.connect sits unnoticed. An employee's PC accepted
// here (a personId) also calls `admitted` (B-078 D15: the personal manager's one wake about that person).
// F17: the requests waiting on my other PCs join the list (remote/mirror.ts, while the mesh offers peer methods); Accept on
// one of them is decided on the PC that holds it. F13: Accept may make the person (`newPerson`) – made when the device
// links (`createPerson`), so the person and their PC arrive in one step; an employee's PC that links makes its person
// active (`joined`). F09: the LAN hello names this company (`company`), so a PC with several companies lists them under it.
// Eine-ID 22.11.2026: two IDs, no role picking. `remoteId` is this PC's own device ID (the phone QR); `companyId` the
// company's (remote/code.ts codeFor – on a member's PC the company's ID it was told until its chain arrived) and `myId` my
// own (meFor) – both only once this is a company (`setUp`: its first run is done). A PC accepted as one of my devices
// gets my signature in my own tree, and in the company's where this PC is one of the company's own (no employer); a new
// member on the company's own PC gets it in the company's tree. A new member accepted on a member's PC is admitted by the
// company's PC (devices/company-admit.ts, `admitHere` there) – Accept checks first that that PC is online. My own
// request accepted (as one of my devices or a new member) finishes this company's first run (`setUpDone`, with the name I
// joined with as a new member).
// Review 22.11.2026: `confirm` is my yes to becoming one of someone's devices (remote/join.ts 'confirm'); `self.member`
// marks a member's PC (Accept there names, it picks no person); the same company.admit asked again answers again.
// Owns: wiring of these parts, the state Settings › Devices shows, `remote.updated` and the linked notice.
// Never: links a PC without the person's answer, or answers probes while not findable.

import { WorkforceError } from '../../shared/errors.ts';
import type { NearbyPc, NewPerson, RemoteIncoming, RemoteOutgoing, RemoteState } from '../../shared/model/remote.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { Bus } from '../bus.ts';
import type { Clock, Logger } from '../contracts.ts';
import type { Candidate, HelloAnswer } from '../devices/discovery.ts';
import type { DeviceIdentity } from '../devices/identity.ts';
import type { PeerInfo, Reply } from '../devices/pair-proof.ts';
import { admitThrough, employerOf, serveAdmit, unreachable, type AdmitMarks } from '../devices/company-admit.ts';
import { fingerprintOf, fromB64url } from '../devices/keys.ts';
import { chainsOf, codeFor, meFor, watchCode } from './code.ts';
import { formatRemoteId, remoteIdOf } from './id.ts';
import { findTarget, type FindDeps, type Found } from './find.ts';
import { RemoteJoiner, type ConnectInput } from './join.ts';
import { RequestMirror, type Decision, type MirrorMesh } from './mirror.ts';
import { NearbyPcs } from './nearby.ts';
import { TargetRequests, type Timers } from './requests.ts';

export interface RemoteDeps {
  identity: Pick<DeviceIdentity, 'deviceId' | 'fingerprint' | 'sign'>;
  clock: Clock;
  bus: Bus;
  log: Logger;
  /**
   * The linked PCs: this PC's identity, storing a proven PC (and dialing it), the device list; with peer methods
   * (register, call – the mesh) the requests of my other PCs show here too (remote/mirror.ts).
   */
  mesh: { selfInfo(): PeerInfo; add(info: PeerInfo, options: { side: 'joiner' | 'inviter'; personId?: string; joinedAs?: 'ceo' | 'employee' }): Device; list(): Device[] }
    & Partial<Pick<MirrorMesh, 'register' | 'call'>>;
  /** F09: this company's name (companyLabel), told in the LAN hello – on a member's PC with the person ("Dojo · Momo"). */
  company?(): string;
  /** Eine-ID: the company's name alone, told to a PC that asks to join ("Joining Dojo as a new member"). */
  companyName?(): string;
  /** Owner 21.11.2026: the company's one Remote ID where this PC is an employee's (devices/company-facts.ts); undefined on the company's own PCs. */
  companyCode?(): string | undefined;
  /** Eine-ID addendum: this is a company – its first run is done (absent: always); before, no IDs show. */
  setUp?(): boolean;
  /**
   * Eine-ID addendum: my own request was accepted and linked – this company's first run is done now; `name`: the name I
   * joined with as a new member (Fest 22.11.2026: kept as this PC's person's name where none is set).
   */
  setUpDone?(name?: string): void;
  /** Review H1: this PC's person, named to a PC that would become one of their devices. */
  person?(): string;
  /** Review M2: the keys stored here through company.admit (devices/company-admit.ts admitMarks); absent: kept in memory. */
  admits?: AdmitMarks;
  /** F13: makes the person Accept named (people.save) and returns their id; throws to refuse. */
  createPerson?(input: NewPerson): string;
  /** Is this a person of the organisation here (a decide from another of my PCs names one). */
  knows?(personId: string): boolean;
  /** An employee's PC is linked for this person: the person is in now (people/service.ts joinedWith). */
  joined?(personId: string, device: { id: string; name: string }): void;
  /** settings.devices.findable (and a peer listener that may open at all). */
  findable(): boolean;
  /** POST JSON to `<address>/peer/pair` (or the meeting server's `relay:<fp>` route) with a timeout. */
  post(address: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  /** LAN: answers hello probes while findable. */
  responder?: { answer(answer: HelloAnswer | undefined): void };
  /** LAN: one hello probe. */
  lan?(): Promise<Candidate[]>;
  /** The meeting server: PCs that accept requests under a Remote ID. */
  meeting?(remoteId: string, signal: AbortSignal): Promise<Found[]>;
  wellKnownAt?: FindDeps['wellKnown'];
  /** Holds the peer listener open while this PC's request runs. */
  holdListener?(): Promise<(() => void) | undefined>;
  /** The peer listener's port while it listens (well-known). */
  peerPort?(): number | undefined;
  /** A request is shown here: one notification for the person. */
  notify?(view: RemoteIncoming): void;
  /** A PC is now linked here (either side): one important notification for the person (linkedNote). */
  linked?(note: { title: string; body: string }): void;
  /** B-078 (D15): an employee's PC was accepted here for this person (org/member-welcome.ts, once per person). */
  admitted?(personId: string): void;
  timers?: Timers;
}

/** As what a linked PC is here: one of the CEO's own PCs, the PC of a person here, or the employer's PC this PC joined as an employee's. */
type LinkedAs = 'own' | 'employee' | 'employer';

const LINKED: Readonly<Record<LinkedAs, readonly [as: string, gets: string]>> = {
  own: ['your own PC', 'this company\'s chats, secrets and settings and can run commands on this PC'],
  employee: ['an employee\'s PC', 'its person\'s chats and tasks'],
  employer: ['your employer\'s PC', 'your lines and task changes in its chats and can run commands on this PC'],
};

/** The notice once a PC is linked: which PC, as what, what it receives and where to remove it. */
export function linkedNote(device: Pick<Device, 'name' | 'fingerprint'>, as: LinkedAs): { title: string; body: string } {
  const [what, gets] = LINKED[as];
  return {
    title: `${device.name} is now linked`,
    body: `${device.name} (Remote ID ${formatRemoteId(remoteIdOf(device.fingerprint))}) is linked as ${what}: it receives ${gets}. Remove it in Settings › Devices.`,
  };
}

const realTimers: Timers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** Request kinds of POST /peer/pair. */
export const REMOTE_KINDS: ReadonlySet<string> = new Set(['remote1', 'remote2', 'remote3', 'remoteCancel', 'remoteName']);

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export class RemoteService {
  private readonly deps: RemoteDeps;
  private readonly target: TargetRequests;
  private readonly joiner: RemoteJoiner;
  private readonly near: NearbyPcs;
  /** F17: the requests waiting on my other PCs (absent without peer methods). */
  private readonly mirror?: RequestMirror;
  /** Review M2: the keys stored here through company.admit (kv in the app, memory without it). */
  private readonly admits: AdmitMarks;
  private lastFindable?: boolean;
  private lastSetUp?: boolean;
  private stopped = false;
  private readonly offCode: () => void;

  constructor(deps: RemoteDeps) {
    this.deps = deps;
    const marked = new Set<string>();
    this.admits = deps.admits ?? { has: (fp) => marked.has(fp), add: (fp) => { marked.add(fp); } };
    const timers = deps.timers ?? realTimers;
    const now = () => deps.clock.now();
    this.target = new TargetRequests({
      now, timers, log: deps.log, signer: deps.identity,
      findable: () => this.findable(),
      self: () => deps.mesh.selfInfo(),
      link: (info, picked, newPerson, role) => (role === 'ceo' ? this.linkMine(info) : this.linkMember(info, picked, newPerson)),
      company: () => deps.companyName?.() ?? '',
      person: () => deps.person?.() ?? '',
      shown: (view) => deps.notify?.(view),
      changed: () => this.changed(),
    });
    this.joiner = new RemoteJoiner({
      now, timers, log: deps.log, signer: deps.identity,
      self: () => deps.mesh.selfInfo(),
      holdListener: () => deps.holdListener?.() ?? Promise.resolve(undefined),
      post: deps.post,
      find: (target) => findTarget({ self: deps.identity.deviceId, lan: deps.lan, meeting: deps.meeting, wellKnown: deps.wellKnownAt }, target),
      // The role the other PC answered stays with the link; my own request accepted finishes this company's first run.
      link: (info, role, name) => {
        this.store(info, { side: 'joiner', joinedAs: role }, role === 'employee' ? 'employer' : 'own');
        try { deps.setUpDone?.(name); } catch (error) { deps.log.warn('first run not finished', { error: errorText(error) }); }
      },
      changed: () => this.changed(),
    });
    this.near = new NearbyPcs({
      self: { deviceId: deps.identity.deviceId, fingerprint: deps.identity.fingerprint },
      lan: () => deps.lan?.() ?? Promise.resolve([]),
      linked: () => deps.mesh.list().filter((device) => device.kind === 'pc'),
      outgoing: () => this.joiner.outgoing(),
      now,
    });
    const { register, call } = deps.mesh;
    if (register && call) {
      this.mirror = new RequestMirror({
        mesh: { register: register.bind(deps.mesh), call: call.bind(deps.mesh), list: () => deps.mesh.list() },
        bus: deps.bus, now, timers, log: deps.log,
        own: () => this.ownIncoming(),
        decide: (decision) => this.decideHere(decision),
        knows: (personId) => deps.knows?.(personId) ?? false,
        changed: () => this.emitState(),
      });
      serveAdmit({ register: register.bind(deps.mesh), list: () => deps.mesh.list() }, (info, name) => this.admitHere(info, name));
    }
    this.offCode = watchCode(deps.identity.fingerprint, () => this.changed()); // a new code shows at once
  }

  /** This PC's own device ID (derived from its key): the phone QR's ID. */
  remoteId(): string { return remoteIdOf(this.deps.identity.fingerprint); }

  /**
   * Eine-ID: the company's ID and my own, once this is a company. The company's: its tree's code once this PC is in it –
   * on a member's PC still alone in its tree, the ID the company told (company-facts.ts companyCode).
   */
  ids(): { companyId?: string; myId?: string } {
    if (!this.setUp()) return {};
    const fp = this.deps.identity.fingerprint;
    const code = codeFor(fp);
    let told: string | undefined;
    try { told = code?.chain().links.length ? undefined : this.deps.companyCode?.(); } catch { /* the tree's code stands */ }
    const myId = meFor(fp)?.code();
    return { companyId: told ?? code?.code() ?? remoteIdOf(fp), ...(myId ? { myId } : {}) };
  }

  /** My chain to the company's root, when I am not the root myself. */
  private chain(): { chain: unknown } | Record<string, never> {
    const chain = codeFor(this.deps.identity.fingerprint)?.chain();
    return chain?.links.length ? { chain } : {};
  }

  private setUp(): boolean {
    try { return this.deps.setUp?.() ?? true; } catch { return false; }
  }

  state(): RemoteState {
    const self = this.deps.mesh.selfInfo();
    const outgoing = this.joiner.outgoing();
    return {
      self: { deviceId: self.id, name: self.name, remoteId: this.remoteId(), fingerprint: this.deps.identity.fingerprint, findable: this.findable(), ...this.ids(), ...(employerOf(this.deps.mesh.list()) ? { member: true as const } : {}) },
      incoming: [...this.ownIncoming(), ...(this.mirror?.rows() ?? [])],
      ...(outgoing ? { outgoing } : {}),
    };
  }

  /** The requests waiting on this PC itself (RemoteWithPhones adds the phones'). */
  protected ownIncoming(): RemoteIncoming[] { return this.target.incoming(); }

  /** Starts answering LAN probes when findable, ends open requests when not; call again when settings or the listener change. */
  refresh(): void {
    if (this.stopped) return;
    const findable = this.findable();
    const setUp = this.setUp();
    this.deps.responder?.answer(findable ? () => this.hello() : undefined);
    if (!findable) this.target.closeAll();
    // The first run finishing shows the two IDs at once, also on a PC that takes no requests.
    if ((this.lastFindable !== undefined && this.lastFindable !== findable) || (this.lastSetUp !== undefined && this.lastSetUp !== setUp)) this.changed();
    this.lastFindable = findable;
    this.lastSetUp = setUp;
  }

  /** Shutdown: no more LAN answers (refresh() stays quiet), no more mirrored requests. */
  stop(): void {
    this.stopped = true;
    this.offCode();
    this.mirror?.stop();
    this.deps.responder?.answer(undefined);
  }

  /** "Connect" by an ID or address; the PC asked decides the role. */
  connect(input: ConnectInput): Promise<RemoteOutgoing> { return this.joiner.connect(input); }

  /** Review H1: the person's yes to becoming one of the other person's devices (remote.confirm). */
  confirm(): Promise<RemoteOutgoing> { return this.joiner.confirm(); }

  /** Eine-ID: the name I propose while my request as a new member waits (remote.name). */
  rename(name: string): Promise<void> { return this.joiner.rename(name); }

  /** PCs on this network that accept requests, this PC left out; `refresh` asks the network again. */
  nearby(refresh = false): Promise<NearbyPc[]> { return this.near.list(refresh); }

  /** Cancels this PC's open request, or closes its last outcome. */
  cancel(): void { this.joiner.cancel(); }

  /**
   * The person's answer to a request (`personId`: the person an employee's PC or a phone belongs to; `newPerson`: the
   * person to make for it, F13). One waiting here is decided at once (throws); one waiting on another of my PCs (F17) is
   * decided there – the returned promise settles with that PC's answer.
   */
  decide(id: string, accept: boolean, personId?: string, newPerson?: NewPerson): void | Promise<void> {
    const decision: Decision = { id, accept, ...(personId ? { personId } : {}), ...(newPerson ? { newPerson } : {}) };
    if (!this.holdsHere(id) && this.mirror?.holderOf(id)) return this.mirror.decide(decision);
    this.decideHere(decision);
  }

  /** Does this PC itself hold the request `id` (RemoteWithPhones: the phones' too). */
  protected holdsHere(id: string): boolean { return this.target.holds(id); }

  /** The answer to a request this PC holds (also what another of my PCs' decide runs here). */
  protected decideHere(decision: Decision): void {
    if (decision.accept && this.target.roleOf(decision.id) === 'employee') this.checkAdmit(decision);
    this.target.decide(decision.id, decision.accept, decision.personId, decision.newPerson);
  }

  /** A new member accepted on a member's PC: the company's PC adds them – it is online, and the member is named here. */
  private checkAdmit(decision: Decision): void {
    const employer = employerOf(this.deps.mesh.list());
    if (!employer) return;
    if (decision.personId) throw new WorkforceError('bad_request', 'Name the new member here – the company makes their person.');
    if (employer.status !== 'online') throw new WorkforceError('unavailable', unreachable(employer));
  }

  /** One of my devices is in: my own tree signs it, and the company's where this PC is one of the company's own (code.ts refuses on a member's PC). */
  private linkMine(info: PeerInfo): void {
    this.store(info, { side: 'inviter' }, 'own');
    const fp = this.deps.identity.fingerprint;
    meFor(fp)?.sign(info.pub);
    codeFor(fp)?.sign(info.pub);
  }

  /** A new member: on a member's PC the company's PC admits them (its identity rides in the answer), else they are in here. */
  private async linkMember(info: PeerInfo, picked: string | undefined, newPerson: NewPerson | undefined): Promise<void | { employer: PeerInfo }> {
    const employer = employerOf(this.deps.mesh.list());
    if (employer) {
      const call = this.deps.mesh.call;
      if (!call || !newPerson?.name) throw new WorkforceError('bad_request', 'Name the new member here – the company makes their person.');
      return { employer: await admitThrough({ call: call.bind(this.deps.mesh) }, employer, info, newPerson.name) };
    }
    const personId = this.personFor(picked, newPerson);
    if (!personId) throw new WorkforceError('bad_request', 'Name the new member, or pick the person this PC belongs to.');
    this.addMember(info, personId);
  }

  /**
   * Eine-ID: on the company's PC, a new member a member's PC accepted (devices/company-admit.ts): the person, their PC and
   * the company's signature; returns this PC's identity for the new PC to link. The same admit again (its key stored here
   * through an admit, as a member's PC) answers again; a key linked any other way is a conflict.
   */
  admitHere(info: PeerInfo, name: string): PeerInfo {
    const fp = fingerprintOf(fromB64url(info.pub));
    const known = this.deps.mesh.list().find((device) => (device.id === info.id || device.fingerprint === fp) && !device.revokedAt && device.status !== 'revoked');
    if (known?.personId && known.id === info.id && known.fingerprint === fp && this.admits.has(fp)) return this.deps.mesh.selfInfo();
    if (known || fp === this.deps.identity.fingerprint) throw new WorkforceError('conflict', `${info.name} is linked here already.`);
    const personId = this.personFor(undefined, { name });
    if (!personId) throw new WorkforceError('unavailable', 'People cannot be added on this PC.');
    this.addMember(info, personId);
    this.admits.add(fp);
    return this.deps.mesh.selfInfo();
  }

  /** A new member's PC is in here: stored as theirs, signed into the company's tree, the person joined and welcomed. */
  private addMember(info: PeerInfo, personId: string): void {
    this.store(info, { side: 'inviter', personId }, 'employee');
    codeFor(this.deps.identity.fingerprint)?.sign(info.pub);
    try { this.deps.joined?.(personId, { id: info.id, name: info.name }); } catch (error) { this.deps.log.warn('person not marked joined', { personId, error: errorText(error) }); }
    this.admitted(personId);
  }

  /** The person a device links as: the one picked, or (F13) the one Accept named, made now. */
  protected personFor(personId: string | undefined, newPerson: NewPerson | undefined): string | undefined {
    if (personId || !newPerson) return personId;
    if (!this.deps.createPerson) throw new WorkforceError('unavailable', 'People cannot be added on this PC.');
    return this.deps.createPerson(newPerson);
  }

  /** POST /peer/pair with a Remote kind (REMOTE_KINDS). */
  handle(body: Record<string, unknown>, remote: { address?: string }): Promise<Reply> {
    return this.target.handle(body, remote);
  }

  /** What /.well-known/workforce answers: the public identity, the Remote ID, `findable` while requests are accepted. */
  wellKnown(): { app: 'workforce'; protocol: 1; deviceId: string; name: string; fingerprint: string; remoteId: string; peerPort?: number; findable?: true; chain?: unknown } {
    const self = this.deps.mesh.selfInfo();
    const peerPort = this.deps.peerPort?.();
    return {
      app: 'workforce', protocol: 1, deviceId: self.id, name: self.name, fingerprint: this.deps.identity.fingerprint, remoteId: this.remoteId(),
      ...(peerPort ? { peerPort } : {}), ...(this.findable() ? { findable: true as const } : {}), ...this.chain(),
    };
  }

  private findable(): boolean {
    try { return this.deps.findable(); } catch { return false; }
  }

  /** Stores a proven PC, then tells the person which PC is linked as what (linkedNote). */
  private store(info: PeerInfo, options: Parameters<RemoteDeps['mesh']['add']>[1], as: LinkedAs): void {
    const device = this.deps.mesh.add(info, options);
    this.deps.linked?.(linkedNote(device, as));
  }

  /** An employee's PC is in: the personal manager hears once about the person (never fails the link). */
  private admitted(personId: string): void {
    try { this.deps.admitted?.(personId); } catch (error) { this.deps.log.warn('employee welcome not sent', { personId, error: errorText(error) }); }
  }

  /**
   * A LAN hello probe gets this PC's public identity, own Remote ID (older PCs check it), chain and (F09) company name
   * while it accepts requests.
   */
  private hello(): Candidate | undefined {
    if (!this.findable()) return undefined;
    const self = this.deps.mesh.selfInfo();
    const fingerprint = this.deps.identity.fingerprint;
    let company = '';
    try { company = this.deps.company?.().trim().slice(0, 80) ?? ''; } catch { /* the answer goes without it */ }
    return { deviceId: self.id, name: self.name, fingerprint, remoteId: remoteIdOf(fingerprint), addresses: self.addresses, ...chainsOf(fingerprint), ...(company ? { company } : {}) };
  }

  /** This PC's own requests changed: the state goes to the window and phones, the list to my other PCs. */
  protected changed(): void {
    this.emitState();
    this.mirror?.send();
  }

  private emitState(): void {
    try { this.deps.bus.emit('remote.updated', this.state()); } catch (error) { this.deps.log.warn('remote state not sent', { error: errorText(error) }); }
  }
}
