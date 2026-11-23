// Real Electron UI, isolated demo profile (owner 21.11.2026): Settings › Scheduled – the person's own messages by chat on
// top, "Set up by agents" below with a search; Show opens an agent's own schedules underneath, editable. Schedules are
// injected at the MessagePort boundary (schedules.list) – the layout, not the runtime, is under test here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function scheduleTransport() {
  const asked = new Set();
  const now = Date.now();
  const spec = (at) => ({ type: 'once', at });
  const list = () => [
    { id: 'sch_h1', ownerId: 'human', kind: 'message', title: 'Weekly check', spec: { type: 'weekly', days: [1], time: '09:00' }, payload: { body: 'How did the week go?' }, nextAt: now + 2 * 86_400_000, runs: 3, active: true, createdAt: now },
    { id: 'sch_a1', ownerId: 'agt_writer', kind: 'message', title: 'Draft ready', spec: spec(now + 3_600_000), payload: { body: 'The draft is ready for review.' }, nextAt: now + 3_600_000, runs: 0, active: true, createdAt: now },
    { id: 'sch_a2', ownerId: 'agt_writer', kind: 'reminder', title: 'Look again', spec: spec(now + 86_400_000), payload: { note: 'Check the feedback on the draft.' }, nextAt: now + 86_400_000, runs: 0, active: false, pausedBy: 'agt_writer', createdAt: now },
  ];
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (frame, ...rest) { if (frame?.method === 'schedules.list') asked.add(frame.id); return post.call(this, frame, ...rest); };
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
  Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() {
    const frame = data.call(this);
    return frame && asked.has(frame.id) && 'result' in frame ? { ...frame, result: list() } : frame;
  } });
}

test('Scheduled page: yours by chat, agents below, Show opens an agent', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-scheduled-ui-'));
  const shots = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({ executablePath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
  t.after(async () => { await app.close().catch(() => undefined); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(scheduleTransport);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (w, h) => app.evaluate(({ BrowserWindow }, [width, height]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 300); win.setSize(width, height); }, [w, h]);
  await size(1280, 820);
  await page.evaluate(() => { location.hash = '#/settings/scheduled'; });
  await page.getByText('How did the week go?').waitFor({ timeout: 20_000 });
  await page.getByText('Set up by agents', { exact: false }).first().waitFor();
  assert.equal(await page.getByText('The draft is ready for review.').count(), 0, 'an agent\'s own stay closed until Show');
  await page.screenshot({ path: path.join(shots, 'scheduled-closed.png') });
  const show = page.getByRole('button', { name: /Show/ }).first();
  const box = await page.getByText('How did the week go?').boundingBox();
  await show.click();
  await page.getByText('The draft is ready for review.').waitFor();
  await page.getByText('Check the feedback on the draft.').waitFor();
  assert.deepEqual(await page.getByText('How did the week go?').boundingBox(), box, 'nothing above moves');
  for (const [width, height, scheme, name] of [[1280, 820, 'light', 'scheduled-light'], [1280, 820, 'dark', 'scheduled-dark'], [640, 480, 'light', 'scheduled-640'], [390, 844, 'dark', 'scheduled-phone']]) {
    await size(width, height);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name}: no sideways scroll`);
  }
  await size(1280, 820);
  await page.emulateMedia({ colorScheme: 'light' });
  if (!(await page.getByText('The draft is ready for review.').count())) await page.getByRole('button', { name: /Show/ }).first().click(); // the phone layout remounted the page
  await page.getByText('The draft is ready for review.').click({ button: 'right' });
  const edit = page.getByRole('menuitem', { name: /Edit/ }).first();
  if (await edit.count()) { await edit.click(); await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, 'scheduled-agent-edit.png') }); await page.keyboard.press('Escape'); }
  assert.deepEqual(errors, []);
});
