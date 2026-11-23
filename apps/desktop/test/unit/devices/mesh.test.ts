// The device mesh that keeps linked PCs connected (devices/mesh.ts): a PC the connect flow proved is
// stored with `add` and dialed; every PC is home of its own data, linked PCs are peers; an employee's
// PC reaches only the open methods; current addresses and caps travel over the link. The rig is mesh-nodes.ts (in-process
// socket pairs, manual backoff timers). B-080: 'peer link closed' carries the close code (4008: cut for silence); removing a PC or
// quitting aborts the handlers running here for it (RpcPeer.stop), a dropped link does not; a call can bound its answer's wait.
// B-087: a trigger (resume, unlock, online) leaves a live link to the keepalive; the other B-087 cases are in mesh-b087.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { EVERY_LINK } from '../../../src/runtime/devices/mesh.ts';
import { markSilent, SILENT_CLOSE, wrapWs, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { socketPair } from './socket-pair.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import type { Logger, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ManualClock, fakeHost, memoryDb, silentLog } from './fakes.ts';
import { idOf, linkedBoth, linkedPair, makeNode, settle, statusOf, waiting, type Node } from './mesh-nodes.ts';

test('identity: private key is stored encrypted, reloads to the same device, and every PC is home', async () => {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const first = await DeviceIdentity.load({ db, host, clock, name: 'Desk' });
  const stored = new KvRepo(db).get<{ privateCipher: string }>('device', 'identity')!;
  assert.ok(Buffer.from(stored.privateCipher, 'base64').toString().startsWith('enc:'));
  const again = await DeviceIdentity.load({ db, host, clock });
  assert.equal(again.deviceId, first.deviceId);
  assert.equal(again.fingerprint, first.fingerprint);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(new DevicesRepo(db).get(first.deviceId)?.role, 'home');
});

test('mesh: encrypted JSON-RPC call between paired devices, unknown device rejected', async () => {
  const { a, b } = await linkedPair();
  a.mesh.register('echo', async (params, from) => ({ params, from }));
  const result = (await b.mesh.call(a.identity.deviceId, 'echo', { x: 1 })) as { params: unknown; from: string };
  assert.deepEqual(result.params, { x: 1 });
  assert.equal(result.from, b.identity.deviceId);
  await assert.rejects(b.mesh.call(a.identity.deviceId, 'nope', {}), /Unknown peer method/);

  // A stranger with no pairing record cannot connect.
  const c = await makeNode('Stranger', 'http://10.0.0.3:47811');
  const [mine, theirs] = socketPair();
  const accepted = a.mesh.accept(theirs);
  const { connectSecure } = await import('../../../src/runtime/devices/channel.ts');
  const signer = { deviceId: c.identity.deviceId, publicKey: c.identity.publicKey, sign: (d: Uint8Array) => c.identity.sign(d) };
  await assert.rejects(connectSecure(mine, signer, a.identity.fingerprint));
  await assert.rejects(accepted, /Unknown device/);
});

test('after pairing both PCs are online without any call, and nothing stays scheduled', async () => {
  const { a, b } = await linkedPair();
  assert.ok(linkedBoth(a, b));
  assert.equal(statusOf(a, b), 'online');
  assert.equal(statusOf(b, a), 'online');
  assert.equal(a.timers.count() + b.timers.count(), 0, 'the inviter\'s fallback retry ended with the joiner\'s link');
  const seen = b.events.filter((entry) => entry.event === 'device.upserted' && (entry.data as { id: string }).id === idOf(a)).map((entry) => (entry.data as { status: string }).status);
  // F25 (16.11.2026): the PC's caps (its app version) arrive right after and announce the row once more, still 'online'.
  assert.deepEqual(seen.filter((status, i) => status !== seen[i - 1]).slice(-2), ['connecting', 'online']);
});

test('a dropped link: only the lower id retries, once, with backoff – then it reconnects', async () => {
  const { low, high } = await linkedPair();
  (await low.mesh.connect(idOf(high))).channel.close();
  await settle();
  assert.equal(linkedBoth(low, high), false);
  assert.equal(statusOf(high, low), 'offline');
  assert.equal(low.timers.count(), 1, 'exactly one retry on the lower id');
  assert.equal(high.timers.count(), 0, 'the higher id waits (no polling)');
  assert.equal(low.timers.delays.at(-1), 1_000);

  high.down = true;
  low.timers.fire();
  await settle();
  assert.equal(statusOf(low, high), 'offline');
  assert.equal(low.timers.count(), 1);
  assert.equal(low.timers.delays.at(-1), 2_000, 'the next step backs off');

  // B-077: the backoff stops growing at 30 s – a PC that is back is linked within about 30 s, never after minutes.
  for (let i = 0; i < 8; i++) { low.timers.fire(); await settle(); }
  assert.equal(low.timers.delays.at(-1), 30_000);
  assert.ok(low.timers.delays.every((ms) => ms <= 30_000), low.timers.delays.join());

  high.down = false;
  low.timers.fire();
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.equal(low.timers.count() + high.timers.count(), 0);
});

test('B-077: network errors and code-less tunnel closes are retryable; only 4003 is refusal', async () => {
  const { openChannel } = await import('../../../src/runtime/devices/reach.ts');
  const signer = (await makeNode('Solo', 'http://10.9.9.9:1')).identity;
  // The other end closes right after our hello, before any answer – with this code.
  const closing = (code?: number) => async (): Promise<SocketLike> => {
    const listeners: Array<(code?: number) => void> = [];
    return {
      send: () => { queueMicrotask(() => listeners.forEach((listener) => listener(code))); },
      close: () => {},
      onMessage: () => {},
      onClose: (listener) => { listeners.push(listener); },
    };
  };
  const sign = { deviceId: signer.deviceId, publicKey: signer.publicKey, sign: (data: Uint8Array) => signer.sign(data) };
  for (const [code, refused] of [[1006, false], [4000, false], [4003, true], [undefined, false]] as const) {
    const result = await openChannel([closing(code)], sign, 'fp');
    assert.ok('refused' in result);
    assert.equal(result.refused, refused, `close code ${code}`);
  }
});

test('revoke stops: the revoking PC never retries, the revoked one is refused', async () => {
  const { low, high } = await linkedPair();
  low.mesh.revoke(idOf(high));
  await settle();
  assert.equal(low.timers.count() + high.timers.count(), 0);
  assert.ok(low.mesh.list().every((item) => item.id !== idOf(high))); // revoked devices are hidden
  low.mesh.reconnect(); // a resume on the revoking PC does not dial it again
  await assert.rejects(high.mesh.call(idOf(low), 'ping', {}), /Laptop is not reachable|Tower is not reachable/);
  await settle();
  assert.equal(linkedBoth(low, high), false);

  const other = await linkedPair();
  other.high.mesh.revoke(idOf(other.low));
  await settle();
  assert.equal(other.high.timers.count(), 0);
  assert.equal(other.low.timers.count(), 1, 'the lower id cannot know yet: one retry after the close');
  other.low.timers.fire(); // the handshake is refused
  await settle();
  assert.equal(linkedBoth(other.low, other.high), false);
  assert.equal(statusOf(other.low, other.high), 'offline');
  assert.equal(other.low.timers.count(), 0, 'a refusal ends the backoff: no polling of a PC that unlinked this one');
  other.low.mesh.reconnect(); // a trigger still dials once
  await settle();
  assert.equal(other.low.timers.count(), 0);
});

test('start and resume dial at once: no waiting for the other side\'s backoff', async () => {
  const { low, high } = await linkedPair({ connectOnPair: false });
  assert.equal(statusOf(high, low), 'connecting', 'paired but never dialed is not offline');
  high.mesh.start(); // the higher id dials at start too
  await settle();
  assert.ok(linkedBoth(low, high));

  (await high.mesh.connect(idOf(low))).channel.close();
  await settle();
  assert.equal(low.timers.count(), 1);
  high.mesh.reconnect(); // host power 'resume' / 'unlock' (main.ts)
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.equal(low.timers.count(), 0, 'the pending retry ended with the new link');
});

test('B-087 a trigger leaves a live link to the keepalive: a stalled PC keeps its link and its calls; a link that died while this PC slept is redialed once the keepalive cuts it', async () => {
  const { low, high } = await linkedPair({ connectOnPair: false });
  low.mesh.start(); // the lower id holds the dialing end
  await settle();
  const before = await low.mesh.connect(idOf(high));
  const work = waiting(high, 'work.long');
  const answer = low.mesh.call(idOf(high), 'work.long', null); // a long remote call in flight
  await settle();
  high.mesh.register('ping', () => new Promise(() => {}), EVERY_LINK); // the other PC stalls: no ping answer for now
  low.mesh.reconnect(); // host unlock / resume / online
  await settle();
  assert.equal(low.timers.count(), 0, 'no ping timer that could cut the link');
  assert.equal(await low.mesh.connect(idOf(high)), before);
  work.finish();
  assert.deepEqual(await answer, { ok: true }, 'the call in flight gets its answer');

  low.cut!(); // the other PC's keepalive ended it while this one slept
  await settle();
  assert.equal(statusOf(high, low), 'offline');
  assert.equal(statusOf(low, high), 'online', 'the dialing side has not noticed');
  assert.equal(high.timers.count(), 0, 'the higher id does not retry');
  low.mesh.reconnect(); // host resume: the link still looks live
  await settle();
  assert.equal(low.timers.count(), 0);
  // keepalive.test.ts: the late tick after the wake pings, the next on-time tick cuts a link without any frame (4008)
  low.silence!();
  await settle();
  assert.equal(low.timers.count(), 1, 'the smaller id retries');
  low.timers.fire();
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.notEqual(await low.mesh.connect(idOf(high)), before);
  assert.equal(low.timers.count() + high.timers.count(), 0);
});

test('both sides dialing at once end with one working link', async () => {
  const { low, high } = await linkedPair({ connectOnPair: false });
  await Promise.all([low.mesh.connect(idOf(high)), high.mesh.connect(idOf(low))]);
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.deepEqual(await high.mesh.call(idOf(low), 'ping', {}).then((reply) => (reply as { ok: boolean }).ok), true);
  assert.deepEqual(await low.mesh.call(idOf(high), 'ping', {}).then((reply) => (reply as { ok: boolean }).ok), true);
  assert.equal(low.timers.count() + high.timers.count(), 0);
});

function registryOn(node: Node): Registry {
  const services = {
    devices: node.mesh,
    modes: { get: () => { throw new Error('no modes in this test'); } },
    permissions: { check: async () => ({ effect: 'allow' }) },
    runs: { item: () => ({ id: 'ri_1' }), updateItem: () => undefined },
    db: { get: () => undefined },
    secrets: { redact: (text: string) => text },
    files: { put: async () => ({ id: 'file_1' }) },
    log: silentLog,
  } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  const peek: ToolDef = {
    name: 'screen.peek', description: 'peek', inputSchema: { type: 'object' }, category: 'read', remote: true,
    describe: () => ({ summary: 'Peek at the screen', reversible: true, external: true }),
    run: async () => { throw new Error('must run on the linked PC'); },
  };
  registry.register(peek);
  return registry;
}

test('registry: a call to a paired PC without a live link dials it; an unreachable PC is a plain failure', async () => {
  const { a, b } = await linkedPair({ connectOnPair: false });
  assert.equal(b.mesh.online(idOf(a)), false);
  a.mesh.register('tools.call', async (params) => ({ content: [{ type: 'text', text: `ran ${(params as { name: string }).name}` }] }));
  const registry = registryOn(b);
  const ctx = { agent: { id: 'ag_1', name: 'Ada' } as Agent, runId: 'run_1', mode: 'computer', deviceId: idOf(a), signal: new AbortController().signal, status: () => undefined };
  const out = await registry.call('screen.peek', {}, ctx, 'call_1');
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.content, [{ type: 'text', text: 'ran screen.peek' }]);
  assert.ok(b.mesh.online(idOf(a)));

  (await b.mesh.connect(idOf(a))).channel.close();
  a.down = true;
  await settle();
  const failed = await registry.call('screen.peek', {}, ctx, 'call_2');
  assert.equal(failed.isError, true);
  assert.match((failed.content[0] as { text: string }).text, /^Laptop is not reachable \(last seen just now\)\.$/);
  assert.equal(failed.effect, undefined, 'nothing was sent: no unknown effect');
});

