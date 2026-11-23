// An in-memory RPC connection pair (Quests round 20.11.2026: moved here from src/runtime/rpc/connection.ts – no app code
// uses it): `server` goes to RpcServer.attach, `client` sends requests and records replies and events.
// Owns: this pair. Never: imported by src/.

import type { RpcConnection } from '../../../src/runtime/rpc/connection.ts';

/** The client end of an in-memory pair. */
export interface MemoryClient {
  /** Frames the server sent, in order. */
  readonly received: unknown[];
  send(frame: unknown): void;
  close(): void;
  onFrame(listener: (frame: unknown) => void): () => void;
  readonly closed: boolean;
}

/**
 * Two connected ends: `server` goes to RpcServer.attach, `client` sends requests and records
 * replies/events. Delivery is asynchronous (microtask) in both directions, like a real port.
 */
export function memoryConnection(): { server: RpcConnection; client: MemoryClient } {
  const serverListeners = new Set<(data: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const frameListeners = new Set<(frame: unknown) => void>();
  const received: unknown[] = [];
  let closed = false;
  const shut = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) {
      try { listener(); } catch { /* ignore */ }
    }
  };
  const server: RpcConnection = {
    send(frame) {
      if (closed) return;
      queueMicrotask(() => {
        received.push(frame);
        for (const listener of frameListeners) listener(frame);
      });
    },
    close: shut,
    onMessage(listener) { serverListeners.add(listener); },
    onClose(listener) { closeListeners.add(listener); },
  };
  const client: MemoryClient = {
    received,
    send(frame) {
      if (closed) return;
      queueMicrotask(() => { for (const listener of serverListeners) listener(frame); });
    },
    close: shut,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    get closed() { return closed; },
  };
  return { server, client };
}
