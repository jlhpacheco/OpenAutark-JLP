// Owns: process-local provenance of native references. Never: persists trust between runtimes.
// Native transcripts are resumable only when this engine instance opened them under managed-shell policy.
// Process-local by design: a restart, downgrade or replaced engine instance never inherits trust from a ref.
type Engine = { id: string };
const opened = new WeakMap<Engine, Map<string, Set<string>>>();
const LIMIT_PER_ACCOUNT = 1024;
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