test('a call stopped while dialing returns at once and never reaches the linked PC', async () => {
  const { a, b } = await linkedPair({ connectOnPair: false });
  let ran = 0;
  a.mesh.register('tools.call', async () => { ran++; return { content: [{ type: 'text', text: 'clicked' }] }; });
  let release!: () => void;
  b.hold = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const ctx = { agent: { id: 'ag_1', name: 'Ada' } as Agent, runId: 'run_1', mode: 'computer', deviceId: idOf(a), signal: controller.signal, status: () => undefined };
  const pending = registryOn(b).call('screen.peek', {}, ctx, 'call_1');
  await settle();
  assert.equal(statusOf(b, a), 'connecting');
  controller.abort(); // Stop, while the dial still waits
  const out = await Promise.race([pending, settle().then(() => undefined)]);
  assert.ok(out, 'the stopped call returns without waiting for the dial');
  assert.equal(out.isError, true);
  assert.equal((out.content[0] as { text: string }).text, 'Cancelled.');
  assert.equal(out.effect, undefined, 'nothing was sent: no unknown effect');
  await assert.rejects(b.mesh.call(idOf(a), 'tools.call', {}, controller.signal), /Cancelled/);
  release();
  await settle();
  assert.ok(linkedBoth(a, b), 'the dial finished in the background');
  assert.equal(ran, 0, 'the tool never ran on the linked PC');
});

