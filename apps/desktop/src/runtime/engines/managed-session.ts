// Which native Claude/Codex sessions may resume as they are (0.3.19, the masked engine shell). A session's native transcript
// holds what its tools returned; only a session Autark itself wrote under its managed shell – no native Bash/PowerShell, no
// Codex shell – is resumed natively. Two layers:
// - process memory: refs this engine instance opened or wrote (a turn, a fork, a revert, a rebuild) are trusted while it runs;
// - the persistent mark (managed-path.ts, table managed_paths): each own write marks the ref 'pending' at its start and
//   seals it at its end with the transcript measured; after a restart a ref is trusted again only when that mark still
//   matches exactly. Anything else is cold – the caller starts the session anew from the filtered Autark history.
// Without a store (tests, no database) only process memory counts, as before 0.3.19's mark.
// Owns: the per-engine trust (ManagedSessions), process memory of opened refs, the legacy note. Never: decides how a cold
// session is rebuilt, or trusts a ref because of its name or its binding alone.

import type { Account } from '../../shared/model/providers.ts';
import { measure, type ManagedPathStore } from './managed-path.ts';

export type { ManagedPathStore } from './managed-path.ts';

type Engine = { id: string };
const opened = new WeakMap<Engine, Map<string, Set<string>>>();
const LIMIT_PER_ACCOUNT = 1024;
/** How long a transcript must hold still before its seal (Codex may still be flushing its rollout after turn/completed). */
const SETTLE_MS = 300;

export function canContinueManaged(engine: Engine, account: string, ref: string): boolean {
  if (engine.id !== 'claude' && engine.id !== 'codex') return true;
  return opened.get(engine)?.get(account)?.has(ref) === true;
}
export function rememberManaged(engine: Engine, account: string, ref: string): void {
  let accounts = opened.get(engine);
  if (!accounts) opened.set(engine, accounts = new Map());
  let refs = accounts.get(account);
  if (!refs) accounts.set(account, refs = new Set());
  refs.delete(ref);
  refs.add(ref);
  if (refs.size > LIMIT_PER_ACCOUNT) refs.delete(refs.values().next().value!);
}
export function forgetManaged(engine: Engine, account: string, ref: string): void {
  opened.get(engine)?.get(account)?.delete(ref);
}
export const LEGACY_SESSION = 'This native session is not from the current managed-shell runtime. It must be rebuilt from the filtered Autark history.';

/** Whether a bound `ref` may resume natively on `engine` (Engine.managedResume): an engine without it – always; no account or a failed check – never. */
export async function resumable(engine: { managedResume?(account: Account, ref: string): Promise<boolean> }, account: Account | undefined, ref: string): Promise<boolean> {
  if (!engine.managedResume) return true;
  if (!account) return false;
  try { return await engine.managedResume(account, ref); } catch { return false; }
}

export interface ManagedSessionsDeps {
  engine: Engine;
  /** The persistent marks (undefined: process memory only). */
  store?: ManagedPathStore;
  /** The native transcript the engine resumes `ref` from now (undefined: none); `known` is the path its mark holds. */
  locate(account: Account, ref: string, known: string | undefined): Promise<string | undefined>;
  settleMs?: number;
}

/** One engine's trust in its native refs: process memory first, then the persistent mark. */
export class ManagedSessions {
  private readonly deps: ManagedSessionsDeps;
  private readonly writes = new Map<string, number>(); // account + ref → its newest own write (an older write's late seal is dropped)
  private readonly sealing = new Set<Promise<void>>();
  private counter = 0;

  constructor(deps: ManagedSessionsDeps) {
    this.deps = deps;
  }

  private key(account: Account, ref: string) { return { engine: this.deps.engine.id, account: account.id, ref }; }
  private begin(account: Account, ref: string): number {
    const mine = ++this.counter;
    this.writes.set(`${account.id}\u0000${ref}`, mine);
    return mine;
  }

  /** An own write of `ref` starts (a turn, a fork's reservation): trusted in this process, cold after a restart until its seal. */
  opened(account: Account, ref: string): void {
    rememberManaged(this.deps.engine, account.id, ref);
    this.begin(account, ref);
    const store = this.deps.store;
    try { store?.pending(this.key(account, ref), store.transcript(this.key(account, ref))); } catch { /* no mark: cold after a restart */ }
  }

  /** An own write of `ref` ended under CLI version `cli`: trusted here, and its transcript sealed once it holds still. */
  sealed(account: Account, ref: string, cli: string | undefined): Promise<void> {
    rememberManaged(this.deps.engine, account.id, ref);
    const store = this.deps.store;
    if (!store) return Promise.resolve();
    const mine = this.begin(account, ref);
    const key = this.key(account, ref);
    const work: Promise<void> = (async () => {
      const file = await this.deps.locate(account, ref, store.transcript(key)).catch(() => undefined);
      const measured = file ? await measure(file, this.deps.settleMs ?? SETTLE_MS) : undefined;
      if (this.writes.get(`${account.id}\u0000${ref}`) !== mine) return; // a newer write of this session began meanwhile
      if (file && measured) store.seal(key, file, measured, cli);
      else store.pending(key, file);
    })().catch(() => undefined).finally(() => { this.sealing.delete(work); });
    this.sealing.add(work);
    return work;
  }

  /**
   * Whether `ref` may resume natively: opened or written by this process, else its mark matches the transcript exactly – measured
   * at each check and not remembered, so a transcript extended outside Autark after a restart stays cold until an own write.
   */
  async trusted(account: Account, ref: string): Promise<boolean> {
    if (canContinueManaged(this.deps.engine, account.id, ref)) return true;
    const store = this.deps.store;
    if (!store) return false;
    const key = this.key(account, ref);
    try {
      return await store.warm(key, await this.deps.locate(account, ref, store.transcript(key)));
    } catch { return false; }
  }

  /** The session was deleted: neither memory nor mark trusts its ref again. */
  forget(account: Account, ref: string): void {
    forgetManaged(this.deps.engine, account.id, ref);
    this.writes.delete(`${account.id}\u0000${ref}`);
    try { this.deps.store?.remove(this.key(account, ref)); } catch { /* a stale row only ever means cold */ }
  }

  /** The seals still measuring (tests; the engine's dispose). */
  async settled(): Promise<void> {
    await Promise.all([...this.sealing]);
  }
}
