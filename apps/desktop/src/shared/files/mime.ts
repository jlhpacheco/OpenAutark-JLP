// Content types by bytes and by served name, one rule for the runtime (its file store and HTTP server) and the desktop
// (its protocols and media jobs): binary signatures (never trusts a file name for binaries), a stored blob's type from
// its first bytes alone (sniffMime) and the type a served file's extension names (mimeForPath). Text detection by
// name stays in the runtime's file store (runtime/files/mime.ts, it decodes UTF-8).
// Owns: the signature table and the served-extension table. Never: reads files (callers pass bytes).

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);

/** Served files (the UI, the turn models, a page's assets) by extension. */
const SERVED: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/** The type of a served file by its extension (application/octet-stream for any other). */
export function mimeForPath(file: string): string {
  return SERVED[/\.[^./\\]*$/.exec(file)?.[0].toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** A stored blob's type from its first bytes alone (no name): a binary signature, SVG markup, else application/octet-stream. */
export function sniffMime(head: Uint8Array): string {
  const binary = sniffBinary(head);
  if (binary) return binary;
  const start = ascii(head, 0, 5);
  return start.startsWith('<svg') || start === '<?xml' ? 'image/svg+xml' : 'application/octet-stream';
}

/** Binary signatures → mime (checked in order). */
export function sniffBinary(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'AVI ') return 'video/x-msvideo';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'image/gif';
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'avif') return 'image/avif';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'; // EBML (webm/mkv)
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return 'audio/mpeg';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'; // also docx/xlsx/pptx (refined by extension)
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip';
  if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return undefined;
}
