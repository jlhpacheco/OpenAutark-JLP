// The built candidate talks to a real built 0.3.16/0.3.17 headless runtime. Synthetic data, no relay, loopback only.
// Explicit entry: AUTARK_LEGACY_DESKTOP=/path/to/old/apps/desktop node --test test/e2e/runtime-mixed-version.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { test } from 'node:test';
import { connectYes, startRuntime } from './lib/runtime-client.mjs';

const legacyDir = process.env.AUTARK_LEGACY_DESKTOP;

async function until(read, matches, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await sleep(200);
  }
  throw new Error('Timed out: ' + label);
}

test('0.3.18 pairs, syncs tasks both ways and catches up after 0.3.16/0.3.17 reconnects',
  { timeout: 240_000, skip: !legacyDir && 'build the legacy checkout and set AUTARK_LEGACY_DESKTOP' }, async (t) => {
    assert.ok(existsSync(path.join(legacyDir, 'app/runtime-cli.mjs')), 'run build --only cli in the legacy checkout first');
    const candidate = await startRuntime();
    t.after(() => candidate.stop());
    const legacy = await startRuntime({ appRoot: legacyDir, keepData: true });
    let activeLegacy = legacy;
    t.after(async () => {
      await activeLegacy?.stop();
      await rm(legacy.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const info = (runtime) => runtime.client.call('system.info');
    assert.match((await info(candidate)).version, /^0\.3\.18$/);
    assert.match((await info(legacy)).version, /^0\.3\.(16|17)$/);
    for (const runtime of [legacy, candidate]) {
      await runtime.client.call('settings.update', { devices: { relay: '' } });
    }
    const peer = await until(() => info(legacy).then((x) => x.peer), (x) => x?.status === 'open', 'legacy peer open');
    const target = peer.addresses.find((x) => /^http:\/\/127\.0\.0\.1:\d+$/.test(x));
    assert.ok(target, 'legacy peer exposes a loopback address');
    const oldId = (await legacy.client.call('remote.state')).self.deviceId;
    const newId = (await candidate.client.call('remote.state')).self.deviceId;
    await connectYes(candidate.client, target);
    const incoming = await until(() => legacy.client.call('remote.state').then((x) => x.incoming),
      (x) => x.length === 1, 'legacy join request');
    await legacy.client.call('remote.decide', { id: incoming[0].id, accept: true });
    const status = (runtime, id) => runtime.client.call('devices.list').then((x) => x.find((d) => d.id === id)?.status);
    await until(() => status(candidate, oldId), (x) => x === 'online', 'legacy peer online');
    await until(() => status(legacy, newId), (x) => x === 'online', 'candidate peer online');

    const findTask = (runtime, id) => runtime.client.call('tasks.list').then((x) => x.some((task) => task.id === id));
    const fromOld = await legacy.client.call('tasks.create', { title: 'Legacy fixture task' });
    await until(() => findTask(candidate, fromOld.id), Boolean, 'legacy task on candidate');
    const fromNew = await candidate.client.call('tasks.create', { title: 'Candidate fixture task' });
    await until(() => findTask(legacy, fromNew.id), Boolean, 'candidate task on legacy peer');

    await legacy.stop();
    activeLegacy = undefined;
    const duringOutage = await candidate.client.call('tasks.create', { title: 'Task saved while legacy peer is offline' });
    const again = activeLegacy = await startRuntime({ appRoot: legacyDir, dataDir: legacy.dataDir, keepData: true });
    await until(() => findTask(again, duringOutage.id), Boolean, 'offline task delivered to restarted legacy peer');
  });
