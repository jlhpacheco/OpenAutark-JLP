// W (19.11.2026, owner: "vom Handy … auch erwachen lassen. Auch wenn die App komplett zu ist durch diesen Broker"): the
// iPhone web app wakes a PC of mine itself, through its own meeting-server link, when none of my PCs is online to do it.
// The same wire as a PC's wake (runtime/devices/wake.ts sendWake): 'find' under the Remote ID of the PC's wake helper
// key, then one sealed 'pair' request with {op:'wake', at, nonce, sig} – the signature by this phone's own device key
// (WebCrypto Ed25519, non-extractable) over shared/model/wake.ts wakeText. The helper takes it because the PC pinned my
// phones in its wake file (wake.ts wakeFileFor). The Android app does the same in Java (apps/android relay/Wake.java).
// Owns: the phone side of one wake. Never: keeps or shows a key, or wakes a helper that is not the one asked for.

import { wakeText, type WakeBody } from '../../shared/model/wake.ts';
import { b64url, fromB64url, utf8 } from './bytes.ts';
import { fingerprint, remoteIdOf, sign, type DeviceKey } from './crypto.ts';
import type { Found } from './relay.ts';

/** How long the helper's answer may take through the meeting server (as wake.ts WAKE_REPLY_MS). */
export const WAKE_REPLY_MS = 10_000;

/** What a wake needs of the meeting-server link (relay.ts RelayLink has both). */
export interface WakeLink {
  find(remoteId: string, timeoutMs?: number): Promise<Found[]>;
  request(pc: Found, body: unknown, timeoutMs: number): Promise<Record<string, unknown>>;
}

/** The body for the helper session found (`wakeFp`, its box), signed with this phone's key. */
export async function signedWake(key: DeviceKey, wakeFp: string, box: string, at: number, nonce: string): Promise<WakeBody> {
  return { op: 'wake', at, nonce, sig: b64url(await sign(key.privateKey, utf8(wakeText(wakeFp, box, at, nonce)))) };
}

/** A fresh nonce (18 random bytes, base64url – the helper takes 16…64 such characters). */
export const wakeNonce = (): string => b64url(globalThis.crypto.getRandomValues(new Uint8Array(18)));

/**
 * One wake of the PC whose helper key is `wakePub` (its caps.wakeKey), named `name` in the errors. Rejects with a
 * sentence for the person: not waiting there, refused, or the meeting server's own trouble.
 */
export async function wakeThrough(link: WakeLink, key: DeviceKey, wakePub: string, name: string, now: number = Date.now(), nonce: string = wakeNonce()): Promise<void> {
  let raw: Uint8Array;
  try { raw = fromB64url(wakePub); } catch { raw = new Uint8Array(); }
  if (raw.length !== 32) throw new Error(`${name} runs an Autark that cannot be woken yet – start it there once.`);
  const wakeFp = await fingerprint(raw);
  const entry = (await link.find(await remoteIdOf(wakeFp))).find((found) => found.fp === wakeFp);
  if (!entry) throw new Error(`${name} is not waiting at the meeting server – the PC is off or asleep, has no internet, or its app was not closed from the app.`);
  const reply = await link.request(entry, await signedWake(key, wakeFp, entry.box, now, nonce), WAKE_REPLY_MS);
  if (reply.ok !== true) throw new Error(`${name} did not take the wake from this phone – its app was closed before it knew this phone. Wake it from another PC, or start it there once.`);
}