test('an employee\'s PC reaches only the open methods here; the CEO\'s own PC reaches everything', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'per_anna' });
  a.mesh.register('tools.call', async () => ({ ok: true }));
  b.mesh.register('tools.call', async () => ({ ok: true }));
  assert.equal(a.mesh.list().find((device) => device.id === idOf(b))?.personId, 'per_anna');
  await assert.rejects(b.mesh.call(idOf(a), 'tools.call', {}), /employee/);
  assert.deepEqual(await a.mesh.call(idOf(b), 'tools.call', {}), { ok: true }, 'the CEO\'s PC runs tools on the employee\'s PC');
  assert.equal(((await b.mesh.call(idOf(a), 'ping', null)) as { ok: boolean }).ok, true, 'ping stays open');
});

test('B-078 the one registration hook: a module opens its method to the link kinds it names (e.g. calendar.ask); default stays closed to employees', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'per_anna' });
  a.mesh.register('calendar.ask', async (_params, from) => ({ from }), EVERY_LINK);
  a.mesh.register('only.mine', async () => ({ ok: true }), ['ceo']);
  b.mesh.register('only.mine', async () => ({ ok: true }), ['ceo']);
  assert.deepEqual(await b.mesh.call(idOf(a), 'calendar.ask', {}), { from: idOf(b) }, 'the employee\'s PC reaches an open method');
  await assert.rejects(b.mesh.call(idOf(a), 'only.mine', {}), /employee's PC does not run/);
  new DevicesRepo(b.db).patch(idOf(a), { joinedAs: 'employee' }); // the Tower joined the Laptop's company as an employee
  await assert.rejects(a.mesh.call(idOf(b), 'only.mine', {}), /This link does not run that method/, 'a method for my own PCs only: not for an employer either');
});

