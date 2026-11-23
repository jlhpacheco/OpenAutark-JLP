// Desktop broker (B-077): handshake, sealed typing and the driver choice against a fake broker on a test pipe
// (the real worker is resources/broker/Worker.cs; this fake mirrors its handshake and Sealer.Open). F03 (16.11.2026): the
// fact line while the secure desktop is out of reach, and main's word on the setup through the bus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { brokerLease, brokerState, followBrokerSetup, lockedDesktop, secureDesktopLine, type BrokerAccess } from '../../../src/runtime/computer/broker.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { createHelper } from '../../../src/runtime/computer/drivers.ts';
import { WindowsHelper } from '../../../src/runtime/computer/helper.ts';
import { MemoryLogger } from '../fakes.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fakeSpawn, testSupervisor } from '../engines/fakes.ts';

const mac = (key: Buffer, label: string, ...parts: Buffer[]) => createHmac('sha256', key).update(Buffer.concat([Buffer.from(label), ...parts])).digest();
let pipes = 0;
const pipeName = () => `\\\\.\\pipe\\autark-broker-test-${process.pid}-${++pipes}`;

interface Seen { requests: Array<Record<string, unknown>>; opened: string[] }

/** A fake worker: greets, checks the hello, proves the key, answers each op and opens sealed text like Worker.cs. */
async function fakeBroker(key: Buffer, desktop: string, proveWith = key): Promise<{ pipe: string; seen: Seen; close(): Promise<void> }> {
  const seen: Seen = { requests: [], opened: [] };
  const pipe = pipeName();
  const server = net.createServer((socket) => {
    const serverNonce = randomBytes(16);
    let session: Buffer | undefined;
    let buffer = '';
    socket.write(`${JSON.stringify({ broker: 1, nonce: serverNonce.toString('base64') })}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (!session) {
          const clientNonce = Buffer.from(message.nonce, 'base64');
          assert.ok(timingSafeEqual(Buffer.from(message.hello, 'base64'), mac(key, 'hello', serverNonce, clientNonce)));
          session = mac(key, 'session', serverNonce, clientNonce);
          socket.write(`${JSON.stringify({ ready: true, protocol: 4, pid: 7, dpiAware: true, proof: mac(proveWith, 'proof', serverNonce, clientNonce).toString('base64'), desktop })}\n`);
          continue;
        }
        seen.requests.push(message);
        const sealed = message.args?.sealed;
        if (sealed) {
          const iv = Buffer.from(sealed.iv, 'base64');
          const data = Buffer.from(sealed.data, 'base64');
          assert.ok(timingSafeEqual(Buffer.from(sealed.mac, 'base64'), mac(mac(session, 'mac'), `${message.id}\n${message.op}\n`, iv, data)));
          const decipher = createDecipheriv('aes-256-cbc', mac(session, 'enc'), iv);
          seen.opened.push(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
        }
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result: { done: true }, desktop })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  return { pipe, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function helperOn(pipe: string, key: Buffer, log = new MemoryLogger()): WindowsHelper {
  return new WindowsHelper({ supervisor: { spawn: () => brokerLease({ pipe, key, log }) }, scriptPath: 'unused.ps1', log });
}

test('the broker answers the helper protocol; typed text and set_value leave only sealed', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Winlogon');
  const helper = helperOn(broker.pipe, key);
  assert.deepEqual(await helper.call('tree', { hwnd: 5 }), { done: true });
  await helper.call('type', { text: 'pässwort\n' });
  await helper.call('act', { rid: '3', action: 'set_value', value: 'hunter22' });
  assert.deepEqual(broker.seen.requests[0], { id: 1, op: 'tree', args: { hwnd: 5 } });
  assert.equal(broker.seen.requests[1].op, 'type_secret');
  assert.deepEqual(broker.seen.opened, ['pässwort\n', 'hunter22']);
  const wire = JSON.stringify(broker.seen.requests);
  assert.ok(!wire.includes('hunter22') && !wire.includes('sswort'), 'no typed text in clear on the pipe');
  assert.deepEqual((broker.seen.requests[2].args as Record<string, unknown>).rid, '3');
  assert.equal(brokerState.via, 'broker');
  assert.equal(brokerState.desktop, 'Winlogon');
  assert.equal(lockedDesktop(), true);
  await helper.dispose();
  await broker.close();
});

test('a pipe that cannot prove the installation key is not used', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Default', randomBytes(32));
  const log = new MemoryLogger();
  const helper = helperOn(broker.pipe, key, log);
  await assert.rejects(helper.call('ping'), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
  assert.equal(broker.seen.requests.length, 0);
  assert.equal(log.entries.some((entry) => entry.message === 'desktop broker authenticated'), false);
  assert.equal(log.entries.some((entry) => entry.message === 'desktop broker observed'), false);
  await helper.dispose();
  await broker.close();
});

test('broker telemetry correlates authenticated transport and response desktop without secrets', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Default');
  const log = new MemoryLogger();
  const helper = helperOn(broker.pipe, key, log);
  try {
    await helper.call('ping');
    await helper.call('type', { text: 'not-for-logs' });
    const auth = log.entries.find((entry) => entry.message === 'desktop broker authenticated')!;
    const observed = log.entries.filter((entry) => entry.message === 'desktop broker observed');
    assert.equal(auth.data?.via, 'broker');
    assert.ok(Number.isSafeInteger(auth.data?.connectionId));
    assert.deepEqual(observed.map((entry) => entry.data), [{ connectionId: auth.data?.connectionId, requestId: 1, desktop: 'Default' }]);
    await helper.dispose();
    assert.ok(log.entries.some((entry) => entry.message === 'desktop broker disconnected' && entry.data?.connectionId === auth.data?.connectionId && entry.data?.authenticated === true));
    const logs = JSON.stringify(log.entries);
    assert.ok(!logs.includes('not-for-logs') && !logs.includes(key.toString('base64')));
    assert.ok(!logs.includes('proof') && !logs.includes('nonce'));
  } finally { await helper.dispose(); await broker.close(); }
});

test('drivers.ts takes the broker whenever it is reachable, else the PowerShell helper', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Default');
  let reachable = false;
  const access: BrokerAccess = { reachable: () => reachable, lease: (log) => brokerLease({ pipe: broker.pipe, key, log }) };
  const fake = fakeSpawn((call) => {
    call.child.onLine = (message) => call.child.send({ id: message.id, ok: true, result: { from: 'powershell' } });
    setImmediate(() => call.child.send({ ready: true, protocol: 4, pid: 1, dpiAware: true }));
  });
  const deps = { supervisor: testSupervisor(fake.spawn), resourcesDir: 'C:\\app\\resources', log: new MemoryLogger(), unpacked: (file: string) => file, broker: access };
  const viaShell = createHelper('win32', deps);
  assert.deepEqual(await viaShell.call('ping'), { from: 'powershell' });
  assert.equal(fake.calls[0].command, 'powershell.exe');
  assert.equal(brokerState.via, 'powershell');
  assert.equal(lockedDesktop(), false);
  await viaShell.dispose();
  reachable = true;
  const viaBroker = createHelper('win32', deps);
  assert.deepEqual(await viaBroker.call('ping'), { done: true });
  assert.equal(fake.calls.length, 1, 'no PowerShell started');
  assert.equal(brokerState.via, 'broker');
  assert.equal(lockedDesktop(), false); // Default desktop: unlocked
  await viaBroker.dispose();
  await broker.close();
});

const SCRIPT = 'C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\resources\\broker\\install.ps1';

test('F03: without the broker on Windows the fact line says why the secure desktop is out of reach and how one Yes changes it', () => {
  const saved = { ...brokerState };
  try {
    Object.assign(brokerState, { via: 'powershell', desktop: undefined, setup: { state: 'declined', script: SCRIPT } });
    const declined = secureDesktopLine('win32')!;
    assert.match(declined, /^The Windows secure desktop \(UAC prompts, the locked screen\) is out of my reach on this PC: the desktop broker is not installed – Windows asked at this app's start and got no Yes\. /);
    assert.ok(declined.includes(`I run powershell -ExecutionPolicy Bypass -File "${SCRIPT}"`), declined);
    assert.match(declined, /Windows then asks the person once \(the prompt names Windows PowerShell; it installs the desktop broker\), and their Yes lets these same tools reach it\.$/);
    brokerState.setup = { state: 'failed', code: 1, script: SCRIPT };
    assert.match(secureDesktopLine('win32')!, /not installed – its setup at this app's start failed \(exit 1\)\. When I need it/);
    brokerState.setup = { state: 'failed', script: SCRIPT };
    assert.match(secureDesktopLine('win32')!, /its setup at this app's start failed\. When I need it/, 'no exit code: none named');

    for (const [label, patch, platform] of [
      ['installed', { setup: { state: 'installed', script: SCRIPT } }, 'win32'],
      ['the broker serves', { via: 'broker', setup: { state: 'declined', script: SCRIPT } }, 'win32'],
      ['no setup ran (background start, dev build)', { setup: undefined }, 'win32'],
      ['not Windows', { setup: { state: 'declined', script: SCRIPT } }, 'linux'],
    ] as const) {
      Object.assign(brokerState, { via: 'powershell' }, patch);
      assert.equal(secureDesktopLine(platform), undefined, label);
    }
  } finally { Object.assign(brokerState, { via: saved.via, desktop: saved.desktop, setup: saved.setup }); }
});

test("F03: main's word on the setup reaches brokerState through the bus (replayed to a restarted runtime)", () => {
  const saved = brokerState.setup;
  const bus = new Bus();
  const off = followBrokerSetup(bus);
  try {
    bus.emit('broker.setup', { state: 'declined', script: SCRIPT });
    assert.deepEqual(brokerState.setup, { state: 'declined', script: SCRIPT });
    off();
    bus.emit('broker.setup', { state: 'installed', script: SCRIPT });
    assert.equal(brokerState.setup?.state, 'declined', 'unsubscribed');
  } finally { brokerState.setup = saved; }
});
