// Electron window check of the chat's live bar (13.11.2026, ui/chat/LiveBar.tsx, runtime/chat/live.ts) with the demo
// engine in an isolated profile. Two agents of a group chat work on hanging tasks ([[hang:bash]]):
//   * the bar sits right above the composer: one line per working agent – dot, name, what it does, time –, its title
//     names the model · effort of the activity; no run is a row in the history (no .working-message);
//   * the person's newest message stays right above the bar (the list keeps its end);
//   * another chat of the same agent, where nothing comes from, shows no bar;
//   * the header's live line opens both lines of the bar (their steps) and closes them again; the header and the
//     composer do not move (20.11.2026: no popover draws the same rows a second time);
//   * a click on a line opens the agent's page with its activity log;
//   * light, dark, 640×480 (no horizontal page scroll) and phone width 390; no renderer errors.
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
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
/** The UI's effort words (src/ui/chat/live-text.ts EFFORT_LABEL). */
const EFFORT = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Max' };

test('live bar: who works for the chat, above the composer; nothing in the history; other chats stay quiet', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-live-bar-'));
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
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const quill = await rpc.call('agents.create', { name: 'Quill', role: 'Writer', managerId: manager.id });
  const chat = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id, quill.id] });
  const quiet = await rpc.call('chats.create', { title: 'Weekly video', agentIds: [manager.id, quill.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks', `chat:${chat.id}`, 'org', 'system'] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  await page.locator('.composer').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.live-bar').count(), 0, 'nobody works: no bar');

  // Both agents work in this chat (native tools that never end by themselves).
  const routed = (event, agentId) => event.active.find((run) => run.agentId === agentId && run.conversationId === chat.id && run.modelName && run.effort);
  const bothRouted = rpc.waitFor('agent.activity', (event) => Boolean(routed(event, manager.id) && routed(event, quill.id)), 60_000);
  await rpc.call('tasks.create', { conversationId: chat.id, title: 'Plan the launch [[hang:bash]]', to: manager.id });
  await rpc.call('tasks.create', { conversationId: chat.id, title: 'Draft the post [[hang:bash]]', to: quill.id });
  const activity = await bothRouted;

  const bar = page.locator('.live-bar');
  await page.waitForFunction(() => document.querySelectorAll('.live-bar .live-bar-line').length === 2, undefined, { timeout: 20_000 });
  for (const agent of [manager, quill]) {
    const run = routed(activity, agent.id);
    const line = bar.locator(`.live-bar-line[data-run-id="${run.runId}"]`);
    assert.equal((await line.locator('.live-bar-name').textContent())?.trim(), agent.name);
    assert.ok(((await line.locator('.live-bar-text').textContent()) ?? '').trim().length > 0, `${agent.name}: what it does`);
    assert.match((await line.locator('.live-bar-time').textContent()) ?? '', /min/);
    // The line's summary arrives through the throttled activity stream (GAP_MS), so right after both runs are routed
    // the title may still read "Quill · Working". Wait for it instead of reading once (Noah 17.11.2026, task_3f52djfp).
    const effortText = `· ${EFFORT[run.effort]}`;
    await line.evaluate((el, expected) => new Promise((resolve) => {
      const done = () => (el.getAttribute('title') ?? '').includes(expected);
      if (done()) return resolve(true);
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(true); } });
      observer.observe(el, { attributes: true, attributeFilter: ['title'] });
      setTimeout(() => { observer.disconnect(); resolve(false); }, 5_000);
    }), effortText);
    const title = (await line.getAttribute('title')) ?? '';
    assert.ok(title.includes(effortText), `${agent.name}: model · effort on hover (${title})`);
  }
  assert.equal(await page.locator('.working-message, .run-disclosure').count(), 0, 'no run is a row in the history');
  // Mika's pass 17.11.2026: a long text never squeezes the name down to its first letter ("T." for "Theo").
  await page.evaluate(() => { for (const el of document.querySelectorAll('.live-bar-text')) el.textContent = 'Running cd "./projects/company/workspace/a/very/long/path/that/keeps/going/and/going/and/going/on"'; });
  for (const agent of [manager, quill]) {
    const shown = await bar.locator('.live-bar-name', { hasText: agent.name }).evaluate((el) => ({ full: el.scrollWidth, shown: el.clientWidth }));
    assert.ok(shown.shown >= shown.full - 1, `${agent.name}: the name keeps its full width beside a long text (${JSON.stringify(shown)})`);
  }

  // The bar sits right above the composer, inside the chat column, without horizontal overflow.
  const boxes = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    return { bar: box('.live-bar'), composer: box('.composer-area') ?? box('.composer'), scroller: box('.message-scroller') };
  });
  assert.ok(boxes.bar && boxes.composer && boxes.bar.bottom <= boxes.composer.top + 1 && boxes.composer.top - boxes.bar.bottom < 16, `above the composer: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.scroller.bottom <= boxes.bar.top + 1, 'the messages end above the bar');

  // The person's newest line stays right above the bar.
  await rpc.call('messages.send', { conversationId: chat.id, body: 'How far are you?' });
  await page.locator('.message.human', { hasText: 'How far are you?' }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const gap = await page.evaluate(() => {
    const own = [...document.querySelectorAll('.message.human')].at(-1)?.getBoundingClientRect();
    const scroller = document.querySelector('.message-scroller')?.getBoundingClientRect();
    return own && scroller ? scroller.bottom - own.bottom : -1;
  });
  assert.ok(gap >= 0 && gap < 120, `the newest message stays at the bottom of the list, right above the bar (${gap}px)`);
  await shot('live-bar-01-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('live-bar-02-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // The header's live line opens the bar's lines (both) and closes them again; the header and the composer stay.
  const fixed = ['.chat-header', '.composer'];
  await expectStable(page, fixed, async () => { await page.locator('.chat-header .chat-live').click(); await page.locator('.live-bar-more').first().waitFor(); });
  await page.waitForFunction(() => document.querySelectorAll('.live-bar .live-bar-more').length === 2, undefined, { timeout: 10_000 });
  assert.equal(await page.locator('.chat-header .chat-live').getAttribute('aria-expanded'), 'true');
  await shot('live-bar-03-open');
  await expectStable(page, fixed, async () => { await page.locator('.chat-header .chat-live').click(); await page.locator('.live-bar-more').first().waitFor({ state: 'detached' }); });
  assert.equal(await page.locator('.live-bar .live-bar-more').count(), 0, 'closed again');

  // Hover only colours a line.
  await expectStable(page, ['.live-bar', '.live-bar-line', '.composer'], () => page.locator('.live-bar-line').first().hover());

  // A chat nothing comes from shows no bar.
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, quiet.id);
  await page.waitForFunction((title) => document.querySelector('.chat-header .chat-title')?.textContent?.trim() === title, 'Weekly video', { timeout: 10_000 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.live-bar').count(), 0, 'an old chat shows nothing');
  await shot('live-bar-04-other-chat');
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await bar.waitFor({ timeout: 10_000 });

  // 640×480 and phone width: on screen, no horizontal page scroll.
  for (const [width, height, name] of [[640, 480, '05-640x480'], [390, 844, '06-phone']]) {
    await size(width, height);
    await page.waitForTimeout(800);
    await bar.waitFor();
    const box = await bar.boundingBox();
    const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(box && box.x >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height, `the bar is on screen at ${width}×${height}: ${JSON.stringify({ box, view })}`);
    assert.ok(await overflow() <= 1, `no horizontal page scroll at ${width}×${height} (${await overflow()}px)`);
    await shot(`live-bar-${name}`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('live-bar-07-phone-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Owner 19.11.2026: the ▾ opens a line a little – its recent steps to scroll and "Watch live" – on the phone too;
  // the caret cell only swaps its icon, the line beside it keeps its place.
  const quillRow = bar.locator('.live-bar-item', { has: page.locator('.live-bar-name', { hasText: 'Quill' }) });
  const caret = quillRow.locator('.live-bar-caret');
  await expectStable(page, ['.composer'], async () => { await caret.click(); await quillRow.locator('.live-bar-more').waitFor(); });
  assert.equal(await caret.getAttribute('aria-expanded'), 'true');
  await quillRow.locator('.live-bar-steps .run-item').first().waitFor({ timeout: 15_000 });
  assert.ok(await quillRow.locator('.live-bar-steps .run-item').count() >= 1, 'its steps show');
  await quillRow.locator('.live-bar-watch').waitFor();
  const phoneOpen = await page.evaluate(() => {
    const steps = document.querySelector('.live-bar-steps')?.getBoundingClientRect();
    return { steps, view: { width: innerWidth, height: innerHeight }, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  assert.ok(phoneOpen.steps && phoneOpen.steps.right <= phoneOpen.view.width + 0.5 && phoneOpen.page <= 1, `the open line fits the phone: ${JSON.stringify(phoneOpen)}`);
  await shot('live-bar-07b-phone-open');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('live-bar-07c-phone-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1280, 820);
  await page.waitForTimeout(800);
  await shot('live-bar-07d-open');
  await quillRow.locator('.live-bar-watch').click();
  await page.locator('.browser-live-empty, .browser-live-address').first().waitFor({ timeout: 10_000 }); // Quill's own area (it does not browse here)
  await shot('live-bar-07e-watch-live');
  await caret.click();
  await quillRow.locator('.live-bar-more').waitFor({ state: 'detached' });
  assert.equal(await caret.getAttribute('aria-expanded'), 'false', 'the ▾ closes it again');

  // A line opens the agent's Work page with its activity log (the log lives there since F11, 16.11.2026).
  await bar.locator('.live-bar-line', { has: page.locator('.live-bar-name', { hasText: 'Quill' }) }).click();
  await page.waitForFunction((id) => location.hash === `#/team/${encodeURIComponent(id)}/work`, quill.id, { timeout: 10_000 });
  await page.locator('.agent-log').waitFor({ timeout: 10_000 });
  await shot('live-bar-08-agent-log');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
