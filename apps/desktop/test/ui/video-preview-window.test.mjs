// Electron window check of "Videos im Chat flüssig" (17.11.2026, Konrad task_d4pdwppg) with the real app, its real runtime and its real hidden preview window:
// a heavy video (WF_TEST_VIDEO – a real export, e.g. the 1080×1920 drone test video of 32 MB) is attached to a chat message; the runtime probes it, main's hidden preview
// window converts it to a light H.264/MP4 copy with its index in front, the runtime stores it as a blob of its own and links it (`media.previewFileId`, event
// media.upserted); the copy is no medium of its own in the library; GET /files/<copy> serves it with ranges (what the phone streams); and the pane's Video tab plays
// the copy, not the original, while Open still opens the original. Sizes before and after and the times are printed (t.diagnostic). Screenshots at 1280 and 390 px.
// Skipped without WF_TEST_VIDEO (the file is private, 30 MB; the logic is unit-tested without it: test/unit/media/preview.test.ts, test/unit/main/media-preview.test.ts).
// Run: npm run build && WF_TEST_VIDEO=<file.mp4> node --test test/ui/video-preview-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { durationLabel } from '../../src/ui/workspace/media-facts.ts';
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const VIDEO = process.env.WF_TEST_VIDEO ?? '';

/** The top-level boxes of an MP4 in its first `bytes` (names in order) – enough to see that the index stands in front. */
function boxes(bytes) {
  const names = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(at);
    names.push(bytes.subarray(at + 4, at + 8).toString('latin1'));
    if (size === 1) size = Number(bytes.readBigUInt64BE(at + 8));
    if (size === 0) break;
    at += size;
  }
  return names;
}

