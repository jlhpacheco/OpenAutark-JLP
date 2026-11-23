// Umzug 21.11.2026 (PCSEC, CONTRACT points 5): security per PC. The settings section `security` stays on each PC (never
// sent, an older PC's copy never applied); `security.otherPcs` (yes | ask | no, absent = yes, both modes) decides what a
// forwarded call from an agent on another PC gets before the normal gate – ask goes through an approval request of its
// own category, no refuses naming this PC; an agent that runs here passes; the prompt names it once when it is not yes;
// devices.list shows each PC's mode and switch (this PC from its settings, a linked one from its ping).
// Owns: these assertions only. Never: a real linked PC or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { runRemoteTool } from '../../../src/runtime/devices/tools.ts';
import { devicesList } from '../../../src/runtime/devices/list-tool.ts';
import { deviceLoad, loadIn } from '../../../src/runtime/devices/load.ts';
import { syncedSettings, SettingsSync, type SettingsMessage } from '../../../src/runtime/devices/sync/settings.ts';
import { Stamps, hashOf } from '../../../src/runtime/devices/sync/stamps.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { decide } from '../../../src/runtime/security/policy.ts';
import { agreementsSection } from '../../../src/runtime/security/agreements.ts';
import { validateSecurity } from '../../../src/runtime/settings/security-keys.ts';
import { effective, securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { setup, WORKSPACE } from '../tools/helpers.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';

test('the security section stays on this PC: never sent, and an older PC\'s copy is not applied', () => {
  const settings = { profile: { name: 'Alex' }, security: { ...securityDefaults('secure'), otherPcs: 'no' } } as unknown as Settings;
  assert.equal('security' in syncedSettings(settings), false);
  const db = memoryDb();
  const { bus } = recordingBus();
  const current = settings;
  const updates: unknown[] = [];
  const s = { db, bus, clock: new ManualClock(1_000_000), log: silentLog, settings: { get: () => current, update: (patch: unknown) => { updates.push(patch); return current; } } } as unknown as RuntimeServices;
  const sync = new SettingsSync(s, new Stamps(db, s.clock), () => undefined);
  assert.equal('security' in sync.current().sections, false, 'link-up sends no security');
  const trust = securityDefaults('trust');
  const old: SettingsMessage = { sections: { security: { at: 99_000_000, h: hashOf(trust), value: trust } } };
  sync.receive(old, 'dev_old', false);
  assert.deepEqual(updates, [], 'an older PC still sending its section changes nothing here');
});

test('otherPcs: absent reads yes, Trust AI mode keeps it, the schema takes yes | ask | no, the gate knows its category', () => {
  const bad = (where: string, expected: string): never => { throw new Error(`${where}: ${expected}`); };
  const trust = securityDefaults('trust');
  assert.equal(trust.otherPcs, undefined, 'no default: a section kept before the key equals the file');
  assert.doesNotThrow(() => validateSecurity(structuredClone(trust), bad));
  assert.doesNotThrow(() => validateSecurity({ ...trust, otherPcs: 'no' }, bad));
  assert.throws(() => validateSecurity({ ...trust, otherPcs: 'maybe' as never }, bad), /security\.otherPcs: yes \| ask \| no/);
  assert.equal(effective({ ...trust, otherPcs: 'ask', commands: 'ask' }).otherPcs, 'ask', 'both modes');
  assert.equal(effective({ ...trust, otherPcs: 'ask', commands: 'ask' }).commands, 'yes');
  const places = { data: path.join(os.tmpdir(), 'pcsec-data'), workspace: WORKSPACE, resources: WORKSPACE, temp: [] };
  const verdict = (otherPcs?: SecuritySettings['otherPcs']) => decide(effective({ ...trust, ...(otherPcs ? { otherPcs } : {}) }), places, { agentId: 'ag_1', capability: 'otherPcs' }).verdict;
  assert.deepEqual([verdict(), verdict('yes'), verdict('ask'), verdict('no')], ['open', 'open', 'ask', 'closed']);
});

function receiving(mode: 'secure' | 'trust', otherPcs?: 'yes' | 'ask' | 'no') {
  const h = setup();
  h.settings.update({ profile: { name: 'Mia' }, security: { ...securityDefaults(mode), ...(otherPcs ? { otherPcs } : {}) } } as never);
  const services = h.services as RuntimeServices;
  services.paths = { data: path.join(WORKSPACE, '..', 'pcsec-data'), workspace: WORKSPACE, resources: path.join(WORKSPACE, '..', 'res'), temp: path.join(WORKSPACE, '..', 'pcsec-data', 'tmp') } as RuntimeServices['paths'];
  services.security = new Security({ services: () => services, waitMs: 20 });
  services.devices = { self: () => ({ id: 'dev_self', name: 'Server' }), list: () => [{ id: 'dev_tower', name: 'Tower' }] } as unknown as RuntimeServices['devices'];
  let ran = 0;
  const read: ToolDef = {
    name: 'files.read', category: 'read', remote: true, description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (args) => ({ summary: `Read ${String((args as { path: string }).path)}`, external: false }),
    run: async () => { ran++; return { content: [{ type: 'text', text: 'the text' }] }; },
  };
  services.tools = { get: (name: string) => (name === read.name ? read : undefined) } as unknown as RuntimeServices['tools'];
  const call = (agentId = 'ag_far') => runRemoteTool(services, { name: 'files.read', args: { path: path.join(WORKSPACE, 'notes.md') }, agentId, agentName: 'Lena', runId: 'run_far', mode: 'general' }, 'dev_tower', new AbortController().signal);
  return { ...h, services, call, ran: () => ran };
}

test('otherPcs yes (and absent): a forwarded call runs as before', async () => {
  for (const value of [undefined, 'yes'] as const) {
    const h = receiving('secure', value);
    await h.call();
    assert.equal(h.ran(), 1);
    assert.deepEqual(h.services.security.requests(), []);
  }
});

test('otherPcs no: a forwarded call is refused naming this PC, in both modes; the tool never runs', async () => {
  for (const mode of ['trust', 'secure'] as const) {
    const h = receiving(mode, 'no');
    await assert.rejects(h.call(), (error: Error & { code?: string }) => error.code === 'forbidden' && error.message === 'Server takes no calls from agents on other PCs (Settings › Security there).');
    assert.equal(h.ran(), 0);
    assert.deepEqual(h.services.security.requests(), [], 'nothing to answer');
  }
});

test('otherPcs ask: the app asks the person (its own category), even in Trust AI mode; "once" lets that call through', async () => {
  const h = receiving('trust', 'ask');
  await assert.rejects(h.call(), (error: Error & { code?: string }) => error.code === 'forbidden' && /Calls from agents on other PCs is closed on Server, so the app asked Mia/.test(error.message));
  assert.equal(h.ran(), 0);
  const [request] = h.services.security.requests();
  assert.equal(request.capability, 'otherPcs');
  assert.equal(request.agentName, 'Lena (Tower)');
  assert.equal(request.summary, `From Tower: Read ${path.join(WORKSPACE, 'notes.md')}`);
  h.services.security.answer(request.id, 'once');
  await h.call();
  assert.equal(h.ran(), 1, 'the same call goes through once');
});

test('otherPcs no: an agent that runs on this PC itself is no agent on another PC', async () => {
  const h = receiving('secure', 'no');
  await h.call('ag_tom'); // Tom is in this PC's org without a home elsewhere
  assert.equal(h.ran(), 1);
});

const texts = { folder: () => 'C:\\Data\\security\\trust', text: () => '' };

test('the agreements name otherPcs once when it is not yes, in both modes', () => {
  const line = (mode: 'trust' | 'secure', otherPcs?: 'yes' | 'ask' | 'no') => agreementsSection({ security: { ...securityDefaults(mode), ...(otherPcs ? { otherPcs } : {}) }, name: 'Ada', ...texts })
    .split('\n').filter((one) => one.includes('other PCs'));
  assert.deepEqual(line('trust'), []);
  assert.deepEqual(line('secure', 'yes'), []);
  assert.deepEqual(line('trust', 'ask'), ['- Calls from agents on other PCs: the app asks Ada before each one runs here.']);
  assert.deepEqual(line('secure', 'no'), ['- Calls from agents on other PCs: this PC refuses them.']);
});

test('a ping carries the PC\'s mode and otherPcs next to its load; an older PC\'s ping has neither', () => {
  assert.deepEqual(deviceLoad(1, { mode: 'secure' }, 2 * 1024 * 1024 * 1024), { freeMemoryMb: 2048, runs: 1, security: 'secure', otherPcs: 'yes' });
  assert.deepEqual(loadIn({ load: { freeMemoryMb: 10, runs: 0, security: 'trust', otherPcs: 'ask' } }), { freeMemoryMb: 10, runs: 0, security: 'trust', otherPcs: 'ask' });
  assert.deepEqual(loadIn({ load: { freeMemoryMb: 10, runs: 0, security: 'open', otherPcs: 'x' } }), { freeMemoryMb: 10, runs: 0 }, 'unknown words are left out');
});

test('devices.list: each PC\'s security mode and otherPcs – this PC from its settings, a linked one from its ping', async () => {
  const pc = (id: string, name: string, self = false) => ({ id, name, kind: 'pc', role: 'home', fingerprint: id, addresses: [], caps: {}, status: 'online', ...(self ? { self: true } : {}) });
  const devices = [pc('dev_self', 'Server', true), pc('dev_notebook', 'Notebook'), pc('dev_old', 'Old PC')];
  const answers: Record<string, unknown> = { dev_notebook: { ok: true, at: 1, load: { freeMemoryMb: 9000, runs: 0, security: 'secure', otherPcs: 'no' } }, dev_old: { ok: true, at: 1, load: { freeMemoryMb: 100, runs: 2 } } };
  const ctx = {
    agent: { id: 'ag_1', name: 'Mira' }, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: {
      devices: { self: () => devices[0], list: () => devices, online: () => true, call: async (id: string) => answers[id] },
      dispatcher: { activity: () => [] },
      security: { current: () => ({ ...securityDefaults('trust'), otherPcs: 'ask' }) },
    },
  } as unknown as ToolContext;
  const out = (await devicesList().run({}, ctx)).structured as { devices: Array<Record<string, unknown>> };
  const by = new Map(out.devices.map((device) => [device.name, device]));
  assert.deepEqual([by.get('Server')!.security, by.get('Server')!.otherPcs], ['trust', 'ask']);
  assert.deepEqual([by.get('Notebook')!.security, by.get('Notebook')!.otherPcs], ['secure', 'no']);
  assert.deepEqual(by.get('Notebook')!.load, { freeMemoryMb: 9000, runs: 0 }, 'the load stays the load');
  assert.equal('security' in by.get('Old PC')!, false, 'an older PC: no mode named');
  assert.match(devicesList().description, /security \(each PC's own mode/);
});
