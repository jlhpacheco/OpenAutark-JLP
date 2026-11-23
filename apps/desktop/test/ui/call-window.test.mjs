// Electron window check of the chat header's call cell (Umbau Einfachheit: a call is the chat's voice conversation;
// seats, floor, call history and recap went) in an isolated test profile with the demo engine, Chromium's fake
// microphone fed with silence (no utterance is cut, nothing is sent) and a localhost fake speech-to-text server
// (registered as a local 'vllm' account, like e2e/runtime-speech.test.mjs):
//   * the call cell "Talk" in a first and then a second chat starts the voice conversation: the open chat's shows on
//     its call card ("Connecting…" / "Listening · 0:05", Hang up – B-085), the other chat's in the status line over the
//     main zone ("<chat> · on hold", with End); the cell turns "End voice" in the same box – the header's cells do not move;
//   * opening the first chat makes it the listening one (the focused chat listens; the other goes on hold in the line);
//   * End on the other chat's line leaves one conversation; the cell's "End voice" ends the last and its card goes;
//   * a dictation in the composer ends the running conversations first (one microphone);
//   * each conversation is a call of this PC in its chat: one bubble "Call · <time> · running" that shows how long it ran
//     once it ended (its row: meta.call with participant 'device:pc'); talking again is a new call;
//   * the status line lies over the main zone under its header row; at phone width it stays clear of the native
//     caption controls; screenshots light, dark and phone width; no renderer errors.
// Real speech and realtime voice are not claimed here (unit tests: test/unit/voice/*).
// Run: npm run test:ui (needs a fresh build). SCREENSHOTS=<dir> keeps the shots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/** 16 kHz mono 16-bit PCM silence. */
function silence(seconds) {
  const data = Buffer.alloc(32_000 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A speech-to-text model on localhost: its model list, and no words for any take. */
async function fakeSpeechServer() {
  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/v1/models') return reply(200, { object: 'list', data: [{ id: 'whisper-1', object: 'model' }] });
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') { req.resume(); req.on('end', () => reply(200, { text: '' })); return undefined; }
    return reply(404, { error: { message: 'not here' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('call cell: two voice conversations, the focused chat listens, End per chat, nothing moves', { timeout: 240_000 }, async (t) => {
  const speech = await fakeSpeechServer();
  t.after(() => speech.close());
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-call-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const quiet = path.join(profile, 'silence.wav');
  await writeFile(quiet, silence(30));
  const app = await electron.launch({
    executablePath: electronPath, args: [root, '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${quiet}`], cwd: root, timeout: 60_000,
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
  page.on('console', (message) => { if (message.type() === 'error' && !/Autofill|DevTools|Electron Security Warning/i.test(message.text())) errors.push(`${message.text()}${message.location()?.url ? ` (${message.location().url})` : ''}`); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  await rpc.call('accounts.add', { provider: 'vllm', label: 'Local whisper', baseUrl: `http://127.0.0.1:${speech.port}/v1` });
  await rpc.call('models.list', { refresh: true });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const plan = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id] });
  const research = await rpc.call('chats.create', { title: 'Research', agentIds: [manager.id] });
  const open = async (chat) => {
    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    await page.locator('.composer').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
  };

  const cell = page.locator('.chat-header [data-cell="call"]');
  const talk = cell.locator('button[aria-label="Talk"]');
  const endVoice = cell.locator('button[aria-label="End voice"]');
  const voiceLines = page.locator('.status-host .status-note[data-notice^="voice:"]');
  const lineTexts = async () => (await voiceLines.locator('.status-text').allTextContents()).map((text) => text.trim());
  const waitLines = async (check, what) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await page.waitForTimeout(200)) {
      const now = await lineTexts();
      if (check(now)) return now;
    }
    assert.fail(`timed out: ${what} (${JSON.stringify(await lineTexts())})`);
  };
  const headerCells = ['.chat-header [data-cell="call"]', '.chat-header .frame-header-title', '.chat-header [data-cell="browser"]', '.composer', '.message-scroller'];
  // B-085: the open chat's call shows on its call card (chat/call/CallCard.tsx) – the status line keeps only the others
  const card = page.locator('.chat-view .call-card');
  const cardSays = async (pattern, what) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await page.waitForTimeout(200)) {
      const text = (await card.locator('.call-status').textContent().catch(() => ''))?.trim() ?? '';
      if (pattern.test(text)) return text;
    }
    assert.fail(`timed out: ${what} (${await card.locator('.call-status').textContent().catch(() => 'no card')})`);
  };
  const LISTENS = /^(Connecting…|Listening( · \d+:\d{2})?)$/;

  // Talk in the first chat: the voice conversation starts on the chat's call card; the cell turns "End voice" in its box.
  await open(plan);
  await talk.waitFor({ timeout: 15_000 });
  await expectStable(page, headerCells, async () => {
    await talk.click();
    await endVoice.waitFor({ timeout: 20_000 });
  });
  await cardSays(LISTENS, 'the first chat talks on its card');
  assert.deepEqual(await lineTexts(), [], 'the open chat\'s call is no status line');
  // The call is one bubble in the chat, written by this PC (B-085: a compact card whose accessible name is the title;
  // its toggle reads "Transcript").
  const bubbles = page.locator('.message-scroller .call-transcript');
  const titles = async () => (await bubbles.evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label') ?? ''))).map((text) => text.trim());
  const waitTitles = async (check, what) => {
    for (const end = Date.now() + 15_000; Date.now() < end; await page.waitForTimeout(200)) if (check(await titles())) return;
    assert.fail(`timed out: ${what} (${JSON.stringify(await titles())})`);
  };
  await waitTitles((now) => now.length === 1 && /^Call · .+ · running$/.test(now[0]), 'the call bubble runs');
  assert.equal((await bubbles.first().locator('.call-transcript-toggle').textContent())?.trim(), 'Transcript');
  const callRows = async () => (await rpc.call('messages.list', { conversationId: plan.id })).filter((message) => Array.isArray(message.meta?.call?.lines));
  assert.equal((await callRows())[0]?.meta.call.participant, 'device:pc');
  await shot('call-00-one');

  // Talk in the second chat: the newer one listens on its card, the older one waits on hold in the status line; End
  // per chat (the line's End, the card's Hang up).
  await open(research);
  await talk.click();
  await endVoice.waitFor({ timeout: 20_000 });
  await waitLines((now) => now.length === 1 && /Launch plan · on hold$/.test(now[0]), 'the older chat on hold in the status line');
  await cardSays(LISTENS, 'the newer one listens on its card');
  assert.equal(await voiceLines.getByRole('button', { name: 'End', exact: true }).count(), 1, 'End on the other chat\'s line');
  assert.equal(await card.getByRole('button', { name: 'Hang up', exact: true }).count(), 1, 'Hang up on the open chat\'s card');
  await shot('call-01-two-light');
  const geometry = await page.evaluate(() => {
    const line = document.querySelector('.status-host .status-note[data-notice^="voice:"]').getBoundingClientRect();
    const header = document.querySelector('.chat-header').getBoundingClientRect();
    return { lineTop: line.top, headerBottom: header.bottom };
  });
  assert.ok(geometry.lineTop >= geometry.headerBottom - 1, `the status line lies under the header row (${geometry.lineTop} < ${geometry.headerBottom})`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('call-02-two-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // The focused chat listens: opening Launch plan makes it the listening one.
  await open(plan);
  await waitLines((now) => now.length === 1 && /Research · on hold$/.test(now[0]), 'the other chat on hold');
  await cardSays(LISTENS, 'the opened chat listens on its card');

  await size(420, 860);
  await page.waitForTimeout(600);
  await shot('call-03-phone');
  if (process.platform !== 'darwin') {
    const under = await page.evaluate(() => {
      const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
      if (!rect || !rect.width) return null;
      const left = rect.x + rect.width;
      return [...document.querySelectorAll('button, a[href], input, select, textarea')].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.right > left && box.top < rect.height;
      }).map((el) => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30));
    });
    assert.deepEqual(under ?? [], [], 'nothing lies under the native caption controls');
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at phone width (${overflow}px)`);
  await size(1280, 820);
  await page.waitForTimeout(600);

  // End on Research's line leaves the open chat's conversation on its card; the cell's "End voice" ends the last and the
  // card goes.
  await voiceLines.filter({ hasText: 'Research' }).getByRole('button', { name: 'End', exact: true }).click();
  await waitLines((now) => now.length === 0, 'Research ended: no line left');
  await cardSays(LISTENS, 'one conversation left, the open chat\'s');
  await expectStable(page, headerCells, async () => {
    await endVoice.click();
    await talk.waitFor({ timeout: 10_000 });
  });
  await card.waitFor({ state: 'detached', timeout: 10_000 });
  await waitTitles((now) => now.length === 1 && /^Call · .+ · \d+:\d{2}$/.test(now[0]), 'the ended call shows how long it ran');

  // A dictation ends a running conversation first (one microphone).
  await talk.click();
  await cardSays(LISTENS, 'talking again');
  await page.locator('.composer button[aria-label="Dictate"]').click();
  await card.waitFor({ state: 'detached', timeout: 20_000 }); // the dictation ended the conversation
  assert.deepEqual(await lineTexts(), [], 'and no line stands for it');
  await page.locator('.composer button[aria-label="Stop dictation"]').click({ timeout: 10_000 }).catch(() => undefined);
  await talk.waitFor({ timeout: 15_000 });
  await waitTitles((now) => now.length === 2 && now.every((title) => /^Call · .+ · \d+:\d{2}$/.test(title)), 'talking again was a second call, ended by the dictation');
  assert.ok((await callRows()).every((row) => typeof row.meta.call.endedAt === 'number'));

  // B-082: a conversation loads its turn models from app://app/turn/ and leaves out one that is not downloaded – that
  // route answers 404 then (main/protocols/handlers.ts), as in this fresh profile; the detector keeps its level fallback
  const notDownloaded = /^Failed to load resource: the server responded with a status of 404 \(Not Found\) \(app:\/\/app\/turn\/(silero_vad|smart-turn-v3\.2-cpu)\.onnx\)$/;
  assert.deepEqual(errors.filter((text) => !notDownloaded.test(text)), [], 'no renderer errors');
});
