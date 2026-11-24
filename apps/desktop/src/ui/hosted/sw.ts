// Service worker of the iPhone web app (B-078 follow-up; built to apps/website/src/app/sw.js, scope <site>/app/). It holds
// no socket – iOS ends idle workers – and relays: a request for a PC path under the scope (anything but the shell's own
// files) goes to the shell page that holds the tunnel (ui/hosted/bridge.ts, a MessagePort), and the answer streams back
// as a Response. The PC's '/x' is '<scope>x', so the PC UI's relative paths (chunks, icons, the worklet, files, sandbox
// frames) work unchanged. Cache 'autark-pc': chunks/ and icons/ cache-first (the PC marks them immutable); main.js,
// main.css and the other root files revalidate with their ETag (the PC answers 304) and fall back to the copy when no
// tunnel came within 4 s, so the UI boots and shows its own "connecting" state. Without a copy and a tunnel within 10 s:
// 503. The shell's own files are network-first in 'autark-shell'. Pushes always show a notice (sw-notify.ts, iOS); a
// clear shows one again only on Apple's push service (B-087: elsewhere it just closes).
// F29: a file on the PC's list (ui-hashes.ts) and every script, stylesheet or worker reach the page only with the bytes
// the PC lists – a copy that differs is fetched anew, a fresh file that differs or a script the PC does not list is
// refused with a 403 that says why, and the shell page is told ({type:'hosted.refused', file}).
// Owns: that routing, caching and refusing. Never: holds the token or the key, caches /rpc, /files, /sandbox or anything
// else live.

import { wireNotifications, type NotifyScope } from '../pwa/sw-notify.ts';
import { UI_HASHES_PATH } from '../../shared/model/ui-hashes.ts';
import { CODE, PC_CACHE, UiHashCheck } from './ui-hashes.ts';

export {};

interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; clientId: string; respondWith(response: Response | Promise<Response>): void }
interface ClientLike { id?: string; url: string; type?: string; focused?: boolean; visibilityState?: string; focus(): Promise<unknown>; postMessage(message: unknown, transfer?: unknown[]): void }
interface HostedScope extends Omit<NotifyScope, 'clients' | 'addEventListener'> {
  clients: {
    get(id: string): Promise<ClientLike | undefined>;
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<ClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (event: FetchEvent) => void): void;
  addEventListener(type: 'push' | 'notificationclick' | 'notificationclose', fn: (event: never) => void): void;
}

const sw = self as unknown as HostedScope;
const SCOPE = new URL(sw.registration?.scope ?? './', sw.location.href);
const BASE = SCOPE.pathname; // '/autark/app/'
const SHELL_CACHE = 'autark-shell';
/** F29: the PC's list of its UI files – as the shell kept it, else asked through the tunnel. */
const hashes = new UiHashCheck(caches, SCOPE.href, () => relay(new Request(new URL(UI_HASHES_PATH.slice(1), SCOPE).href), UI_HASHES_PATH, '', QUICK_MS));
/** The shell's own files; everything else under the scope is the PC's. */
const SHELL = new Set(['', 'index.html', 'shell.js', 'sw.js', 'app.webmanifest', 'app-icon.png', 'app-icon-512.png']);
/** Named by content on the PC (immutable there): chunks, icons, esbuild's hashed assets (fonts). */
const IMMUTABLE = /^(chunks|icons)\/|-[A-Z0-9]{8}\.(woff2|png|svg)$/;
/** Root files of the PC UI, revalidated with their ETag. */
const REVALIDATE = new Set(['main.js', 'main.css', 'pcm-worklet.js', 'icon.png', 'icon-maskable.png', 'manifest.webmanifest']);
const QUICK_MS = 4_000;
const WAIT_MS = 10_000;
const OFFLINE = 'Your PCs are not reachable right now. Autark has to be running on at least one of them.';

sw.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(['', 'shell.js', 'app.webmanifest', 'app-icon.png'].map((file) => cache.add(new URL(file, SCOPE).href).catch(() => undefined)));
    await sw.skipWaiting();
  })());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

