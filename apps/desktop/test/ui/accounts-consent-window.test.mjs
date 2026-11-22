// Electron window check of the account rows in Settings › Models (settings/ModelSetup.tsx, AccountRow.tsx, extra-usage.ts) for
// Konrad's task_bgykyzcx (17.11.2026): (1) a plan login this PC found – or another company on it made – is a row "Found: Codex
// (ChatGPT login) – use in this company?" with Use / Not here, no account until Use; (2) every account row carries its On/Off
// switch and a visible "Remove from this company" (no right-click, no search); (3) a plan login has the switch "When the plan is
// empty: use extra usage" with its cost line – off by default, and where the provider has none the switch is off and says why.
// The demo engine never scans this PC and has no plan accounts, so the page's answers are replaced (as accounts-detect-window.test.mjs
// and away-sign-in-window.test.mjs do): an init script answers accounts.list / detect / update / useFound / declineFound / remove
// from a small in-page state and pushes the runtime events (account.upserted / account.removed); every other call reaches the
// runtime. The runtime rules themselves are unit-tested (test/unit/accounts/consent.test.ts). Nothing is signed in or removed.
// Screenshots at 1280 and 390 px (light, dark); no horizontal scroll; every control inside the window; no renderer errors.
// Run: npm run build && node --test test/ui/accounts-consent-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/** Page init script: the fake accounts and offers, answered and changed in the page; window.__wfConsent.calls records every faked call. */
const FAKE = `(() => {
  const post = MessagePort.prototype.postMessage;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const now = Date.now();
  const calls = [];
  const state = {
    accounts: [
      { id: 'acc-claude', provider: 'claude', label: 'Claude Code', auth: 'cli', state: 'ok', plan: 'max', priority: 0, enabled: true, detected: false, createdAt: 1,
        limits: { readAt: now, windows: [
          { name: '5h', windowMinutes: 300, usedPercent: 100, resetsAt: now + 2 * 3600000 },
          { name: 'weekly', windowMinutes: 10080, usedPercent: 62, resetsAt: now + 3 * 86400000 } ] } },
      { id: 'acc-gemini', provider: 'gemini-cli', label: 'Gemini CLI', auth: 'cli', state: 'ok', priority: 1, enabled: true, detected: true, createdAt: 2 },
    ],
    found: [
      { key: 'codex:default', provider: 'codex', where: 'this-pc' },
      { key: 'claude:acc_lena', provider: 'claude', where: 'other-company', email: 'lena@example.com' },
    ],
  };
  let port = null;
  const deliver = (data) => dispatch.call(port, new MessageEvent('message', { data }));
  const upsert = (account) => {
    const at = state.accounts.findIndex((entry) => entry.id === account.id);
    if (at >= 0) state.accounts[at] = account; else state.accounts.push(account);
    deliver({ event: 'account.upserted', data: account });
  };
  Object.defineProperty(window, '__wfConsent', { value: { calls, state } });
  const FAKED = new Set(['accounts.list', 'accounts.detect', 'accounts.update', 'accounts.useFound', 'accounts.declineFound', 'accounts.remove']);
  MessagePort.prototype.postMessage = function (frame, ...rest) {
    const method = frame && typeof frame === 'object' ? frame.method : undefined;
    if (!FAKED.has(method)) return post.call(this, frame, ...rest);
    port = this;
    const params = frame.params ?? {};
    const answer = (result) => setTimeout(() => deliver({ id: frame.id, result }), 0);
    if (method !== 'accounts.list' && method !== 'accounts.detect') calls.push({ method, params });
    if (method === 'accounts.list') return answer(state.accounts);
    if (method === 'accounts.detect') {
      return answer({ checkedAt: Date.now(), localServers: [], envKeys: [], found: state.found,
        clis: [{ provider: 'codex', path: 'codex.cmd', loggedIn: true, method: 'ChatGPT' }, { provider: 'claude', path: 'claude.exe', loggedIn: true, method: 'claude.ai' }, { provider: 'gemini-cli', path: 'gemini.cmd' }] });
    }
    if (method === 'accounts.update') {
      const account = { ...state.accounts.find((entry) => entry.id === params.id) };
      const { id, ...patch } = params;
      Object.assign(account, patch);
      if (patch.extraUsage === false) delete account.extraUsage;
      if (patch.thisPcOnly === false) delete account.thisPcOnly;
      if (patch.enabled !== undefined) account.state = patch.enabled ? 'ok' : 'disabled';
      upsert(account);
      return answer(account);
    }
    if (method === 'accounts.useFound') {
      const offer = state.found.find((entry) => entry.key === params.key);
      state.found = state.found.filter((entry) => entry !== offer);
      const account = { id: 'acc-new-' + offer.provider, provider: offer.provider, label: offer.provider === 'codex' ? 'Codex' : 'Claude Code 2', auth: 'cli', state: 'ok', plan: offer.provider === 'codex' ? 'pro' : 'max',
        priority: 5, enabled: true, detected: offer.where === 'this-pc', createdAt: Date.now(), ...(params.thisPcOnly ? { thisPcOnly: true } : {}) };
      upsert(account);
      return answer(account);
    }
    if (method === 'accounts.declineFound') {
      state.found = state.found.flatMap((entry) => (entry.key !== params.key ? [entry] : entry.where === 'other-company' ? [{ ...entry, declined: true }] : []));
      return answer({ ok: true });
    }
    state.accounts = state.accounts.filter((entry) => entry.id !== params.id); // accounts.remove
    deliver({ event: 'account.removed', data: { id: params.id } });
    return answer({ ok: true });
  };
})();`;

