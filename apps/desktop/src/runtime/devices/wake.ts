// Sicher-Runde 19.11.2026 (owner: "Geräte wecken (Gerät, dessen App zu ist …) ist wichtig"): waking a PC whose app is
// closed, without the broker (its exe cannot be rebuilt: unsigned, Smart App Control). The pieces on this side:
// - wakeKey: this PC's wake helper key, made once and kept in kv (ns 'device', not synced); its public half goes out in
//   this PC's caps (`wakeKey`, mesh.ts start), so my other PCs can reach the helper.
// - wakeFileFor / writeWakeFile: on the person's quit (devices.bye, handlers/devices.ts) <data>/wake.json is written for
//   the helper (sleeper.ts) when the meeting server is set and at least one own PC or phone is linked – else it is removed.
//   W (19.11.2026, owner: "vom Handy … auch erwachen lassen. Auch wenn die App komplett zu ist"): my own paired phones are
//   pinned too, so a phone wakes this PC itself through the meeting server when none of my PCs is online.
// - sendWake: the Wake button (devices.wake → mesh.ts wake): the meeting server finds the helper by its key's Remote ID,
//   and one sealed request carries the signed wake (wake-sign.ts) – the relay's existing 'find' and 'pair' frames, so the
//   meeting server needs no change.
// Owns: the helper key, its file and the sending side of a wake. Never: logs or returns a private key, wakes another
// person's PC (only my own linked PCs, CEO links), or starts anything on this PC.

import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { KvRepo } from '../store/kv.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { remoteIdOf } from '../remote/id.ts';
import { b64url, exportPrivate, generateEd25519, rawPublic } from './keys.ts';
import type { DeviceRecord } from './repo.ts';
import { MAX_PINS, WAKE_FILE, signWake, wakeFpOf, type WakeFile } from './wake-sign.ts';

const NS = 'device';
const KEY = 'wake';
/** How long a wake waits for the helper's answer through the meeting server. */
export const WAKE_REPLY_MS = 10_000;

/** This PC's wake helper key (made on first use). The private half goes only into wake.json for the helper. */
export function wakeKey(db: Db, now = Date.now()): { pub: string; pkcs8: string } {
  const kv = new KvRepo(db);
  const stored = kv.get<{ pub?: unknown; pkcs8?: unknown }>(NS, KEY);
  if (stored && typeof stored.pub === 'string' && typeof stored.pkcs8 === 'string') return { pub: stored.pub, pkcs8: stored.pkcs8 };
  const pair = generateEd25519();
  const key = { pub: b64url(rawPublic(pair.publicKey)), pkcs8: exportPrivate(pair.privateKey) };
  kv.set(NS, KEY, key, now);
  return key;
}

/** My own linked PC (no employee's PC, none whose company I joined as an employee), with its device key. */
const ownPc = (record: DeviceRecord): boolean =>
  record.kind === 'pc' && !record.self && !record.revokedAt && record.status !== 'revoked' && record.status !== 'pairing'
  && !record.personId && record.joinedAs !== 'employee' && Boolean(record.publicKey);

/** My own paired phone (no employee's phone) with the device key it registers with at the meeting server. */
const ownPhone = (record: DeviceRecord): boolean =>
  record.kind === 'phone' && !record.self && !record.revokedAt && record.status !== 'revoked' && !record.personId && Boolean(record.publicKey);

/** The helper's file: undefined without a meeting server or without an own linked PC or phone (nobody could wake this one). */
export function wakeFileFor(input: { relay: string | undefined; key: WakeFile['key']; devices: readonly DeviceRecord[] }): WakeFile | undefined {
  const pinned = [...input.devices.filter(ownPc), ...input.devices.filter(ownPhone)];
  const pins = pinned.map((record) => ({ fp: record.fingerprint, pub: record.publicKey! })).slice(0, MAX_PINS);
  return input.relay && pins.length ? { v: 1, relay: input.relay, key: input.key, pins } : undefined;
}

/** Writes (owner-only file mode where the system has one) or removes <dir>/wake.json; true when written. Never throws. */
export function writeWakeFile(dir: string, file: WakeFile | undefined): boolean {
  const target = path.join(dir, WAKE_FILE);
  try {
    if (!file) { rmSync(target, { force: true }); return false; }
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(temp, 0o600); } catch { /* Windows: the profile folder's own rights */ }
    renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

/** What sendWake needs of the meeting server connection (rendezvous/relay-client.ts RelayClient has both). */
export interface Waker {
  find(remoteId: string, signal?: AbortSignal): Promise<Array<{ fp: string; pub: string; box: string }>>;
  request(fp: string, box: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
}

const unavailable = (message: string, deviceId?: string) => new WorkforceError('unavailable', message, deviceId ? { details: { deviceId } } : undefined);

/** One wake to a linked own PC's helper: found at the meeting server under its key, then the signed wake, sealed. */
export async function sendWake(waker: Waker | undefined, record: DeviceRecord | undefined, sign: (data: Uint8Array) => Uint8Array, now: number): Promise<void> {
  if (!record || !ownPc(record)) throw new WorkforceError('not_found', 'That PC is not one of your linked PCs.');
  const pub = record.caps.wakeKey;
  if (!pub) throw unavailable(`${record.name} runs an Autark that cannot be woken yet – start it there once.`, record.id);
  if (!waker) throw unavailable('Waking goes through the meeting server, and this PC is not connected to one (Settings › Devices › Connection).', record.id);
  const fp = wakeFpOf(pub);
  const entry = (await waker.find(remoteIdOf(fp))).find((found) => found.fp === fp && found.pub === pub);
  if (!entry) throw unavailable(`${record.name} is not waiting at the meeting server – the PC is off or asleep, has no internet, or its app was not closed from the app.`, record.id);
  const reply = await waker.request(fp, entry.box, signWake(sign, fp, entry.box, now, b64url(randomBytes(18))), { timeoutMs: WAKE_REPLY_MS }) as { ok?: unknown } | undefined;
  if (reply?.ok !== true) throw unavailable(`${record.name} did not take the wake.`, record.id);
}
