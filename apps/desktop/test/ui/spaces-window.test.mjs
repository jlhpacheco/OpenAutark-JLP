// Electron window check of spaces (P05 areas) with the demo engine in an isolated test profile:
//   * the seed Manager has no space; hiring the secretary and a video editor (reports of the
//     Manager) creates "Private" and "Personal brand";
//   * the Team sidebar (B-085: reports always stay under their manager; only top agents are grouped by space): one
//     group – headed "Agents" only when People stand beside it – with the Manager and, under it, the area agents,
//     whose rows name their space first on the status line ("Private", "Personal brand"); the desktop #/team page
//     shows the same tree read-only and open (no carets);
//   * spaces stay system data – a rename and an archive through the RPCs show on the rows (the archived space's agents
//     stay on the team under the Manager, without a space name); a new space without agents adds no group;
//   * screenshots light, dark and 640×480; no renderer errors.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('spaces: created by hiring, named on the Team rows; rename/add/archive through the RPCs (no Settings › Agents)', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-spaces-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('events.subscribe', { topics: ['org'] });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'seed Manager exists');
  assert.equal(manager.spaceId, undefined, 'the seed Manager has no space');
  assert.deepEqual(await rpc.call('spaces.list'), [], 'no spaces before the first area hire');

  const secretary = await rpc.call('agents.create', { template: 'secretary', name: 'Ella', managerId: manager.id });
  const editor = await rpc.call('agents.create', { template: 'video-editor', name: 'Jonas', managerId: manager.id });
  const names = (await rpc.call('spaces.list')).map((space) => space.name).sort();
  assert.deepEqual(names, ['Personal brand', 'Private']);
  assert.ok(secretary.spaceId && editor.spaceId && secretary.spaceId !== editor.spaceId);

  // The Team sidebar: one group with the Manager; the area agents stay under it and name their space on the row.
  const groups = page.locator('.team-nav .team-space:not(.team-people):not(.team-archived)');
  const heading = (name) => page.locator('.team-nav .team-space-title', { hasText: name });
  const row = (name) => page.locator('.team-nav .team-row', { has: page.locator('.row-title', { hasText: name }) });
  await go('#/team');
  await groups.first().locator('.team-row .row-title', { hasText: 'Manager' }).waitFor({ timeout: 15_000 });
  const expandAll = async () => { for (let i = 0; i < 5; i += 1) { const closed = page.locator('.team-nav .team-caret[aria-expanded="false"]'); if (!(await closed.count())) break; await closed.first().click(); } };
  await expandAll();
  await row('Ella').waitFor({ timeout: 15_000 });
  assert.equal(await groups.count(), 1, 'reports stay under their manager: no group per space');
  const hasPeople = (await page.locator('.team-nav .team-people').count()) > 0;
  assert.deepEqual(await groups.nth(0).locator(':scope > .team-space-title').allTextContents(), hasPeople ? ['Agents'] : [], 'headed Agents only beside People');
  assert.equal(await heading('Private').count(), 0, 'no space heading');
  assert.equal(await heading('Personal brand').count(), 0, 'no space heading');
  assert.equal((await groups.nth(0).locator('.team-row .row-title').first().textContent())?.trim(), 'Manager');
  assert.equal(await row('Ella').count(), 1, 'the secretary is on the team');
  assert.equal(await row('Jonas').count(), 1, 'the video editor is on the team');
  assert.equal(await groups.nth(0).locator('.team-reports .row-title', { hasText: 'Ella' }).count(), 1, 'the secretary sits under the Manager');
  assert.equal((await row('Ella').locator('.team-row-space').textContent())?.trim(), 'Private', "the secretary's row names its space");
  assert.equal((await row('Jonas').locator('.team-row-space').textContent())?.trim(), 'Personal brand', "the video editor's row names its space");
  // The desktop Team page: the same tree, read-only and fully open.
  assert.ok((await page.locator('.team-view .team-overview .team-row').count()) >= 3, 'the main page shows the whole tree');
  assert.equal(await page.locator('.team-view .team-caret').count(), 0, 'read-only: no carets in the main zone');
  await shot('spaces-01-team-light');

  // Spaces are system data (renamed by managers through spaces.save, archived through spaces.archive).
  const brand = (await rpc.call('spaces.list')).find((space) => space.name === 'Personal brand');
  await rpc.call('spaces.save', { id: brand.id, name: 'Brand studio' });
  await rpc.waitFor('space.upserted', (space) => space.name === 'Brand studio', 15_000);
  await rpc.call('spaces.save', { name: 'Podcast', kind: 'custom' });
  await rpc.waitFor('space.upserted', (space) => space.name === 'Podcast' && space.kind === 'custom', 15_000);

  // Archive Private: the secretary stays on the team, back under the Manager.
  await rpc.call('spaces.archive', { id: secretary.spaceId });
  await rpc.waitFor('space.upserted', (space) => space.id === secretary.spaceId && Boolean(space.archivedAt), 15_000);
  const active = (await rpc.call('spaces.list')).filter((space) => !space.archivedAt).map((space) => space.name).sort();
  assert.deepEqual(active, ['Brand studio', 'Podcast']);
  const still = (await rpc.call('agents.list')).find((agent) => agent.id === secretary.id);
  assert.equal(still?.archivedAt, undefined, 'archiving a space never archives its agents');

  await expandAll();
  await row('Jonas').locator('.team-row-space', { hasText: /^Brand studio$/ }).waitFor({ timeout: 15_000 }); // the rename shows on the row
  await row('Ella').first().waitFor({ timeout: 10_000 }); // the secretary stays on the team
  await page.waitForFunction(() => {
    const ella = [...document.querySelectorAll('.team-nav .team-row')].find((el) => el.querySelector('.row-title')?.textContent?.trim() === 'Ella');
    return Boolean(ella) && !ella.querySelector('.team-row-space');
  }, undefined, { timeout: 15_000 }); // the archived space is no longer named on its row
  assert.equal(await groups.count(), 1, 'the new space without agents adds no group');
  await shot('spaces-04-team-after-archive-light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('spaces-05-team-dark');
  await size(640, 480);
  await shot('spaces-08-team-640x480');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
