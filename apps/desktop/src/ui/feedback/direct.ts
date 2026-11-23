// Feedback straight to the team (owner 18.11.2026: "das soll doch einfach direkt zu uns gehen"): a phone or a browser
// seals its report itself and creates the letter in the team's write-only mailbox – no PC on the way, so a team
// member's phone and a phone whose PC is off send too. The same letter as the PC's (runtime/feedback/delivery.ts
// FeedbackPayload, opened by the team's inbox, letter.ts): the same envelope as runtime/feedback/seal.ts ("WFB1" |
// ephemeral X25519 key | nonce | AES-256-GCM ciphertext + tag; HKDF-SHA256, salt = ephemeral ‖ recipient key, info
// "workforce-feedback v1"), here with Web Crypto, and the same create request as drop.ts (document id = the report's
// clientId, so a retry whose first answer got lost finds its own letter: 409 = it arrived). The receiver (public key,
// project, web API key) is built into the page (scripts/build.mjs from resources/feedback/receiver.json).
// Text, view, place and the device's own diagnostics are redacted here (shared/secrets/redact-text.ts) – the PC's vault
// never sees these words. Owner 20.11.2026: a report is its words – a dictated one goes as its transcript (`dictated`).
// Owner 21.11.2026: its images go as `images`, in order.
// Owns: the payload, the seal and the create request of a page. Never: sends without a Send, sends anything but the
// sealed bytes, or reaches a host other than the mailbox; null (the PC sends instead) where this page cannot seal.

import { FEEDBACK_CLIENT_DIAGNOSTICS_MAX, FEEDBACK_CLIENT_MAX, FEEDBACK_SEALED_LIMIT } from '../../shared/model/feedback-delivery.ts';
import { redactText } from '../../shared/secrets/redact-text.ts';
import { entryImages } from './outbox.ts';
import type { OutboxEntry, ReportLine } from './outbox.ts';

declare const __FEEDBACK_RECEIVER__: { publicKey: string; project: string; apiKey: string } | null | undefined;
declare const __APP_VERSION__: string | undefined;

export interface Receiver { publicKey: string; project: string; apiKey: string; endpoint?: string }

const INFO = new TextEncoder().encode('workforce-feedback v1');
const MAGIC = new TextEncoder().encode('WFB1');
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LETTER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // runtime/feedback/drop.ts
const TIMEOUT_MS = 20_000;
const SEAL_BYTES = 64;

/** The receiver built into this page (none in a build without one). */
export function builtInReceiver(): Receiver | null {
  try { return typeof __FEEDBACK_RECEIVER__ === 'object' && __FEEDBACK_RECEIVER__ ? __FEEDBACK_RECEIVER__ : null; } catch { return null; }
}

const base64 = (bytes: Uint8Array): string => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/** Seals `bytes` for `publicKey` (raw 32-byte X25519, base64url) – the envelope of runtime/feedback/seal.ts. */
export async function sealWeb(publicKey: string, bytes: Uint8Array<ArrayBuffer>, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<Uint8Array> {
  const recipient = fromBase64Url(publicKey);
  if (recipient.length !== 32) throw new Error('The team key is not a 32-byte X25519 key.');
  const other = await subtle.importKey('raw', recipient, { name: 'X25519' }, false, []);
  const own = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const ephemeral = new Uint8Array(await subtle.exportKey('raw', own.publicKey));
  const shared = await subtle.deriveBits({ name: 'X25519', public: other }, own.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: join(ephemeral, recipient), info: INFO }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, bytes)); // ciphertext ‖ tag
  return join(MAGIC, ephemeral, nonce, body);
}

/** The letter's JSON bytes: the report as the team reads it. */
export async function letterOf(entry: OutboxEntry, version: string): Promise<Uint8Array<ArrayBuffer>> {
  const clean = (value: string, max: number) => redactText(value).slice(0, max);
  const payload: Record<string, unknown> = {
    v: 1, id: entry.clientId, createdAt: entry.at, text: redactText(entry.text), appVersion: version.slice(0, 120),
    os: clean(entry.client.split(' · ').slice(0, 2).join(' · '), 120), client: clean(entry.client, FEEDBACK_CLIENT_MAX),
    ...(entry.where.view ? { view: clean(entry.where.view, 120) } : {}),
    ...(entry.clientDiagnostics ? { clientDiagnostics: clean(entry.clientDiagnostics, FEEDBACK_CLIENT_DIAGNOSTICS_MAX) } : {}),
    ...(entry.dictated ? { dictated: true } : {}),
  };
  const images = entryImages(entry).map((src) => /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(src)).filter((image) => image !== null);
  if (images.length) payload.images = images.map((image) => ({ mime: image[1], base64: image[2] }));
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length + SEAL_BYTES > FEEDBACK_SEALED_LIMIT) throw new Error('This report is too large to send.');
  return bytes;
}

/** Why a direct send did not go: the mailbox refused it (the PC may try), or no connection or server (try again later). */
export class DirectFailed extends Error {
  readonly refused: boolean;
  constructor(message: string, refused: boolean) { super(message); this.refused = refused; }
}

/** Creates feedback/<id> in the mailbox (runtime/feedback/drop.ts dropSealed, from a page). */
export async function dropWeb(receiver: Receiver, id: string, sealed: Uint8Array, createdAt: number, run: typeof fetch = fetch): Promise<void> {
  if (!DOCUMENT_ID.test(id)) throw new DirectFailed('Invalid feedback id.', true);
  const origin = receiver.endpoint ?? 'https://firestore.googleapis.com';
  const url = `${origin}/v1/projects/${encodeURIComponent(receiver.project)}/databases/(default)/documents/feedback?documentId=${encodeURIComponent(id)}&mask.fieldPaths=v&key=${encodeURIComponent(receiver.apiKey)}`;
  const fields = { v: { integerValue: '1' }, sealed: { bytesValue: base64(sealed) } };
  const post = async (body: string): Promise<number> => {
    try {
      const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
      return (await run(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...(signal ? { signal } : {}) })).status;
    } catch {
      throw new DirectFailed('Feedback could not be sent right now; it goes by itself later.', false);
    }
  };
  let status = await post(JSON.stringify({ fields: { ...fields, exp: { timestampValue: new Date(createdAt + LETTER_TTL_MS).toISOString() } } }));
  if (status === 400 || status === 403) status = await post(JSON.stringify({ fields })); // rules before v2: without exp
  if ((status >= 200 && status < 300) || status === 409) return;
  throw new DirectFailed(status === 400 || status === 403 || status === 404 ? 'The feedback mailbox refused this report.' : 'Feedback could not be sent right now; it goes by itself later.', status === 400 || status === 403 || status === 404);
}

/**
 * Sends one outbox entry straight to the team: its report line (receipt = its clientId) when it went; null when this
 * page cannot (no receiver built in, no Web Crypto X25519 here – the PC sends it then); DirectFailed when it did not go.
 */
export async function sendDirect(entry: OutboxEntry, receiver: Receiver | null = builtInReceiver(), run: typeof fetch = fetch): Promise<ReportLine | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!receiver || !subtle) return null;
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  let sealed: Uint8Array;
  try {
    sealed = await sealWeb(receiver.publicKey, await letterOf(entry, version), subtle);
  } catch (error) {
    if (error instanceof Error && /too large/.test(error.message)) throw new DirectFailed(error.message, true);
    return null; // X25519 is not in this browser: the PC seals it
  }
  await dropWeb(receiver, entry.clientId, sealed, entry.at, run);
  return { id: entry.clientId, status: 'sent', receiptId: entry.clientId };
}
