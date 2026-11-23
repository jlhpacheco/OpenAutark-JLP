// The RPC server: the one dispatcher between clients (desktop window, PWA/phone, CLI) and the
// runtime. Transports attach a connection with a scope they authenticated; the
// server parses frames, runs every request independently (no head-of-line blocking) through
// the handler table, replies `{id, result}` / `{id, error}` and pushes bus events to the
// connections subscribed to the event's topic and allowed to see it, each with the payload its
// scope may see (scopes.ts).
// Every handler runs as its caller (rpc/caller.ts: the scope, and the address of a tokenless
// call) so code further down can narrow what that caller's answer may do (DEV5B).
// Owns: dispatch, per-connection state (topics, abort signal, in-flight cap), event fan-out
// (incl. `run.item` → `runs:<agentId>`, and `agent.activity` with the other PCs' runs added – F10), the KEPT events'
// last state and closing connections of revoked devices. The
// tokenless `POST /rpc` route is served by rpc/tokenless.ts on this server's table.
// Roles: the owner and the owner's paired phones (scope kind 'device', the CEO's) see everything their
// tier allows (scopes.ts); an employee's device (scope kind 'person') gets only what
// runtime/people/events.ts lets through (the chats they are a member of, their tasks, their colleagues),
// seen from the person's perspective, and loses its connection when its token or person ends
// (`person.upserted`) – or when the owner changed that person's rights, so the open app reconnects at
// once with its new session.info (people/events.ts personRights).
// Fest round 22.11.2026 (state, not messages): an event that is the whole current state of something no method reads
// (KEPT: main's updater, update.state) is kept – heard from the start, with or without a connection (a restarted runtime
// hears main's replay before any port connects) – and a phone's or browser's connection that joins its topic gets it at
// once, so it knows after every (re)connect whether an update waits; the window has main's own, a CLI's `wf events`
// hears only news.
// Never: business logic (handlers delegate to services), logging params (they may hold
// secrets), or letting a slow/closed connection throw into the bus.

import { topicOf } from '../../shared/api/events.ts';
import type { EventName } from '../../shared/api/events.ts';
import { isRequest } from '../../shared/api/protocol.ts';
import type { ClientScope, RpcEvent, RpcRequest, RpcResponse, Topic } from '../../shared/api/protocol.ts';
import { WorkforceError, toErrorData } from '../../shared/errors.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { AgentActivity, Run, RunItem } from '../../shared/model/runs.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { allActivity } from '../chat/live.ts';
import { withCaller } from './caller.ts';
import { parseFrame } from './connection.ts';
import type { RpcConnection } from './connection.ts';
import type { RpcExtras } from './extras.ts';
import { createHandlerTable } from './handlers/index.ts';
import { deviceAgent, mayReceive, visibleData } from './scopes.ts';
import type { Agent } from '../../shared/model/org.ts';
import { scopeDenial, secureScope } from './table.ts';
import { serveTokenless, type HttpCallMeta } from './tokenless.ts';
import { personMayReceive, personRemoval, personRights, personView } from '../people/events.ts';
import type { Person } from '../../shared/model/people.ts';
import type { HandlerContext, HandlerTable } from './table.ts';

export interface RpcServerDeps {
  services: () => RuntimeServices;
  extras: () => RpcExtras;
  table?: HandlerTable;
  log?: Logger;
}

/** Requests one connection may have running at once; more get `rate_limited`. */
const MAX_INFLIGHT = 64;
/** runId → agentId entries kept for routing `run.item` events. */
const RUN_CACHE = 512;
const NEVER = new AbortController().signal;
/** Events whose payload is the whole current state of something no method reads: the last one goes to every new subscriber. */
const KEPT: ReadonlySet<EventName> = new Set(['update.state']);

interface Client {
  connection: RpcConnection;
  scope: ClientScope;
  topics: Set<Topic>;
  abort: AbortController;
  inflight: number;
  closed: boolean;
  /** F-52: a person's rights when the connection was attached (people/events.ts personRights). */
  rights?: string;
  /** A device's agents as last sent on this connection (scopes.ts deviceAgent). */
  agents?: Map<string, string>;
  detach(): void;
}

