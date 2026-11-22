// Electron window check of B-091's sign-in sheet (settings/SignInSheet.tsx + away-sign-in.ts, mounted by the model
// setup in Settings › Models): a plan sign-in started from the phone returns Codex's one-time code (`code`) or Claude
// Code's `paste`, and the sheet shows it – Codex: the code large and one button "Copy code and sign in" (copies the code,
// opens the page); Claude Code: "Open sign-in", the field "Code from the page" and Done; a code that did not work shows
// "That code did not work – open sign-in again." in the footer's reserved line without moving anything (expectStable),
// and the next "Open sign-in" opens the fresh sign-in's page; an accepted code closes the sheet with a toast. Escape and
// the close button close it.
// The PC never receives `code`/`paste` and the demo engine has no plan accounts, so the page's answers are replaced: an
// init script rewrites the RPC frames on the runtime MessagePort (as accounts-detect-window.test.mjs does) – accounts.list
// returns one Codex and one Claude Code plan account that need a sign-in; accounts.login and accounts.loginCode are sent
// to the runtime as a harmless accounts.list (no real sign-in ever starts) and answered with the fake results. Links go to
// a stubbed shell.openExternal in main, the clipboard to a stub – nothing opens, nothing is copied.
// Screenshots of both sheets at 390×844 light and dark and 640×480; no horizontal scroll; no renderer errors.
// Run: npm run build && node --test test/ui/away-sign-in-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const CODE = 'FR4A-CONBK';
const CODEX_URL = 'https://example.invalid/sign-in';
const CLAUDE_URL = 'https://example.invalid/claude-sign-in';
const CLAUDE_URL_AGAIN = 'https://example.invalid/claude-sign-in-again';
const account = (id, provider, label, priority) => ({ id, provider, label, auth: 'cli', state: 'needs_login', priority, enabled: true, detected: true, createdAt: 1 });
const ACCOUNTS = [account('acc-codex-away', 'codex', 'Codex', 0), account('acc-claude-away', 'claude', 'Claude Code', 1)];

/** Page init script: the fake answers above; window.__wfAway records the login/loginCode calls, copies and window.open. */
function fakeAway() {
  return `(() => {
    const accounts = ${JSON.stringify(ACCOUNTS)};
    const record = { login: [], loginCode: [], copied: [], opened: [] };
    Object.defineProperty(window, '__wfAway', { value: record });
    const answers = new Map();
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (frame, ...rest) {
      if (frame && typeof frame === 'object' && typeof frame.method === 'string') {
        const params = frame.params ?? {};
        if (frame.method === 'accounts.list') answers.set(frame.id, accounts);
        else if (frame.method === 'accounts.login') {
          record.login.push(params);
          const claudeLogins = record.login.filter((entry) => entry.id === 'acc-claude-away').length;
          answers.set(frame.id, params.id === 'acc-codex-away'
            ? { started: true, url: ${JSON.stringify(CODEX_URL)}, code: ${JSON.stringify(CODE)} }
            : { started: true, url: claudeLogins > 1 ? ${JSON.stringify(CLAUDE_URL_AGAIN)} : ${JSON.stringify(CLAUDE_URL)}, paste: true });
          return post.call(this, { id: frame.id, method: 'accounts.list' }, ...rest); // never a real sign-in
        } else if (frame.method === 'accounts.loginCode') {
          record.loginCode.push(params);
          answers.set(frame.id, { ok: record.loginCode.length > 1 });
          return post.call(this, { id: frame.id, method: 'accounts.list' }, ...rest);
        }
      }
      return post.call(this, frame, ...rest);
    };
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, enumerable: true, get() {
      const value = data.call(this);
      if (value && typeof value === 'object' && ('result' in value || 'error' in value) && answers.has(value.id)) return { id: value.id, result: answers.get(value.id) };
      return value;
    } });
    if (window.Clipboard) Clipboard.prototype.writeText = function (text) { record.copied.push(String(text)); return Promise.resolve(); };
    window.open = (url) => { record.opened.push(String(url)); return null; };
  })();`;
}

