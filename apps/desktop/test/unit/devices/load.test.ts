// Chat sweep 16.11.2026 (owner 06.11.: "ihr könnt auch gerne das Notebook verwenden … nicht so ausgelastet"): a ping of my
// own PCs answers that PC's load (devices/load.ts: free memory, turns at work); devices.list shows it per online PC, this
// PC's own too, and a PC on an older version (a ping without load) is still listed. An employee's or employer's link gets
// no load. Owns: these assertions only. Never: a real network or a real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh } from '../../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { deviceLoad, loadIn } from '../../../src/runtime/devices/load.ts';
import { devicesList } from '../../../src/runtime/devices/list-tool.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from './fakes.ts';

test('deviceLoad and loadIn: MB rounded; a ping without load or with a broken one reads as none', () => {
  assert.deepEqual(deviceLoad(2, undefined, 3.6 * 1024 * 1024 * 1024), { freeMemoryMb: 3686, runs: 2 });
  assert.deepEqual(loadIn({ ok: true, at: 1, load: { freeMemoryMb: 5120.4, runs: 0 } }), { freeMemoryMb: 5120, runs: 0 });
  for (const answer of [{ ok: true, at: 1 }, { load: { freeMemoryMb: 'x', runs: 1 } }, { load: { freeMemoryMb: 10, runs: -1 } }, null, undefined]) {
    assert.equal(loadIn(answer), undefined, JSON.stringify(answer));
  }
});

test('the ping answers the load to my own PCs only', async () => {
  const db = memoryDb();
  const clock = new ManualClock();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock, name: 'Tower' });
  const mesh = new DeviceMesh({ db, identity, clock, log: silentLog, bus: recordingBus().bus, dial: async () => { throw new Error('no network'); }, load: () => ({ freeMemoryMb: 7000, runs: 1 }) });
  const repo = new DevicesRepo(db);
  const record = (id: string, extra: object) => repo.upsert({ id, name: id, kind: 'pc', role: 'home', fingerprint: id, addresses: [], caps: {}, status: 'online', self: false, pairedAt: 0, lastSeenAt: 0, ...extra });
  record('dev_notebook', {});
  record('dev_staff', { personId: 'per_anna' });
  const ping = (mesh as unknown as { handlers: Map<string, { handler: (params: unknown, from: string) => Promise<unknown> }> }).handlers.get('ping')!.handler;
  assert.deepEqual(await ping(null, 'dev_notebook'), { ok: true, at: clock.now(), load: { freeMemoryMb: 7000, runs: 1 } });
  assert.deepEqual(await ping(null, 'dev_staff'), { ok: true, at: clock.now() }, 'an employee\'s PC gets no load');
});

test('devices.list: the load of this PC and of each PC whose ping sent one; an older PC is listed without it', async () => {
  const pc = (id: string, name: string, self = false) => ({ id, name, kind: 'pc', role: 'home', fingerprint: id, addresses: [], caps: {}, status: 'online', ...(self ? { self: true } : {}) });
  const devices = [pc('dev_self', 'Server', true), pc('dev_notebook', 'Notebook'), pc('dev_old', 'Old PC')];
  const answers: Record<string, unknown> = { dev_notebook: { ok: true, at: 1, load: { freeMemoryMb: 9000, runs: 0 } }, dev_old: { ok: true, at: 1 } };
  const ctx = {
    agent: { id: 'ag_1', name: 'Mira' }, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: {
      devices: { self: () => devices[0], list: () => devices, online: () => true, call: async (id: string) => answers[id] },
      dispatcher: { activity: () => [{ agentId: 'ag_1' }, { agentId: 'ag_2' }, { agentId: 'ag_3' }] },
    },
  } as unknown as ToolContext;
  const out = (await devicesList().run({}, ctx)).structured as { devices: Array<{ name: string; online: boolean; load?: { freeMemoryMb: number; runs: number } }> };
  const by = new Map(out.devices.map((device) => [device.name, device]));
  assert.equal(by.get('Server')!.load!.runs, 3, 'this PC: the turns at work here');
  assert.ok(by.get('Server')!.load!.freeMemoryMb > 0);
  assert.deepEqual(by.get('Notebook')!.load, { freeMemoryMb: 9000, runs: 0 }, 'the idle notebook shows');
  assert.equal(by.get('Old PC')!.online, true);
  assert.equal('load' in by.get('Old PC')!, false, 'an older version: listed, no load');
  assert.match(devicesList().description, /load \(free memory, agent turns at work\)/);
});
