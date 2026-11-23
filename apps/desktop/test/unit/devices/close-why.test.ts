// devices/channel.ts closeWhy (Fest 22.11.2026): a socket error's cause travels with the 1006 to the mesh's close line –
// the error's code and syscall, whether this PC still has the address the socket ran on (never the address), age and bytes
// waiting – so a vanished Wi-Fi address reads differently from a peer that stopped answering.

import test from 'node:test';
import assert from 'node:assert/strict';
import { closeWhy, wrapWs } from '../../../src/runtime/devices/channel.ts';

const fakeWs = (localAddress?: string) => ({ _socket: localAddress ? { localAddress, localPort: 51234 } : undefined, bufferedAmount: 42 });

test('an address this PC no longer has reads as gone; the address itself is never in the cause', () => {
  const why = closeWhy(fakeWs('203.0.113.9') as never, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }), Date.now() - 1500);
  assert.equal(why.error, 'ECONNRESET');
  assert.equal(why.syscall, 'read');
  assert.equal(why.localGone, true);
  assert.equal(why.buffered, 42);
  assert.ok((why.ageMs ?? 0) >= 1500);
  assert.doesNotMatch(JSON.stringify(why), /203\.0\.113\.9/);
});

test('the loopback address is still here; an error without a code keeps its short message', () => {
  const why = closeWhy(fakeWs('127.0.0.1') as never, new Error('socket hang up'), Date.now());
  assert.equal(why.localGone, false);
  assert.equal(why.error, 'socket hang up');
  assert.equal(closeWhy(fakeWs() as never, 'x', Date.now()).localGone, undefined, 'no socket: unknown, not gone');
});

test('wrapWs hands the cause along with the 1006 of an error', () => {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const ws = { ...fakeWs('127.0.0.1'), on: (event: string, fn: (arg?: unknown) => void) => { handlers.set(event, fn); } };
  const seen: Array<[number | undefined, unknown]> = [];
  wrapWs(ws as never).onClose((code, why) => { seen.push([code, why]); });
  handlers.get('error')?.(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  assert.equal(seen[0][0], 1006);
  assert.equal((seen[0][1] as { error?: string }).error, 'ETIMEDOUT');
});
