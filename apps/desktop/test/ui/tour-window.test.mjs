// Electron window check of the feedback tour (B-055 Q5) with the demo engine in an isolated test profile:
//   * a fresh profile shows the first run's choice card (B-085, step 'tour'); its "Watch how it works" opens the
//     player in the replay dialog: the poster (the filled example scene with a big Play button), the title row with
//     × (on screen down to phone width, no Skip, no Connect), the caption line and the control bar;
//   * Play runs it (the time grows); nothing in the player moves while it plays (expectStable); Space pauses
//     (the time stands still – nothing runs), → steps 5 s, Home goes back to the start;
//   * seeking on the scrubber shows each part of the shipped flow (re-cut 16.11.2026, F11/F15) at once: the cell's
//     tooltip "Feedback – Ctrl+Shift+F, hold to talk", the frozen screen with the dock at its foot and the cursor's tip
//     on the cell, the pen's black stroke on the frozen screen over the e-mail and the phone number, the dock's mic
//     listening, the transcript in the field, then Send: the dock gone and the status line's "Feedback sent · No. …";
//   * End shows the end card; Continue closes the dialog and the choice card is still there (step 'tour');
//   * the command palette's "Watch how it works" (openTour) opens the same player at its poster again; Esc closes it;
//     in the phone layout it plays the phone's tour (a phone-shaped stage, the dock as the bottom edge);
//   * screenshots light, dark, 640×480 and phone width; no horizontal page scroll; no renderer errors.
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
import { CELL_TIP, SENT_LINE, TOURS, TRANSCRIPT } from '../../src/ui/tour/timeline.ts';