export class RpcServer {
  private readonly deps: RpcServerDeps;
  private readonly table: HandlerTable;
  private readonly clients = new Set<Client>();
  private readonly runAgents = new Map<string, string>();
  /** The last payload of each KEPT event. */
  private readonly kept = new Map<EventName, unknown>();
  private readonly offKept: Array<() => void> = [];
  private offBus: (() => void) | undefined;

  constructor(deps: RpcServerDeps) {
    this.deps = deps;
    this.table = deps.table ?? createHandlerTable();
    try {
      const bus = deps.services().bus;
      for (const event of KEPT) this.offKept.push(bus.on(event, (data: unknown) => { this.kept.set(event, data); }));
    } catch { /* services without a bus (the repair runtime): nothing to keep */ }
  }

  /** Number of attached connections (diagnostics). */
  get size(): number {
    return this.clients.size;
  }

  /** Methods the table serves (diagnostics, tests). */
  methods(): string[] {
    return this.table.methods();
  }

  // ------------------------------------------------------------------ connections

  /** Serves one authenticated connection. The returned function detaches and closes it. */
  attach(connection: RpcConnection, scope: ClientScope): () => void {
    const client: Client = {
      connection, scope, topics: new Set(), abort: new AbortController(), inflight: 0, closed: false,
      detach: () => {
        if (client.closed) return;
        client.closed = true;
        client.abort.abort();
        client.topics.clear();
        this.clients.delete(client);
        if (!this.clients.size) this.releaseBus();
      },
    };
    if (scope.kind === 'person') client.rights = this.rightsOf(scope.personId);
    this.clients.add(client);
    this.ensureBus();
    connection.onMessage((data) => this.receive(client, data));
    connection.onClose(() => client.detach());
    return () => this.drop(client);
  }

  /** Closes every connection and stops listening to the bus (shutdown). */
  close(): void {
    for (const client of [...this.clients]) this.drop(client);
    this.releaseBus();
    for (const off of this.offKept.splice(0)) off();
  }

  /** Detaches a client and closes its transport. */
  private drop(client: Client): void {
    client.detach();
    try { client.connection.close(); } catch { /* already closed */ }
  }

  // ------------------------------------------------------------------ direct calls

  /** Runs one method in-process (main/CLI adapters, tests). Throws WorkforceError on failure. */
  async call(method: string, params: unknown, scope: ClientScope): Promise<unknown> {
    try {
      return await this.dispatch(method, params, this.context(scope, new Set(), NEVER));
    } catch (error) {
      if (error instanceof WorkforceError) throw error;
      const data = this.errorData(error, method);
      throw new WorkforceError(data.code, data.message, { details: data.details, retryAfterMs: data.retryAfterMs, cause: error });
    }
  }

  /**
   * The unauthenticated `POST /rpc` route: only the TOKENLESS methods – pairing a new
   * phone/browser by link, or asking this PC for access and waiting for the answer (DEV5B).
   * `meta` carries the caller's address (per-address limits) and ends a long wait when the page goes.
   */
  handleHttp(frame: unknown, meta: HttpCallMeta = {}): Promise<RpcResponse> {
    return serveTokenless(frame, meta, {
      table: this.table, context: (scope, signal) => this.context(scope, new Set(), signal), errorData: (error, method) => this.errorData(error, method),
    });
  }

  // ------------------------------------------------------------------ requests

  private receive(client: Client, data: unknown): void {
    if (client.closed) return;
    const frame = parseFrame(data);
    if (!frame || !isRequest(frame)) return; // clients only send requests (Hello is the transport's)
    if (typeof frame.id !== 'number' || !Number.isFinite(frame.id)) return; // nothing to reply to
    void this.handleRequest(client, frame);
  }

