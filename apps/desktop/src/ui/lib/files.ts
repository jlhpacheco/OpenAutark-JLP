// File helpers for the UI: upload browser File/Blob objects to the blob store (inline for
// small files, in ≤ 4 MB chunks above that – the PWA's /ws frame limit is 6 MB) and turn stored
// file ids into object URLs for previews/avatars (cached, small files only; past PREVIEW_KEEP bytes the least recently
// drawn go first – never one a mounted component holds through useFileUrl – and load again when drawn).
// F-52 (wave 2): on a person's device a file for a chat goes up chunked with that chat's id – people
// upload only into their own chats (runtime/people/uploads.ts); the owner's uploads are unchanged.
// Owns: base64 encoding, the inline/chunked choice, the preview URL cache.
// Never: keeps file bytes in signals, or holds more than one chunk of a large file in memory.

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import type { ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { newId } from '../../shared/ids.ts';
import { isPersonSession } from './people.ts';
import { rpc } from './rpc.ts';

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // per file (concept: 20 MB)
export const MAX_FILES = 20; // per message
/** Chunk size of files.uploadChunk (4 MB raw ≈ 5.6 MB base64, below the 6 MB frame limit). */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Files up to this size go in one files.upload frame; anything larger is chunked. */
export const INLINE_MAX_BYTES = CHUNK_BYTES;

type UploadMethod = 'files.upload' | 'files.uploadChunk';
/** The RPC surface uploads need (rpc by default, a fake in tests). */
export interface UploadRpc {
  call<M extends UploadMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
}

/** Base64 of bytes, built in slices (one String.fromCharCode call per 32 KB). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Uploads a blob in chunks of `chunk` bytes (`files.uploadChunk`; ≤ 4 MB).
 * Only one chunk is held in memory at a time, so long recordings never sit in RAM twice.
 * `onProgress` gets 0..1.
 */
export async function uploadBlob(blob: Blob, name: string, onProgress?: (ratio: number) => void, via: UploadRpc = rpc, chunk = CHUNK_BYTES, conversationId?: string): Promise<FileRef> {
  const uploadId = newId('up');
  const mime = blob.type || undefined;
  const count = Math.max(1, Math.ceil(blob.size / chunk));
  for (let index = 0; index < count; index++) {
    const part = new Uint8Array(await blob.slice(index * chunk, (index + 1) * chunk).arrayBuffer());
    const final = index === count - 1;
    const result = await via.call('files.uploadChunk', { uploadId, index, dataBase64: toBase64(part), final, name, mime, ...(conversationId ? { conversationId } : {}) });
    onProgress?.((index + 1) / count);
    if (final) {
      if (!result.file) throw new Error('Upload did not finish.');
      return result.file;
    }
  }
  throw new Error('Upload did not finish.');
}

/** Where an upload goes: the chat it is for (a person's device sends it with the upload). */
export interface UploadTarget { conversationId?: string }

/** Uploads one file (≤ 20 MB): one frame up to `chunk` bytes (4 MB), chunked above; a person's file for a chat always chunked with its id. */
export async function uploadRef(file: File | Blob, name?: string, via: UploadRpc = rpc, chunk = CHUNK_BYTES, target?: UploadTarget): Promise<FileRef> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name ?? (file as File).name ?? 'File'} is larger than 20 MB.`);
  const fileName = name ?? (file as File).name ?? 'file';
  const forChat = target?.conversationId && isPersonSession() ? target.conversationId : undefined;
  if (forChat || file.size > chunk) return uploadBlob(file, fileName, undefined, via, chunk, forChat);
  return via.call('files.upload', { name: fileName, mime: file.type || undefined, dataBase64: toBase64(new Uint8Array(await file.arrayBuffer())) });
}

/** A stored file as a message attachment. */
export function toAttachment(ref: FileRef): Attachment {
  return { fileId: ref.id, name: ref.name, mime: ref.mime, size: ref.size, width: ref.width, height: ref.height, durationMs: ref.durationMs };
}

/** Uploads one browser file and returns it as a message attachment. */
export async function uploadFile(file: File | Blob, name?: string, target?: UploadTarget): Promise<Attachment> {
  return toAttachment(await uploadRef(file, name, rpc, CHUNK_BYTES, target));
}

const urls = new Map<string, Signal<string | null>>();
const PREVIEW_MAX = 8 * 1024 * 1024;
/** Preview bytes the page keeps at most; past it the least recently drawn files that no mounted component holds go (their next draw loads them again). */
export const PREVIEW_KEEP = 48 * 1024 * 1024;
/** The cap trim() uses (PREVIEW_KEEP; a test sets a small one). */
export const previewLimit = { bytes: PREVIEW_KEEP };

async function readBlob(fileId: string): Promise<Blob> {
  const { dataBase64, mime } = await rpc.call('files.read', { id: fileId, maxBytes: PREVIEW_MAX });
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const loads = new Map<string, Promise<string>>();
/** Loaded previews in the order they were last drawn (oldest first): their object URL and size. */
const kept = new Map<string, { url: string; bytes: number }>();
let keptBytes = 0;
/** How many mounted components hold each file's URL (useFileUrl): those are never freed. */
const holders = new Map<string, number>();

/** A draw of `fileId`: it becomes the most recent one. */
function touch(fileId: string): void {
  const entry = kept.get(fileId);
  if (entry) { kept.delete(fileId); kept.set(fileId, entry); }
}

/** Frees the least recently drawn previews nobody holds until the kept bytes fit (`keep`: the one just loaded stays). */
function trim(keep?: string): void {
  for (const [id, entry] of kept) {
    if (keptBytes <= previewLimit.bytes) return;
    if (holders.has(id) || id === keep) continue;
    kept.delete(id); keptBytes -= entry.bytes;
    loads.delete(id); urls.delete(id);
    URL.revokeObjectURL(entry.url);
  }
}

/** The one load of a stored file's object URL (shared by fileUrl and fileUrlReady; forgotten when it fails). */
function load(fileId: string): Promise<string> {
  let pending = loads.get(fileId);
  if (!pending) {
    pending = readBlob(fileId).then((blob) => {
      const url = URL.createObjectURL(blob);
      kept.set(fileId, { url, bytes: blob.size }); keptBytes += blob.size;
      trim(fileId);
      return url;
    });
    loads.set(fileId, pending);
    pending.catch(() => { loads.delete(fileId); urls.delete(fileId); });
  } else touch(fileId);
  return pending;
}

/** Object URL for a stored file (images, audio). Null until loaded or when unavailable. */
export function fileUrl(fileId: string): Signal<string | null> {
  let entry = urls.get(fileId);
  if (entry) { touch(fileId); return entry; }
  entry = signal<string | null>(null);
  urls.set(fileId, entry);
  const target = entry;
  load(fileId).then((url) => { target.value = url; }).catch(() => undefined);
  return target;
}

/** Keeps `fileId`'s preview from being freed until the returned release runs (a mounted component: useFileUrl). */
export function holdFileUrl(fileId: string): () => void {
  holders.set(fileId, (holders.get(fileId) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holders.get(fileId) ?? 1) - 1;
    if (left > 0) holders.set(fileId, left); else holders.delete(fileId);
    trim();
  };
}

/** A component's preview URL of a stored file (null until loaded, or for no id); while mounted the URL is never freed. */
export function useFileUrl(fileId: string | null | undefined): string | null {
  useEffect(() => (fileId ? holdFileUrl(fileId) : undefined), [fileId]);
  return fileId ? fileUrl(fileId).value : null;
}

/** B-084: the same object URL, awaited – a first tap on a file whose preview has not loaded yet. Throws when unavailable. */
export function fileUrlReady(fileId: string): Promise<string> {
  return load(fileId);
}
