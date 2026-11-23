// Static UI for the PWA/browser: files from the built UI directory (app/ui) with correct MIME
// types (shared/files/mime.ts mimeForPath, the desktop's rule), cache headers, ETags, the app CSP for HTML and an SPA fallback to index.html for
// navigation paths (no file extension). B-082: /turn/<name> – the conversation's turn detector files by fixed name
// (onnxruntime-web's wasm and loader, Silero VAD, Smart Turn; turnFile), never a path from the client.
// F29 (16.11.2026): UI_HASHES_PATH lists the SHA-256 of every file below `root` – the iPhone web app fetches it over its
// pinned channel and runs only files with those bytes (shared/model/ui-hashes.ts); each hash is kept until the file's
// size or mtime changes, so an update of the UI folder is listed at once.
// Owns: URL → file mapping with traversal protection, the cache/CSP policy of UI files and their hash list.
// Never: serves files outside `root`, dotfiles, or anything authenticated (files.ts does that).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { mimeForPath } from '../../shared/files/mime.ts';
import { TURN_ROUTE, turnFile } from '../../shared/model/local-speech-models.ts';
import { UI_HASHES_PATH, type UiHashes } from '../../shared/model/ui-hashes.ts';
import { modelDir } from '../voice/local/store.ts';
import { BASE_HEADERS, sendError, sendJson } from './body.ts';

/** CSP of the UI shell served over HTTP (the PWA). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // B-082: the conversation's turn models (onnxruntime-web); WebAssembly only, never eval
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss: blob: https://firestore.googleapis.com", // 18.11.2026: a phone's feedback goes straight to the team's mailbox (ui/feedback/direct.ts) // 17.11.2026: the page may read back its own blob: URLs (a phone's attachment save failed with "Failed to fetch")
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * CSP of sandbox documents (```app mini-tools, web-genui.md §3): no network, no frames, no
 * forms targets, no navigation base; `sandbox` keeps them in an opaque origin even when opened
 * top-level, so they can never read the app's storage (device token).
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src blob: data:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ');

/**
 * Maps a URL pathname to a file below `root`; null when it escapes the root, is malformed or
 * names a dotfile. '' and '/' map to index.html. Percent-encoding is decoded once.
 */
export function resolveUnder(root: string, pathname: string, index = 'index.html'): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '') || index;
  if (relative.split('/').some((segment) => segment.startsWith('.'))) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** esbuild content hashes: `chunks/name-ABCDEFGH.js`, `font-ABCDEFGH.woff2`. */
const HASHED = /-[A-Z0-9]{8}\.[a-z0-9]+$/;

/** Cache policy: shell files revalidate every time; content-hashed assets are immutable. */
export function cacheControlFor(relative: string): string {
  const name = relative.replace(/\\/g, '/');
  if (name === 'index.html' || name === 'sw.js') return 'no-cache';
  if (name.startsWith('chunks/') || HASHED.test(name)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/** Paths that belong to API routes and must never fall back to the SPA shell. */
const RESERVED = /^\/(?:api|rpc|ws|mcp|files|peer|sandbox|\.well-known|chunks|icons)(?:\/|$)/;

export class StaticFiles {
  private readonly root: string;
  private readonly dataDir?: () => string;
  /** F29: each UI file's SHA-256 by its size and mtime. */
  private readonly hashed = new Map<string, { stamp: string; hash: string }>();

  /** `dataDir`: where the downloaded models are (the turn files); without it /turn/ serves the ort files only. */
  constructor(root: string, dataDir?: () => string) {
    this.root = path.resolve(root);
    this.dataDir = dataDir;
  }

  /** Serves a GET/HEAD for a UI file or the SPA shell. Always answers (404/405 included). */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'bad_request', 'Method not allowed.', { Allow: 'GET, HEAD' });
      return;
    }
    if (pathname === UI_HASHES_PATH) {
      try { sendJson(res, 200, { files: await this.uiHashes() } satisfies UiHashes); } catch { sendError(res, 503, 'unavailable', 'The UI folder is changing; ask again.'); }
      return;
    }
    if (pathname.startsWith(TURN_ROUTE)) {
      const file = this.turnPath(pathname.slice(TURN_ROUTE.length));
      if (!file || !(await this.send(req, res, file))) sendError(res, 404, 'not_found', 'Not found.');
      return;
    }
    const file = resolveUnder(this.root, pathname);
    if (!file) {
      sendError(res, 404, 'not_found', 'Not found.');
      return;
    }
    if (await this.send(req, res, file)) return;
    // Navigation inside the SPA (/chats/ch_…): no extension in the last segment → index.html.
    const last = pathname.split('/').pop() ?? '';
    if (!RESERVED.test(pathname) && !last.includes('.')) {
      if (await this.send(req, res, path.join(this.root, 'index.html'))) return;
    }
    sendError(res, 404, 'not_found', 'Not found.');
  }

  /** F29: path below `root` → SHA-256 hex of every file there (dotfiles left out, as serve() never serves them). */
  private async uiHashes(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const rel = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(full, `${rel}/`);
        else if (entry.isFile()) {
          const info = await stat(full);
          const stamp = `${info.size}-${info.mtimeMs}`;
          const known = this.hashed.get(rel);
          const hash = known?.stamp === stamp ? known.hash : createHash('sha256').update(await readFile(full)).digest('hex');
          this.hashed.set(rel, { stamp, hash });
          files[rel] = hash;
        }
      }
    };
    await walk(this.root, '');
    return files;
  }

  /** The file behind one fixed turn name: ort next to the app's package.json (unpacked from the asar), a model in its folder. */
  private turnPath(name: string): string | null {
    const source = turnFile(name);
    if (!source) return null;
    if ('ort' in source) return path.join(this.root, '..', '..', 'node_modules', 'onnxruntime-web', 'dist', source.ort).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const dataDir = this.dataDir?.();
    return dataDir ? path.join(modelDir(dataDir, source.model), source.model.files[0]) : null;
  }

  /** Streams one file with its headers; false when it does not exist (nothing written). */
  private async send(req: IncomingMessage, res: ServerResponse, file: string): Promise<boolean> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mimeForPath(file),
      'Cache-Control': cacheControlFor(relative),
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = relative.startsWith('sandbox/') ? SANDBOX_CSP : APP_CSP;
    if (relative === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = String(info.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    try {
      await pipeline(createReadStream(file), res);
    } catch {
      res.destroy(); // client went away or the file vanished mid-stream
    }
    return true;
  }
}
