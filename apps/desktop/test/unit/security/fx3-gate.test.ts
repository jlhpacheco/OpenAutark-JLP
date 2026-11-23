// FX3 of the Sicher-Runde (19.11.2026, REVIEW-2 1–6, 8, 10/11/13): the secrets.export tool leaves card data out in Secure
// mode and its file – the default one in Downloads too – needs `write`; devices.connect is closed in Secure mode; a file
// method keeps its path with `device` and the linked PC gates its own files.path for the caller; a linked PC older than
// GATES_FORWARDED_FROM gets its tool calls gated here; the links that mint a person session, computer.preview,
// chats.export {dir}, spaces.save, bridges.connectTelegram and an approval request's to-do map as decided.
// Owns: these assertions only. Never: a real linked PC, a real vault on disk outside a temp home, or Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { exportSecrets, exportTarget } from '../../../src/runtime/secrets/export.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { connectText, gateToolCall, needsOf, peerGates } from '../../../src/runtime/security/tool-gate.ts';
import { methodNeed } from '../../../src/runtime/security/rpc-map.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { RemotePaths } from '../../../src/runtime/devices/sync/paths.ts';
import { onDevice, PATH_OPS } from '../../../src/runtime/rpc/handlers/files-path.ts';
import { mayAdmit } from '../../../src/runtime/people/join.ts';
import type { GateRequest } from '../../../src/runtime/security/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { agent } from '../chat/harness.ts';
import { link, makePc, Net } from '../devices/sync-net.ts';

const AGENT: ClientScope = { kind: 'owner', agentId: 'ag_tom' };
const WINDOW: ClientScope = { kind: 'owner', person: true };
const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};

/** A security service stand-in: its mode, and what the gate was asked (`verdict` for each). */
function fakeSecurity(mode: 'trust' | 'secure', verdict: 'open' | 'ask' = 'open') {
  const gated: GateRequest[] = [];
  const security = {
    current: () => ({ mode }),
    check: () => verdict,
    gate: async (req: GateRequest) => { gated.push(req); return verdict === 'open' ? { ok: true as const } : { ok: false as const, text: `closed: ${req.capability}` }; },
  };
  return { security, gated };
}

const withHome = async <T>(run: (home: string) => Promise<T>): Promise<T> => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-fx3-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await run(home); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  }
};

async function vaultWithCard() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(Date.UTC(2026, 10, 19, 12));
  const vault = new SecretVault({ db, host, clock });
  await vault.save({ label: 'Deploy key', kind: 'api_key', value: 'sk-fx3-key', route: 'servers' });
  await vault.saveGroup({ label: 'Company Visa', kind: 'card', fields: [{ field: 'number', kind: 'card', value: '4111111111111111' }, { field: 'cvc', kind: 'card', value: '987' }] });
  await vault.save({ label: 'Shop PIN', kind: 'password', value: 'pin-4711', route: 'payment' });
  return { db, clock, vault, services: { db, host, clock, secrets: vault } as unknown as RuntimeServices };
}

test('REVIEW-2 1: an agent\'s secrets.export in Secure mode leaves every payment entry out and says so; Trust and the person keep them', async () => {
  const t = await vaultWithCard();
  await withHome(async () => {
    const without = await exportSecrets(t.services, { withoutPayment: true });
    const text = readFileSync(without.file, 'utf8');
    assert.equal(without.payment, 2, 'the card and the payment route\'s entry');
    assert.ok(text.includes('sk-fx3-key') && !text.includes('4111111111111111') && !text.includes('pin-4711'));
    const all = await exportSecrets(t.services);
    assert.ok(readFileSync(all.file, 'utf8').includes('4111111111111111'), 'the person\'s own export (Settings › Secrets) keeps them');

    const tool = secretTools.find((one) => one.name === 'secrets.export')!;
    const ctx = (mode: 'trust' | 'secure', id = 'ag_tom') => ({
      agent: { id }, services: { ...t.services, security: fakeSecurity(mode).security, settings: { get: () => ({ profile: { name: 'Mia' } }) } },
    }) as unknown as ToolContext;
    const secure = await tool.run({}, ctx('secure')) as ToolOutput;
    const result = secure.structured as { payment?: number; note: string; file: string };
    assert.equal(result.payment, 2);
    assert.match(result.note, /2 payment entries \(cards, the payment route\) stayed out: spending money is closed on this PC \(Secure mode\).*Mia exports those in Settings › Secrets/);
    assert.ok(!readFileSync(result.file, 'utf8').includes('987'));
    const trust = await tool.run({}, ctx('trust')) as ToolOutput;
    assert.equal((trust.structured as { payment?: number }).payment, undefined, 'Trust AI mode: as before');
  });
});

