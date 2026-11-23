// RpcPeer (devices/rpc-peer.ts, MP6 follow-up): a call refused before anything left this PC – the
// channel was closed already, or closed under the send – says details.reachable false (the other
// PC never saw it: remote-agents.ts keeps its placeholder instead of guessing an unknown effect);
// a call that was sent and then lost its channel does not claim that. B-080: a closed link leaves the
// handlers running here alone (only the caller's cancel frame stops one); stop() – this PC ends the link on purpose –
// aborts them, then closes the channel. B-087: a message too large for the link (8 MB) never leaves – refused before its
// counter is used – and an answer that large comes back as an error while the link stays. Owns: these assertions only.
// Never: opens sockets (the B-087 cases run a real encrypted channel over an in-memory socket pair).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_DROPPED, RpcPeer } from '../../../src/runtime/devices/rpc-peer.ts';
import { acceptSecure, connectSecure, type SecureChannel, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from './socket-pair.ts';
import { fingerprintOf, generateEd25519, rawPublic, signEd25519 } from '../../../src/runtime/devices/keys.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

function fakeChannel(options: { closed?: boolean; sendFails?: boolean } = {}) {
  const closers: Array<() => void> = [];
  const listeners: Array<(message: unknown) => void> = [];
  const sent: unknown[] = [];
  const closes: boolean[] = [];
  const channel = {
    peerId: 'dev_other', closed: options.closed ?? false,
    onMessage: (fn: (message: unknown) => void) => { listeners.push(fn); },
    onClose: (fn: () => void) => { closers.push(fn); },
    send: (message: unknown) => { if (options.sendFails || channel.closed) throw new Error('Channel closed'); sent.push(message); },
    close: () => { closes.push(true); channel.closed = true; },
  };
  return {
    channel: channel as unknown as SecureChannel, sent, closes,
    deliver: (frame: unknown) => { for (const fn of listeners) fn(frame); },
    drop: () => { channel.closed = true; for (const fn of closers) fn(); },
  };
}

const reachable = (error: unknown) => error instanceof WorkforceError ? (error.details as { reachable?: unknown } | undefined)?.reachable : 'not a WorkforceError';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a call on a closed channel, or one whose send fails, is refused as never sent', async () => {
  const closed = new RpcPeer(fakeChannel({ closed: true }).channel, () => undefined);
  const before = await closed.call('agents.deliver', {}).catch((error: unknown) => error);
  assert.equal((before as WorkforceError).code, 'unavailable');
  assert.equal(reachable(before), false);

  const failing = new RpcPeer(fakeChannel({ sendFails: true }).channel, () => undefined);
  const under = await failing.call('agents.deliver', {}, { timeoutMs: 50 }).catch((error: unknown) => error);
  assert.equal((under as WorkforceError).code, 'unavailable');
  assert.equal(reachable(under), false, 'rejected at once, not after the timeout');
});

test('a sent call whose channel closes later is not marked unsent (its effect is unknown) and says it runs on there', async () => {
  const fake = fakeChannel();
  const peer = new RpcPeer(fake.channel, () => undefined);
  const pending = peer.call('agents.deliver', { title: 'x' }).catch((error: unknown) => error);
  assert.equal(fake.sent.length, 1, 'the request left this PC');
  fake.drop();
  const error = await pending;
  assert.equal((error as WorkforceError).code, 'unavailable');
  assert.notEqual(reachable(error), false);
  assert.equal((error as WorkforceError).message, LINK_DROPPED);
});

test('B-080: after the link closes, a running handler goes on to its end (its answer is dropped); a cancel frame still aborts one', async () => {
  const fake = fakeChannel();
  const signals: AbortSignal[] = [];
  const finish: Array<(value: unknown) => void> = [];
  const peer = new RpcPeer(fake.channel, () => (_params, _from, signal) => { signals.push(signal); return new Promise((resolve) => { finish.push(resolve); }); });
  fake.deliver({ id: 1, method: 'tools.call', params: {} });
  fake.deliver({ id: 2, method: 'tools.call', params: {} });
  await tick();
  assert.equal(signals.length, 2);
  fake.deliver({ cancel: 2 });
  assert.equal(signals[1].aborted, true, 'the caller\'s stop aborts it');
  fake.drop();
  assert.equal(signals[0].aborted, false, 'the link\'s end is no stop: the work runs on');
  finish[0]('done');
  finish[1]('stopped');
  await tick();
  assert.deepEqual(fake.sent, [], 'the answers are dropped: the link is gone');
  assert.equal(peer.idle(), true, 'both handlers ended');
});

