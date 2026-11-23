// Sicher-Runde 19.11.2026 (owner: "Geräte wecken … ist wichtig"): the shared words of a wake – what the waking PC signs,
// what the wake helper (sleeper.ts) checks, and the helper's file. A wake is one sealed message through the meeting
// server's existing request forwarding ('pair', services/remote-relay – no server change) to the helper's own key: it
// carries the time, a nonce and the waking PC's device-key signature over the helper's key, its per-session box key, the
// time and the nonce. The helper takes it only from a key in its pins (my own linked PCs and – 19.11.2026, W – my own
// paired phones, written by this PC while it ran), fresh (±WAKE_FRESH_MS) and once per nonce; the relay's `from` names the
// sender, its signature proves it. The signed text itself is shared/model/wake.ts (the phones sign it too).
// <data>/wake.json: the meeting server's address, the helper's own key pair (a low-value key: it can only stand at the
// meeting server and hear wakes – the device key never leaves its object) and the pins (public keys only).
// Owns: these texts, the signature check and the file's shape. Never: sockets, files, starting anything, or logging keys.

import { wakeText, type WakeBody } from '../../shared/model/wake.ts';
import { b64url, fingerprintOf, fromB64url, verifyEd25519 } from './keys.ts';

export const WAKE_FILE = 'wake.json';
/** A wake older or newer than this (clocks of two PCs) is not taken. */
export const WAKE_FRESH_MS = 60_000;
export const MAX_PINS = 64;

export interface WakePin { fp: string; pub: string }
export interface WakeFile {
  v: 1;
  /** The meeting server (wss://…). */
  relay: string;
  /** The helper's Ed25519 key: raw public base64url and PKCS#8 base64. */
  key: { pub: string; pkcs8: string };
  /** My own linked PCs' and paired phones' device keys: only they wake this PC. */
  pins: WakePin[];
}

const FP = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const key32 = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && B64URL.test(value) && fromB64url(value).length === 32;

/** The helper's fingerprint (its key at the meeting server) from its public key. */
export const wakeFpOf = (pub: string): string => fingerprintOf(fromB64url(pub));

/** The wake a PC sends: signed with its device key (`sign`), bound to this helper session's box. */
export function signWake(sign: (data: Uint8Array) => Uint8Array, wakeFp: string, box: string, at: number, nonce: string): WakeBody {
  return { op: 'wake', at, nonce, sig: b64url(sign(Buffer.from(wakeText(wakeFp, box, at, nonce), 'utf8'))) };
}

/**
 * The helper's check: a wake body from `from` (the relay's sender fingerprint) signed by that pin's key over this
 * session (`wakeFp`, `box`), fresh, with a nonce not seen before. Records the nonce when it passes.
 */
export function checkWake(body: unknown, from: unknown, pins: readonly WakePin[], session: { wakeFp: string; box: string }, now: number, seen: Set<string>): boolean {
  const o = (body && typeof body === 'object' ? body : {}) as Partial<WakeBody>;
  const pin = typeof from === 'string' ? pins.find((entry) => entry.fp === from) : undefined;
  if (!pin || o.op !== 'wake' || typeof o.at !== 'number' || !Number.isFinite(o.at) || Math.abs(now - o.at) > WAKE_FRESH_MS) return false;
  if (typeof o.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(o.nonce) || seen.has(o.nonce)) return false;
  if (typeof o.sig !== 'string' || o.sig.length > 128 || !B64URL.test(o.sig)) return false;
  if (!verifyEd25519(fromB64url(pin.pub), Buffer.from(wakeText(session.wakeFp, session.box, o.at, o.nonce), 'utf8'), fromB64url(o.sig))) return false;
  seen.add(o.nonce);
  return true;
}

/** The helper's file as far as it is valid (undefined: no wake helper for this PC). */
export function parseWakeFile(text: string): WakeFile | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const o = (value && typeof value === 'object' ? value : {}) as Partial<WakeFile>;
  if (o.v !== 1 || typeof o.relay !== 'string' || !/^wss?:\/\/\S{1,300}$/.test(o.relay)) return undefined;
  if (!o.key || !key32(o.key.pub) || typeof o.key.pkcs8 !== 'string' || o.key.pkcs8.length > 200) return undefined;
  if (!Array.isArray(o.pins)) return undefined;
  const pins = o.pins.filter((pin): pin is WakePin => Boolean(pin && FP.test(pin.fp) && key32(pin.pub) && fingerprintOf(fromB64url(pin.pub)) === pin.fp)).slice(0, MAX_PINS);
  return pins.length ? { v: 1, relay: o.relay, key: { pub: o.key.pub, pkcs8: o.key.pkcs8 }, pins } : undefined;
}