  private async handleRequest(client: Client, request: RpcRequest): Promise<void> {
    if (client.inflight >= MAX_INFLIGHT) {
      this.send(client, { id: request.id, error: { code: 'rate_limited', message: 'Too many requests at once.', retryAfterMs: 1000 } });
      return;
    }
    client.inflight++;
    const before = request.method === 'events.subscribe' ? new Set(client.topics) : undefined;
    let reply: RpcResponse;
    try {
      const result = await this.dispatch(request.method, request.params, this.context(client.scope, client.topics, client.abort.signal));
      reply = { id: request.id, result: result ?? null };
    } catch (error) {
      reply = { id: request.id, error: this.errorData(error, typeof request.method === 'string' ? request.method : '?') };
    } finally {
      client.inflight--;
    }
    if (client.closed) return;
    this.send(client, reply);
    if (before) this.sendKept(client, before);
  }

  /** The kept state of every topic a phone's or browser's client just joined (it had none of them in `before`). */
  private sendKept(client: Client, before: ReadonlySet<Topic>): void {
    if (client.scope.kind !== 'device' && client.scope.kind !== 'person') return; // the window has main's own state; a CLI's events stay news
    for (const [event, data] of this.kept) {
      const topic = topicOf(event, data);
      if (!before.has(topic) && client.topics.has(topic)) this.deliver(client, topic, event, data);
    }
  }

  private async dispatch(method: unknown, params: unknown, ctx: HandlerContext): Promise<unknown> {
    if (typeof method !== 'string' || !method || method.length > 80) throw new WorkforceError('bad_request', 'Invalid method name.');
    const entry = this.table.get(method);
    if (!entry) throw new WorkforceError('not_found', 'Unknown method.', { details: { method } });
    const denial = scopeDenial(entry.scope, ctx.scope);
    if (denial === 'insecure') throw new WorkforceError('forbidden', 'Open the HTTPS address to do this.', { details: { method, needsSecure: true } });
    if (denial) throw new WorkforceError('forbidden', 'This device is not allowed to do that.', { details: { method } });
    return await withCaller({ scope: ctx.scope }, () => entry.handler(params as never, ctx));
  }

  private context(scope: ClientScope, topics: Set<Topic>, signal: AbortSignal): HandlerContext {
    return { scope, services: this.deps.services(), extras: this.deps.extras(), topics, signal, secure: secureScope(scope) };
  }

  /** Safe error data; unexpected errors are logged (method name only, never params). */
  private errorData(error: unknown, method: string): WorkforceErrorData {
    const data = toErrorData(error);
    if (data.code === 'internal' && !(error instanceof WorkforceError)) {
      let text = error instanceof Error ? error.message : String(error);
      try { text = this.deps.services().secrets?.redact(text) ?? text; } catch { /* secret store not ready */ }
      this.log()?.error('rpc handler failed', { method, error: text.slice(0, 500) });
    }
    return data;
  }

  // ------------------------------------------------------------------ events

