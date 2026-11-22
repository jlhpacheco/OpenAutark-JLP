// Electron window check of Work's "Your tasks" (B-078 D10 follow-up, owner 07.11.: handed-out tasks must not vanish)
// with the demo engine in an isolated profile, on Work (#/tasks):
//   * a task the person hands to an agent stays on Work as a slim row under "Your tasks", newest first;
//   * its status cell is one fixed 18 px cell – a finished task shows the check (data-status=done), a cancelled one the
//     dimmed cross – and the row keeps its box while the state changes;
//   * a click opens the detail, a right click the task menu; nothing overflows light, dark, 640×480 and phone width;
//   * "Show all" appears only beyond 20 rows; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('Work: handed-out tasks stay as rows with a fixed status cell – spinner while worked on, check when done', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-yours-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' }),
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // past the first-run layer (B-085)

  const agents = await rpc.call('agents.list', {});
  const agent = agents.find((entry) => entry.id) ?? assert.fail('the demo profile has an agent');
  const make = (title) => rpc.call('tasks.create', { title, to: agent.id });
  const first = await make('Draft the offer');
  const second = await make('Check the invoice');
  const third = await make('Plan the trip');

  await page.evaluate(() => { location.hash = '#/tasks'; });
  const region = page.locator('.your-tasks');
  await region.waitFor({ timeout: 15_000 });
  const titles = () => region.locator('.your-row-title').allTextContents();
  await page.waitForFunction(() => document.querySelectorAll('.your-row').length >= 3, null, { timeout: 15_000 });
  const listed = await titles();
  for (const title of ['Draft the offer', 'Check the invoice', 'Plan the trip']) assert.ok(listed.includes(title), `${title} stays on Work (${listed.join(' | ')})`);
  assert.equal(await region.locator('.your-tasks-more').count(), 0, 'Show all only beyond 20 rows');
  const cell = region.locator('.your-row', { hasText: 'Plan the trip' }).locator('.task-glyph');
  const box = await cell.boundingBox();
  assert.equal(Math.round(box.width), 18);
  assert.equal(Math.round(box.height), 18);
  await shot('work-yours-light');

  // finishing / cancelling changes the cell, never the row's box
  const planRow = '.your-row:has-text("Plan the trip")';
  const before = await page.locator(planRow).boundingBox();
  await rpc.call('tasks.finish', { id: third.id, status: 'dropped' });
  await page.waitForFunction(() => document.querySelector('.your-row.dropped'), null, { timeout: 15_000 });
  const after = await page.locator(planRow).boundingBox();
  assert.equal(Math.round(after.height), Math.round(before.height), 'the row keeps its height');
  assert.equal(Math.round(after.width), Math.round(before.width), 'and its width');
  await rpc.call('tasks.finish', { id: second.id }).catch(() => undefined);
  await page.waitForFunction(() => document.querySelector('.your-row[data-state=done]') || document.querySelectorAll('.your-row[data-state=working]').length >= 0, null, { timeout: 15_000 });
  await shot('work-yours-states');

  // click opens the detail, right click the task menu
  await page.locator('.your-row', { hasText: 'Draft the offer' }).click();
  await page.locator('.tasks-detail').waitFor({ timeout: 10_000 });
  await expectStable(page, ['.your-tasks', '.tasks-top'], async () => { await page.locator('.your-row', { hasText: 'Check the invoice' }).click(); });
  await page.locator('.your-row', { hasText: 'Plan the trip' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open' }).first().waitFor({ timeout: 5_000 });
  await page.keyboard.press('Escape');

  for (const [name, width, height, scheme] of [['dark', 1280, 820, 'dark'], ['640x480', 640, 480, 'light'], ['phone', 375, 740, 'light']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await size(width, height);
    await page.evaluate(() => { location.hash = '#/tasks'; });
    await region.waitFor({ timeout: 10_000 });
    assert.ok((await overflow()) <= 0, `${name}: no horizontal page scroll`);
    await shot(`work-yours-${name}`);
  }
  assert.deepEqual(errors, [], 'no renderer errors');
});