test('addresses travel over the link: a new own address reaches the online PC', async () => {
  const { a, b } = await linkedPair();
  a.mesh.updateSelf({ addresses: ['http://192.168.7.7:47811'] });
  await settle();
  assert.equal(b.mesh.list().find((device) => device.id === idOf(a))?.addresses[0], 'http://192.168.7.7:47811');
});

test('KI-Runde 17.11.2026: new caps travel the same way – a phone that attaches to one PC shows on the other', async () => {
  const { a, b } = await linkedPair();
  const seen = () => b.mesh.list().find((device) => device.id === idOf(a))?.caps;
  a.mesh.updateSelf({ caps: { appPhones: ['dev_phone'], os: 'win32' } });
  await settle();
  assert.deepEqual(seen()?.appPhones, ['dev_phone'], 'without a new address, the caps alone go out');
  a.mesh.updateSelf({ caps: { appPhones: [] } });
  await settle();
  assert.deepEqual(seen()?.appPhones, [], 'the phone left that PC: the empty list replaces it');
  assert.equal(seen()?.os, 'win32', 'the rest of its caps stand');
});

test('one key, one device: a new id with the key of a linked PC, or of this PC itself, is refused', async () => {
  const { a, b } = await linkedPair();
  const theirs = { ...b.mesh.selfInfo(), id: 'dev_impostor0001', name: 'Impostor' };
  assert.throws(() => a.mesh.add(theirs, { side: 'joiner', personId: 'per_y' }), /already belongs to another device/);
  const mine = { ...a.mesh.selfInfo(), id: 'dev_impostor0002', name: 'Me again' };
  assert.throws(() => b.mesh.add(mine, { side: 'joiner' }), /already belongs to another device/, 'b knows a by that key');
  assert.equal(new DevicesRepo(a.db).get('dev_impostor0001'), undefined, 'nothing stored');
});