  private ensureBus(): void {
    if (this.offBus) return;
    this.offBus = this.deps.services().bus.onAny((event, data) => {
      try { this.forward(event, data); } catch (error) {
        this.log()?.warn('rpc event forwarding failed', { event, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private releaseBus(): void {
    this.offBus?.();
    this.offBus = undefined;
  }

  private forward(event: EventName, data: unknown): void {
    if (event === 'run.upserted') this.rememberRun(data as Run);
    if (event === 'device.upserted' || event === 'device.removed') this.dropRevoked(event, data);
    if (event === 'person.upserted' || event === 'settings.updated') this.dropPeople(event === 'person.upserted' ? data as Person : undefined); // revoked or rights changed
    if (!this.clients.size) return;
    let topic: Topic;
    if (event === 'run.item') {
      // Run items travel only on the insight stream of their agent (not to every 'org' subscriber).
      if (!this.anyRunsSubscriber()) return;
      const agentId = this.agentOfRun((data as RunItem).runId);
      if (!agentId) return;
      topic = `runs:${agentId}`;
    } else {
      topic = topicOf(event, data);
    }
    // F10 (16.11.2026): windows and phones hear this PC's running runs with those of the person's other PCs (chat/live.ts).
    if (event === 'agent.activity') data = { active: allActivity(this.deps.services().bus, (data as { active: AgentActivity[] }).active) };
    const shared: { frame?: RpcEvent } = {};
    for (const client of this.clients) {
      if (!client.closed && client.topics.has(topic)) this.deliver(client, topic, event, data, shared);
    }
  }

  /** One event to one subscribed client, as its scope may see it; `shared` reuses one frame for the clients that see it unchanged. */
  private deliver(client: Client, topic: Topic, event: EventName, data: unknown, shared: { frame?: RpcEvent } = {}): void {
    if (client.scope.kind === 'person') { this.forwardPerson(client, topic, event, data); return; }
    if (!mayReceive(client.scope, topic, event, data)) return;
    if (event === 'agent.upserted' && client.scope.kind === 'device') { // a phone: no SYSTEM.md again for a status change
      this.send(client, { event, data: deviceAgent(client.agents ??= new Map(), data as Agent) });
      return;
    }
    const visible = visibleData(client.scope, event, data); // per-scope payload (an external agent's messages)
    this.send(client, visible === data ? (shared.frame ??= { event, data }) : { event, data: visible });
  }

  /** F-52: an event for a person's device – only what they may see, from their perspective. */
  private forwardPerson(client: Client, topic: Topic, event: EventName, data: unknown): void {
    if (client.scope.kind !== 'person') return;
    const services = this.deps.services();
    if (!personMayReceive(services, client.scope, topic, event, data)) {
      const removal = personRemoval(services, client.scope, topic, event, data); // a chat they left: the row goes
      if (removal) this.send(client, removal);
      return;
    }
    this.send(client, { event, data: personView(services, client.scope, event, data) });
  }

  /**
   * F-52: a person's device whose token or person ended loses its connection at once; so does one whose
   * rights the owner just changed (`changed`): the app reconnects and loads its new session.
   */
  private dropPeople(changed?: Person): void {
    let people: RuntimeServices['people'];
    try { people = this.deps.services().people; } catch { return; }
    for (const client of [...this.clients]) {
      if (client.scope.kind !== 'person') continue;
      if (!people?.isLive(client.scope)) this.drop(client);
      else if (changed?.id === client.scope.personId && personRights(changed) !== client.rights) this.drop(client);
    }
  }

  /** F-52: the stored rights of a person (empty when the people module is not there). */
  private rightsOf(personId: string): string {
    try { return personRights(this.deps.services().people?.repo.get(personId)); } catch { return ''; }
  }

  /** Sends without ever throwing; a broken transport is closed and detached. */
  private send(client: Client, frame: RpcResponse | RpcEvent): void {
    if (client.closed) return;
    try {
      client.connection.send(frame);
    } catch (error) {
      this.log()?.debug('rpc send failed, closing connection', { error: error instanceof Error ? error.message : String(error) });
      this.drop(client);
    }
  }

  private anyRunsSubscriber(): boolean {
    for (const client of this.clients) if (hasRunsTopic(client.topics)) return true;
    return false;
  }

  private rememberRun(run: Run | undefined): void {
    if (!run?.id || !run.agentId) return;
    this.runAgents.delete(run.id);
    this.runAgents.set(run.id, run.agentId);
    if (this.runAgents.size > RUN_CACHE) this.runAgents.delete(this.runAgents.keys().next().value!);
  }

  private agentOfRun(runId: string | undefined): string | undefined {
    if (!runId) return undefined;
    const cached = this.runAgents.get(runId);
    if (cached) return cached;
    try {
      const run = this.deps.services().runs.get(runId);
      this.rememberRun(run);
      return run?.agentId;
    } catch {
      return undefined;
    }
  }

  /** A revoked or removed phone/browser loses its live connections immediately, not at the next reconnect. */
  private dropRevoked(event: EventName, data: unknown): void {
    const device = data as Partial<Device> | undefined;
    if (!device?.id || (event === 'device.upserted' && device.status !== 'revoked' && !device.revokedAt)) return;
    for (const client of [...this.clients]) if (client.scope.kind === 'device' && client.scope.deviceId === device.id) this.drop(client);
  }

  private log(): Logger | undefined {
    if (this.deps.log) return this.deps.log;
    try { return this.deps.services().log; } catch { return undefined; }
  }
}

function hasRunsTopic(topics: Set<Topic>): boolean {
  for (const topic of topics) if (topic.startsWith('runs:')) return true;
  return false;
}
