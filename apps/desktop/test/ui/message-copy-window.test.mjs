// Copying text on the phone "wie überall" (17.11.2026, the owner twice, task_74h3part): a finger's long press on a message opens nothing of ours – the page's
// own selection stays as the browser made it (it is not cleared, the event is not stopped), so the phone's handles and "Copy" copy exactly the marked part; the
// message's menu is the "More" button in its meta row and still the mouse's right click; Select text is not needed. Photos (SCREENSHOTS=<dir>) at 390 px,
// light and dark; the window really is that wide. A sideways drag that extends a selection is no swipe (unit test swipe-selection.test.ts).
// Owns: this check. Never: a real phone's selection handles (Mika's device test).

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

test('a long press on a message selects text natively; the menu is the More button or a right click', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-copy-'));
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
    const win = BrowserWindow.getAllWindows().find((entry) => entry.isVisible()) ?? BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  await size(390, 844);
  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Copy test', agentIds: [manager.id] });
  await rpc.call('messages.send', { conversationId: chat.id, body: 'First sentence. Second sentence, which used to stay behind when copying, and a third one.' });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const message = page.locator('article.message.human').first();
  await message.waitFor({ timeout: 30_000 });
  assert.ok(await page.evaluate(() => window.innerWidth) <= 400, 'the window really is phone wide');
  const menu = page.locator('.menu[aria-label="Context menu"]');

  // The finger: pointerdown (touch); the long press selects text (here the second sentence); the browser's contextmenu event comes; the finger lifts.
  const selected = await message.locator('.message-content').evaluate((content) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes('Second')) node = walker.nextNode();
    const text = node.textContent;
    const range = document.createRange();
    range.setStart(node, text.indexOf('Second'));
    range.setEnd(node, text.indexOf(', and a third'));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  assert.equal(selected, 'Second sentence, which used to stay behind when copying');
  const outcome = await message.evaluate(async (el) => {
    const at = el.querySelector('.message-content').getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, clientX: at.left + 40, clientY: at.top + 10 };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    await new Promise((resolve) => setTimeout(resolve, 800)); // past the old 500 ms long press
    const contextmenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY });
    el.dispatchEvent(contextmenu);
    el.dispatchEvent(new PointerEvent('pointerup', init));
    return { prevented: contextmenu.defaultPrevented, selection: getSelection().toString() };
  });
  assert.equal(outcome.prevented, false, "the browser's own long-press handling is not stopped");
  assert.equal(outcome.selection, selected, "the selection is the browser's: nothing of ours cleared it");
  assert.equal(await menu.count(), 0, 'no menu of ours opened');
  await shot('copy-390-selected-light');

  // The menu: the More button (touch), and the mouse's right click.
  await page.evaluate(() => getSelection().removeAllRanges());
  const more = message.getByRole('button', { name: 'More' });
  assert.equal(await more.count(), 1, 'a More button in the meta row');
  const box = await more.boundingBox();
  assert.ok(box.width >= 24 && box.height >= 24, `the button's size ${box.width}x${box.height}`);
  await more.click();
  await menu.waitFor({ timeout: 5_000 });
  const items = (await menu.getByRole('menuitem').allTextContents()).map((text) => text.trim());
  assert.ok(items.includes('Copy') && items.includes('Reply'), items.join(' | '));
  assert.ok(!items.includes('Select text'), 'no Select text: the phone selects natively');
  await shot('copy-390-more-menu-light');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  await message.click({ button: 'right', position: { x: 20, y: 10 } });
  await menu.waitFor({ timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('copy-390-dark');
  assert.deepEqual(errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text)), [], 'no renderer errors');
});
