// A phone/browser token this PC does not know at all closes with 4404 (src/runtime/http/ws.ts, Sicher-Runde 19.11.2026
// D5): the phone then tries its company's next PC and says so in its status line instead of showing the pairing screen.
// A token this PC knows but refuses (`known`) stays 4401, a removed one 4403; without `known` every refusal is 4401 as
// before, and other clients (the CLI) keep 4401.
// Owns: these assertions only. Never: a real socket or server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { CLOSE, ClientSockets } from '../../../src/runtime/http/ws.ts';
import type { ClientSocketDeps } from '../../../src/runtime/http/ws.ts';
import type { Logger } from '../../../src/runtime/contracts.ts';

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  closedWith: number | undefined;
  close(code: number) { this.closedWith = code; this.readyState = 3; }
}

const LOG = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

function closeFor(token: string, client: string, deps: Partial<ClientSocketDeps>): number | undefined {
  const sockets = new ClientSockets({
    rpc: { attach: () => () => undefined, handleHttp: async () => ({ id: 0 }) } as unknown as ClientSocketDeps['rpc'],
    authenticate: () => undefined,
    keepalive: { add: () => undefined } as unknown as ClientSocketDeps['keepalive'],
    log: () => LOG,
    helloTimeoutMs: 60_000,
    ...deps,
  });
  const ws = new FakeWs();
  sockets.accept(ws as unknown as WebSocket, false);
  ws.emit('message', Buffer.from(JSON.stringify({ protocol: 1, token, client })), false);
  ws.emit('close');
  return ws.closedWith;
}

test('a phone token this PC never issued: 4404; a known but refused token: 4401; a removed one: 4403', () => {
  const known = (token: string) => token === 'launch-token';
  assert.equal(CLOSE.unknown, 4404);
  assert.equal(closeFor('someone-elses-phone', 'pwa', { known }), 4404);
  assert.equal(closeFor('launch-token', 'pwa', { known }), 4401, 'the launch token from another computer stays refused');
  assert.equal(closeFor('removed-phone', 'pwa', { known, revoked: (token) => token === 'removed-phone' }), 4403);
});

test('without `known`, and for other clients, every refusal stays 4401', () => {
  assert.equal(closeFor('someone-elses-phone', 'pwa', {}), 4401);
  assert.equal(closeFor('someone-elses-phone', 'cli', { known: () => false }), 4401);
  assert.equal(closeFor('someone-elses-phone', 'pwa', { known: () => { throw new Error('db gone'); } }), 4401, 'a failing check is the old answer');
});
