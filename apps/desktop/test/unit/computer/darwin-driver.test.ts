// The macOS AX driver (24.11.2026; computer/drivers.ts, apps/mac-steuerung): how the runtime starts and guards the Swift helper,
// checked against a stand-in process that speaks protocol 4 – the ready line, the permission refusal a helper without the
// Accessibility permission gives, and its answers. The Swift helper itself (AX, CGEvent) is tested on a macOS runner
// (.github/workflows/mac-steuerung.yml); nothing here touches a Mac.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHelper, driverFor } from '../../../src/runtime/computer/drivers.ts';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Lease, Supervisor } from '../../../src/runtime/system/supervisor.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { securityDefaults } from '../../../src/shared/model/security-settings.ts';
import { MemoryLogger } from '../fakes.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const MISSING = 'macOS has not given Autark the Accessibility permission, so this PC cannot be controlled yet. Open System Settings › Privacy & Security › Accessibility, switch Autark on and try again.';

/** A helper stand-in: ready line, then one answer per request (a mac without the permission refuses every control op). */
const STAND_IN = `
const readline = require('node:readline');
const trusted = process.env.STAND_IN_TRUSTED === '1';
console.log(JSON.stringify({ ready: true, protocol: 4, pid: process.pid, dpiAware: true }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, op, args } = JSON.parse(line);
  const control = ['windows', 'tree', 'find', 'act', 'click', 'move', 'path', 'scroll', 'type', 'key'].includes(op);
  if (control && !trusted) return console.log(JSON.stringify({ id, ok: false, error: { code: 'unavailable', message: ${JSON.stringify(MISSING)} } }));
  if (op === 'screenshot') return console.log(JSON.stringify({ id, ok: false, error: { code: 'unavailable', message: 'Not available from the macOS helper; the desktop app captures the screen.' } }));
  console.log(JSON.stringify({ id, ok: true, result: op === 'windows' ? [{ hwnd: 7, title: 'Notes', process: 'Notes', pid: 4242, minimized: false, foreground: true, app: false, rect: [0, 0, 800, 600] }] : { op, args } }));
});
`;

function rig(trusted: boolean, macHelper?: string) {
  const spawned: Array<{ command: string; args: string[] }> = [];
  const supervisor: Pick<Supervisor, 'spawn'> = {
    spawn(input) {
      spawned.push({ command: input.command, args: input.args });
      // The real binary does not exist here: run the stand-in instead, keep what the runtime asked for.
      const child = spawn(process.execPath, ['-e', STAND_IN], { env: { ...process.env, STAND_IN_TRUSTED: trusted ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      return { id: 1, owner: input.owner, kind: 'light', startedAt: 0, lastActiveAt: 0, child, exited, touch() {}, release: async () => { child.kill(); await exited; } } as unknown as Lease;
    },
  };
  const helper = createHelper('darwin', { supervisor, resourcesDir: '/App/Contents/Resources/app.asar/resources', log: new MemoryLogger(), unpacked: (file) => file.replace('app.asar', 'app.asar.unpacked'), macHelper });
  return { helper, spawned };
}

const code = (wanted: string, message?: RegExp) => (error: unknown) => error instanceof WorkforceError && error.code === wanted && (!message || message.test(error.message));

test('darwin driver: semantic AX with full input, and what it needs', () => {
  const info = driverFor('darwin');
  assert.deepEqual([info?.semantic, info?.input], [true, 'full']);
  assert.match(info?.needs ?? '', /Accessibility permission/);
});

test('darwin helper: starts the unpacked binary without arguments and talks protocol 4', async () => {
  const r = rig(true);
  try {
    const windows = await r.helper.call<Array<{ hwnd: number; title: string }>>('windows');
    assert.deepEqual(windows.map((w) => [w.hwnd, w.title]), [[7, 'Notes']]);
    assert.match(r.spawned[0].command.split(path.sep).join('/'), /app\.asar\.unpacked\/resources\/computer\/darwin\/autark-mac-helper$/);
    assert.deepEqual(r.spawned[0].args, []);
  } finally { await r.helper.dispose(); }
});

test('darwin helper: the binary can be named (macHelper); a missing permission arrives as unavailable with the way to grant it', async () => {
  const r = rig(false, '/opt/test/autark-mac-helper');
  try {
    await assert.rejects(r.helper.call('tree', {}), code('unavailable', /System Settings › Privacy & Security › Accessibility/));
    await assert.rejects(r.helper.call('click', { x: 1, y: 1 }), code('unavailable', /Accessibility/));
    await assert.rejects(r.helper.call('screenshot', {}), code('unavailable'));
    assert.deepEqual(r.spawned.map((s) => s.command), ['/opt/test/autark-mac-helper']);
    assert.equal((await r.helper.call<{ op: string }>('ping')).op, 'ping', 'ping needs no permission');
  } finally { await r.helper.dispose(); }
});

class FakeHelper implements HelperClient {
  calls: Array<{ op: HelperOp; args: Record<string, unknown> }> = [];
  async call<T>(op: HelperOp, args: Record<string, unknown> = {}): Promise<T> { this.calls.push({ op, args }); return { done: true } as T; }
  running(): boolean { return true; }
  async dispose(): Promise<void> {}
}

function host(): Host {
  return { kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false, openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node', pid: 4321 }, idleSeconds: async () => 60 } as unknown as Host;
}

function macService(secure: boolean) {
  const helper = new FakeHelper();
  const services = () => ({ security: { current: () => securityDefaults(secure ? 'secure' : 'trust'), openApps: () => ['Notes'] }, host: host() }) as unknown as RuntimeServices;
  const computer = new ComputerService({ host: host(), supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'darwin', services });
  return { computer, helper };
}

test('macOS can be controlled: the app\'s process ids reach the helper\'s guard in Secure mode, the same way as on Windows', async () => {
  assert.equal(macService(false).computer.canControl(), true);
  const secure = macService(true);
  await secure.computer.windows();
  const config = secure.helper.calls.find((call) => call.op === 'config');
  assert.ok(config, 'the guard goes before the first call');
  assert.ok((config!.args.appPids as number[]).includes(4321), "Autark's own pid is guarded");
  assert.equal(secure.helper.calls.findIndex((call) => call.op === 'config') < secure.helper.calls.findIndex((call) => call.op === 'windows'), true);
});

test('macOS in Trust mode: settings that cannot be read close input to every app, as on Windows (helper-route.ts)', async () => {
  const helper = new FakeHelper();
  const services = () => ({ security: { current: () => { throw new Error('unreadable'); }, openApps: () => [] }, host: host() }) as unknown as RuntimeServices;
  const computer = new ComputerService({ host: host(), supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'darwin', services });
  await computer.windows().catch(() => undefined);
  const config = helper.calls.find((call) => call.op === 'config');
  assert.ok(config, 'the Trust helper gets the closed guard before the first call');
  assert.deepEqual(config!.args.apps, [], 'no app receives input');
});
