// Where the security gate sits (Sicher-Runde 19.11.2026): the registry's call path (a closed call is refused and journaled
// like any refusal, an open one runs), an agent's own `wf` session in the RPC table (security/rpc-guard.ts), the Secure-mode
// disk lock of settings.json's security section, the vault's card refusal and the computer helper's guard config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { vaultRefusal } from '../../../src/runtime/security/policy.ts';
import { withGuardConfig, type HelperClient } from '../../../src/runtime/computer/helper.ts';
import { securityDefaults } from '../../../src/shared/model/security-settings.ts';
import { securityOf } from '../../../src/shared/model/system.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { ctxFor, setup, tool, WORKSPACE } from '../tools/helpers.ts';

function secured(waitMs = 20) {
  const h = setup();
  h.settings.update({ profile: { name: 'Mia' }, security: securityDefaults('secure') } as never);
  const services = h.services as RuntimeServices;
  services.paths = { data: path.join(WORKSPACE, '..', 'gate-data'), workspace: WORKSPACE, resources: path.join(WORKSPACE, '..', 'res'), temp: path.join(WORKSPACE, '..', 'gate-data', 'tmp') } as RuntimeServices['paths'];
  services.security = new Security({ services: () => services, waitMs });
  return { ...h, services };
}

test('registry: a closed call is refused with my text and never runs; an open one runs', async () => {
  const h = secured();
  let ran = 0;
  const registry = new Registry({ services: () => h.services });
  registry.register(tool('files.read', 'read', { describe: (args) => ({ summary: `Read ${String((args as { path: string }).path)}`, external: false }), run: async () => { ran++; return { content: [{ type: 'text', text: 'ok' }] }; } }));
  const { services: _s, ...base } = ctxFor(h);
  const outside = path.join(os.homedir(), 'elsewhere-for-the-gate.pdf');
  const refused = await registry.call('files.read', { path: outside }, base, 'call_1');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].type === 'text' ? refused.content[0].text : '', /Reading files is closed on this PC, so the app asked Mia/);
  assert.equal(ran, 0);
  assert.equal(h.services.security.requests().length, 1, 'the request stays');
  const open = await registry.call('files.read', { path: path.join(WORKSPACE, 'a.md') }, base, 'call_2');
  assert.equal(open.isError, undefined);
  assert.equal(ran, 1);
});

test('registry: Trust AI mode passes everything but its switches', async () => {
  const h = secured();
  h.settings.update({ security: securityDefaults('trust') } as never);
  let ran = 0;
  const registry = new Registry({ services: () => h.services });
  registry.register(tool('shell.exec', 'write_system', { run: async () => { ran++; return { content: [] }; } }));
  const { services: _s, ...base } = ctxFor(h);
  await registry.call('shell.exec', { command: 'ls', cwd: os.homedir() }, base, 'call_1');
  assert.equal(ran, 1);
});

function agentCtx(services: RuntimeServices, agentId?: string): HandlerContext {
  // FX1: no agent here = the person's window
  return { scope: { kind: 'owner', ...(agentId ? { agentId } : { person: true as const }) }, services, extras: {} as HandlerContext['extras'], topics: new Set(), signal: new AbortController().signal };
}

