// A scripted services.security for the engine tests (Sicher-Runde 19.11.2026): a mode, a file scope, which paths are open,
// and what the gate answers; every gate request is recorded.
// Owns: nothing in production. Never imported by src/.

import type { FileScope, GateRequest, GateResult, SecurityService } from '../../../src/runtime/security/service.ts';
import { securityDefaults, type SecurityMode } from '../../../src/shared/model/security-settings.ts';

export interface FakeSecurityOptions {
  mode?: SecurityMode;
  scope?: Partial<FileScope>;
  /** Paths check() calls open (default: below /work). */
  open?: (path: string) => boolean;
  /** The gate's answer (default: a refusal that says the request waits). */
  gate?: (request: GateRequest) => GateResult | Promise<GateResult>;
}

export const WAITING = 'The person has not answered yet; the request stays in their to-dos.';

export function fakeSecurity(options: FakeSecurityOptions = {}) {
  const mode = options.mode ?? 'secure';
  const gates: GateRequest[] = [];
  const scope: FileScope = { mode, read: ['/work'], write: ['/work'], commands: 'ask', web: 'yes', closed: ['/data/security'], ...options.scope };
  const open = options.open ?? ((file: string) => file.startsWith('/work/'));
  const service: SecurityService = {
    current: () => securityDefaults(mode),
    check: (request) => (request.path?.startsWith('/data/security') ? 'closed' : request.path && open(request.path) ? 'open' : 'ask'),
    gate: async (request) => { gates.push(request); return options.gate ? options.gate(request) : { ok: false, text: WAITING }; },
    fileScope: () => scope,
    requests: () => [],
    answer: () => {},
  };
  return { service, gates, lookup: () => service };
}
