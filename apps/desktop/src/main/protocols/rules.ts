// Pure rules for the custom protocols app://, wf-sandbox:// and wf-file://.
// Owns: CSP strings, URL → file mapping with traversal protection, the turn detector's fixed files (B-082), blob id validation
// and the sandbox document wrapper of ```app blocks (content types and HTTP Range: shared/files, one rule with the runtime).
// Never: touches Electron or the filesystem (handlers.ts does that), so it is unit-tested.

import path from 'node:path';
import { blobParts } from '../../shared/files/serving.ts';
import { TURN_ROUTE, turnFile } from '../../shared/model/local-speech-models.ts';

/** CSP of the app shell (desktop window). Generative UI never relaxes it; it lives in wf-sandbox frames. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // B-082: the conversation's turn models (onnxruntime-web); WebAssembly only, never eval
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: wf-file:",
  "media-src 'self' blob: wf-file:",
  "connect-src 'self'",
  'frame-src wf-sandbox:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** CSP of ```app mini-tools (web-genui.md §3): no network, no frames, no forms, no navigation. */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' wf-sandbox:",
  "style-src 'unsafe-inline' wf-sandbox:",
  'img-src data: blob:',
  'media-src blob: data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** CSP of a view in <data>/pages: open, it may load and fetch what it likes; its opaque origin keeps it out of the app itself. */
export const PAGE_CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval' wf-sandbox:; form-action *; base-uri *";

export const SANDBOX_LIB = 'wf-sandbox://lib/wf.js';

/**
 * Maps a URL pathname to a file below `root`; null when it escapes the root or is malformed.
 * '' and '/' map to index.html. Percent-encoding is decoded once.
 */
export function resolveUnder(root: string, pathname: string, index = 'index.html'): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '') || index;
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

export type AppRoute = { kind: 'ui'; pathname: string } | { kind: 'turn'; name: string };

/** app://app/<path> → the shipped UI; app://app/turn/<name> → one of the turn detector's fixed files (B-082, turnFile). */
export function routeAppUrl(url: string): AppRoute | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'app:' || parsed.host !== 'app') return null;
  if (parsed.pathname.startsWith(TURN_ROUTE)) return { kind: 'turn', name: parsed.pathname.slice(TURN_ROUTE.length) };
  return { kind: 'ui', pathname: parsed.pathname };
}

/**
 * B-082: the file behind one fixed turn name – onnxruntime-web's wasm or loader in `ortDir`, a model in
 * <speechDir>/<id>/<file> (runtime/voice/local/store.ts layout); null for every other name (no path from the page).
 */
export function turnFilePath(name: string, dirs: { ortDir: string; speechDir: string }): string | null {
  const source = turnFile(name);
  if (!source) return null;
  return 'ort' in source ? path.join(dirs.ortDir, source.ort) : path.join(dirs.speechDir, source.model.id, source.model.files[0]);
}

/** Where the shipped onnxruntime-web files are: next to the app's package.json, outside the asar (they are unpacked). */
export function ortDirOf(appRoot: string): string {
  return path.join(appRoot, 'node_modules', 'onnxruntime-web', 'dist').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export type SandboxRoute =
  | { kind: 'lib'; file: string }
  | { kind: 'app'; messageId: string; blockIndex: number }
  | { kind: 'page'; name: string };

/** wf-sandbox://lib/<file> → shipped sandbox runtime; wf-sandbox://app/<messageId>/<n> → app block; wf-sandbox://page/<name> → a view in <data>/pages. */
export function routeSandboxUrl(url: string): SandboxRoute | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'wf-sandbox:') return null;
  if (parsed.host === 'lib') {
    const file = parsed.pathname.replace(/^\/+/, '');
    return /^[a-z0-9_-]+\.js$/.test(file) ? { kind: 'lib', file } : null;
  }
  if (parsed.host === 'app') {
    const match = /^\/([a-z]{2,4}_[0-9a-z]{8,40})\/(\d{1,4})\/?$/.exec(parsed.pathname);
    if (!match) return null;
    return { kind: 'app', messageId: match[1], blockIndex: Number(match[2]) };
  }
  if (parsed.host === 'page') {
    let name: string;
    try { name = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')); } catch { return null; }
    return name && !/[/\\\0]/.test(name) ? { kind: 'page', name } : null;
  }
  return null;
}

/** wf-file://<sha256> → validated lowercase hex id, else null. */
export function parseBlobUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'wf-file:') return null;
  const id = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  return isBlobId(id) ? id : null;
}

export function isBlobId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** A blob's file: the store's layout (shared/files/serving.ts blobParts) under <blobs>. */
export function blobPath(blobsDir: string, id: string): string {
  return path.join(blobsDir, ...blobParts(id));
}

/**
 * Wraps the HTML of an ```app block into a sandbox document that loads wf.js first.
 * A full document gets the script injected right after <head> (or <html>); a fragment is wrapped.
 */
export function wrapSandboxHtml(html: string): string {
  const script = `<script src="${SANDBOX_LIB}"></script>`;
  const meta = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  if (/^\s*(<!doctype[^>]*>\s*)?<html[\s>]/i.test(html)) {
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, match => `${match}${meta}${script}`);
    return html.replace(/<html[^>]*>/i, match => `${match}<head>${meta}${script}</head>`);
  }
  return `<!doctype html><html><head>${meta}${script}</head><body>${html}</body></html>`;
}