const TOUR = TOURS.desktop;
const DURATION = TOUR.duration;
const PAINT_SPAN = TOUR.paintSpan;
const firstOn = (name) => TOUR.firstOn(name);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('feedback tour: choice card → dialog poster → play → seek through every part → Continue; replay from the palette', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-tour-'));
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
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const noScroll = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${label} (${overflow}px)`);
  };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  assert.deepEqual((await rpc.call('settings.get')).onboarding, { completed: false, step: 'tour' }, 'a new install starts with the choice card (step id tour)');

  // The choice card's "Watch how it works" opens the player in its dialog: the filled scene, the big Play, × – no
  // Skip, no Connect.
  const choice = page.locator('.first-run-card[data-card="first-run-choice"]');
  await choice.waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('.first-run-view .tour-player').count(), 0, 'no video in the first-run layer');
  await choice.getByRole('button', { name: 'Watch how it works' }).click();
  const dialog = page.locator('dialog.tour-dialog[open]');
  await dialog.waitFor({ timeout: 5_000 });
  const player = dialog.locator('.tour-player');
  assert.equal(await player.getAttribute('data-phase'), 'poster');
  assert.ok(await player.getByRole('button', { name: 'Play' }).first().isVisible());
  assert.ok(await player.locator('.tour-top').getByRole('button', { name: 'Close' }).isVisible(), 'the × in the title row');
  assert.equal(await player.getByRole('button', { name: 'Skip' }).count(), 0);
  assert.equal(await player.getByRole('button', { name: /Connect/ }).count(), 0, 'the dialog only plays');
  assert.ok(await player.locator('.tour-scene > .tour-app .tour-feedback-cell').isVisible(), 'the scene shows the feedback cell');
  assert.match(await player.locator('.tour-scene').textContent(), /anna\.meyer@example\.com/, 'example private details in the scene');
  await shot('tour-01-poster-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-02-poster-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Play: the time runs; nothing in the player moves.
  const time = async () => Number(await player.getAttribute('data-time'));
  const frame = ['.tour-top', '.tour-close', '.tour-stage-box', '.tour-caption', '.tour-controls', '.tour-time', '.tour-scrubber', '.tour-control'];
  await expectStable(page, frame, async () => {
    await player.locator('.tour-play').click();
    await page.waitForTimeout(1500);
  });
  assert.equal(await player.getAttribute('data-phase'), 'playing');
  const running = await time();
  assert.ok(running > 800, `the tour runs (${running} ms)`);
  // Space pauses: nothing runs any more; → steps 5 s; Home goes back.
  await page.keyboard.press('Space');
  const paused = await time();
  await page.waitForTimeout(600);
  assert.equal(await time(), paused, 'paused: the time stands still');
  assert.equal(await player.getAttribute('data-phase'), 'paused');
  await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs((await time()) - Math.min(DURATION, paused + 5000)) <= 1, '→ steps 5 s');
  await page.keyboard.press('Home');
  assert.equal(await time(), 0);

  // Seeking on the scrubber: each part shows at once, the scene follows.
  const scrubber = player.locator('.tour-scrubber');
  const seek = async (ms) => {
    const box = await scrubber.boundingBox();
    await page.mouse.click(box.x + (box.width * ms) / DURATION, box.y + box.height / 2);
    await page.waitForTimeout(120);
  };
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const scale = async () => (await player.locator('.tour-stage-box').boundingBox()).width / 960;
  // the cursor's tip is the arrow's top-left corner (its svg)
  const tip = async () => { const box = await player.locator('.tour-cursor svg').boundingBox(); return { x: box.x, y: box.y }; };

  // the cell names its shortcut, then one click freezes the window: the shot at 1:1 with the dock at its foot
  await seek(firstOn('tip') + 600);
  assert.equal((await player.locator('.tour-tooltip').textContent()).trim(), CELL_TIP);
  await shot('tour-03-tooltip-light');
  await expectStable(page, frame, () => seek(firstOn('frozen') + 700));
  const frozen = player.locator('.tour-scene .tour-frozen');
  await frozen.waitFor({ timeout: 2_000 });
  const cell = await player.locator('.tour-scene > .tour-app .tour-feedback-cell').boundingBox();
  const sceneBox = await player.locator('.tour-scene').boundingBox();
  const dockBox = await player.locator('.tour-frozen .tour-dock').boundingBox();
  const k = await scale();
  assert.ok(Math.abs(sceneBox.y + sceneBox.height - (dockBox.y + dockBox.height) - 12 * k) < 3, 'the dock lies at the foot of the frozen screen');
  assert.ok(Math.abs(dockBox.x + dockBox.width / 2 - (sceneBox.x + sceneBox.width / 2)) < 3, 'centred');
  assert.ok(await player.locator('.tour-frozen .tour-feedback-cell.look-open').count() === 1, 'the cell drawn open over the frozen screen');
  const cellCenter = center(cell), at = await tip();
  assert.ok(Math.hypot(at.x - cellCenter.x, at.y - cellCenter.y) < 8 * k + 3, `the cursor's tip is on the cell (${JSON.stringify(at)} vs ${JSON.stringify(cellCenter)})`);
  const cursorBox = await player.locator('.tour-cursor svg').boundingBox();
  assert.ok(cursorBox.height / k > 45 && cursorBox.height / k < 60, 'a big cursor (≈ 52 scene units)');
  await shot('tour-04-frozen-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-04-frozen-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // hold the dock's mic: it listens; let go: the words come into the field
  await seek(firstOn('listen') + 900);
  assert.ok(await player.locator('.tour-dock .tour-mic.active').isVisible(), 'the mic listens while held');
  assert.match(await player.locator('.tour-caption').textContent(), /Listening/);
  await shot('tour-05-listening-light');
  await seek(firstOn('sent') - 900);
  assert.equal((await player.locator('.tour-field').textContent()).trim(), TRANSCRIPT);
  assert.match(await player.locator('.tour-rec-hint').textContent(), /^0:0\d – goes with the words\.$/);
  await shot('tour-06-transcript-light');

  await seek((PAINT_SPAN.start + PAINT_SPAN.end) / 2);
  await frozen.waitFor({ timeout: 2_000 });
  await shot('tour-08-painting-light');
  await seek(PAINT_SPAN.end + 300);
  const covered = await page.evaluate(() => {
    const ink = document.querySelector('.tour-frozen .tour-ink polyline');
    const stroke = Number(ink?.getAttribute('stroke-width') ?? 0);
    const rects = ['email', 'phone'].map((key) => document.querySelector(`.tour-frozen [data-private="${key}"]`)?.getBoundingClientRect());
    const svg = ink?.ownerSVGElement;
    const k = svg ? svg.getBoundingClientRect().width / 960 : 0;
    const points = (ink?.getAttribute('points') ?? '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
    const origin = svg?.getBoundingClientRect();
    const near = (x, y) => points.some(([px, py], i) => {
      if (i === 0) return false;
      const [ax, ay] = points[i - 1];
      const dx = px - ax, dy = py - ay, len = dx * dx + dy * dy;
      const lx = (x - origin.x) / k, ly = (y - origin.y) / k;
      const u = len ? Math.min(1, Math.max(0, ((lx - ax) * dx + (ly - ay) * dy) / len)) : 0;
      return Math.hypot(lx - ax - u * dx, ly - ay - u * dy) <= stroke / 2;
    });
    const misses = [];
    for (const rect of rects) {
      if (!rect) { misses.push('missing text'); continue; }
      for (let x = rect.left + 1; x < rect.right - 1; x += 1.5) for (let y = rect.top + rect.height * 0.2; y < rect.bottom - rect.height * 0.2; y += 1) if (!near(x, y)) misses.push([x, y]);
    }
    return { points: points.length, misses: misses.length, first: misses[0] ?? null, widths: rects.map((rect) => rect?.width) };
  });
  t.diagnostic(`paint check: ${JSON.stringify(covered)}`);
  assert.ok(covered.points > 50, 'a stroke was painted');
  assert.equal(covered.misses, 0, `the black stroke covers the e-mail and the phone number (${JSON.stringify(covered.first)})`);
  await shot('tour-09-painted-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-10-painted-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await seek(firstOn('sent') + 600);
  assert.equal((await player.locator('.tour-status-note').textContent()).trim(), SENT_LINE);
  assert.equal(await player.locator('.tour-frozen').count(), 0, 'Send closed the overlay at once');
  await shot('tour-11-sent-light');

  // 640×480 and phone width: the scene scales into its box, the controls stay on screen, nothing scrolls sideways.
  for (const [width, height, label] of [[640, 480, '640x480'], [420, 860, 'phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    const reachable = await page.evaluate(() => [...document.querySelectorAll('.tour-controls > *')].every((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    }));
    assert.ok(reachable, `every control is on screen and uncovered at ${label}`);
    const top = await page.evaluate(() => {
      const bar = document.querySelector('dialog.tour-dialog .tour-top')?.getBoundingClientRect();
      const box = document.querySelector('dialog.tour-dialog .tour-close')?.getBoundingClientRect();
      return Boolean(bar && box && box.left >= bar.left - 1 && box.right <= bar.right + 1 && box.top >= bar.top - 1 && box.bottom <= bar.bottom + 1);
    });
    assert.ok(top, `the × stays inside the title row at ${label}`);
    await seek((PAINT_SPAN.start + PAINT_SPAN.end) / 2);
    assert.ok(await player.locator('.tour-frozen .tour-dock').isVisible(), `the scrubber seeks at ${label}`);
    const stage = await player.locator('.tour-stage-box').boundingBox();
    const scene = await player.locator('.tour-scene').boundingBox();
    assert.ok(scene.width <= stage.width + 1 && scene.height <= stage.height + 1, `the scene fits its box at ${label}`);
    assert.ok(Math.abs(scene.width / scene.height - 1.6) < 0.01, `aspect kept at ${label} (the opening's computer tour)`);
    await shot(`tour-12-frozen-${label}`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(`tour-12-frozen-${label}-dark`);
    await page.emulateMedia({ colorScheme: 'light' });
    await noScroll(label);
  }
  await size(1280, 820);
  await page.waitForTimeout(400);

  // End: the end card with Continue; Continue closes the dialog, the choice card is still there.
  await player.locator('.tour-scrubber').focus();
  await page.keyboard.press('End');
  await player.locator('.tour-end').waitFor({ timeout: 2_000 });
  assert.equal(await player.getAttribute('data-phase'), 'ended');
  assert.match(await player.locator('.tour-end').textContent(), /Only the Teydra team can read your feedback – it is encrypted on your PC\./);
  await shot('tour-13-end-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-14-end-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await player.getByRole('button', { name: 'Continue' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5_000 });
  assert.ok(await choice.isVisible(), 'back on the choice card');
  assert.equal((await rpc.call('settings.get')).onboarding.step, 'tour', 'the video changes no step');
  await shot('tour-15-choice-light');

  // Replay from the command palette ("Watch how it works"): the same player in its dialog, at its poster again;
  // Esc closes it.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('.palette-input').fill('Watch how');
  await page.locator('.palette-row', { hasText: 'Watch how it works' }).first().click();
  await dialog.waitFor({ timeout: 5_000 });
  assert.equal(await dialog.locator('.tour-player').getAttribute('data-phase'), 'poster', 'each opening starts at the poster');
  assert.equal(await dialog.getByRole('button', { name: /Connect/ }).count(), 0, 'the replay only plays');
  await shot('tour-16-dialog-light');
  await dialog.locator('.tour-play').click();
  await page.waitForTimeout(1200);
  assert.ok(Number(await dialog.locator('.tour-player').getAttribute('data-time')) > 500, 'it plays in the dialog');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-17-dialog-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(420, 860);
  await page.waitForTimeout(500);
  await shot('tour-18-dialog-phone');
  await noScroll('dialog phone');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5_000 });
  // In the phone layout the replay plays the phone's tour: a phone-shaped stage, the dock as the bottom edge.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('.palette-input').fill('Watch how');
  await page.locator('.palette-row', { hasText: 'Watch how it works' }).first().click();
  await page.locator('dialog.tour-dialog.phone[open] .tour-player.phone').waitFor({ timeout: 5_000 });
  const phoneScene = await page.locator('dialog.tour-dialog .tour-scene.phone').boundingBox();
  assert.ok(Math.abs(phoneScene.width / phoneScene.height - 360 / 760) < 0.01, 'a phone-shaped scene');
  const phoneSeek = async (ms) => {
    const box = await page.locator('dialog.tour-dialog .tour-scrubber').boundingBox();
    await page.mouse.click(box.x + (box.width * ms) / TOURS.phone.duration, box.y + box.height / 2);
    await page.waitForTimeout(120);
  };
  await phoneSeek((TOURS.phone.paintSpan.start + TOURS.phone.paintSpan.end) / 2);
  const phoneDock = await page.locator('dialog.tour-dialog .tour-frozen .tour-dock').boundingBox();
  assert.ok(Math.abs(phoneDock.width - phoneScene.width) < 2, 'the dock is the phone\'s bottom edge');
  assert.ok(await page.locator('dialog.tour-dialog .tour-finger').count() === 1, 'a fingertip, not a cursor');
  await shot('tour-19-phone-tour');
  await noScroll('phone tour');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5_000 });
  await size(1280, 820);
  assert.equal((await rpc.call('settings.get')).onboarding.step, 'tour', 'the replay changes no setting');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