test('B-091 sign-in sheet: Codex code and Claude Code paste, failure line, close – desktop and 390 px', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-away-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' }),
  });
  t.after(async () => {
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (url) => { globalThis.__opened.push(String(url)); }; });
  const opened = async () => [...await app.evaluate(() => globalThis.__opened), ...await page.evaluate(() => window.__wfAway.opened)];
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  await size(1280, 820);

  await page.addInitScript(fakeAway());
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.evaluate(() => { location.hash = '#/settings/models'; });
  const group = page.locator('#settings-models');
  await group.waitFor({ timeout: 15_000 });
  const codexRow = group.locator('.account-row.provider-codex');
  const claudeRow = group.locator('.account-row.provider-claude');
  await codexRow.locator('.account-sign-in').waitFor({ timeout: 15_000 });
  await claudeRow.locator('.account-sign-in').waitFor({ timeout: 5_000 });
  const sheet = page.locator('dialog.sign-in-sheet');
  assert.equal(await sheet.isVisible(), false, 'no sheet before a sign-in');

  /** At 390×844 light and dark and 640×480: the sheet stays open, fits, no horizontal scroll. */
  const sizes = async (prefix, check) => {
    for (const [width, height, name, dark] of [[390, 844, 'phone-light', false], [390, 844, 'phone-dark', true], [640, 480, '640x480', false]]) {
      await size(width, height);
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await page.waitForTimeout(600);
      await sheet.waitFor({ state: 'visible', timeout: 5_000 });
      await check();
      const fit = await page.evaluate(() => {
        const dialog = document.querySelector('dialog.sign-in-sheet');
        const box = dialog.getBoundingClientRect();
        const content = dialog.querySelector('.dialog-content');
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          left: box.left, right: window.innerWidth - box.right, top: box.top, bottom: window.innerHeight - box.bottom,
          content: content.scrollWidth - content.clientWidth,
        };
      });
      assert.ok(fit.page <= 1, `no horizontal page scroll at ${width} px: ${JSON.stringify(fit)}`);
      assert.ok(fit.content <= 1, `no horizontal scroll in the sheet at ${width} px: ${JSON.stringify(fit)}`);
      assert.ok(fit.left >= -1 && fit.right >= -1 && fit.top >= -1 && fit.bottom >= -1, `the sheet lies inside the window at ${width}×${height}: ${JSON.stringify(fit)}`);
      await shot(`${prefix}-${name}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await size(1280, 820);
    await page.waitForTimeout(600);
  };

  // ---- Codex: the code and one button that copies it and opens the page
  await codexRow.locator('.account-sign-in').click();
  await sheet.waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(await page.evaluate(() => window.__wfAway.login), [{ id: 'acc-codex-away' }]);
  assert.equal(await sheet.locator('.dialog-header h2').textContent(), 'Sign in to Codex');
  assert.equal(await sheet.locator('.sign-in-code').textContent(), CODE);
  assert.equal(await sheet.locator('.sign-in-hint').textContent(), 'Device sign-in off? Turn it on once in ChatGPT › Settings › Security.');
  const copy = sheet.getByRole('button', { name: 'Copy code and sign in' });
  assert.equal(await sheet.locator('.dialog-footer button').count(), 1, 'one button in the footer');
  assert.deepEqual(await opened(), [], 'the CLI opens the PC browser itself – the window opened nothing yet');
  await sizes('away-codex', async () => {
    assert.equal(await sheet.locator('.sign-in-code').textContent(), CODE);
    assert.ok(await copy.isVisible(), 'the button is visible');
  });
  await copy.click();
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.__wfAway.copied), [CODE], 'the code went to the clipboard');
  assert.deepEqual(await opened(), [CODEX_URL], 'the click opened the sign-in page');
  assert.ok(await sheet.isVisible(), 'the sheet stays until the account works');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden', timeout: 5_000 });

  // ---- Claude Code: Open sign-in, the code field and Done
  await claudeRow.locator('.account-sign-in').click();
  await sheet.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await sheet.locator('.dialog-header h2').textContent(), 'Sign in to Claude Code');
  assert.equal(await sheet.locator('.sign-in-code').count(), 0);
  const open = sheet.getByRole('button', { name: 'Open sign-in' });
  const field = sheet.getByRole('textbox', { name: 'Code from the page' });
  const done = sheet.getByRole('button', { name: 'Done' });
  await open.waitFor({ timeout: 5_000 });
  await field.waitFor({ timeout: 5_000 });
  assert.equal(await done.isDisabled(), true, 'Done waits for a code');
  assert.equal(await sheet.locator('.dialog-message').textContent(), '', 'the message line is reserved and empty');
  await sizes('away-claude', async () => {
    assert.ok(await open.isVisible() && await field.isVisible() && await done.isVisible(), 'Open sign-in, the field and Done are visible');
  });
  await open.click();
  await page.waitForTimeout(300);
  assert.deepEqual((await opened()).slice(1), [CLAUDE_URL], '"Open sign-in" opened the page');
  await field.fill('wrong-code#123');
  assert.equal(await done.isDisabled(), false);
  await expectStable(page, [
    'dialog.sign-in-sheet', 'dialog.sign-in-sheet .dialog-header', 'dialog.sign-in-sheet .sign-in-open',
    'dialog.sign-in-sheet .dialog-field', 'dialog.sign-in-sheet .dialog-footer', 'dialog.sign-in-sheet .dialog-actions', // the message grows inside the footer's row (overlays.css)
  ], async () => {
    await done.click();
    await sheet.locator('.dialog-message', { hasText: 'That code did not work – open sign-in again.' }).waitFor({ timeout: 5_000 });
  });
  assert.deepEqual(await page.evaluate(() => window.__wfAway.loginCode), [{ id: 'acc-claude-away', code: 'wrong-code#123' }]);
  assert.equal(await page.evaluate(() => window.__wfAway.login.length), 3, 'a code that did not work started a fresh sign-in');
  assert.equal(await field.inputValue(), '', 'the field is empty again');
  await sizes('away-claude-failed', async () => {
    assert.equal(await sheet.locator('.dialog-message').textContent(), 'That code did not work – open sign-in again.');
  });
  await open.click();
  await page.waitForTimeout(300);
  assert.equal((await opened()).at(-1), CLAUDE_URL_AGAIN, 'the next "Open sign-in" opens the fresh sign-in page');

  // the close button closes it; reopening starts clean
  await sheet.getByRole('button', { name: 'Close' }).click();
  await sheet.waitFor({ state: 'hidden', timeout: 5_000 });
  await claudeRow.locator('.account-sign-in').click();
  await sheet.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await sheet.locator('.dialog-message').textContent(), '', 'a new sign-in shows no old failure');

  // an accepted code (Enter) closes the sheet with the toast
  await field.fill('good-code');
  await field.press('Enter');
  await sheet.waitFor({ state: 'hidden', timeout: 5_000 });
  await page.getByText('Claude Code signed in').first().waitFor({ timeout: 5_000 });
  assert.deepEqual((await page.evaluate(() => window.__wfAway.loginCode)).at(-1), { id: 'acc-claude-away', code: 'good-code' });
  await shot('away-claude-signed-in');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