test('REVIEW-2 1: secrets.export needs write for the file it writes – the default one in Downloads too', () => {
  const tool = { name: 'secrets.export', category: 'secret' } as const;
  const action = { summary: 'Export', external: false };
  const downloads = path.join(os.homedir(), 'Downloads', 'autark-secrets.csv');
  assert.deepEqual(needsOf(tool, {}, action, { agentId: 'ag_tom' }), [{ capability: 'accounts' }, { capability: 'write', path: downloads }]);
  const data = path.resolve('fx3-data');
  assert.deepEqual(needsOf(tool, { path: path.join(data, 'x.csv') }, action, { agentId: 'ag_tom', data })[1], { capability: 'write', path: downloads }, 'a file inside the data folder goes to the default');
  const mine = path.resolve('fx3-out', 'mine.csv');
  assert.deepEqual(needsOf(tool, { path: mine }, action, { agentId: 'ag_tom', data }).slice(1), [{ capability: 'write', path: mine }], 'one write need, the file itself');
  assert.equal(exportTarget(undefined, data, 'D:\\Downloads'), path.join('D:\\Downloads', 'autark-secrets.csv'));
});

test('REVIEW-2 2: devices.connect is closed in Secure mode with my text; in Trust AI mode it passes the gate as before', async () => {
  const tool = { name: 'devices.connect', category: 'device' } as unknown as ToolDef;
  const ctx = (security: unknown) => ({ agent: { id: 'ag_tom', name: 'Tom' }, runId: 'run_1', services: { security, settings: { get: () => ({ profile: { name: 'Mia' } }) }, paths: { data: path.resolve('fx3-data') }, secrets: { list: () => [] } } }) as unknown as ToolContext;
  const secure = fakeSecurity('secure');
  const refused = await gateToolCall(secure.security as never, tool, { target: '123456789' }, { summary: 'Ask PC 123456789 to link', external: true }, ctx(secure.security));
  assert.equal(refused, connectText('Mia'));
  assert.match(refused!, /full copy of this company.*Settings › Devices › Connect a PC/);
  assert.equal(secure.gated.length, 0, 'no request: no answer opens it');
  const trust = fakeSecurity('trust');
  assert.equal(await gateToolCall(trust.security as never, tool, { target: '123456789' }, { summary: 'x', external: true }, ctx(trust.security)), undefined);
  assert.deepEqual(trust.gated.map((one) => one.capability), ['setup']);
});

test('REVIEW-2 3/6/8/13: file methods keep their path with device; computer.preview, chats.export {dir}, spaces.save, bridges.connectTelegram', () => {
  assert.deepEqual(methodNeed('files.readPath', { device: 'dev_tower', path: 'C:\\Users\\m\\secret.docx' }), { kind: 'switch', capability: 'read', path: 'C:\\Users\\m\\secret.docx' });
  assert.deepEqual(methodNeed('files.writePath', { device: 'dev_tower', path: 'C:\\x\\SYSTEM.md', text: '' }), { kind: 'switch', capability: 'write', path: 'C:\\x\\SYSTEM.md' });
  assert.deepEqual(methodNeed('computer.preview', { device: 'dev_tower' }), { kind: 'switch', capability: 'computer' });
  assert.deepEqual(methodNeed('chats.export', { conversationIds: ['c'], dir: 'C:\\anywhere' }), { kind: 'switch', capability: 'write', path: 'C:\\anywhere' });
  assert.deepEqual(methodNeed('chats.export', { conversationIds: ['c'] }), { kind: 'open' }, 'without dir: the company\'s own exports folder');
  assert.deepEqual(methodNeed('spaces.save', {}), { kind: 'switch', capability: 'team' });
  assert.deepEqual(methodNeed('bridges.connectTelegram', {}), { kind: 'switch', capability: 'accounts' });
});

