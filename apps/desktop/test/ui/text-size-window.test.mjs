// Real Electron UI, isolated demo profile (owner 21.11.2026): Settings › General › Labels size and Text size change the
// letters (a row grows only by what its letters need, nothing scrolls sideways) in light, dark, 640×480 and phone width; and a plan
// whose reading has no 5-hour window draws the weekly share as its ring with the weekly reset under it. Quota values
// are injected at the MessagePort boundary (demo mode never reads real plans); not a real-provider test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function quotaTransport() {
  const asked = new Set();
  const entry = () => [{ accountId: 'acc_weekly_only', provider: 'claude', label: 'Claude', name: 'weekly-only', active: true,
    weeklyRemainingPercent: 64, weeklyResetsAt: Date.now() + 3 * 86_400_000 + 4 * 3_600_000 + 60_000,
    limits: { readAt: Date.now(), stale: false, windows: [
      { name: 'weekly', windowMinutes: 10080, usedPercent: 36, resetsAt: Date.now() + 3 * 86_400_000 + 4 * 3_600_000 + 60_000 },
    ] } }];
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (frame, ...rest) { if (frame?.method === 'usage.list') asked.add(frame.id); return post.call(this, frame, ...rest); };
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
  Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() {
    const frame = data.call(this);
    return frame && asked.has(frame.id) && 'result' in frame ? { ...frame, result: entry() } : frame;
  } });
}

test('labels and text size; weekly ring without a 5-hour window', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-text-size-ui-'));
  const shots = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({ executablePath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
  t.after(async () => { await app.close().catch(() => undefined); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(quotaTransport);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (w, h) => app.evaluate(({ BrowserWindow }, [width, height]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 300); win.setSize(width, height); }, [w, h]);
  await size(1280, 820);

  // the weekly-only plan: a ring with the weekly arc, 64 % in it, "3d 4h" under it
  const badge = page.locator('.usage-badge:visible').first();
  await badge.getByText('64%', { exact: true }).waitFor();
  assert.equal(await badge.locator('.usage-ring-arc').count(), 1, 'the weekly share is the ring');
  assert.equal((await badge.locator('.usage-wait').textContent()).trim(), '3d 4h');
  assert.match(await badge.getAttribute('aria-label'), /no 5-hour limit/);
  await badge.screenshot({ path: path.join(shots, 'weekly-ring.png') });

  // the settings rows
  await page.evaluate(() => { location.hash = '#/settings/general'; });
  await page.locator('input[aria-label="Labels size"]').waitFor({ timeout: 20_000 });
  const fontOf = (selector) => page.evaluate((sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize), selector);
  const heightOf = (selector) => page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, selector);
  const rowLabel = '.set-row-text';
  const before = { font: await fontOf(rowLabel), height: await heightOf('.chat-row, .nav-item, .settings-nav button') };
  await page.evaluate(() => { localStorage.setItem('wf.labelPx', '17'); localStorage.setItem('wf.textPx', '21'); });
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.evaluate(() => { location.hash = '#/settings/general'; });
  const field = page.locator('input[aria-label="Labels size"]');
  await field.waitFor({ timeout: 20_000 });
  assert.equal(await field.inputValue(), '17');
  assert.ok(await fontOf(rowLabel) > before.font * 1.2, 'labels grew');
  const grown = await heightOf('.chat-row, .nav-item, .settings-nav button');
  assert.ok(grown >= before.height && grown <= before.height * 1.3, `a row grows only by what its letters need (${before.height} → ${grown})`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chat-zoom').trim()), '1.5');
  // the px field: typed past the bound takes the bound; − steps below the default
  await field.fill('40'); await field.press('Enter');
  assert.equal(await field.inputValue(), '17');
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Labels size smaller' }).click();
  assert.equal(await field.inputValue(), '11');
  assert.ok(await fontOf(rowLabel) < before.font, 'smaller than the default');
  await page.screenshot({ path: path.join(shots, 'labels-11.png') });
  await field.fill('17'); await field.press('Enter');
  for (const [width, height, scheme, name] of [[1280, 820, 'light', 'settings-light'], [1280, 820, 'dark', 'settings-dark'], [640, 480, 'light', 'settings-640'], [390, 844, 'dark', 'settings-phone']]) {
    await size(width, height);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name}: no sideways scroll`);
  }
  await size(1280, 820);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => { location.hash = '#/settings/scheduled'; }); // the Scheduled page (owner 21.11.2026) at the large sizes
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'scheduled-large.png') });
  const add = page.getByRole('button', { name: /^New/ }).first();
  if (await add.count()) { await add.click(); await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, 'scheduled-new.png') }); await page.keyboard.press('Escape'); }
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'home-large.png') });
  assert.deepEqual(errors, []);
});
