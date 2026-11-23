// B-085 – an owner Hello may name `agent` (an agent's own wf, wf-cli/discover.ts): the owner scope then carries
// agentId when agentLive says the agent exists and is not archived (4403 otherwise); on any other scope the Hello
// closes with 4400; a malformed agent is no Hello (4400); without agentLive the claim passes on (the handlers check it).
// Owns: these assertions only. Never: real sockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CLOSE, ClientSockets, Keepalive } from '../../../src/runtime/http/ws.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { silentLog } from '../devices/fakes.ts';
import { agentProof } from '../../../src/runtime/security/agent-proof.ts';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  closedWith?: number;
  send(): void {}
  close(code: number): void { this.closedWith ??= code; }
  ping(): void {}
  terminate(): void {}
}

/** One Hello on a fresh socket: the attached scope, or the close code. */
function helloWith(frame: Record<string, unknown>, scope: ClientScope, agentLive?: (id: string) => boolean): { scope?: ClientScope; closed?: number } {
  const keepalive = new Keepalive();
  let attached: ClientScope | undefined;
  const sockets = new ClientSockets({
    rpc: { attach: (_connection, next) => { attached = next; return () => {}; }, handleHttp: async () => ({ id: 0 }) },
    authenticate: () => scope, keepalive, log: () => silentLog, ...(agentLive ? { agentLive } : {}),
  });
  const ws = new FakeSocket();
  try {
    sockets.accept(ws as never, true);
    const proof = typeof frame.agent === 'string' && !('proof' in frame) ? { proof: agentProof(frame.agent) } : {}; // the runtime's proof unless the test names one
    ws.emit('message', Buffer.from(JSON.stringify({ protocol: 1, token: 'owner-token', client: 'cli', ...proof, ...frame })), false);
    return { scope: attached, closed: ws.closedWith };
  } finally {
    keepalive.stop();
  }
}

const live = (id: string) => id === 'ag_ava';

test("an owner Hello with a live agent attaches the owner scope with that agent's id; without agent as before", () => {
  assert.deepEqual(helloWith({ agent: 'ag_ava' }, { kind: 'owner' }, live).scope, { kind: 'owner', agentId: 'ag_ava' });
  assert.deepEqual(helloWith({}, { kind: 'owner' }, live).scope, { kind: 'owner' });
  assert.deepEqual(helloWith({ agent: 'ag_ava' }, { kind: 'owner' }).scope, { kind: 'owner', agentId: 'ag_ava' }, 'no agentLive: the handlers check it');
});

test('an agent that is gone or archived closes with 4403; agent on another scope with 4400; a malformed one is no Hello', () => {
  assert.deepEqual(helloWith({ agent: 'ag_old' }, { kind: 'owner' }, live), { scope: undefined, closed: CLOSE.revoked });
  const device: ClientScope = { kind: 'device', deviceId: 'dev_1', capabilities: ['chat'] };
  assert.deepEqual(helloWith({ agent: 'ag_ava' }, device, live), { scope: undefined, closed: CLOSE.badHello });
  assert.deepEqual(helloWith({ agent: 'ag ava; drop' }, { kind: 'owner' }, live), { scope: undefined, closed: CLOSE.badHello });
  assert.deepEqual(helloWith({ agent: 42 }, { kind: 'owner' }, live), { scope: undefined, closed: CLOSE.badHello });
  assert.deepEqual(helloWith({ agent: 'ag_ava' }, { kind: 'owner' }, () => { throw new Error('db gone'); }), { scope: undefined, closed: CLOSE.revoked });
});