test('rpc: an agent\'s wf never changes the security section, saves topics or answers; in Secure mode settings and secrets ask', async () => {
  const h = secured();
  const table = new HandlerTable();
  const calls: string[] = [];
  for (const method of ['settings.update', 'security.saveTopic', 'security.answer', 'secrets.save', 'secrets.list'] as const) {
    table.add(method, (() => { calls.push(method); return { ok: true }; }) as never, 'owner');
  }
  const run = (method: string, params: unknown, agentId?: string) => Promise.resolve(table.get(method)!.handler(params as never, agentCtx(h.services, agentId)));
  await assert.rejects(run('settings.update', { security: securityDefaults('trust') }, 'ag_tom'), /The security mode and its switches are Mia's/);
  await assert.rejects(run('security.saveTopic', { mode: 'trust', topic: 'money', text: 'x' }, 'ag_tom'), /Settings › Security/);
  await assert.rejects(run('security.answer', { id: 'apr_1', answer: 'once' }, 'ag_tom'), /Mia's own step/);
  await assert.rejects(run('settings.update', { voice: {} }, 'ag_tom'), /Autark's own setup is closed on this PC, so the app asked Mia/);
  await assert.rejects(run('secrets.save', { label: 'x' }, 'ag_tom'), /Accounts, sign-ins and passwords is closed/);
  await run('secrets.list', {}, 'ag_tom');
  await run('settings.update', { security: securityDefaults('trust') }); // the person's own session
  assert.deepEqual(calls, ['secrets.list', 'settings.update']);
  h.settings.update({ security: securityDefaults('trust') } as never);
  await run('settings.update', { voice: {} }, 'ag_tom');
  assert.deepEqual(calls.at(-1), 'settings.update', 'Trust mode: an agent changes settings as before');
});

test('settings.json: a disk edit of the security section is put back and kept as settings.rejected.json (Secure and, FX1, Trust AI mode)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sec-lock-'));
  try {
    const store = new SettingsStore({ bus: new Bus(), clock: new ManualClock(), dataDir: dir, env: { locale: 'en-US', timezone: 'UTC' } });
    store.update({ security: securityDefaults('secure') } as never);
    const file = path.join(dir, 'settings.json');
    const written = readFileSync(file, 'utf8');
    assert.match(written, /"mode": "secure"/);
    writeFileSync(file, written.replace('"mode": "secure"', '"mode": "trust"').replace('"commands": "ask"', '"commands": "yes"'));
    store.fromDisk();
    assert.equal(securityOf(store.get()).mode, 'secure');
    assert.equal(securityOf(store.get()).commands, 'ask');
    assert.match(readFileSync(file, 'utf8'), /"mode": "secure"/, 'the file says what is in force again');
    assert.ok(existsSync(path.join(dir, 'settings.rejected.json')));
    assert.match(store.notice() ?? '', /security/);
    // other sections still take a disk edit, and the person's update still changes the section
    store.update({ security: { ...securityDefaults('secure'), commands: 'yes' } } as never);
    assert.equal(securityOf(store.get()).commands, 'yes');
    // FX1 H4: in Trust AI mode too – its Ask switches and the Secure lists kept in it are the person's
    store.update({ security: securityDefaults('trust') } as never);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"mode": "trust"', '"mode": "secure"').replace('"money": "yes"', '"money": "ask"'));
    store.fromDisk();
    assert.equal(securityOf(store.get()).mode, 'trust');
    assert.match(readFileSync(file, 'utf8'), /"mode": "trust"/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('vault: in Secure mode an agent gets no card data; the person and other secrets are unchanged', async () => {
  const db = new Db(':memory:');
  migrate(db);
  let mode: 'secure' | 'trust' = 'secure';
  const host = {
    encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
    decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
  };
  const vault = new SecretVault({ db, host, clock: new ManualClock(), refuse: (entry, agentId) => vaultRefusal(securityDefaults(mode), entry, agentId, 'Mia') });
  const card = await vault.saveGroup({ label: 'Visa', kind: 'card', fields: [{ field: 'number', kind: 'card', value: '4111111111111234' }] });
  const pw = await vault.save({ label: 'Site', kind: 'password', value: 'hunter2hunter2' });
  await assert.rejects(vault.use(card.fields[0].id, 'ag_tom'), /Spending money is closed/);
  assert.equal(await vault.use(card.fields[0].id, 'human'), '4111111111111234');
  assert.equal(await vault.use(pw.id, 'ag_tom'), 'hunter2hunter2');
  mode = 'trust';
  assert.equal(await vault.use(card.fields[0].id, 'ag_tom'), '4111111111111234');
});

test('computer helper: the guard goes first when it changed or the helper (re)starts; an open guard is not sent to a fresh helper', async () => {
  const sent: Array<[string, unknown]> = [];
  let running = false;
  const inner: HelperClient = { call: async (op, args) => { running = true; sent.push([op, args]); return undefined as never; }, running: () => running, dispose: async () => {} };
  let guard = { appPids: [] as number[], apps: null as string[] | null };
  const helper = withGuardConfig(inner, () => guard);
  await helper.call('windows');
  assert.deepEqual(sent.map(([op]) => op), ['windows']);
  guard = { appPids: [7], apps: ['excel'] };
  await helper.call('click', {});
  await helper.call('click', {});
  assert.deepEqual(sent.map(([op]) => op), ['windows', 'config', 'click', 'click']);
  assert.deepEqual(sent[1][1], { appPids: [7], apps: ['excel'] });
  running = false; // the helper was idle-killed: the new one gets the guard again
  await helper.call('key', {});
  assert.deepEqual(sent.map(([op]) => op).slice(-2), ['config', 'key']);
  guard = { appPids: [], apps: null }; // back to Trust mode: cleared
  await helper.call('key', {});
  assert.deepEqual(sent.at(-2), ['config', { appPids: [], apps: null }]);
});
