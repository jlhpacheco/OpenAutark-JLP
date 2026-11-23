// Fest round 22.11.2026: a page's socket (Hello `client: 'pwa'` – browser, Android, iPhone) is marked as a page for the
// keepalive once its Hello is accepted (src/runtime/http/ws.ts): it gets the beat, so ui/lib/rpc.ts can notice silence,
// and (G) its round trips count for the phone's or browser's device id its token names. A refused Hello is never marked
// (a beat must not count as the PC's answer to a refused token), nor are the CLI's and other programs' sockets (their
// documented frames stay answers and events).
// Owns: these assertions only. Never: a real socket or server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { ClientSockets } from '../../../src/runtime/http/ws.ts';
import type { ClientSocketDeps } from '../../../src/runtime/http/ws.ts';
import type { Logger } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  close() { this.readyState = 3; }
}

const LOG = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const DEVICE: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo'] };
const PERSON: ClientScope = { kind: 'person', personId: 'per_anna', deviceId: 'dev_anna_phone', tokenId: 'tok_1' };

/** Runs one Hello through ClientSockets; answers how the keepalive was told about the socket (undefined: not at all). */
function pageAfter(client: string, scope: ClientScope | undefined): { device?: string } | undefined {
  const pages: Array<{ ws: unknown; device?: string }> = [];
  const sockets = new ClientSockets({
    rpc: { attach: () => () => undefined, handleHttp: async () => ({ id: 0 }) } as unknown as ClientSocketDeps['rpc'],
    authenticate: () => scope,
    keepalive: { add: () => undefined, page: (ws: unknown, device?: string) => { pages.push({ ws, device }); } } as unknown as ClientSocketDeps['keepalive'],
    log: () => LOG,
    helloTimeoutMs: 60_000,
  });
  const ws = new FakeWs();
  sockets.accept(ws as unknown as WebSocket, true);
  ws.emit('message', Buffer.from(JSON.stringify({ protocol: 1, token: 'a-token', client })), false);
  ws.emit('close');
  assert.ok(pages.length <= 1 && (!pages.length || pages[0].ws === ws));
  return pages[0] && { device: pages[0].device };
}

test('a page socket is marked once its Hello is accepted, with the device its token names', () => {
  assert.deepEqual(pageAfter('pwa', DEVICE), { device: 'dev_phone' });
  assert.deepEqual(pageAfter('pwa', PERSON), { device: 'dev_anna_phone' }, 'a person\'s phone too');
  assert.deepEqual(pageAfter('pwa', { kind: 'owner' }), { device: undefined }, 'a page without a device id still beats');
});

test('a refused Hello, the CLI and other programs are not marked', () => {
  assert.equal(pageAfter('pwa', undefined), undefined, 'refused: the close code is the only answer');
  assert.equal(pageAfter('cli', { kind: 'owner' }), undefined);
  assert.equal(pageAfter('external', DEVICE), undefined);
});