test('Settings › Models: a found plan login is offered (Use / Not here); On/Off and Remove are in the row; the extra-usage switch says its cost or why not', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-consent-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const calls = () => page.evaluate(() => window.__wfConsent.calls);
  /** The controls of the models page lie inside the window and the page does not scroll sideways. */
  const fits = async (label) => {
    const fit = await page.evaluate(() => {
      const outside = [...document.querySelectorAll('#settings-models .found-row .button, #settings-models .account-power, #settings-models .account-remove, #settings-models .account-extra .switch')]
        .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1); })
        .map((el) => el.className);
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, outside };
    });
    assert.ok(fit.page <= 1, `no horizontal page scroll at ${label}: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.outside, [], `every control lies inside the window at ${label}`);
  };
  await size(1280, 820);

  await page.addInitScript(FAKE);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.evaluate(() => { location.hash = '#/settings/models'; });
  const group = page.locator('#settings-models');
  await group.waitFor({ timeout: 15_000 });
  const found = group.locator('.found-row');
  await found.first().waitFor({ timeout: 15_000 });

  // ---- (1) the offers: no account behind them, texts and buttons as agreed
  assert.equal(await found.count(), 2);
  const codexOffer = found.filter({ hasText: 'Codex' });
  const lenaOffer = found.filter({ hasText: 'lena@example.com' });
  assert.equal((await codexOffer.locator('.set-row-label').textContent())?.trim(), 'Found: Codex (ChatGPT login) – use in this company?');
  assert.equal((await lenaOffer.locator('.set-row-label').textContent())?.trim(), 'Found: Claude Code (lena@example.com) – use in this company?');
  assert.match((await codexOffer.locator('.set-row-hint').textContent()) ?? '', /^Not used, and not shared with this company's other PCs, until you say Use\.$/);
  assert.deepEqual(await codexOffer.locator('.button').allTextContents(), ['Use', 'Not here']);
  assert.equal(await group.locator('.account-row.provider-codex').count(), 0, 'no Codex account: it is only offered');
  assert.deepEqual(await calls(), [], 'nothing was used, declined or changed by looking');
  await fits('1280');
  await shot('01-found-1280-light');
  await size(390, 844);
  await page.waitForTimeout(500);
  await fits('390');
  await shot('02-found-390-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('03-found-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1280, 820);

  // ---- (2) On/Off and Remove sit in the row, no menu
  const claude = group.locator('.account-row.provider-claude').first();
  const gemini = group.locator('.account-row.provider-gemini-cli');
  for (const row of [claude, gemini]) {
    assert.equal(await row.locator('.account-power .switch').getAttribute('role'), 'switch');
    assert.equal(await row.locator('.account-power .switch').getAttribute('aria-checked'), 'true');
    assert.equal((await row.locator('.account-power').textContent())?.trim(), 'On');
    assert.equal((await row.locator('.account-remove').textContent())?.trim(), 'Remove from this company');
    assert.ok(await row.locator('.account-remove').isVisible(), 'visible without a right-click');
  }
  await claude.locator('.account-power .switch').click();
  await page.waitForFunction(() => document.querySelector('#settings-models .account-row.provider-claude .account-power')?.textContent?.trim() === 'Off');
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.update', params: { id: 'acc-claude', enabled: false } });
  assert.equal(await claude.locator('.account-power .switch').getAttribute('aria-checked'), 'false');
  await claude.locator('.account-power .switch').click();
  await page.waitForFunction(() => document.querySelector('#settings-models .account-row.provider-claude .account-power')?.textContent?.trim() === 'On');
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.update', params: { id: 'acc-claude', enabled: true } });

  // ---- (3) the extra-usage switch: off with its cost line; none where the provider has none
  const extra = claude.locator('.account-extra');
  assert.equal((await extra.locator('.account-extra-switch').textContent())?.trim(), 'When the plan runs out: continue with paid extra usage');
  assert.equal(await extra.locator('.switch').getAttribute('aria-checked'), 'false', 'off by default');
  assert.match((await extra.locator('.account-extra-hint').textContent()) ?? '', /^Billed by Claude at API rates \("usage credits"\).*claude\.ai › Settings › Usage.*Off: the plan waits for its reset\.$/);
  const none = gemini.locator('.account-extra');
  assert.equal(await none.locator('.switch').count(), 0, 'where the provider has none there is no switch to set');
  assert.equal((await none.locator('.account-extra-hint').textContent())?.trim(), 'No paid extra usage for this plan – it waits for its reset.');
  await fits('1280 rows');
  await shot('04-rows-1280-light');
  await extra.locator('.switch').click();
  await page.waitForFunction(() => document.querySelector('#settings-models .account-row.provider-claude .account-extra .switch')?.getAttribute('aria-checked') === 'true');
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.update', params: { id: 'acc-claude', extraUsage: true } });
  assert.match((await extra.locator('.account-extra-hint').textContent()) ?? '', /^On: costs money once the plan is used up – billed by Claude at API rates from your usage credits\./);
  await shot('05-extra-on-1280-light');
  await size(390, 844);
  await page.waitForTimeout(500);
  await fits('390 rows');
  await shot('06-rows-390-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('07-rows-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1280, 820);

  // ---- (4) where the login goes (Konrad #109): the row's switch – shared by default for an account that exists; keeping it here asks first
  const share = claude.locator('.account-share');
  assert.equal((await share.locator('.account-share-switch').textContent())?.trim(), 'On all PCs of this company');
  assert.equal(await share.locator('.switch').getAttribute('aria-checked'), 'true', 'an account that exists stays shared');
  assert.equal((await share.locator('.account-share-hint').textContent())?.trim(), 'The account and its sign-in go to every PC of this company');
  await share.locator('.switch').click();
  const keep = page.locator('dialog[open]');
  await keep.waitFor({ timeout: 5_000 });
  assert.match((await keep.textContent()) ?? '', /Keep Claude Code on this PC only\?.*The company's other PCs drop this account and its sign.in\. Work there continues on their other accounts, if they have any\./);
  assert.match((await keep.textContent()) ?? '', /sign\u2011in/, 'the hyphen never breaks the line');
  await shot('09-keep-here-dialog-1280-light');
  await keep.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await calls()).filter((call) => call.params.thisPcOnly !== undefined).length, 0, 'cancelled: nothing changed');
  await share.locator('.switch').click();
  await keep.waitFor({ timeout: 5_000 });
  await keep.getByRole('button', { name: 'Only on this PC' }).click();
  await page.waitForFunction(() => document.querySelector('#settings-models .account-row.provider-claude .account-share .switch')?.getAttribute('aria-checked') === 'false');
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.update', params: { id: 'acc-claude', thisPcOnly: true } });
  assert.equal((await share.locator('.account-share-hint').textContent())?.trim(), 'Only this PC uses it', 'the line changes with the state');
  await shot('10-only-this-pc-1280-light');
  await share.locator('.switch').click(); // back to all PCs: no question, the label says it
  await page.waitForFunction(() => document.querySelector('#settings-models .account-row.provider-claude .account-share .switch')?.getAttribute('aria-checked') === 'true');
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.update', params: { id: 'acc-claude', thisPcOnly: false } });

  // ---- Not here: another company's login stays on offer as declined (only Use); Use: the account row appears
  await lenaOffer.getByRole('button', { name: 'Not here' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#settings-models .found-row .set-row-label')].some((el) => /Not used here/.test(el.textContent ?? '')));
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.declineFound', params: { key: 'claude:acc_lena' } });
  const declined = group.locator('.found-row', { hasText: 'Not used here' });
  assert.equal((await declined.locator('.set-row-label').textContent())?.trim(), 'Not used here: Claude Code (lena@example.com)');
  assert.deepEqual(await declined.locator('.button').allTextContents(), ['Use']);

  // "Use" on the declined login of another company: asks where; the default is only on this PC
  await declined.getByRole('button', { name: 'Use' }).click();
  const where = page.locator('dialog[open]');
  await where.waitFor({ timeout: 5_000 });
  assert.equal((await where.locator('h2').textContent())?.trim(), 'Use Claude Code in this company?');
  assert.deepEqual((await where.locator('.dialog-choice-text > span').allTextContents()).map((text) => text.trim()), ['Only on this PC', 'On all PCs of this company']);
  assert.equal(await where.locator('.dialog-choice', { hasText: 'Only on this PC' }).locator('input').isChecked(), true, 'the default');
  assert.equal(await where.locator('.dialog-choice', { hasText: 'On all PCs of this company' }).locator('input').isChecked(), false);
  await shot('11-use-asks-1280-light');
  await size(390, 844);
  await page.waitForTimeout(500);
  await shot('12-use-asks-390-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('13-use-asks-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1280, 820);
  await where.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await calls()).filter((call) => call.method === 'accounts.useFound').length, 0, 'cancelled: not used');
  await declined.getByRole('button', { name: 'Use' }).click();
  await where.waitFor({ timeout: 5_000 });
  await where.getByRole('button', { name: 'Use', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#settings-models .account-row.provider-claude').length === 2);
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.useFound', params: { key: 'claude:acc_lena', thisPcOnly: true } });
  const second = group.locator('.account-row.provider-claude').nth(1);
  assert.equal(await second.locator('.account-share .switch').getAttribute('aria-checked'), 'false', 'used on this PC only');

  // "Use" on this PC's own login: the person picks all PCs of the company
  await codexOffer.getByRole('button', { name: 'Use' }).click();
  await where.waitFor({ timeout: 5_000 });
  await where.locator('.dialog-choice', { hasText: 'On all PCs of this company' }).click();
  await where.getByRole('button', { name: 'Use', exact: true }).click();
  await group.locator('.account-row.provider-codex').waitFor({ timeout: 10_000 });
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.useFound', params: { key: 'codex:default', thisPcOnly: false } });
  assert.equal(await group.locator('.found-row', { hasText: 'Found: Codex' }).count(), 0, 'the offer is gone');
  const codex = group.locator('.account-row.provider-codex');
  assert.equal(await codex.locator('.account-share .switch').getAttribute('aria-checked'), 'true', 'the person chose all PCs of the company');
  assert.equal((await codex.locator('.account-extra-switch').textContent())?.trim(), 'When the plan runs out: continue with ChatGPT credits');
  assert.match((await codex.locator('.account-extra-hint').textContent()) ?? '', /ChatGPT account \(Codex Settings › Usage › Credits\).*Off: the plan waits for its reset\./);
  assert.equal(await codex.locator('.account-limit').count(), 0, 'no bars before a first reading – an empty bar would read as used up');
  assert.equal((await codex.locator('.account-limit-pending').textContent())?.trim(), 'Limits show once they have been read.');
  assert.equal(await claude.locator('.account-limit').count(), 2, 'a plan with a reading keeps both bars');
  assert.match((await claude.locator('.account-hint').textContent()) ?? '', /^Max plan/, 'the plan tier as the person knows it');
  await shot('08-used-1280-light');

  // ---- Remove: visible button, the confirm names the company's other PCs
  await gemini.locator('.account-remove').click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor({ timeout: 5_000 });
  assert.match((await dialog.textContent()) ?? '', /It also goes from this company's other PCs\./);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#settings-models .account-row.provider-gemini-cli'));
  assert.deepEqual((await calls()).at(-1), { method: 'accounts.remove', params: { id: 'acc-gemini' } });

  await fits('1280 end');
  assert.deepEqual(errors, [], 'no renderer errors');
});