async function sha256(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

test('a heavy video in a chat gets a light preview copy that the Video tab plays, the phone\'s route serves with ranges, and the original stays', {
  skip: VIDEO ? false : 'needs WF_TEST_VIDEO=<a heavy .mp4>', timeout: 360_000,
}, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-video-preview-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows().find((entry) => entry.isVisible()) ?? BrowserWindow.getAllWindows()[0]; if (win.isMaximized()) win.unmaximize(); if (win.isFullScreen()) win.setFullScreen(false); win.setMinimumSize(320, 300); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  await size(1280, 800);
  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Cut review', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  const sourceBytes = (await stat(VIDEO)).size;
  const sent = Date.now();
  const original = await rpc.call('files.uploadPath', { path: VIDEO });
  assert.equal(original.size, sourceBytes);
  await rpc.call('messages.send', {
    conversationId: chat.id, body: 'The new cut',
    attachments: [{ fileId: original.id, name: original.name, mime: original.mime, size: original.size }],
  });

  // The runtime probes the video, queues it, main's hidden window converts it; one event carries the link.
  let row;
  for (let i = 0; i < 600 && !row?.previewFileId; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    row = (await rpc.call('media.list', { conversationId: chat.id, kind: 'video' })).find((entry) => entry.fileId === original.id);
  }
  assert.ok(row?.previewFileId, 'the preview copy was made and linked');
  const madeMs = Date.now() - sent;
  const copy = (await rpc.call('files.get', { id: row.previewFileId }).catch(() => undefined)) ?? { id: row.previewFileId };
  assert.deepEqual((await rpc.call('media.list', { conversationId: chat.id })).map((entry) => entry.fileId), [original.id], 'the copy is no medium of its own');
  assert.equal(row.fileId, original.id);
  assert.equal(row.size, sourceBytes, 'the original is as it was');

  // The phone's route: the copy with ranges; light; MP4 with its index in front.
  const get = (range, fileId = row.previewFileId) => fetch(`http://127.0.0.1:${info.port}/files/${fileId}`, { headers: { Authorization: `Bearer ${info.token}`, ...(range ? { Range: range } : {}) } });
  const whole = await get();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  const bytes = Buffer.from(await whole.arrayBuffer());
  const ranged = await get('bytes=0-1023');
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 1024);
  assert.deepEqual(boxes(bytes).slice(0, 2), ['ftyp', 'moov'], 'the index (moov) stands in front: playing starts at once');
  assert.ok(bytes.length < sourceBytes / 2, `lighter: ${bytes.length} of ${sourceBytes} bytes`);
  t.diagnostic(`${path.basename(VIDEO)}: ${sourceBytes} B → ${bytes.length} B (${(sourceBytes / bytes.length).toFixed(1)}×), copy linked ${madeMs} ms after the upload (probe + queue + conversion, in the background)`);

  const servedOriginal = await get(undefined, original.id);
  assert.equal(servedOriginal.status, 200, 'the original is still served by its own id');
  assert.equal(await sha256(servedOriginal.body), await sha256(createReadStream(VIDEO)), 'original download is byte-for-byte the input');
  assert.ok(row.durationMs > 0, 'the runtime learned the source duration');
  const clock = durationLabel(row.durationMs);

  // Mika's installed-build finding: the same bytes appear in a second chat, but the media row still
  // belongs to the first. Visit the second chat first, so the chip cannot rely on the first chat's cache.
  const forwarded = await rpc.call('chats.create', { title: 'Second cut review', agentIds: [manager.id] });
  await rpc.call('messages.send', {
    conversationId: forwarded.id, body: 'Same cut for a second reviewer',
    attachments: [{ fileId: original.id, name: original.name, mime: original.mime, size: original.size }],
  });
  assert.deepEqual(await rpc.call('media.list', { conversationId: forwarded.id, kind: 'video' }), [], 'the deduplicated video is not owned by this chat');
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, forwarded.id);
  const forwardedChip = page.locator('.attachments .file-chip-open', { hasText: original.name }).filter({ hasText: clock });
  await forwardedChip.waitFor({ timeout: 30_000 });
  await forwardedChip.click();
  const forwardedPlayer = page.locator('video.pane-video-player');
  await forwardedPlayer.waitFor({ timeout: 30_000 });
  assert.equal(await forwardedPlayer.getAttribute('src'), `wf-file://${row.previewFileId}`, 'opening the repeated attachment plays the same light copy, not an empty Video tab');
  await page.waitForFunction(() => { const v = document.querySelector('video.pane-video-player'); return v && v.readyState >= 1 && v.videoWidth > 0; }, null, { timeout: 30_000 });

  // The pane's Video tab also plays the copy in its owning chat; the file stays the original.
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const chip = page.locator('.attachments .file-chip-open', { hasText: original.name });
  await chip.waitFor({ timeout: 30_000 });
  assert.match(await chip.locator('.icon').first().getAttribute('style'), /icons\/play\.svg/, 'a play mark, not a paperclip');
  assert.ok((await chip.innerText()).includes(clock), 'the chip shows the source duration');
  await shot('video-preview-chat-1280');
  const opened = performance.now();
  await chip.click();
  const player = page.locator('video.pane-video-player');
  await player.waitFor({ timeout: 30_000 });
  assert.equal(await player.getAttribute('src'), `wf-file://${row.previewFileId}`, 'the player streams the copy, not the original');
  await page.waitForFunction(() => { const v = document.querySelector('video.pane-video-player'); return v && v.readyState >= 1 && v.videoWidth > 0; }, null, { timeout: 30_000 });
  const played = await player.evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, d: v.duration }));
  assert.ok(Math.min(played.w, played.h) <= 720, `the copy's picture ${played.w}×${played.h}`);
  assert.ok(played.d > 1, `its length ${played.d} s`);
  await player.evaluate((v) => new Promise((resolve, reject) => {
    v.muted = true;
    const handle = v.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    const timer = setTimeout(() => { v.cancelVideoFrameCallback(handle); reject(new Error('No video frame presented')); }, 15_000);
    v.play().catch((error) => { clearTimeout(timer); v.cancelVideoFrameCallback(handle); reject(error); });
  }));
  t.diagnostic(`desktop chip open to first observed playing frame: ${Math.round(performance.now() - opened)} ms (includes the harness's checks; not a phone measurement)`);
  await page.waitForFunction(() => document.querySelector('video.pane-video-player').currentTime > 0.3, null, { timeout: 15_000 });
  await shot('video-preview-pane-1280');
  // A video an agent shows as a media block plays the copy too.
  await rpc.call('messages.send', { conversationId: chat.id, body: `Here it is [[ui:{"type":"media","fileId":"${original.id}","kind":"video"}]]` });
  const block = page.locator('video.b-media-video');
  await block.first().waitFor({ timeout: 30_000 });
  await page.waitForFunction((id) => [...document.querySelectorAll('video.b-media-video')].some((v) => v.getAttribute('src') === `wf-file://${id}`), row.previewFileId, { timeout: 30_000 });
  await size(390, 844);
  await page.waitForTimeout(600);
  const innerWidth = await page.evaluate(() => window.innerWidth); assert.ok(innerWidth <= 400, `the window really is phone wide (inner width ${innerWidth})`);
  await shot('video-preview-pane-390');
  assert.deepEqual((await rpc.call('media.list', { conversationId: chat.id })).map((entry) => entry.fileId), [original.id], 'still only the original in the library');
  assert.deepEqual(errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text)), [], 'no renderer errors');
  void copy;
});
