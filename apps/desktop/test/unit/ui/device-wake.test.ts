// W (19.11.2026, owner: "vom Handy … die PCs updaten … und natürlich auch erwachen lassen"): Settings › Devices on a
// phone session – the owner's paired phone on its secure way (meeting server, tunnel → the PC's loopback) holds Update and
// Wake like the desktop, plain LAN http does not; the kept list shows every own PC with a wake key as wakeable while no PC
// answers; a Wake goes through the connected PC first and the phone's own link (Android port / iPhone shell) otherwise.
// Owns: these assertions (pure parts and the port, no window). Never: a real phone or meeting server (hosted/phone-wake.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { FULL_ACCESS } from '../../../src/runtime/pwa/tokens.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import { RpcError } from '../../../src/ui/lib/rpc-error.ts';
import { can, session } from '../../../src/ui/lib/session.ts';
import { adoptPort, resetNativePort } from '../../../src/ui/pwa/native-port.ts';
import { rowAction } from '../../../src/ui/settings/device-version.ts';
import { askAndroid, ownWay, readDevicesCopy, unreachableView, wakePc, wakesFromHere, type WakeDeps } from '../../../src/ui/settings/device-wake.ts';

const phone = (secure: boolean): ClientScope => ({ kind: 'device', deviceId: 'dev_phone', capabilities: [...FULL_ACCESS], secure });

const pc = (id: string, extra: Partial<Device> = {}): Device => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: id.padEnd(64, '0'), addresses: [], caps: { version: '0.3.12', wakeKey: 'k'.repeat(43) },
  status: 'online', self: false, ...extra,
});

test('my phone on its secure way holds Update and Wake as the desktop does; plain LAN http does not', () => {
  const table = createHandlerTable();
  const secure = sessionInfo(table, phone(true));
  for (const method of ['system.update', 'devices.wake', 'devices.list'] as const) assert.ok(secure.allowedMethods.includes(method), method);
  const lan = sessionInfo(table, phone(false));
  for (const method of ['system.update', 'devices.wake'] as const) assert.ok(!lan.allowedMethods.includes(method), `${method} needs the secure way`);
  session.value = secure;
  try {
    assert.equal(can('system.update'), true);
    assert.equal(can('devices.wake'), true);
  } finally { session.value = null; }
});

test('the kept list while no PC answers: every own PC with a wake key offers Wake, none offers Update', () => {
  const list = [pc('desk', { self: true }), pc('tower', { status: 'connecting' }), pc('staff', { personId: 'pe_1', status: 'offline' }),
    pc('old', { caps: { version: '0.3.4' }, status: 'offline' }), { ...pc('phone'), kind: 'phone' as const, role: 'client' as const }];
  const shown = unreachableView(list);
  assert.deepEqual(shown.map((device) => [device.id, device.self, device.status]), [
    ['desk', false, 'offline'], ['tower', false, 'offline'], ['staff', false, 'offline'], ['old', false, 'offline'], ['phone', false, 'online']]);
  assert.deepEqual(shown.map((device) => rowAction(device, shown)), ['wake', 'wake', undefined, undefined, undefined]);
  assert.equal(wakesFromHere(false, undefined), false, 'a browser with no PC: no Wake');
  assert.equal(wakesFromHere(false, 'android'), true);
  assert.equal(wakesFromHere(true, undefined), true);
});

test('the kept list reads back only what the page needs', () => {
  assert.equal(readDevicesCopy({ v: 2, list: [] }), undefined);
  assert.equal(readDevicesCopy(null), undefined);
  assert.deepEqual(readDevicesCopy({ v: 1, at: 1, list: [pc('desk'), { id: 'x' }, null, { ...pc('y'), kind: 'tv' }] }), [pc('desk')]);
});

function deps(over: Partial<WakeDeps> & { log?: string[] } = {}): WakeDeps {
  const log = over.log ?? [];
  return {
    open: () => true, call: async (id) => { log.push(`pc:${id}`); }, own: undefined,
    android: async (device, key) => { log.push(`android:${device.id}:${key.length}`); }, hosted: async (key, name) => { log.push(`hosted:${name}:${key.length}`); },
    ...over,
  };
}

test('wakePc: through the connected PC; its "unavailable" or no PC at all → the phone\'s own link; other errors stay', async () => {
  const log: string[] = [];
  assert.equal(await wakePc(pc('desk'), deps({ log })), 'pc');
  const unavailable = async () => { throw new RpcError({ code: 'unavailable', message: 'Waking goes through the meeting server, and this PC is not connected to one.' }); };
  assert.equal(await wakePc(pc('desk'), deps({ log, call: unavailable, own: 'android' })), 'android');
  assert.equal(await wakePc(pc('desk'), deps({ log, open: () => false, own: 'hosted' })), 'hosted');
  assert.deepEqual(log, ['pc:desk', 'android:desk:43', 'hosted:desk:43']);
  await assert.rejects(wakePc(pc('desk'), deps({ call: unavailable })), /meeting server/, 'no own way: the PC\'s answer');
  const forbidden = async () => { throw new RpcError({ code: 'forbidden', message: 'no' }); };
  await assert.rejects(wakePc(pc('desk'), deps({ call: forbidden, own: 'android' })), /no/, 'a refusal is not retried');
  await assert.rejects(wakePc(pc('desk'), deps({ open: () => false })), /only while one of your PCs is reachable/);
  await assert.rejects(wakePc(pc('desk', { caps: {} }), deps({ open: () => false, own: 'android' })), /only while/, 'no wake key: nothing to send');
});

test('the Android app is asked over its port and answers woken (or why not)', async () => {
  const channel = new MessageChannel();
  const seen: Array<Record<string, unknown>> = [];
  channel.port2.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    seen.push(msg);
    channel.port2.postMessage(JSON.stringify(msg.id === 'desk' ? { t: 'woken', id: 'desk' } : { t: 'woken', id: msg.id, error: 'Tower is not waiting at the meeting server.' }));
  };
  adoptPort(channel.port1);
  try {
    await askAndroid({ id: 'desk', name: 'Desk' }, 'k'.repeat(43));
    await assert.rejects(askAndroid({ id: 'tower', name: 'Tower' }, 'k'.repeat(43)), /not waiting/);
    assert.deepEqual(seen[0], { t: 'wake', id: 'desk', key: 'k'.repeat(43), name: 'Desk' });
  } finally {
    resetNativePort();
    channel.port2.close();
  }
});

test('ownWay: the iPhone shell with wake is a way; a browser is none', () => {
  assert.equal(ownWay(), undefined);
  const shell = globalThis as { autarkHosted?: unknown };
  shell.autarkHosted = { v: 1, base: '/app/', socket: () => undefined, frameUrl: (path: string) => path, forget: async () => undefined, wake: async () => undefined };
  try { assert.equal(ownWay(), 'hosted'); } finally { delete shell.autarkHosted; }
  shell.autarkHosted = { v: 1, base: '/app/', socket: () => undefined, frameUrl: (path: string) => path, forget: async () => undefined };
  try { assert.equal(ownWay(), undefined, 'a shell from before that day'); } finally { delete shell.autarkHosted; }
});