test('B-080: stop() – this PC removes that PC or quits – aborts every handler running here for it, then closes the channel', async () => {
  const fake = fakeChannel();
  const signals: AbortSignal[] = [];
  const peer = new RpcPeer(fake.channel, () => (_params, _from, signal) => {
    signals.push(signal);
    return new Promise((resolve) => { signal.addEventListener('abort', () => resolve('stopped'), { once: true }); });
  });
  fake.deliver({ id: 1, method: 'tools.call', params: {} });
  fake.deliver({ id: 2, method: 'tools.call', params: {} });
  await tick();
  peer.stop();
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
  assert.deepEqual(fake.closes, [true], 'the channel is closed after the aborts');
  await tick();
  assert.equal(peer.idle(), true, 'both handlers ended');
  assert.deepEqual(fake.sent, [], 'their answers are dropped with the link');
});

const signer = (deviceId: string) => {
  const keys = generateEd25519();
  return { deviceId, publicKey: rawPublic(keys.publicKey), sign: (data: Uint8Array) => signEd25519(keys.privateKey, data) };
};

/** Both ends of a real encrypted channel; `frames`: the encrypted frames the dialing end put on the wire. */
async function securePair() {
  const [a, b] = socketPair();
  const frames: Buffer[] = [];
  const wire: SocketLike = { ...a, send: (data) => { if (Buffer.isBuffer(data)) frames.push(data); a.send(data); } };
  const client = signer('dev_client00000');
  const server = signer('dev_server00000');
  const accepted = acceptSecure(b, server, () => client.deviceId);
  const dialed = await connectSecure(wire, client, fingerprintOf(server.publicKey));
  return { dialed, accepted: await accepted, frames };
}

test('B-087: a message too large for the link is refused before its counter is used – nothing on the wire, the next goes out as counter 0', async () => {
  const { dialed, accepted, frames } = await securePair();
  let error: unknown;
  try { dialed.send({ big: 'x'.repeat(8 * 1024 * 1024) }); } catch (caught) { error = caught; }
  assert.equal((error as WorkforceError | undefined)?.code, 'bad_request');
  assert.match((error as Error).message, /^Too large for the link between PCs: 8\.0 MB \(at most 8 MB per message\)\.$/);
  assert.equal(reachable(error), false, 'nothing left this PC');
  assert.equal(frames.length, 0);
  const got: unknown[] = [];
  accepted.onMessage((message) => got.push(message));
  dialed.send({ n: 1 });
  await tick();
  assert.equal(frames[0].readBigUInt64BE(0), 0n, 'the refused message used no nonce');
  assert.deepEqual(got, [{ n: 1 }]);
  assert.equal(dialed.closed || accepted.closed, false, 'the link stays');
});

test('B-087: an answer too large for the link comes back as an error naming it (the call ran there); the link and its other calls stay', async () => {
  const { dialed, accepted } = await securePair();
  const caller = new RpcPeer(dialed, () => undefined);
  new RpcPeer(accepted, (method) => (method === 'shot' ? async () => 'x'.repeat(9 * 1024 * 1024) : async () => ({ ok: true })));
  const error = await caller.call('shot', null, { timeoutMs: 5_000 }).catch((caught: unknown) => caught);
  assert.equal((error as WorkforceError).code, 'bad_request', String(error));
  assert.match((error as Error).message, /^The call ran on that PC, but its answer did not come back\. Too large for the link between PCs: 9\.0 MB/);
  assert.equal(dialed.closed || accepted.closed, false, 'the link stays');
  assert.deepEqual(await caller.call('other', null, { timeoutMs: 5_000 }), { ok: true });

  const request = await caller.call('other', 'x'.repeat(9 * 1024 * 1024), { timeoutMs: 5_000 }).catch((caught: unknown) => caught);
  assert.equal((request as WorkforceError).code, 'bad_request', 'a request that large says so, not "offline"');
  assert.equal(reachable(request), false, 'it never left this PC');
  assert.equal(caller.idle(), true);
});
