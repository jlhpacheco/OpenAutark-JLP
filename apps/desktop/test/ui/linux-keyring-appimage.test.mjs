// Linux packaged-only smoke. Run under Xvfb with an unlocked disposable GNOME keyring:
//   WORKFORCE_APPIMAGE=dist/autark-linux-x64.AppImage node --test test/ui/linux-keyring-appimage.test.mjs
// APPIMAGE_EXTRACT_AND_RUN=1 is supported for runners without FUSE. No production data or secrets.
import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const image = process.env.WORKFORCE_APPIMAGE;
const skip = process.platform !== 'linux' || !image ? 'requires Linux and WORKFORCE_APPIMAGE' : false;

test('AppImage guides setup without a keyring; a real keyring preserves and reads existing secrets', { skip, timeout: 240_000 }, async () => {
  const exe = path.resolve(image);
  assert.ok(exe.endsWith('.AppImage') && existsSync(exe), 'requires the packaged AppImage, not Electron or its unpacked executable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'autark-appimage-keyring-'));
  const shots = process.env.SCREENSHOTS && path.resolve(process.env.SCREENSHOTS);
  if (shots) await mkdir(shots, { recursive: true });
  const isolated = { ...process.env, WORKFORCE_FAKE_ENGINE: '1' };
  delete isolated.ELECTRON_RUN_AS_NODE;

  async function launch(profile, withKeyring, check) {
    const env = testNetworkEnv(profile, undefined, { inherited: isolated });
    if (!withKeyring) env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + path.join(root, 'no-bus');
    const args = withKeyring ? ['--password-store=gnome-libsecret'] : [];
    const deadline = Date.now() + 30_000;
    const app = await electron.launch({ executablePath: exe, args, env, timeout: 30_000 });
    try {
      const page = await app.firstWindow({ timeout: Math.max(1, deadline - Date.now()) });
      assert.ok(await app.evaluate(({ app }) => app.isPackaged), 'the app is packaged');
      await check(app, page, Math.max(1, deadline - Date.now()));
    } finally {
      await app.close();
    }
  }
  const vault = path.join(root, 'vault');
  const db = path.join(vault, 'workforce.db');
  const value = 'disposable keyring smoke ' + randomUUID();
  let id;
  const repairWindow = async (app, page, timeout) => {
    await page.getByRole('heading', { name: 'Autark needs an unlocked system keyring' }).waitFor({ timeout });
    assert.equal(await page.locator('.shell').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Restore', exact: true }).count(), 0);
    if (shots) await page.screenshot({ path: path.join(shots, 'appimage-keyring-setup.png') });
  };
  const withVault = async (app, page, timeout, create) => {
    await page.locator('.shell').waitFor({ timeout });
    assert.equal(await page.locator('.repair-card').count(), 0);
    const info = JSON.parse(await readFile(path.join(vault, 'runtime.json'), 'utf8'));
    const rpc = await connect(info.port, info.token, 'cli');
    try {
      if (create) id = (await rpc.call('secrets.save', { label: 'Disposable smoke', kind: 'password', value })).id;
      assert.ok((await rpc.call('secrets.list')).some(row => row.id === id));
      const sql = new DatabaseSync(db, { readOnly: true });
      let cipher;
      try { cipher = sql.prepare('SELECT cipher FROM secrets WHERE id = ?').get(id)?.cipher; }
      finally { sql.close(); }
      assert.ok(cipher?.length > 0);
      assert.ok(!Buffer.from(cipher).includes(value), 'never persisted as plaintext');
      // Exercise the same real OS decryption used by the packaged vault without printing the value.
      assert.equal(await app.evaluate(async ({ safeStorage }, { bytes, expected }) => {
        const backend = safeStorage.getSelectedStorageBackend();
        return backend !== 'basic_text' && backend !== 'unknown' && (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result === expected;
      }, { bytes: [...cipher], expected: value }), true);
    } finally { rpc.close(); }
  };
  try {
    const empty = path.join(root, 'empty');
    await launch(empty, false, repairWindow);
    assert.equal(existsSync(path.join(empty, 'workforce.db')), false, 'no DB or device identity is created without a keyring');
    assert.equal(existsSync(path.join(empty, 'runtime.json')), false, 'no normal RPC server, including secret operations');
    await launch(vault, true, (app, page, timeout) => withVault(app, page, timeout, true));
    const before = await readFile(db);
    await launch(vault, false, repairWindow);
    assert.ok(before.equals(await readFile(db)), 'repair neither opens/migrates the existing DB nor replaces keys');
    await launch(vault, true, (app, page, timeout) => withVault(app, page, timeout, false));
  } finally {
    assert.ok(path.basename(root).startsWith('autark-appimage-keyring-'));
    await rm(root, { recursive: true, force: true });
  }
});
