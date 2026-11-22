// Port selection for the runtime HTTP server: the port that was chosen last time the default was
// busy (kept in kv, so installed PWAs and a second company keep their own origin), the configured
// port, then an ephemeral port; re-listening on another host with the same port (bind changes).
// 15.11.2026 (two companies on one PC): Windows lets 0.0.0.0:P and 127.0.0.1:P of two processes
// coexist without EADDRINUSE, and loopback traffic then reaches the more specific listener – the
// second company's runtime answered the first one's MCP calls with 401. So a listener at 0.0.0.0 also holds
// 127.0.0.1 on its port itself (holdLoopback) – an exact address only one socket can have: whoever binds it
// first owns the port's loopback, the other one gets EADDRINUSE and takes another port. No probe beforehand
// (a probe reserves nothing; two companies starting together raced past it). Where the system already
// refuses the overlap (Linux), the 0.0.0.0 listener alone does it.
// Owns: listen-with-fallback and that one remembered value.
// Never: decides the bind host (settings do) or retries beyond a few short, bounded attempts.

import type { Server } from 'node:http';
import { createServer as createNet, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeServices } from '../contracts.ts';
import type { Settings } from '../../shared/model/system.ts';
import { KvRepo } from '../store/kv.ts';
import { loopbackOnly } from '../root/test-network.ts';

/** Default port of the runtime HTTP server. */
export const DEFAULT_PORT = 47811;

/**
 * Listen address for `settings.pwa.bind`: this computer only, or every interface for LAN /
 * tailnet access (the Host allowlist and tokens still apply to every request).
 */
export function bindHostFor(bind: Settings['pwa']['bind'], env: NodeJS.ProcessEnv = process.env): string {
  return loopbackOnly(env) || bind === 'localhost' ? '127.0.0.1' : '0.0.0.0';
}

const KV_NS = 'http';
const KV_KEY = 'fallbackPort';

/** Listens once; rejects with the listen error (EADDRINUSE …). */
export function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Port busy or reserved (Windows reports excluded port ranges as EACCES). */
export function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

let overlap: Promise<boolean> | undefined;

/** Whether this system lets 127.0.0.1:P be bound next to a listener at 0.0.0.0:P (Windows does); tried once. */
export function loopbackOverlaps(): Promise<boolean> {
  overlap ??= (async () => {
    const wide = createNet();
    const near = createNet();
    try {
      await netListen(wide, '0.0.0.0', 0);
      await netListen(near, '127.0.0.1', (wide.address() as AddressInfo).port);
      return true;
    } catch {
      return false;
    } finally {
      for (const server of [near, wide]) if (server.listening) server.close();
    }
  })();
  return overlap;
}

function netListen(server: NetServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

/** For tests only: runs between the 0.0.0.0 listen and holding 127.0.0.1 (where another listener could slip in). */
export interface ListenHooks { listening?: (port: number) => Promise<void> }

/**
 * Listens `server` at `host`:`port`; at 0.0.0.0 it also holds 127.0.0.1 on the chosen port, handing those
 * connections to `server` (see the header). Rejects busy when either is taken; `server` then listens nowhere.
 * Closing `server` closes the loopback hold with it.
 */
export async function listenHeld(server: Server, host: string, port: number, hooks?: ListenHooks): Promise<number> {
  const chosen = await listenOn(server, host, port);
  if (host !== '0.0.0.0' || !(await loopbackOverlaps())) return chosen;
  await hooks?.listening?.(chosen);
  const hold = createNet((socket) => { server.emit('connection', socket); });
  try {
    await netListen(hold, '127.0.0.1', chosen);
  } catch (error) {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    throw error;
  }
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { hold.close(); return close(callback); }) as Server['close'];
  return chosen;
}

export function rememberedPort(services: RuntimeServices): number | undefined {
  try {
    const value = new KvRepo(services.db).get<number>(KV_NS, KV_KEY);
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
  } catch {
    return undefined; // no database (tests, early start): nothing remembered
  }
}

export function rememberPort(services: RuntimeServices, port: number): void {
  try {
    new KvRepo(services.db).set(KV_NS, KV_KEY, port, services.clock.now());
  } catch { /* best effort */ }
}

/**
 * Listens on `host` with the remembered fallback (when the default port is configured), the
 * configured port, then an ephemeral port, each held as listenHeld does. Every attempt uses a
 * fresh server from `create` (a failed server is discarded). A configured port of 0 means
 * "ephemeral" (tests) and is never remembered.
 */
export async function listenWithFallback(create: () => Server, host: string, configured: number, services: RuntimeServices, hooks?: ListenHooks): Promise<{ server: Server; port: number }> {
  const remembered = configured > 0 ? rememberedPort(services) : undefined;
  // The remembered port first only for the default: a company that once found it taken keeps its own origin.
  const candidates = remembered && remembered !== configured
    ? (configured === DEFAULT_PORT ? [remembered, configured] : [configured, remembered])
    : [configured];
  if (configured !== 0) candidates.push(0);
  let lastError: unknown;
  for (const port of candidates) {
    const server = create();
    try {
      const chosen = await listenHeld(server, host, port, hooks);
      if (configured > 0 && chosen !== configured && chosen !== remembered) rememberPort(services, chosen);
      return { server, port: chosen };
    } catch (error) {
      server.close();
      if (!isBusy(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Listens on `port` at the first of `hosts` that works. A busy port is retried a few times
 * (the previous listener on that port is still closing); other errors skip to the next host.
 */
export async function relisten(create: () => Server, hosts: readonly string[], port: number, stopped: () => boolean): Promise<{ server: Server; host: string } | undefined> {
  for (const host of hosts) {
    for (const wait of [0, 50, 250, 1000]) {
      if (wait) await delay(wait, undefined, { ref: false });
      if (stopped()) return undefined;
      const server = create();
      try {
        await listenHeld(server, host, port);
        return { server, host };
      } catch (error) {
        server.close();
        if (!isBusy(error)) break;
      }
    }
  }
  return undefined;
}
