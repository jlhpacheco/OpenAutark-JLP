// Sicher-Runde 19.11.2026 (owner: the other PCs should say honestly what a PC is doing – "App closed · 14:02" instead of
// "Not reachable"): right before a deliberate stop (the person quits, an update installs, Windows ends the session) this
// PC sends `device.bye {reason}` over every live link (mesh.ts bye, devices.bye from main); the receiver keeps it as
// Device.away {reason, at} with its own clock until the link is back (mesh.ts markSeen, repo.ts).
// 20.11.2026 (owner: "dass man da austreten kann"): a company taken off this PC (companies.remove of the company itself)
// says the goodbye LEFT – this PC left the company – and the receiver drops it from its linked PCs (mesh.ts revoke)
// instead of keeping an away state.
// Owns: the method name, reading a bye and sending one to every live link within BYE_MS. Never: closes a link or waits longer.

import type { AwayReason, DeviceAway } from '../../shared/model/devices.ts';

export const BYE_METHOD = 'device.bye';
/** The longest a goodbye waits for the other PCs' answers; the quit goes on after it either way. */
export const BYE_MS = 1_500;
export const AWAY_REASONS: readonly AwayReason[] = ['quit', 'update', 'session-end'];
/** The goodbye of a PC that left the company here: the receiver drops it (no away state, it is not coming back). */
export const LEFT = 'left';
export type ByeReason = AwayReason | typeof LEFT;

/** Is a received `device.bye` the goodbye of a PC that left? */
export const isLeft = (params: unknown): boolean => (params && typeof params === 'object' ? params as { reason?: unknown } : {}).reason === LEFT;

const isReason = (value: unknown): value is AwayReason => typeof value === 'string' && (AWAY_REASONS as readonly string[]).includes(value);

/** A received `device.bye` as stored: the reason it names and this PC's own time (the sender's clock is not trusted). */
export function awayOf(params: unknown, now: number): DeviceAway | undefined {
  const reason = (params && typeof params === 'object' ? params as { reason?: unknown } : {}).reason;
  return isReason(reason) ? { reason, at: now } : undefined;
}

/** A stored away state as far as it is readable (repo.ts reads it from its JSON column). */
export function storedAway(value: unknown): DeviceAway | undefined {
  const o = (value && typeof value === 'object' ? value : {}) as { reason?: unknown; at?: unknown };
  return isReason(o.reason) && typeof o.at === 'number' && Number.isFinite(o.at) ? { reason: o.reason, at: o.at } : undefined;
}

/** Sends the goodbye to every live link at once and waits at most BYE_MS for their answers (a failure is no error). */
export async function sayBye(peers: ReadonlyArray<{ call(method: string, params: unknown, options: { timeoutMs: number }): Promise<unknown> }>, reason: ByeReason): Promise<void> {
  await Promise.allSettled(peers.map((peer) => peer.call(BYE_METHOD, { reason }, { timeoutMs: BYE_MS })));
}
