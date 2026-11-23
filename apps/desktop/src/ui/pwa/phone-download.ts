// B-084 (decision 11) "Save to phone" inside the Android app: a WebView can't save a blob: download, so the page hands
// the bytes to the app over the native port (native-port.ts) as `download {name, mime, data, seq, last}` messages of
// 512 KB each (base64); the app (PhoneDownloads.java) writes them to Downloads and says "Saved to Downloads: <name>".
// One file at a time: a second save waits for the first, so the app never sees two files' chunks interleaved.
// Owns: the chunking. Never: decides where the file lands (the app does), downloads anything outside the app.

import { toBase64 } from '../lib/files.ts';
import { hasNativePort, sendNative } from './native-port.ts';

export const CHUNK_BYTES = 512 * 1024;
/** What the app takes in one save (and what files.read hands the page at most). */
export const PHONE_DOWNLOAD_MAX = 25 * 1024 * 1024;

/** A file name without folders, at most 120 characters ("download" when nothing is left). */
export function safeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return base.slice(-120) || 'download';
}

let queue: Promise<unknown> = Promise.resolve();

async function send(blob: Blob, name: string, mime: string): Promise<boolean> {
  const count = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
  for (let seq = 0; seq < count; seq++) {
    const bytes = new Uint8Array(await blob.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES).arrayBuffer());
    if (!sendNative({ t: 'download', name, mime, data: toBase64(bytes), seq, last: seq === count - 1 })) return false;
  }
  return true;
}

/** Saves a file into the phone's Downloads through the app; false outside the Android app, for a file over 25 MB, or
 *  when the port went away midway (the caller then downloads as a browser would). */
export function saveToPhone(blob: Blob, name: string): Promise<boolean> {
  if (!hasNativePort() || blob.size > PHONE_DOWNLOAD_MAX) return Promise.resolve(false);
  const mime = blob.type || 'application/octet-stream';
  const run = queue.then(() => send(blob, safeName(name), mime));
  queue = run.catch(() => undefined); // the queue itself never rejects
  return run.catch(() => false);
}
