// Network paths (src/runtime/files/net-hosts.ts, 20.11.2026 review of FCMWO5R5): a `\\host\share\…` path reaches its
// host only after the person confirmed that host once on this PC – every path method refuses it before touching the
// file system, with the host in details.netHost; files.allowHost is the person's call only (an agent's is refused, the
// phone's counts); near-path suggestions never walk a share; a linked PC refuses an agent's network path too, and the
// asking PC checks before it forwards. Hosts in these tests are never reached: every call is refused before a stat.
// Owns: these assertions only. Never: a real network, Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { checkNetHost, confirmedHosts, confirmHost, netHostOf } from '../../../src/runtime/files/net-hosts.ts';
import { nearPaths } from '../../../src/runtime/files/near-paths.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { onDevice, PATH_OPS, register } from '../../../src/runtime/rpc/handlers/files-path.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { RemotePaths } from '../../../src/runtime/devices/sync/paths.ts';
import { OWNER, S1_MODULES, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { link, makePc, Net } from '../devices/sync-net.ts';

const SHARE = '\\\\nas\\share\\Vertrag.pdf';

test('netHostOf: the host of a network path in every spelling; this PC\'s own namespaces and drive paths are none', () => {
  for (const [target, host] of [[SHARE, 'nas'], ['//NAS/share/x', 'nas'], ['\\\\?\\UNC\\Files.local\\s\\x', 'files.local'], ['\\\\192.168.1.5\\s', '192.168.1.5'], ['\\\\wsl$\\Ubuntu\\x', 'wsl$']] as const) {
    assert.equal(netHostOf(target), host, target);
  }
  for (const target of ['C:\\a\\b.pdf', '/home/me/x', '\\\\?\\C:\\long\\path', '\\\\.\\pipe\\x', 'relative\\x']) assert.equal(netHostOf(target), undefined, target);
});

test('a host is refused with its name until confirmed, then open; the list keeps each host once', () => {
  const pc = makePc(new Net(), 'dev_here');
  const db = pc.h.db;
  assert.throws(() => checkNetHost(db, SHARE), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden' && error.details?.netHost === 'nas');
  checkNetHost(db, 'C:\\a\\b.pdf'); // not a network path: nothing asked
  checkNetHost(db, undefined);
  assert.equal(confirmHost(db, ' NAS ', 1), 'nas');
  confirmHost(db, 'nas', 2);
  assert.deepEqual(confirmedHosts(db), ['nas']);
  checkNetHost(db, SHARE);
  checkNetHost(db, '//Nas/share/other.md');
  assert.throws(() => checkNetHost(db, '\\\\other\\s\\x'), /other is another computer/);
  for (const bad of ['', 'a\\b', 'a b', '?', '.']) assert.throws(() => confirmHost(db, bad, 3), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request', bad);
});

test('near paths never walk a share', async () => {
  assert.deepEqual(await nearPaths(SHARE), []);
  assert.deepEqual(await nearPaths('//nas/share/missing/x.md'), []);
});

function rpc() {
  const table = new HandlerTable();
  for (const add of [...S1_MODULES, register]) add(table);
  const fixture = rpcFixture({ table });
  return { ...fixture, owner: new TestClient(fixture.server, OWNER) };
}

test('every path method refuses an unconfirmed host before the file system; only the person confirms one', async (t) => {
  const f = rpc();
  t.after(f.cleanup);
  for (const [method, params] of [
    ['files.readPath', { path: SHARE }], ['files.listPath', { path: '\\\\nas\\share' }], ['files.writePath', { path: SHARE, text: 'x' }],
    ['files.uploadPath', { path: SHARE }], ['files.openPath', { path: SHARE, anywhere: true }],
  ] as const) {
    const refused = await f.owner.request(method, params);
    assert.equal(refused.error?.code, 'forbidden', method);
    assert.equal(refused.error?.details?.netHost, 'nas', method);
  }
  assert.equal(f.opened.length, 0, 'nothing opened with the system');

  const agent = new TestClient(f.server, { kind: 'owner', agentId: 'ag_reader' });
  assert.equal((await agent.request('files.allowHost', { host: 'nas' })).error?.code, 'forbidden', 'an agent never confirms a host');
  const script = new TestClient(f.server, { kind: 'owner' });
  assert.equal((await script.request('files.allowHost', { host: 'nas' })).error?.code, 'forbidden', 'nor does runtime.json\'s token');
  assert.deepEqual(confirmedHosts(f.db), []);

  assert.deepEqual(await f.owner.call('files.allowHost', { host: 'NAS' }), { host: 'nas' });
  const phone = new TestClient(f.server, { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'], secure: true });
  assert.deepEqual(await phone.call('files.allowHost', { host: 'box.local' }), { host: 'box.local' }, 'the person on the phone');
  assert.deepEqual(confirmedHosts(f.db), ['nas', 'box.local']);
  assert.equal((await f.owner.request('files.allowHost', { host: 'nas', extra: 1 })).error?.code, 'bad_request');
});

test('a linked PC: the asking PC checks before forwarding, and the other PC refuses an agent\'s network path', async (t) => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const servers = new Map<string, RemotePaths>();
  for (const pc of [a, b]) {
    const paths = new RemotePaths(pc.h.services, pc.sync, PATH_OPS);
    servers.set(pc.id, paths);
    pc.handlers.set('files.path', (params, from) => paths.serve(params, from));
  }
  const ctx = { services: b.h.services } as unknown as HandlerContext;
  await assert.rejects(async () => onDevice(ctx, { path: SHARE, device: a.id }, 'read', PATH_OPS.read),(error: unknown) => error instanceof WorkforceError && error.details?.netHost === 'nas');
  assert.ok(!net.calls.some((call) => call.method === 'files.path'), 'nothing went to A');
  for (const by of [{ agentId: 'ag_x', agentName: 'X' }, {}]) {
    await assert.rejects(servers.get(a.id)!.serve({ op: 'read', path: SHARE, by }, b.id), (error: unknown) => error instanceof WorkforceError && error.details?.netHost === 'nas', JSON.stringify(by));
  }
});
