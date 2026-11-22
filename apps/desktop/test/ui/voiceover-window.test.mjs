// Electron window check of the voice-over recorder (record block with `video` + `cues`; task_2xr88cmc, 17.11.2026) with the
// demo engine and Chromium's fake microphone in an isolated profile:
//   * a to-do from an agent's ui block opens on My day with the video on its first frame, the lines listed and Start microphone;
//   * Record counts 3-2-1, then the video plays SILENT while the current line changes with the video's time (the bar and the
//     pace stand beside it), and the take ends with the video;
//   * the take is a WAV that starts at the video's first frame (its length is the video's, not the countdown's), plays beside
//     the video, Retake starts over, Send hands it to the agent with its file and the video's id;
//   * light, dark and phone width: nothing overflows, no renderer errors.
// The video is made in the window itself (a canvas, MediaRecorder), so no file is kept in the repository.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const CUES = [
  { text: 'Welcome to the valley.', start: 0, end: 2 },
  { text: 'Here the camera turns to the left.', start: 2, end: 4 },
  { text: 'Thanks for watching.', start: 4, end: 5 },
];
const VIDEO_SECONDS = 5;

test('voice-over: video silent, lines follow its time, the take is a WAV from the first frame, Send hands it back', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-voiceover-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root, '--use-fake-device-for-media-stream'],
    cwd: root, timeout: 60_000,
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  await size(1280, 900);
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  await rpc.call('events.subscribe', { topics: ['tasks'] });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Voice-over', agentIds: [manager.id] });

  // The video: five seconds of a canvas that shows the second, recorded in the window.
  const base64 = await page.evaluate(async (seconds) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(20), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const done = new Promise((resolve) => { recorder.onstop = resolve; });
    const began = performance.now();
    recorder.start(250);
    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - began) / 1000;
        context.fillStyle = `hsl(${Math.floor(elapsed) * 70}, 60%, 40%)`;
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#fff'; context.font = '48px sans-serif';
        context.fillText(elapsed.toFixed(1), 100, 100);
        if (elapsed >= seconds) resolve(); else setTimeout(tick, 50);
      };
      tick();
    });
    recorder.stop();
    await done;
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }, VIDEO_SECONDS);
  const videoPath = path.join(profile, 'speak-to-this.webm');
  await writeFile(videoPath, Buffer.from(base64, 'base64'));
  const video = await rpc.call('files.uploadPath', { path: videoPath });
  assert.match(video.id, /^[a-f0-9]{64}$/);

  const block = { type: 'record', id: 'drone-voice', video: video.id, cues: CUES, todo: true, instructions: 'Speak calmly, one line at a time.' };
  await rpc.call('messages.send', { conversationId: chat.id, body: `Please speak to this video [[ui:${JSON.stringify(block)}]]` });
  const todo = await rpc.waitFor('task.upserted', (item) => item.assigneeKind === 'human' && item.widget?.type === 'record', 90_000);
  assert.equal(todo.widget.mode, 'audio', 'a voice-over records the voice only');
  assert.equal(todo.widget.cues.length, 3);

  const openOnHome = async () => {
    await go('#/home');
    const item = page.locator(`.day-view .todo-item[data-task-id="${todo.id}"]`);
    await item.waitFor({ timeout: 20_000 });
    if ((await item.locator('.todo-open').getAttribute('aria-expanded')) !== 'true') await item.locator('.todo-open').click();
    return item;
  };
  const item = await openOnHome();
  const widget = item.locator('.w-voice');
  await widget.waitFor({ timeout: 20_000 });
  const picture = widget.locator('video.w-voice-video');
  await picture.waitFor();
  await page.waitForFunction((el) => el && el.readyState >= 2, await picture.elementHandle(), { timeout: 20_000 });
  assert.equal(await picture.evaluate((el) => el.muted), true, 'the video is silent');
  assert.equal(await widget.locator('.w-voice-lines li').count(), 3, 'the lines are listed');
  assert.equal(await widget.getByRole('button', { name: 'Start microphone' }).isEnabled(), true);
  await shot('voiceover-01-start-light');

  await widget.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await widget.getByRole('button', { name: 'Record', exact: true }).waitFor({ timeout: 20_000 });
  await shot('voiceover-02-ready-light');
  await widget.getByRole('button', { name: 'Record', exact: true }).click();
  const count = widget.locator('.w-voice-count');
  await count.waitFor({ timeout: 5_000 });
  assert.equal((await count.textContent())?.trim(), '3', 'the countdown starts at 3');
  await shot('voiceover-03-countdown-light');

  // The lines follow the video's time.
  const now = widget.locator('[data-testid="voice-now"]');
  const seen = [];
  const watch = setInterval(() => { void now.textContent().then((text) => { const line = (text ?? '').trim(); if (line && seen.at(-1) !== line) seen.push(line); }, () => undefined); }, 120);
  await widget.locator('.w-voice-bar').waitFor({ timeout: 15_000 });
  await now.filter({ hasText: CUES[1].text }).waitFor({ timeout: 10_000 });
  assert.equal(await picture.evaluate((el) => el.muted), true, 'still silent while recording');
  assert.equal(await widget.locator('.w-voice-bar').getAttribute('role'), 'progressbar');
  assert.match((await widget.locator('.w-voice-meta').textContent()) ?? '', /s left/);
  await shot('voiceover-04-recording-light');
  const take = widget.locator('audio[aria-label="Your voice"]');
  await take.waitFor({ timeout: 30_000 });
  clearInterval(watch);
  assert.deepEqual(seen.filter((line) => CUES.some((cue) => cue.text === line)), CUES.map((cue) => cue.text), 'the three lines came in order');
  assert.equal(await picture.evaluate((el) => el.paused), true, 'the video stopped at its end');

  // The take is as long as the video, not as long as the countdown and the video (its header is read by the audio element;
  // the page cannot fetch its own blob: URL, connect-src has no blob:).
  const takeSeconds = await take.evaluate((el) => new Promise((resolve) => { const done = () => resolve(el.duration); if (el.readyState >= 1) done(); else el.addEventListener('loadedmetadata', done, { once: true }); }));
  assert.ok(takeSeconds > VIDEO_SECONDS - 0.6 && takeSeconds < VIDEO_SECONDS + 1.8, `the take is about the video's length (${takeSeconds.toFixed(2)} s for ${VIDEO_SECONDS} s of video; the countdown is not in it)`);
  await shot('voiceover-05-recorded-light');

  // Retake starts over; the second take is sent.
  await widget.getByRole('button', { name: 'Retake', exact: true }).click();
  await widget.getByRole('button', { name: 'Record', exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await take.count(), 0, 'the first take is gone');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('voiceover-06-ready-dark');
  await widget.getByRole('button', { name: 'Record', exact: true }).click();
  await take.waitFor({ timeout: 40_000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await widget.getByRole('button', { name: 'Send', exact: true }).click();
  await rpc.waitFor('task.upserted', (changed) => changed.id === todo.id && changed.status === 'done', 30_000);
  const messages = await rpc.call('messages.list', { conversationId: chat.id, limit: 100 });
  const receipt = messages.find((message) => message.kind === 'answer' && message.taskId === todo.id);
  assert.equal(receipt?.attachments.length, 1);
  assert.match(receipt.attachments[0].name, /^voice-over-.*\.wav$/);
  assert.equal(receipt.attachments[0].mime, 'audio/wav');
  assert.match(receipt.body, /^Recorded \d+:\d\d/);
  // The file the agent got: a 16-bit mono WAV whose header says exactly how much follows.
  const read = await rpc.call('files.read', { id: receipt.attachments[0].fileId });
  const wav = Buffer.from(read.dataBase64, 'base64');
  assert.deepEqual([wav.toString('latin1', 0, 4), wav.toString('latin1', 8, 12), wav.readUInt16LE(22), wav.readUInt16LE(34)], ['RIFF', 'WAVE', 1, 16]);
  assert.equal(wav.length, 44 + wav.readUInt32LE(40));
  const sentSeconds = wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24);
  assert.ok(sentSeconds > VIDEO_SECONDS - 0.6 && sentSeconds < VIDEO_SECONDS + 1.8, `the file is about the video's length (${sentSeconds.toFixed(2)} s)`);

  // Phone width: the stage and the buttons fit.
  const second = await rpc.call('messages.send', { conversationId: chat.id, body: `One more [[ui:${JSON.stringify({ ...block, id: 'drone-voice-2' })}]]` });
  assert.ok(second.seq > 0);
  const phoneTodo = await rpc.waitFor('task.upserted', (changed) => changed.assigneeKind === 'human' && changed.widget?.type === 'record' && changed.id !== todo.id && changed.status !== 'done', 90_000);
  await size(390, 860);
  await go('#/home');
  const phoneItem = page.locator(`.day-view .todo-item[data-task-id="${phoneTodo.id}"]`);
  await phoneItem.waitFor({ timeout: 20_000 });
  if ((await phoneItem.locator('.todo-open').getAttribute('aria-expanded')) !== 'true') await phoneItem.locator('.todo-open').click();
  const phoneWidget = phoneItem.locator('.w-voice');
  await phoneWidget.getByRole('button', { name: 'Start microphone', exact: true }).waitFor({ timeout: 20_000 });
  await phoneWidget.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await phoneWidget.getByRole('button', { name: 'Record', exact: true }).click();
  await phoneWidget.locator('.w-voice-bar').waitFor({ timeout: 15_000 });
  await shot('voiceover-07-recording-phone-light');
  assert.ok(await phoneWidget.evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1), 'the voice-over fits the phone width');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no sideways scroll');
  await phoneWidget.getByRole('button', { name: 'Stop', exact: true }).click();
  await phoneWidget.locator('audio[aria-label="Your voice"]').waitFor({ timeout: 10_000 });
  await shot('voiceover-08-recorded-phone-light');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
