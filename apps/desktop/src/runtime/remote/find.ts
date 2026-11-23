// Finding the PC a person typed into "Connect": a Remote ID is looked for on this network first
// (the LAN hello answers, devices/discovery.ts) and then at the meeting server (it knows the PCs
// that accept requests by Remote ID; one still connecting is waited for – a free host wakes slowly);
// a typed address is asked directly (/.well-known/workforce).
// Every answer is only a hint: its key must give the typed Remote ID – or (B-084) one of its chains must prove that key
// belongs (remote/code.ts belongs; Eine-ID 22.11.2026: its company chain or its `me` chain, for a typed Company ID or
// My ID – the entry found then carries that proving chain as `chain`) –, and the request itself proves
// that key (remote/sas.ts). Answers naming the same device with different keys stay separate (an
// impostor never hides the real PC); the first one that matches is asked. Nothing found: not_found
// says what was searched and what to do, and names a meeting server that is off or not reachable.
// Owns: candidate search, filtering and the not_found text. Never: trusts a candidate whose key neither gives the typed Remote ID nor proves it belongs to it.

import { WorkforceError } from '../../shared/errors.ts';
import type { Candidate } from '../devices/discovery.ts';
import { belongs } from './code.ts';
import type { RemoteTarget } from './id.ts';

/**
 * A PC found for a target: where to send the request (http(s) base URLs or the meeting server's `relay:<fp>`); `chain`:
 * its chain to the typed ID (remote/code.ts) when it answered for one; `me`: its my-ID chain from the LAN hello.
 */
export interface Found { deviceId: string; name: string; fingerprint: string; addresses: string[]; chain?: unknown; me?: unknown }

export interface FindDeps {
  self: string;
  /** LAN hello answers (discovery.ts `discover`). */
  lan?(): Promise<Candidate[]>;
  /** The meeting server's PCs with this Remote ID (devices/rendezvous/service.ts); off or not reachable: rejects 'unavailable' with the reason. */
  meeting?(remoteId: string, signal: AbortSignal): Promise<Found[]>;
  /** GET <address>/.well-known/workforce (a typed address). */
  wellKnown?(address: string): Promise<{ deviceId: string; name: string; fingerprint: string } | undefined>;
}

/** How long the meeting server lookup may take, waiting for a server that is still connecting (a free host's cold start). */
export const MEETING_TIMEOUT_MS = 45_000;
export const MEETING_OFF = 'Meeting server off (devices.relay)';
export const MEETING_UNREACHABLE = 'Meeting server not reachable';

/**
 * not_found: what was searched and what to do; `meeting` is why PCs in other networks could not be asked. The cause
 * comes first – the connect row's one line shows only its start (the rest is its tooltip).
 */
export function notFoundText(target: RemoteTarget, meeting?: string): string {
  if ('address' in target) return 'No Autark PC answered at that address.';
  const open = 'Open Autark on that PC – Settings › Devices shows its Remote ID.';
  return meeting ? `${meeting.replace(/\.$/, '')} – no PC with this Remote ID on this network. ${open}` : `No PC with this Remote ID is online. ${open}`;
}

/** LAN answers with `chain` set to whichever of their chains proves `remoteId` (the `me` chain for a typed My ID). */
function provenBy(remoteId: string, found: readonly Found[]): Found[] {
  return found.map((entry) => (entry.me !== undefined && !belongs(remoteId, entry.fingerprint, entry.chain) && belongs(remoteId, entry.fingerprint, entry.me) ? { ...entry, chain: entry.me } : entry));
}

/** Candidates for the typed target: at the address, else on this network, else at the meeting server; none: not_found. */
export async function findTarget(deps: FindDeps, target: RemoteTarget): Promise<Found[]> {
  if ('address' in target) {
    const known = await deps.wellKnown?.(target.address).catch(() => undefined);
    if (known && known.deviceId !== deps.self) return [{ ...known, addresses: [target.address] }];
    throw new WorkforceError('not_found', notFoundText(target));
  }
  const matches = (found: Found) => found.deviceId !== deps.self && belongs(target.remoteId, found.fingerprint, found.chain);
  const near = provenBy(target.remoteId, await (deps.lan?.().catch((): Candidate[] => []) ?? Promise.resolve([]))).filter(matches);
  if (near.length) return near;
  let gap: string | undefined;
  const far = await deps.meeting?.(target.remoteId, AbortSignal.timeout(MEETING_TIMEOUT_MS)).catch((error: unknown): Found[] => {
    gap = error instanceof WorkforceError && error.code === 'unavailable' ? error.message : MEETING_UNREACHABLE;
    return [];
  }) ?? [];
  const hits = far.filter(matches);
  if (hits.length) return hits;
  throw new WorkforceError('not_found', notFoundText(target, gap));
}
