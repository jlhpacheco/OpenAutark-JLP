// Electron window check of the recorder's device choice and take guard (F07) with Chromium's
// fake capture devices (four fake cameras) and the demo engine in an isolated profile:
//   * a video record to-do on the Tasks page (For you → its detail, the tool beside the list):
//     "Start camera" shows the preview and a "Camera" select with every camera;
//     picking another colour camera is remembered and the preview reopens;
//   * Record → (time shows once the recorder really records) → Stop gives a take; five more to-dos
//     arriving leave the detail and the take on screen (the list never moves the detail);
//   * closing the detail asks "Discard recording?" – Cancel keeps the take;
//   * after another to-do's detail, another view, at phone width and after a reload the to-do offers
//     "Resume unsent recording", which brings the take back; "Discard" in the dialog drops it for good;
//   * leaving the view while still recording keeps the part recorded so far (offered with its
//     duration, resumable); Retake drops the stored copy.
// Screenshots light, dark and phone width; no renderer errors.
// Chromium runs the fake cameras in its "Video Capture" utility process, which crashes now and then
// on a busy PC (0xC0000005, seen in about one run in three, also between takes). The open camera
// track then ends and the widget ends the take there – its right reaction to a lost camera – so a
// step fails without any app fault. Only when main saw that crash is the whole check repeated once in a
// fresh app; every other failure, and a second crash, fails the test.
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
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/** A fresh app in its own profile; `captureCrashes()` lists the Video Capture service crashes main saw. */
async function launch() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-recorder-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath,
    // Chromium's fake capture: four fake cameras and a fake microphone, no real device is opened.
    // The fake cameras cycle pixel formats (I420, Y16, MJPEG, I420). A pick of fake_device_1, the
    // 16-bit depth camera, reopened fake_device_0 – most likely getUserMedia does not pick a depth
    // camera as a colour camera and the `ideal` deviceId keeps the default (inferred, not observed).
    // So the switch goes to fake_device_3, an I420 camera like the default; the track label below
    // shows which camera is really open.
    args: [root, '--use-fake-device-for-media-stream=device-count=4'],
    cwd: root, timeout: 60_000,
    env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' }),
  });
  await app.evaluate(({ app: main }) => {
    globalThis.captureCrashes = [];
    main.on('child-process-gone', (_event, details) => {
      if (/video_capture/i.test(details.serviceName ?? '')) globalThis.captureCrashes.push(`${details.reason} ${details.exitCode}`);
    });
  });
  const run = { app, profile, shots, rpc: null };
  run.captureCrashes = () => app.evaluate(() => globalThis.captureCrashes).catch(() => []);
  run.close = async () => {
    run.rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  };
  return run;
}

test('recorder: device select, take guard and "Resume unsent recording"', { timeout: 480_000 }, async (t) => {
  for (let attempt = 1; ; attempt++) {
    const run = await launch();
    try {
      await recorderCheck(run);
      t.diagnostic(`screenshots: ${run.shots}`);
      return;
    } catch (error) {
      const crashes = await run.captureCrashes();
      if (attempt > 1 || !crashes.length) throw error;
      t.diagnostic(`attempt ${attempt}: Chromium's Video Capture service crashed (${crashes.join('; ')}) – once more in a fresh app`);
    } finally {
      await run.close();
    }
  }
});

