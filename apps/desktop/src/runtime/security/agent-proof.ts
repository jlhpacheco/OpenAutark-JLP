// The proof that a process was started by this runtime for one agent (Sicher-Runde 19.11.2026, REVIEW-2 7): every agent
// process the runtime starts gets AUTARK_AGENT (the agent's id) and beside it AUTARK_AGENT_PROOF – an HMAC-SHA256 of that
// id under a random key this runtime process makes at its first use and keeps in memory only (a new key at every start).
// An agent's `wf` sends both in its Hello (wf-cli/discover.ts); http/ws.ts takes the agent's name only with a valid proof,
// so a shell that sets AUTARK_AGENT=<another agent> is no agent at all (a Hello without an agent's name stays the plain
// launch-token scope). The proof is never written to disk or a log; it lives in the agent processes' env.
// Owns: the key, agentProof/validProof and the two env names' pair (agentIdentity). Never: decides what an agent may do.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AGENT_ENV, AGENT_PROOF_ENV } from '../../shared/api/protocol.ts';

let key: Buffer | undefined;

/** The proof for `agentId` in this runtime process (hex). */
export function agentProof(agentId: string): string {
  key ??= randomBytes(32);
  return createHmac('sha256', key).update(`autark-agent\u0000${agentId}`).digest('hex');
}

/** True when `proof` is this runtime's proof for `agentId`. */
export function validProof(agentId: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(agentProof(agentId), 'hex'));
}

/** The env pair an agent's process carries: its id and its proof. */
export function agentIdentity(agentId: string): Record<string, string> {
  return { [AGENT_ENV]: agentId, [AGENT_PROOF_ENV]: agentProof(agentId) };
}