/** The shell document that holds the tunnel: the requesting window, else an open shell window. */
async function shellClient(clientId: string): Promise<ClientLike | undefined> {
  const isShell = (client: ClientLike | undefined) => {
    if (!client) return false;
    const path = new URL(client.url).pathname;
    return path === BASE || path === `${BASE}index.html`;
  };
  const own = clientId ? await sw.clients.get(clientId).catch(() => undefined) : undefined;
  if (isShell(own)) return own;
  const windows = (await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(isShell);
  return windows.find((client) => client.focused) ?? windows.find((client) => client.visibilityState === 'visible') ?? windows[0];
}

/** One request relayed through the shell page; undefined when no tunnel came within `wait` (or no shell is open). */
async function relay(request: Request, path: string, clientId: string, wait: number, extra: Array<[string, string]> = []): Promise<Response | undefined> {
  const client = await shellClient(clientId);
  if (!client) return undefined;
  const headers: Array<[string, string]> = [];
  request.headers.forEach((value, name) => { headers.push([name, value]); });
  headers.push(...extra);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const channel = new MessageChannel();
  return new Promise<Response | undefined>((resolve) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    const settle = (value: Response | undefined) => { if (!settled) { settled = true; clearTimeout(limit); resolve(value); } };
    const limit = setTimeout(() => { settle(undefined); channel.port1.close(); }, wait + 2_000); // a page that never answers
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as { t?: string; status?: number; statusText?: string; headers?: Array<[string, string]>; data?: ArrayBuffer; offline?: boolean };
      if (message.t === 'head') {
        const status = message.status ?? 502;
        const noBody = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
        const stream = noBody ? null : new ReadableStream<Uint8Array>({
          start: (c) => { controller = c; },
          cancel: () => { channel.port1.postMessage({ t: 'cancel' }); channel.port1.close(); },
        });
        try { settle(new Response(stream, { status, statusText: message.statusText ?? '', headers: message.headers ?? [] })); }
        catch { settle(new Response(stream, { status: 502 })); }
      } else if (message.t === 'chunk' && message.data) {
        try { controller?.enqueue(new Uint8Array(message.data)); } catch { /* the reader went away */ }
      } else if (message.t === 'end') {
        try { controller?.close(); } catch { /* closed */ }
        channel.port1.close();
      } else if (message.t === 'error') {
        if (!settled) settle(undefined);
        else try { controller?.error(new TypeError('Your PC ended the answer.')); } catch { /* closed */ }
        channel.port1.close();
      }
    };
    client.postMessage({ type: 'hosted.fetch', method: request.method, path, headers, ...(body ? { body } : {}), wait }, [channel.port2]);
  });
}

const offline = (): Response => new Response(OFFLINE, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });

async function shellFile(request: Request | string, key: string): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) cache.put(key, response.clone()).catch(() => undefined);
    return response;
  } catch {
    return (await cache.match(key)) ?? offline();
  }
}

/** F29: what the page gets instead of a file that is not the PC's own; the shell page shows why. */
async function refuse(file: string, clientId: string): Promise<Response> {
  (await shellClient(clientId).catch(() => undefined))?.postMessage({ type: 'hosted.refused', file });
  return new Response(`Autark did not run ${file}: it is not one of your PC’s own files.`, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function pcFile(request: Request, rel: string, clientId: string): Promise<Response> {
  const key = new URL(rel, SCOPE).href;
  const search = new URL(request.url).search;
  const path = `/${rel}${search}`;
  const whole = request.method === 'GET' && !request.headers.has('range');
  const held = whole && await hashes.held(rel);
  const checked = held || (whole && CODE.has(request.destination));
  if (checked && !held && !(await hashes.listed(rel))) return refuse(rel, clientId);
  /** The answer with the PC's own bytes; undefined when they differ (a copy is checked without asking the PC). */
  const own = async (response: Response, ask = true) => (checked ? hashes.own(rel, response, ask) : response);
  if (!whole || search || (!IMMUTABLE.test(rel) && !REVALIDATE.has(rel))) {
    const answer = await relay(request, path, clientId, WAIT_MS);
    return answer ? (await own(answer)) ?? refuse(rel, clientId) : offline();
  }
  const cache = await caches.open(PC_CACHE);
  const copy = await cache.match(key);
  const cached = copy && await own(copy, false); // a copy that is not the PC's own file counts as none
  if (cached && IMMUTABLE.test(rel)) return cached;
  const etag = cached?.headers.get('etag');
  const fresh = await relay(request, path, clientId, cached ? QUICK_MS : WAIT_MS, etag ? [['If-None-Match', etag]] : []);
  if (!fresh) return cached ?? offline();
  if (fresh.status === 304 && cached) return cached;
  const mine = await own(fresh);
  if (!mine) return refuse(rel, clientId);
  if (mine.ok) cache.put(key, mine.clone()).catch(() => undefined);
  return mine;
}

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);
  // The shell document for itself and for any page under the scope (a reload on a route), but a sandbox frame is the PC's.
  if (request.mode === 'navigate' && !rel.startsWith('sandbox/')) return event.respondWith(shellFile(SCOPE.href, SCOPE.href));
  if (SHELL.has(rel)) return event.respondWith(shellFile(request, url.href));
  event.respondWith(pcFile(request, rel, event.clientId));
});

wireNotifications(sw as unknown as NotifyScope, { home: BASE, icon: `${BASE}app-icon.png`, alwaysShow: true });