async function recorderCheck(run) {
  const { app, profile, shots } = run;
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 860);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = await runtimeInfo(profile);
  const rpc = await connect(info.port, info.token, 'cli');
  run.rpc = rpc;
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // B-044: past the first-run layer (first-run-window covers it)

  const recording = await rpc.call('tasks.create', { title: 'Record the intro video for the course', widget: { type: 'record', mode: 'video', instructions: 'Record the intro video for the course' } });
  assert.equal(recording.widget?.type, 'record');
  assert.equal(recording.widget?.mode, 'video');
  const { task: other } = await rpc.call('tasks.quickCreate', { text: 'Water the plants' });
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const tasksPage = page.locator('.tasks-page:not(.in-pane)');
  const row = (task) => tasksPage.locator(`ul[aria-label="For you"] .todo-row[data-task-id="${task.id}"]`);
  const detail = tasksPage.locator('.task-detail');
  // The record widget is the detail's tool; its own buttons are looked up there (the thread below has a composer).
  const item = detail.locator('.todo-tool');
  const playback = item.locator('video.w-record-playback');
  /** Tasks › For you, then a click on the to-do's row: its detail. */
  const open = async (task) => {
    await go('#/tasks');
    await row(task).waitFor({ timeout: 15_000 });
    await row(task).locator('.todo-open').click();
    await detail.locator('.detail-title', { hasText: task.title }).waitFor({ timeout: 15_000 });
  };
  const closeDetail = () => detail.locator('.detail-top').getByRole('button', { name: 'Close' }).click();

  // Device choice: four fake cameras → the select appears in the preview's row.
  await open(recording);
  await item.getByRole('button', { name: 'Start camera' }).click();
  await item.locator('.w-record-preview').waitFor({ timeout: 20_000 });
  const select = item.getByRole('combobox', { name: 'Camera' });
  await select.waitFor({ timeout: 10_000 });
  await select.click();
  const list = page.getByRole('listbox', { name: 'Camera' });
  await list.waitFor();
  assert.equal(await list.getByRole('option').count(), 4, 'every fake camera is offered');
  const otherCamera = list.getByRole('option', { name: 'fake_device_3', exact: true });
  assert.equal(await otherCamera.getAttribute('aria-selected'), 'false', 'the default camera is in use first');
  const label = (await otherCamera.textContent()).trim();
  await otherCamera.click();
  await item.getByRole('button', { name: 'Record', exact: true }).waitFor({ timeout: 20_000 });
  await item.locator('.w-record-preview').waitFor();
  // The reopened preview's track names the camera that is really open.
  const preview = await item.locator('video.w-record-preview').elementHandle();
  const opened = await page.waitForFunction(({ video, expected }) => {
    const label = video?.srcObject?.getVideoTracks()[0]?.label;
    return label === expected ? label : false;
  }, { video: preview, expected: label }, { timeout: 10_000 });
  assert.equal(await opened.jsonValue(), label, 'the picked camera is open');
  assert.equal((await select.locator('.select-value').textContent()).trim(), label, 'the picked camera is in use');
  assert.ok(await page.evaluate(() => localStorage.getItem('wf.recorder.device.video')), 'and remembered for the next recording');
  await shot('recorder-01-device-light');

  // A take: Record → Stop → playback. The status says "Starting…" until the recorder really records
  // (its encoder can take a second or more to start on a busy PC); the time shows from then on.
  const recordingTime = item.locator('.w-record-status', { hasText: /^\d+:\d\d/ });
  await item.getByRole('button', { name: 'Record', exact: true }).click();
  await recordingTime.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await item.getByRole('button', { name: 'Stop', exact: true }).click();
  await playback.waitFor({ timeout: 15_000 });

  // Five more to-dos arrive in For you; the detail beside the list keeps the take on screen.
  const more = [];
  for (let i = 1; i <= 5; i++) more.push(await rpc.call('tasks.create', { conversationId: recording.conversationId, title: `Check invoice ${i}`, priority: 2 }));
  await tasksPage.locator('.todo-row', { hasText: 'Check invoice 5' }).waitFor({ timeout: 15_000 });
  assert.ok(await playback.isVisible(), 'still on screen');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('recorder-02-pinned-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const task of more) await rpc.call('tasks.delete', { id: task.id });

  // Closing the detail asks first; Cancel keeps the take.
  await closeDetail();
  const dialog = page.locator('dialog[open]');
  await dialog.getByText('Discard recording?').waitFor({ timeout: 10_000 });
  await shot('recorder-03-discard-light');
  await dialog.locator('.dialog-actions button', { hasText: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await playback.isVisible(), 'Cancel keeps the take');

  // Another to-do's detail and back: the take waits in IndexedDB.
  const resume = item.getByRole('button', { name: 'Resume unsent recording' });
  await row(other).locator('.todo-open').click();
  await detail.locator('.detail-title', { hasText: other.title }).waitFor({ timeout: 15_000 });
  await playback.waitFor({ state: 'detached', timeout: 10_000 });
  await row(recording).locator('.todo-open').click();
  await resume.waitFor({ timeout: 10_000 });

  // Another view and back: the take still waits.
  await go('#/team');
  await item.waitFor({ state: 'detached', timeout: 10_000 });
  await open(recording);
  await resume.waitFor({ timeout: 10_000 });
  await shot('recorder-04-resume-light');

  // Phone width (one column: the detail in the list's place, mounted again): the offer is still there and fits.
  await size(420, 860);
  await page.locator('.mobile-shell .tasks-page .task-detail').waitFor({ timeout: 15_000 });
  await resume.waitFor({ timeout: 10_000 });
  assert.ok(await resume.evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1), 'the offer fits the phone width');
  await shot('recorder-05-phone');
  await size(1280, 860);

  // A reload keeps it too; Resume brings the take back.
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await open(recording);
  await resume.waitFor({ timeout: 10_000 });
  await resume.click();
  await playback.waitFor({ timeout: 10_000 });

  // Discard in the dialog drops it for good.
  await closeDetail();
  await dialog.getByText('Discard recording?').waitFor({ timeout: 10_000 });
  await dialog.locator('.dialog-actions button', { hasText: 'Discard' }).click();
  await dialog.waitFor({ state: 'detached' });
  await playback.waitFor({ state: 'detached', timeout: 10_000 });
  await detail.waitFor({ state: 'detached', timeout: 10_000 }); // the detail closed: the calendar again
  await open(recording);
  await item.getByRole('button', { name: 'Start camera' }).waitFor({ timeout: 10_000 });
  assert.equal(await resume.count(), 0, 'nothing is left to resume');

  // Leaving while still recording: the widget finishes the take and keeps it (recordTake).
  await item.getByRole('button', { name: 'Start camera' }).click();
  await item.getByRole('button', { name: 'Record', exact: true }).click({ timeout: 20_000 });
  await item.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 10_000 });
  await recordingTime.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2200);
  await go('#/team');
  await item.waitFor({ state: 'detached', timeout: 10_000 });
  await open(recording);
  await resume.waitFor({ timeout: 10_000 });
  const unsent = (await item.locator('.w-record-resume').textContent()).trim();
  assert.match(unsent, /^Unsent recording · \d+:\d\d$/);
  assert.notEqual(unsent, 'Unsent recording · 0:00', 'the part recorded before leaving is kept');
  await resume.click();
  await playback.waitFor({ timeout: 10_000 });
  await item.getByRole('button', { name: 'Retake' }).click();
  await item.getByRole('button', { name: 'Record', exact: true }).waitFor({ timeout: 20_000 });
  await item.getByRole('button', { name: 'Cancel', exact: true }).click();
  await go('#/team');
  await item.waitFor({ state: 'detached', timeout: 10_000 });
  await open(recording);
  await item.getByRole('button', { name: 'Start camera' }).waitFor({ timeout: 10_000 });
  assert.equal(await resume.count(), 0, 'Retake dropped the stored take');

  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
}
