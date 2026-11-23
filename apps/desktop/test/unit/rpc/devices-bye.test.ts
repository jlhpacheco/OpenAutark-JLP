// Sicher-Runde 19.11.2026 (D2): devices.bye (src/runtime/rpc/handlers/devices.ts) answers main's own link only – it says
// goodbye through the mesh, writes <data>/wake.json fresh when an own PC is linked and a meeting server is set (the helper
// may start after the person's quit) and removes it otherwise; devices.wake goes to the mesh's wake.
// Owns: these assertions only. Never: network or a real helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { b64url, fingerprintOf, generateEd25519, rawPublic } from '../../../src/runtime/devices/keys.ts';
import { parseWakeFile, WAKE_FILE } from '../../../src/runtime/devices/wake-sign.ts';
import { OWNER, TestClient, rpcFixture } from './s1-helpers.ts';

test("devices.bye: main's link only; goodbye, then the helper's file – written with an own PC linked, removed without", async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const byes: string[] = [];
  const woken: string[] = [];
  (f.extras as { mesh: unknown }).mesh = { ...f.extras.mesh, bye: async (reason: string) => { byes.push(reason); }, wake: async (id: string) => { woken.push(id); } };
  f.services.settings.update({ devices: { relay: 'wss://meet.example/autark' } } as never);
  const refused = await new TestClient(f.server, OWNER).request('devices.bye', { reason: 'quit' });
  assert.equal(refused.error?.code, 'forbidden', 'the window or an agent never says goodbye for the PC');
  const main = new TestClient(f.server, { kind: 'owner', main: true });
  const file = path.join(f.paths.data, WAKE_FILE);
  assert.deepEqual(await main.call('devices.bye', { reason: 'quit' }), { ok: true, sleeper: false }, 'no own PC linked: nobody could wake it');
  assert.equal(existsSync(file), false);
  const key = generateEd25519();
  const pub = b64url(rawPublic(key.publicKey));
  new DevicesRepo(f.services.db).upsert({
    id: 'dev_tower0000001', name: 'Tower', kind: 'pc', role: 'home', fingerprint: fingerprintOf(rawPublic(key.publicKey)), publicKey: pub,
    addresses: [], caps: {}, status: 'offline', self: false,
  });
  assert.deepEqual(await main.call('devices.bye', { reason: 'quit' }), { ok: true, sleeper: true });
  const written = parseWakeFile(readFileSync(file, 'utf8'));
  assert.equal(written?.relay, 'wss://meet.example/autark');
  assert.deepEqual(written?.pins.map((pin) => pin.pub), [pub]);
  assert.deepEqual(await main.call('devices.bye', { reason: 'update' }), { ok: true, sleeper: false }, 'an update starts the app again itself');
  assert.deepEqual(byes, ['quit', 'quit', 'update']);
  const bad = await main.request('devices.bye', { reason: 'gone' });
  assert.equal(bad.error?.code, 'bad_request');
  assert.deepEqual(await new TestClient(f.server, OWNER).call('devices.wake', { id: 'dev_tower0000001' }), { ok: true });
  assert.deepEqual(woken, ['dev_tower0000001']);
});
