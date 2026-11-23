// Content type detection of a stored file: the binary signatures (shared/files/mime.ts sniffBinary, one rule with the
// desktop) first, then UTF-8 text typed by the name's extension, plus cheap image dimension parsing from headers.
// Owns: the text-by-extension table and the header parsers. Never: reads files (callers pass bytes).

import { sniffBinary } from '../../shared/files/mime.ts';

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** Text types we recognise by extension once the bytes decode as UTF-8 text. */
const TEXT_EXTENSIONS: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/x-typescript',
  tsx: 'text/x-typescript', xml: 'application/xml', svg: 'image/svg+xml', yaml: 'application/yaml', yml: 'application/yaml',
  srt: 'application/x-subrip', vtt: 'text/vtt', txt: 'text/plain', log: 'text/plain',
};

const OFFICE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const extension = (name: string) => /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';

/** True when the bytes are valid UTF-8 without NUL (only the first 64 KiB are checked). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return true;
  } catch {
    // The cut at 64 KiB may split a multi-byte character; retry without the last 3 bytes.
    if (bytes.length <= head.length) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 3)); return true; } catch { return false; }
  }
}

/**
 * Detects the mime type: magic bytes first, then UTF-8 text (typed by extension), else the
 * caller's hint when it is a plausible binary type, else application/octet-stream.
 */
export function detectMime(bytes: Uint8Array, name = '', hint?: string): string {
  const binary = sniffBinary(bytes);
  const ext = extension(name);
  if (binary === 'application/zip' && OFFICE[ext]) return OFFICE[ext];
  if (binary) return binary;
  if (bytes.length && looksLikeText(bytes)) return TEXT_EXTENSIONS[ext] ?? 'text/plain';
  if (hint && /^[a-z]+\/[a-z0-9.+-]{1,100}$/i.test(hint) && !hint.startsWith('text/')) return hint.toLowerCase();
  return 'application/octet-stream';
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'image/svg+xml', 'application/x-subrip'].includes(mime);
}

/** Width/height from PNG, GIF, JPEG or WEBP headers (undefined when not parseable). */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === 'image/png' && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
    if (mime === 'image/gif' && bytes.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (mime === 'image/webp' && bytes.length >= 30) {
      const chunk = ascii(bytes, 12, 16);
      if (chunk === 'VP8X') return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
      if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === 'image/jpeg') {
      // Walk segments until a SOFn marker (not DHT C4, JPG C8, DAC CC).
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const length = view.getUint16(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch { /* malformed header */ }
  return undefined;
}
