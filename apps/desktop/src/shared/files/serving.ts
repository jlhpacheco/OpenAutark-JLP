// How a stored file is served, one rule for the runtime's HTTP server and the desktop's wf-file:// protocol: its place in
// the content-addressed blob store (<blobs>/ab/cd/<sha256> – each layer joins the parts with its own path module) and a
// single HTTP Range, so audio and video can seek.
// Owns: the blob layout and the Range rule. Never: reads files or joins paths (shared runs in every layer).

/** The blob store's folders and file name of a sha256 id: ['ab', 'cd', '<sha256>']. */
export function blobParts(id: string): [string, string, string] {
  return [id.slice(0, 2), id.slice(2, 4), id];
}

/** Parses a single-range `Range: bytes=a-b` header against a file size; null = serve the whole file. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') { // suffix: the last N bytes
    const length = Number(match[2]);
    if (length === 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}
