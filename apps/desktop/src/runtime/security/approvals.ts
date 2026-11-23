// The approval requests that wait for the person (Sicher-Runde 19.11.2026): in memory and in the kv table, so a request
// survives a restart (only the call that waited for it does not – its agent is woken by the answer). One request per agent
// and fingerprint: the same step asked again waits on the request already there. A call waits at most its wait time and
// stops waiting when its turn ends (signal); the request stays. "Once" goes to exactly one call: the first waiting one
// (the others waiting on the same request hear 'spent'), or, while nobody waits, a grant for that agent's next identical
// call (agent + fingerprint), kept a day.
// Owns: the pending list, the waiters and the once grants. Never: decides, asks, writes settings or wakes (service.ts).

import type { ApprovalAnswer } from '../../shared/model/security-settings.ts';
import type { ApprovalRequest } from '../../shared/api/methods-security-mode.ts';

/** How long a call waits in place for the person's answer. */
export const WAIT_MS = 2 * 60_000;
/** A once grant nobody used is gone after a day. */
export const GRANT_MS = 24 * 60 * 60_000;
/** At most this many requests wait; a newer one pushes out the oldest. */
export const MAX_PENDING = 100;

const NS = 'security.approvals';

/** A request with what the runtime needs besides what the person sees. */
export interface StoredRequest extends ApprovalRequest {
  fingerprint: string;
  /** The agent's task when it asked (its wake goes there). */
  taskId?: string;
  /** The person's to-do for it (tasks/approval-todo.ts). */
  todoId?: string;
}

/** What the kv table needs to offer. */
export interface ApprovalKv {
  get<T>(ns: string, key: string): T | undefined;
  set(ns: string, key: string, value: unknown, at: number): void;
}

/** What a waiting call hears: the answer; 'waiting' (time up or its turn ended – the request stays); 'spent' (the "once" went to another call waiting on the same request). */
export type WaitOutcome = ApprovalAnswer | 'waiting' | 'spent';

type Waiter = (answer: WaitOutcome) => void;

/** One grant per agent and step: another agent's identical call never uses it. */
const grantKey = (agentId: string, fingerprint: string): string => `${agentId}\u0000${fingerprint}`;

export class Approvals {
  private readonly pending = new Map<string, StoredRequest>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private grants = new Map<string, number>(); // grantKey(agent, fingerprint) → granted at
  private readonly deps: { kv?: ApprovalKv; now(): number };

  constructor(deps: { kv?: ApprovalKv; now(): number }) {
    this.deps = deps;
    const stored = this.read<StoredRequest[]>('pending') ?? [];
    for (const request of Array.isArray(stored) ? stored : []) if (request?.id && request.fingerprint) this.pending.set(request.id, request);
    const grants = this.read<Array<[string, number]>>('grants') ?? [];
    for (const [fingerprint, at] of Array.isArray(grants) ? grants : []) if (typeof fingerprint === 'string' && typeof at === 'number') this.grants.set(fingerprint, at);
  }

  list(): StoredRequest[] {
    return [...this.pending.values()].sort((a, b) => a.at - b.at);
  }

  get(id: string): StoredRequest | undefined {
    return this.pending.get(id);
  }

  /** The request this agent already has for the same step. */
  find(agentId: string, fingerprint: string): StoredRequest | undefined {
    for (const request of this.pending.values()) if (request.agentId === agentId && request.fingerprint === fingerprint) return request;
    return undefined;
  }

  /** Adds a request; returns the requests pushed out to make room (their to-dos close). */
  add(request: StoredRequest): StoredRequest[] {
    this.pending.set(request.id, request);
    const out: StoredRequest[] = [];
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.list()[0];
      this.pending.delete(oldest.id);
      this.release(oldest.id, 'waiting');
      out.push(oldest);
    }
    this.save();
    return out;
  }

  /** Notes the request's to-do. */
  setTodo(id: string, todoId: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    request.todoId = todoId;
    this.save();
  }

  /** Waits for the answer: the answer, 'waiting' when `ms` passed or `signal` ended the wait (the request stays), or 'spent'. */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (!this.pending.has(id) || signal?.aborted) return Promise.resolve('waiting');
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, set = new Set());
      const done: Waiter = (answer) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.get(id)?.delete(done);
        if (this.waiters.get(id)?.size === 0) this.waiters.delete(id);
        resolve(answer);
      };
      const onAbort = () => done('waiting');
      const timer = setTimeout(() => done('waiting'), Math.max(0, ms));
      (timer as { unref?: () => void }).unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      set.add(done);
    });
  }

  /** Ends a request with the person's answer; `waited`: a call was still waiting and goes on now. */
  settle(id: string, answer: ApprovalAnswer): { request: StoredRequest; waited: boolean } | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;
    this.pending.delete(id);
    const waited = (this.waiters.get(id)?.size ?? 0) > 0;
    this.release(id, answer);
    this.save();
    return { request, waited };
  }

  /** "Once" with nobody waiting: this agent's next identical call goes through. */
  grant(agentId: string, fingerprint: string): void {
    this.grants.set(grantKey(agentId, fingerprint), this.deps.now());
    this.save();
  }

  /** Uses this agent's once grant for this fingerprint (true when there was one). */
  take(agentId: string, fingerprint: string): boolean {
    const key = grantKey(agentId, fingerprint);
    const at = this.grants.get(key);
    if (at === undefined) return false;
    this.grants.delete(key);
    this.save();
    return this.deps.now() - at <= GRANT_MS;
  }

  /** The answer to the waiting calls; "once" to the first of them only, the others hear 'spent'. */
  private release(id: string, answer: WaitOutcome): void {
    const waiting = [...(this.waiters.get(id) ?? [])];
    this.waiters.delete(id);
    waiting.forEach((waiter, i) => waiter(answer === 'once' && i > 0 ? 'spent' : answer));
  }

  private read<T>(key: string): T | undefined {
    try { return this.deps.kv?.get<T>(NS, key); } catch { return undefined; }
  }

  private save(): void {
    const now = this.deps.now();
    for (const [fingerprint, at] of this.grants) if (now - at > GRANT_MS) this.grants.delete(fingerprint);
    try {
      this.deps.kv?.set(NS, 'pending', this.list(), now);
      this.deps.kv?.set(NS, 'grants', [...this.grants], now);
    } catch { /* memory keeps them for this run */ }
  }
}
