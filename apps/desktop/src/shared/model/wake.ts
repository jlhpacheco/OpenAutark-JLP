// Sicher-Runde 19.11.2026 (owner: "vom Handy … auch erwachen lassen. Auch wenn die App komplett zu ist"): the words of a
// wake, the same for every waker – a linked PC (runtime/devices/wake-sign.ts signWake), the iPhone web app and the
// browser (ui/hosted/wake.ts) and the Android app (apps/android relay/Wake.java, which spells the same text) – and for the
// wake helper that checks it (runtime/devices/sleeper.ts → wake-sign.ts checkWake). The waker signs this text with its
// own device key; the helper takes it only from a key in its pins (my own linked PCs and phones).
// Owns: the signed text and the body's shape. Never: keys, signing or checking.

/** The sealed body of one wake through the meeting server ('pair' to the helper's key). */
export interface WakeBody { op: 'wake'; at: number; nonce: string; sig: string }

/** What a waker signs: the helper's fingerprint and box key of this session, the time and a nonce. */
export const wakeText = (wakeFp: string, box: string, at: number, nonce: string): string => `wf-wake-v1|${wakeFp}|${box}|${at}|${nonce}`;
