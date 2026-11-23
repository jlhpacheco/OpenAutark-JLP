// 16.11.2026 a company out and in again (src/runtime/portability/company.ts): the export is a new folder "<name> <time>"
// inside the chosen one with the backup and secrets.csv (values readable), never inside the data folder; imported into a
// new folder, the restore leaves secrets.csv out and drops the backup's PC-bound rows (identity, VAPID key, self device,
// push subscriptions) so that start makes its own, while everything else comes along; companies.import stages it in the
// next free company folder and lets main open it.
// Owns: these assertions only. Never: starts a company or touches the real data folders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { exportCompany, importCompany } from '../../../src/runtime/portability/company.ts';
import { applyPendingRestore, stagedRestore } from '../../../src/runtime/portability/restore.ts';
import { MemoryLogger } from '../fakes.ts';
import type { WorkforceError } from '../../../src/shared/errors.ts';
import { portabilityFixture } from './fixture.ts';

function withSecret(f: ReturnType<typeof portabilityFixture>) {
  const now = f.time.now();
  f.db.run('INSERT INTO secrets (id, label, kind, cipher, created_at) VALUES (?, ?, ?, ?, ?)', ['sec_api', 'Shop API key', 'api_key', new Uint8Array([1, 2, 3]), now]);
  f.db.run("INSERT INTO kv (ns, key, value, updated_at) VALUES ('device', 'identity', '{\"deviceId\":\"dev_old\"}', ?), ('pwa', 'vapid', '{}', ?)", [now, now]);
  f.db.run("INSERT INTO devices (id, name, kind, role, fingerprint, self) VALUES ('dev_old', 'old pc', 'pc', 'home', 'fp', 1), ('dev_peer', 'notebook', 'pc', 'peer', 'fp2', 0)");
  f.db.run("INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES ('ps1', 'dev_phone', 'https://push/1', '{}', ?)", [now]);
  return {
    ...f.s,
    host: { decrypt: async () => 'value-of-the-key', app: { dataDir: f.paths.data } },
    secrets: { ...(f.s.secrets as object), list: () => [{ id: 'sec_api', label: 'Shop API key', kind: 'api_key', route: 'notes', group: false }], groups: () => [] },
  } as unknown as RuntimeServices;
}

test('export: a new folder inside the chosen one with the backup and secrets.csv; never inside the data folder', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const services = withSecret(f);
    const out = path.join(f.root, 'exports');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(f.paths.data, 'runtime.json'), '{"port":1,"token":"live-owner-token","pid":1}');
    const done = await exportCompany(services, (dir) => f.portability.backup(dir), out, 'Teydra: Lab/');
    assert.ok(!existsSync(path.join(done.path, 'runtime.json')), 'the running runtime\'s owner token never goes into an export');
    assert.equal(path.dirname(done.path), out);
    assert.match(path.basename(done.path), /^Teydra Lab \d{4}-\d\d-\d\d-\d{4}$/, 'a safe folder name with the time');
    assert.ok(readdirSync(done.path).includes('manifest.json') && readdirSync(done.path).includes('workforce.db'));
    assert.equal(done.secrets, 1);
    assert.match(readFileSync(path.join(done.path, 'secrets.csv'), 'utf8'), /"Shop API key".*"value-of-the-key"/);
    assert.ok(done.bytes > 0);
    const again = await exportCompany(services, (dir) => f.portability.backup(dir), out, 'Teydra: Lab/');
    assert.notEqual(again.path, done.path, 'a second export of the same minute gets its own folder');
    await assert.rejects(exportCompany(services, (dir) => f.portability.backup(dir), path.join(f.paths.data, 'x'), 'T'), (error: WorkforceError) => error.code === 'bad_request');
  } finally { f.cleanup(); }
});

test('import into a new folder: secrets.csv stays out, the PC-bound rows go (that start makes its own), the rest comes along', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const services = withSecret(f);
    const out = path.join(f.root, 'exports');
    mkdirSync(out, { recursive: true });
    const done = await exportCompany(services, (dir) => f.portability.backup(dir), out, 'Teydra Lab');
    const first = path.join(f.root, 'Autark');
    const dir = path.join(f.root, 'Autark Companies');
    mkdirSync(path.join(dir, 'company-2'), { recursive: true });
    const opened: unknown[] = [];
    const host = { app: { dataDir: first, companies: { first, dir } }, openCompany: async (input: unknown) => { opened.push(input); return { ok: true, id: 'company-3' }; } };
    const imported = await importCompany({ host, clock: f.time, log: new MemoryLogger() } as unknown as RuntimeServices, path.join(done.path, 'manifest.json'));
    assert.deepEqual(imported, { ok: true, id: 'company-3' }, 'the next free company folder');
    assert.deepEqual(opened, [{ id: 'company-3' }], 'main opens it');
    const target = path.join(dir, 'company-3');
    assert.equal(stagedRestore(target)?.path, done.path, 'its first start puts the data in');
    assert.equal(applyPendingRestore(target, new MemoryLogger(), { workspace: path.join(target, 'workspace') }), true);
    assert.ok(!existsSync(path.join(target, 'secrets.csv')), 'readable secrets never go into a data folder');
    const db = new DatabaseSync(path.join(target, 'workforce.db'));
    try {
      assert.deepEqual(db.prepare("SELECT ns, key FROM kv WHERE ns IN ('device', 'pwa')").all(), [], 'no identity or VAPID key of the folder it came from');
      assert.deepEqual(db.prepare('SELECT id FROM devices ORDER BY id').all().map((row) => (row as { id: string }).id), ['dev_peer'], 'the self row goes, the linked PCs stay');
      assert.deepEqual(db.prepare('SELECT id FROM push_subscriptions').all(), []);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n > 0, true, 'the team comes along');
      assert.equal((db.prepare("SELECT label FROM secrets WHERE id = 'sec_api'").get() as { label: string }).label, 'Shop API key');
    } finally { db.close(); }
    await assert.rejects(importCompany({ host, clock: f.time, log: new MemoryLogger() } as unknown as RuntimeServices, path.join(f.root, 'exports')), (error: WorkforceError) => error.code === 'bad_request', 'not a backup');
    await assert.rejects(importCompany({ host: { app: { dataDir: first } }, clock: f.time, log: new MemoryLogger() } as unknown as RuntimeServices, done.path), (error: WorkforceError) => error.code === 'unavailable', 'headless');
  } finally { f.cleanup(); }
});