test('B-080: a closed link is logged with its close code; a socket the keepalive cut for silence says 4008', async () => {
  const lines: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const log: Logger = { ...silentLog, info: (message: string, data?: Record<string, unknown>) => { lines.push({ message, data }); } };
  const { a, b } = await linkedPair({ log });
  assert.ok(linkedBoth(a, b));
  (await b.mesh.connect(idOf(a))).channel.close(); // one side ends the link the normal way
  await settle();
  const closed = lines.filter((line) => line.message === 'peer link closed');
  assert.equal(closed.length, 2, 'both ends log it');
  for (const line of closed) assert.equal(line.data?.code, 1000);

  const ws = new EventEmitter();
  const codes: Array<number | undefined> = [];
  wrapWs(ws as never).onClose((code) => codes.push(code));
  markSilent(ws); // http/peer.ts and compose/peer-dial.ts do this just before the keepalive cuts it
  ws.emit('close', 1006);
  assert.deepEqual(codes, [SILENT_CLOSE]);
  assert.equal(SILENT_CLOSE, 4008);
});

test('B-080: removing a PC or quitting aborts the work this PC runs for it; a link that only dropped leaves it running', async () => {
  const revoked = await linkedPair();
  const there = waiting(revoked.a, 'work.long');
  void revoked.b.mesh.call(idOf(revoked.a), 'work.long', null).catch(() => undefined);
  await settle();
  assert.equal(there.signal?.aborted, false, 'running');
  revoked.a.mesh.revoke(idOf(revoked.b)); // the person removes Tower on the Laptop
  assert.equal(there.signal?.aborted, true, 'the work Tower started here ends with it');
  there.finish();

  const quit = await linkedPair();
  const running = waiting(quit.a, 'work.long');
  void quit.b.mesh.call(idOf(quit.a), 'work.long', null).catch(() => undefined);
  await settle();
  quit.a.mesh.close(); // the Laptop quits or updates
  assert.equal(running.signal?.aborted, true, 'a quit ends what runs here for a linked PC');
  running.finish();

  const dropped = await linkedPair();
  const goesOn = waiting(dropped.a, 'work.long');
  void dropped.b.mesh.call(idOf(dropped.a), 'work.long', null).catch(() => undefined);
  await settle();
  (await dropped.b.mesh.connect(idOf(dropped.a))).channel.close(); // the caller's end goes away
  await settle();
  assert.equal(goesOn.signal?.aborted, false, 'a dropped link is no one\'s stop');
  goesOn.finish();
});

test('B-080: a call can bound how long its answer may take once sent (devices.list\'s ping waits PROBE_MS)', async () => {
  const { a, b } = await linkedPair();
  const slow = waiting(a, 'work.slow');
  const error = await b.mesh.call(idOf(a), 'work.slow', null, undefined, 30).catch((caught: unknown) => caught);
  assert.equal((error as WorkforceError).code, 'timeout');
  assert.equal(slow.seen, true, 'it was sent');
  slow.finish();
  assert.deepEqual(await b.mesh.call(idOf(a), 'ping', null, undefined, 1_000).then((answer) => (answer as { ok: boolean }).ok), true);
});