test('REVIEW-2 5/11: links that mint a person session are the person\'s in every mode; an approval to-do ends only with the person\'s answer', async () => {
  const ran: string[] = [];
  const services = {
    settings: { get: () => ({ profile: { name: 'Mia' } }) },
    security: fakeSecurity('trust').security,
    db: { get: (_sql: string, args: unknown[]) => (args[0] === 'tk_apr' ? { client_id: 'apr:req_1' } : { client_id: null }) },
  } as unknown as RuntimeServices;
  const table = new HandlerTable();
  for (const method of ['pwa.link', 'phone.pairLink', 'people.invite', 'tasks.finish', 'tasks.delete', 'tasks.update', 'todos.decline', 'tasks.get']) table.add(method as never, (() => { ran.push(method); return { ok: true }; }) as never, 'owner');
  const call = (method: string, params: unknown, scope: ClientScope) => Promise.resolve(table.get(method)!.handler(params as never, {
    scope, services, extras: {} as HandlerContext['extras'], topics: new Set(), signal: new AbortController().signal,
  }));
  for (const method of ['pwa.link', 'phone.pairLink', 'people.invite']) await assert.rejects(call(method, {}, AGENT), /Settings › Devices › Add a device/, `${method} in Trust AI mode`);
  for (const method of ['tasks.finish', 'tasks.delete', 'tasks.update', 'todos.decline']) await assert.rejects(call(method, { id: 'tk_apr' }, AGENT), /Mia's answer to a security request/, method);
  await call('tasks.get', { id: 'tk_apr' }, AGENT);
  await call('tasks.finish', { id: 'tk_mine' }, AGENT);
  await call('tasks.finish', { id: 'tk_apr' }, WINDOW);
  await call('pwa.link', {}, WINDOW);
  assert.deepEqual(ran, ['tasks.get', 'tasks.finish', 'tasks.finish', 'pwa.link']);
});

test('REVIEW-2 10: a person\'s join is admitted only by the person (or the runtime itself)', () => {
  assert.equal(mayAdmit(undefined), true);
  assert.equal(mayAdmit(WINDOW), true);
  assert.equal(mayAdmit(AGENT), false, 'an agent\'s wf');
  assert.equal(mayAdmit({ kind: 'owner' }), false, 'a runtime.json token');
  assert.equal(mayAdmit({ kind: 'device', deviceId: 'd', capabilities: ['todo', 'settings'], secure: true }), false, 'a phone, as before');
});

test('REVIEW-2 4: a linked PC older than GATES_FORWARDED_FROM (or of unknown version) gets its calls gated here first', async () => {
  assert.equal(peerGates(undefined), false);
  assert.equal(peerGates('0.3.12'), false);
  assert.equal(peerGates('0.2.0'), false);
  assert.equal(peerGates('0.3.14'), false, '0.3.14 shipped without the receiving gate');
  assert.equal(peerGates('0.3.15'), true);
  assert.equal(peerGates('0.3.15-local.1'), true, 'its pre-releases are this round');
  assert.equal(peerGates('0.4.0'), true);

  const version = { now: '0.3.12' };
  const forwarded: string[] = [];
  const { security, gated } = fakeSecurity('secure', 'ask');
  const services = {
    devices: {
      self: () => ({ id: 'dev_self' }), online: () => true,
      list: () => [{ id: 'dev_self', name: 'Laptop', kind: 'pc', self: true, caps: {} }, { id: 'dev_tower', name: 'Tower', kind: 'pc', status: 'online', self: false, caps: { version: version.now } }],
      call: async (deviceId: string) => { forwarded.push(deviceId); return { content: [{ type: 'text', text: 'written' }] }; },
    },
    modes: { get: () => ({ key: 'general', tools: ['*'] }) }, runs: { item: () => ({ id: 'ri' }), updateItem: () => undefined }, db: { get: () => undefined },
    secrets: { redact: (text: string) => text, list: () => [] }, org: { list: () => [], get: () => undefined }, security, settings: { get: () => ({ profile: { name: 'Mia' } }) },
    paths: { data: path.resolve('fx3-data'), workspace: path.resolve('fx3-ws') }, log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  const write: ToolDef = {
    name: 'files.write', category: 'write_local', remote: true, description: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (args) => ({ summary: `Write ${String((args as { path: string }).path)}`, external: false }),
    run: async () => ({ content: [{ type: 'text', text: 'here' }] }),
  };
  registry.register(write);
  const base = { agent: agent('ag_1', 'Mira'), runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => {} };
  const old = await registry.call('files.write', { path: 'C:\\Users\\m\\x.txt', device: 'dev_tower' }, base, 'call_1');
  assert.equal(old.isError, true);
  assert.deepEqual(gated.map((one) => [one.capability, one.path]), [['write', 'C:\\Users\\m\\x.txt']], 'gated here for the old PC');
  assert.deepEqual(forwarded, [], 'nothing went to it');
  version.now = '0.3.15';
  await registry.call('files.write', { path: 'C:\\Users\\m\\x.txt', device: 'dev_tower' }, base, 'call_2');
  assert.deepEqual(forwarded, ['dev_tower'], 'a PC that gates itself decides there');
  assert.equal(gated.length, 1);
});

test('REVIEW-2 3: the linked PC gates files.path for the calling agent with its own settings; the person passes; an unnamed call only when open', async (t) => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-fx3-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { security, gated } = fakeSecurity('secure', 'ask');
  a.h.services.security = security as never;
  for (const pc of [a, b]) {
    const paths = new RemotePaths(pc.h.services, pc.sync, PATH_OPS);
    pc.handlers.set('files.path', (params, from) => paths.serve(params, from));
  }
  b.repo.patch(a.id, { caps: { version: '0.3.15' } });
  const note = path.join(dir, 'secret.md');
  writeFileSync(note, 'on A');
  const ctx = (scope: ClientScope) => ({ scope, services: b.h.services }) as unknown as HandlerContext;
  await assert.rejects(onDevice(ctx(AGENT), { path: note, device: a.id }, 'read', PATH_OPS.read), /closed: read/);
  await assert.rejects(onDevice(ctx(AGENT), { path: note, text: 'x', device: a.id }, 'write', PATH_OPS.write), /closed: write/);
  assert.deepEqual(gated.map((one) => [one.agentId, one.capability, one.path]), [['ag_tom', 'read', note], ['ag_tom', 'write', note]]);
  assert.match(gated[0].summary, /^Read .*secret\.md \(from dev_b\)$/);
  assert.equal(readFileSync(note, 'utf8'), 'on A', 'nothing was written');
  await assert.rejects(onDevice(ctx({ kind: 'owner' }), { path: note, device: a.id }, 'read', PATH_OPS.read), /names no agent/);
  const read = await onDevice(ctx(WINDOW), { path: note, device: a.id }, 'read', PATH_OPS.read) as { text: string };
  assert.equal(read.text, 'on A', 'the person\'s own tab reads as before');
  b.repo.patch(a.id, { caps: { version: '0.3.12' } });
  const frames = net.calls.length;
  await assert.rejects(onDevice(ctx(AGENT), { path: note, device: a.id }, 'read', PATH_OPS.read), /names no agent/, 'an old PC gets no caller: unnamed there');
  assert.equal((net.calls[frames]?.params as { by?: unknown }).by, undefined, 'and no unknown key it would refuse');
});
