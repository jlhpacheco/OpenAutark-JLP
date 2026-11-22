// Electron window check of My day (B-041 §4; Umbau Einfachheit: no Plan or Timer buttons – the AI plans and sets
// timers from text; a row's actions are its right-click menu) with the demo engine in an isolated profile:
//   * #/day: the header (My day, the date with ‹ ›, the fixed Day | Week cell), the input row, the list root and the
//     calendar pane beside it; the sidebar's mini month;
//   * the input adds the person's own to-do (day.add) – it lands under Unplanned;
//   * a row's right-click menu: Snooze › "In 1 hour" moves an ordinary to-do to Later; Remove takes it off at once;
//   * a click into a free time of the day grid opens the slot field – the text becomes a block (calendar.add 'auto');
//     the block's popover moves it ("Move to") and its check finishes it; the keyboard reaches a free hour too;
//   * work the person handed to an agent shows under "Handed off n" with "<agent> working";
//   * Week shows the seven days in the calendar pane, Day goes back; nothing in the header moves;
//   * ‹ › and the mini month change the day (#/day/<date>, "Tomorrow"), the title goes back to today;
//   * a narrow window shows List | Calendar; the phone width shows the list first; light, dark, 640×480 and 375 px
//     screenshots; no horizontal page scroll; no renderer errors;
//   * 17.11.2026 (package 1): an empty day has no "Next"; an agent's asks show "Next" (the soonest, its length, who
//     asks, Start opens it), "High" only near its due time, the why under the meta, a two-line title at 390 px, a passed
//     time that asks "When does it suit you?" (Now · a free time · Tomorrow 08:00 · Not needed – each answer the person's
//     own call), a later day's block named "Tomorrow 18:00", no notice line over My day for a row its list shows, and
//     "Done since yesterday"; screenshots p1-* at 1280 and 390 px, light and dark.
// Run: npm run test:ui (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { expectStable } from './lib/stable.mjs';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('My day: input, row menu (snooze, remove), calendar slot and block, handed off, week, day navigation, layouts, Next and passed times', { timeout: 480_000, skip: new Date().getHours() >= 21 ? 'needs three hours left in the day: its long ask is due in three hours (after 21:00 that is tomorrow)' : false }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-day-'));
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
    win.setMinimumSize(320, 480); // the app's 640 px minimum would hide the phone layout
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  /** Polls `check` (no fixed sleeps: the renderer may lag under memory pressure) until it holds or `ms` pass. */
  const until = async (check, what, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) assert.fail(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const listed = async (id) => (await rpc.call('todos.list', { limit: 200 })).some((task) => task.id === id);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const menu = page.locator('.menu[aria-label="Context menu"]');

  await page.evaluate(() => { location.hash = '#/day'; });
  const view = page.locator('.day-view');
  await view.waitFor({ timeout: 15_000 });
  const header = view.locator('.day-header');
  assert.equal((await header.locator('.frame-header-text').textContent())?.trim(), 'My day');
  assert.equal((await header.locator('.day-date').textContent())?.trim(), 'Today', 'it opens on today');
  assert.equal(await header.getByRole('button', { name: 'Plan' }).count(), 0, 'no Plan button – the AI plans');
  assert.equal(await header.getByRole('button', { name: 'Timer' }).count(), 0, 'no Timer cell – timers come from text');
  assert.deepEqual((await header.locator('.day-span [role="tab"]').allTextContents()).map((text) => text.trim()), ['Day', 'Week']);
  assert.equal(await view.locator('.day-list .for-you').count(), 1, 'the protected list root holds the list');
  await view.locator('.day-cal-pane .day-cal-grid').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.sidebar .day-month .day-month-day.current').count(), 1, 'the mini month marks today');
  await shot('day-01-empty-light');
  // An empty day (17.11.2026): no "Next" card and no done line – nothing on top that could say something untrue.
  assert.equal(await view.locator('.day-next').count(), 0, 'an empty day has no Next');
  assert.equal(await view.locator('.day-next-done').count(), 0, 'nothing done yet');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('p1-empty-1280-dark');
  await size(390, 844);
  await page.locator('.mobile-shell .day-view .day-list').waitFor({ timeout: 15_000 });
  await shot('p1-empty-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('p1-empty-390-light');
  await size(1280, 820);
  await view.locator('.day-cal-pane .day-cal-grid').waitFor({ timeout: 15_000 });
  await shot('p1-empty-1280-light');

  // 1. The input: the person's own to-do, under Unplanned.
  const input = view.locator('.day-input-field');
  await input.fill('Water the plants');
  await input.press('Enter');
  const plants = view.locator('.todo-item', { hasText: 'Water the plants' });
  await plants.waitFor({ timeout: 15_000 });
  assert.equal(await view.locator('.todo-list[aria-label="Unplanned"] .todo-item', { hasText: 'Water the plants' }).count(), 1, 'no time: Unplanned');
  const todo = (await rpc.call('todos.list', { limit: 200 })).find((task) => task.title.startsWith('Water the plants'));
  assert.equal(todo?.assigneeKind, 'human', "the person's own");

  // 2. The row's right-click menu: Snooze › In 1 hour waits under Later; Remove takes it off at once.
  await input.fill('Sort the receipts');
  await input.press('Enter');
  const receipts = view.locator('.day-group .todo-item', { hasText: 'Sort the receipts' });
  await receipts.waitFor({ timeout: 15_000 });
  await receipts.locator('.todo-open').click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  const items = (await menu.locator('[role="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  for (const entry of ['In 1 hour', 'Remove']) assert.ok(items.includes(entry), `the menu offers ${entry}: ${items.join(' | ')}`);
  await shot('day-02-row-menu-light');
  await menu.getByRole('menuitem', { name: 'In 1 hour' }).click();
  await receipts.waitFor({ state: 'detached', timeout: 10_000 });
  await view.getByRole('button', { name: /^Later \d+$/ }).waitFor({ timeout: 10_000 }); // the count as the open groups show it
  await plants.locator('.todo-open').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Remove' }).click();
  await plants.waitFor({ state: 'detached', timeout: 10_000 });
  await until(async () => !(await listed(todo.id)), 'removed');

  // 3. The calendar: click into a free time → the slot field → a block; move it; tick it off.
  const grid = view.locator('.day-cal-grid');
  const box = await grid.boundingBox();
  await grid.evaluate((el) => { el.parentElement.scrollTop = 15 * 48 - 40; });
  await page.mouse.click(box.x + box.width / 2, (await grid.boundingBox()).y + 15 * 48 + 6);
  const slot = view.locator('.day-slot');
  await slot.waitFor({ timeout: 5_000 });
  assert.match((await slot.locator('.day-slot-time').textContent()) ?? '', /^15:00–15:30$/);
  await slot.locator('.day-slot-input').fill('Call Anna about the offer');
  await slot.locator('.day-slot-input').press('Enter');
  const block = view.locator('.day-block', { hasText: 'Call Anna' });
  await block.waitFor({ timeout: 15_000 });
  await shot('day-03-calendar-light');
  await block.locator('.day-block-open').click();
  const popover = page.locator('.day-block-popover');
  await popover.waitFor({ timeout: 5_000 });
  await popover.locator('.day-move-time').fill('16:00');
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await page.waitForFunction(() => /16:00–16:30/.test(document.querySelector('.day-block-open[aria-label^="Call Anna"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 10_000 });
  await page.keyboard.press('Escape');
  const check = view.locator('.day-block:has(.day-block-open[aria-label^="Call Anna"]) .day-block-check');
  if (await check.count()) {
    await check.click();
    await view.locator('.day-block-check.done').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  }
  // The keyboard reaches a free time too: one tab stop of hours (↑ ↓), Enter opens the slot field there.
  const stop = view.locator('.day-cal-grid .day-cal-stop[tabindex="0"]');
  await stop.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await view.locator('.day-slot').waitFor({ timeout: 5_000 });
  await view.locator('.day-slot-input').press('Escape');
  await view.locator('.day-slot').waitFor({ state: 'detached', timeout: 5_000 });
  assert.match((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ?? '', /^Add at \d{2}:00$/, 'back on the hour');

  // 4. Handed off: work the person gave an agent.
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager' || agent.mode === 'manager');
  await rpc.call('tasks.create', { title: 'Prepare the tax papers', to: manager.id });
  const handedToggle = view.getByRole('button', { name: /^Handed off \d+$/ });
  await handedToggle.waitFor({ timeout: 15_000 });
  await handedToggle.click();
  const handedRow = view.locator('.day-handed-row', { hasText: 'Prepare the tax papers' });
  await handedRow.waitFor({ timeout: 10_000 });
  assert.match((await handedRow.locator('.day-handed-state').textContent()) ?? '', new RegExp(`${manager.name}|Not assigned yet`));

  // 5. Week ⇄ Day in the fixed header cell: the week takes the pane; the header keeps its boxes.
  const steady = ['.day-header .day-span', '.day-header button[aria-label^="Previous"]', '.day-header button[aria-label^="Next"]', '.day-header .day-date'];
  await expectStable(page, steady, async () => {
    await header.locator('.day-span [role="tab"]', { hasText: 'Week' }).click();
    await view.locator('.day-week').waitFor({ timeout: 10_000 });
  });
  assert.equal(await header.locator('.day-span [role="tab"][aria-selected="true"]').textContent(), 'Week');
  await shot('day-04-week-light');
  await expectStable(page, steady, async () => {
    await header.locator('.day-span [role="tab"]', { hasText: 'Day' }).click();
    await view.locator('.day-cal-grid').waitFor({ timeout: 10_000 });
  });

  // 6. Day navigation: › opens tomorrow (#/day/<date>), the title goes back to today; the mini month.
  await header.getByRole('button', { name: 'Next day' }).click();
  await page.waitForFunction(() => /^#\/day\/\d{4}-\d{2}-\d{2}$/.test(location.hash), null, { timeout: 5_000 });
  assert.equal((await header.locator('.day-date').textContent())?.trim(), 'Tomorrow');
  await expectStable(page, ['.day-header button[aria-label="Previous day"]', '.day-header button[aria-label="Next day"]', '.day-header .day-span'], async () => {
    await header.getByRole('button', { name: 'Previous day' }).click();
    await page.waitForFunction(() => location.hash === '#/day', null, { timeout: 5_000 });
    await header.getByRole('button', { name: 'Previous day' }).click();
    await page.waitForFunction(() => /^#\/day\/\d{4}-\d{2}-\d{2}$/.test(location.hash), null, { timeout: 5_000 });
  });
  assert.equal((await header.locator('.day-date').textContent())?.trim(), 'Yesterday');
  await header.locator('.day-date').click();
  await page.waitForFunction(() => location.hash === '#/day', null, { timeout: 5_000 });
  await page.locator('.sidebar .day-month-day:not(.current):not(.outside)').last().click();
  await page.waitForFunction(() => /^#\/day\/\d{4}-\d{2}-\d{2}$/.test(location.hash), null, { timeout: 5_000 });
  await page.evaluate(() => { location.hash = '#/day'; });

  // 7. Dark, a narrow window (List | Calendar), 640×480 and the phone width.
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('day-05-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(900, 700);
  const switcher = view.locator('.day-switch');
  await switcher.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined); // a narrow view shows it
  if (await switcher.isVisible()) {
    await switcher.getByRole('tab', { name: 'Calendar' }).click();
    await view.locator('.day-cal-grid').waitFor({ timeout: 5_000 });
    assert.equal(await view.locator('.day-listpane').isVisible(), false, 'the calendar instead of the list');
    await shot('day-06-narrow-calendar');
    await switcher.getByRole('tab', { name: 'List' }).click();
  }
  await size(640, 480);
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 640×480 (${await overflow()}px)`, 5_000);
  await shot('day-07-640x480');
  await size(375, 812);
  await page.evaluate(() => { location.hash = '#/day'; });
  await page.locator('.mobile-shell .day-view .day-list').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.mobile-shell .day-view .day-listpane').isVisible(), true, 'the phone opens on the list');
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 375 px (${await overflow()}px)`, 5_000);
  await shot('day-08-375');

  // 8. "Next", the rows and a passed time (17.11.2026, My day package 1). An agent asks four things the way agents do:
  //    each High or normal with a due time, which places its block there (tools/builtin/tasks.ts placeOnMyDay).
  await size(1280, 900);
  const now = Date.now();
  const iso = (at) => new Date(at).toISOString();
  const morning = new Date(now); morning.setDate(morning.getDate() + 1); morning.setHours(8, 0, 0, 0);
  const evening = new Date(now); evening.setDate(evening.getDate() + 1); evening.setHours(18, 0, 0, 0);
  const asks = {
    soon: 'Approve the invoice for the conference booth',
    long: 'Social start: eight short questions so the first posts sound like you and can go out this week without another round of edits',
    passed: 'Phone test: hand the phone to Mira for 15 minutes with wireless debugging switched on',
    tomorrow: 'Address proof for the certificate (photo or PDF)',
  };
  const why = 'The booth is booked until Friday.';
  const repeated = 'So the first posts sound like you.'; // part of the long title: the row does not say it twice
  const create = (args) => `[[tool:tasks.create ${JSON.stringify({ widget: { type: 'confirm' }, ...args })}]]`;
  const launch = await rpc.call('chats.create', { title: 'Social launch', agentIds: [manager.id] });
  await page.evaluate(() => { location.hash = '#/settings'; }); // elsewhere: the asks show as notice lines
  await rpc.call('messages.send', {
    conversationId: launch.id,
    body: [
      create({ title: asks.soon, priority: 1, dueAt: iso(now + 40 * 60_000), estimateMin: 5, widget: { type: 'confirm', why } }),
      create({ title: asks.long, priority: 1, dueAt: iso(now + 3 * 60 * 60_000), estimateMin: 10, widget: { type: 'confirm', why: repeated } }),
      create({ title: asks.passed, dueAt: iso(now - 3 * 60 * 60_000), estimateMin: 15 }),
      create({ title: asks.tomorrow, priority: 1, dueAt: iso(evening.getTime()), estimateMin: 5 }),
    ].join(' '),
  });
  const todoOf = async (title) => (await rpc.call('todos.list', { limit: 200 })).find((task) => task.title === title);
  await until(async () => (await Promise.all(Object.values(asks).map(todoOf))).every(Boolean), 'the four asks on the list', 60_000);
  const ids = Object.fromEntries(await Promise.all(Object.entries(asks).map(async ([key, title]) => [key, (await todoOf(title)).id])));
  const toastLines = page.locator('.status-note[data-notice^="toast-"]', { hasText: /Approve the invoice|Social start|Phone test|Address proof/ });
  await until(async () => (await toastLines.count()) > 0, 'the asks as notice lines outside My day', 30_000);
  await page.evaluate(() => { location.hash = '#/day'; });
  await view.locator('.day-next').waitFor({ timeout: 15_000 });
  await until(async () => (await toastLines.count()) === 0, 'no notice line over My day for a row its list shows', 10_000);

  const row = (id) => view.locator(`.todo-item[data-task-id="${id}"]`);
  const card = view.locator('.day-next');
  await until(async () => (await card.locator('.day-next-title').textContent()) === asks.soon, 'Next is the soonest ask');
  assert.match((await card.locator('.day-next-label').textContent()) ?? '', /^Next · \d{2}:\d{2}$/i);
  // Where the shell's status lines would lie (shell/StatusLine.tsx: over the main zone's top, never a band) – recorded for
  // the open point "status lines over My day", not asserted: the lines still lie over the top of the view.
  const host = await page.locator('.main-slot > .status-host').boundingBox();
  const start = await card.getByRole('button', { name: 'Start' }).boundingBox();
  if (host && start) t.diagnostic(`1280: status lines x ${Math.round(host.x)}–${Math.round(host.x + host.width)} from y ${Math.round(host.y)}; Start x ${Math.round(start.x)}–${Math.round(start.x + start.width)}, y ${Math.round(start.y)}–${Math.round(start.y + start.height)}`);
  assert.match((await card.locator('.day-next-meta').textContent()) ?? '', new RegExp(`^5 min · ${manager.name} asks`), 'its length and who asks');
  assert.equal(await card.getByRole('button', { name: 'Start' }).count(), 1);
  assert.equal((await row(ids.soon).locator('.todo-priority').textContent())?.trim(), 'High', 'High forty minutes before its due time');
  assert.equal(await row(ids.long).locator('.todo-priority').count(), 0, 'no High three hours ahead');
  assert.equal((await row(ids.soon).locator('.todo-why-line').textContent())?.trim(), why, 'the sentence why under the meta');
  assert.equal(await row(ids.long).locator('.todo-why-line').count(), 0, 'a why that only repeats the title is left out');
  const meta = (await row(ids.long).locator('.todo-meta > *').allTextContents()).map((text) => text.trim()).filter(Boolean); // the dots between are CSS
  assert.match(meta.join(' · '), new RegExp(`^\\d{2}:\\d{2} · 10 min · ${manager.name}$`), `time · length · who asks: ${meta.join(' | ')}`);
  const passedHint = row(ids.passed).locator('.day-stale');
  await passedHint.waitFor({ timeout: 10_000 });
  assert.match((await passedHint.locator('.day-stale-text').textContent()) ?? '', /^Was planned for (Yesterday )?\d{2}:\d{2}\. When does it suit you\?$/);
  const answers = (await passedHint.getByRole('button').allTextContents()).map((text) => text.trim());
  assert.equal(answers[0], 'Now');
  assert.ok(answers.length < 3 || /^Today \d{2}:\d{2}$/.test(answers[1] ?? ''), `a free time says its day ("Today 16:20", not "16:20"): ${answers.join(' | ')}`);
  assert.ok(answers.includes('Tomorrow 08:00') && answers.at(-1) === 'Not needed', `the answers: ${answers.join(' | ')}`);
  assert.equal(await view.locator('.day-stale').count(), 1, 'only the passed one asks');
  const laterToggle = view.getByRole('button', { name: /^Later \d+$/ });
  if ((await laterToggle.getAttribute('aria-expanded')) !== 'true') await laterToggle.click(); // the list may have opened it for an earlier reveal
  await until(async () => /Tomorrow 18:00/.test((await row(ids.tomorrow).locator('.todo-meta').textContent()) ?? ''), 'a block on another day names its day');
  await shot('p1-list-1280-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('p1-list-1280-dark');
  await size(390, 844);
  await page.locator('.mobile-shell .day-view .day-next').waitFor({ timeout: 15_000 });
  const phone = page.locator('.mobile-shell .day-view');
  const phoneHost = await page.locator('.mobile-shell > .status-host').boundingBox();
  const phoneCard = await phone.locator('.day-next').boundingBox();
  if (phoneHost && phoneCard) t.diagnostic(`390: status lines from y ${Math.round(phoneHost.y)} (one line about 38 px); Next from y ${Math.round(phoneCard.y)}`);
  const title = phone.locator(`.todo-item[data-task-id="${ids.long}"] .todo-title`);
  const lines = await title.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  assert.equal(lines, 2, 'the long title takes two lines at 390 px');
  assert.ok(await title.evaluate((el) => el.scrollHeight > el.clientHeight + 1), 'and is cut after the second');
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 390 px (${await overflow()}px)`, 5_000);
  await shot('p1-list-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('p1-list-390-light');
  await size(390, 1700); // the whole list at phone width
  await shot('p1-list-390-tall-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('p1-list-390-tall-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1280, 900);
  await view.locator('.day-next').waitFor({ timeout: 15_000 });

  // The answers are the person's own changes: Now moves the block to now (its due time along) – it becomes "Now" on top.
  await row(ids.passed).locator('.day-stale').getByRole('button', { name: 'Now' }).click();
  await row(ids.passed).locator('.day-stale').waitFor({ state: 'detached', timeout: 10_000 });
  await until(async () => (await card.locator('.day-next-label').textContent())?.trim().toLowerCase() === 'now' && (await card.locator('.day-next-title').textContent()) === asks.passed, 'the moved ask is Now');
  const moved = await todoOf(asks.passed);
  assert.ok(moved.dueAt >= now - 60_000, 'its due time moved along');
  await card.getByRole('button', { name: 'Start' }).click();
  await view.locator(`.todo-item.expanded[data-task-id="${ids.passed}"]`).waitFor({ timeout: 5_000 });
  await shot('p1-now-start-1280-light');
  // "Tomorrow 08:00" on a passed to-do of the person's own (calendar.add into a past slot) moves its block there.
  const own = await rpc.call('calendar.add', { kind: 'todo', text: 'Call the landlord about the heating', startAt: now - 2 * 60 * 60_000, endAt: now - 90 * 60_000 });
  const ownHint = row(own.task.id).locator('.day-stale');
  await ownHint.waitFor({ timeout: 10_000 });
  await ownHint.getByRole('button', { name: 'Tomorrow 08:00' }).click();
  await ownHint.waitFor({ state: 'detached', timeout: 10_000 });
  const tomorrowRows = await rpc.call('calendar.list', { from: morning.getTime() - 60 * 60_000, to: morning.getTime() + 2 * 60 * 60_000 });
  assert.equal(tomorrowRows.events.find((event) => event.taskId === own.task.id)?.startAt, morning.getTime(), 'its block tomorrow at the start of work');
  // "Not needed" declines an agent's ask with that reason; it leaves the list.
  await rpc.call('messages.send', { conversationId: launch.id, body: create({ title: 'Send the booth photos to the printer', dueAt: iso(now - 4 * 60 * 60_000), estimateMin: 5 }) });
  await until(async () => Boolean(await todoOf('Send the booth photos to the printer')), 'the second passed ask', 60_000);
  const printer = (await todoOf('Send the booth photos to the printer')).id;
  await row(printer).locator('.day-stale').getByRole('button', { name: 'Not needed' }).click();
  await until(async () => !(await listed(printer)), 'declined: off the list');
  // Ticking one off: "Done since yesterday" names it.
  await row(ids.soon).locator('.day-check').click();
  await until(async () => /Approve the invoice/.test((await view.locator('.day-next-done').textContent().catch(() => '')) ?? ''), 'the done line names it');
  await shot('p1-after-answers-1280-light');

  // A full day at phone width (Mika 17.11.2026): more entries, three of them past their time – the asks stack, the page stays calm.
  const crowd = ['Reply to the printer about the proofs', 'Check the stand plan with Mira', 'Book the train to the fair', 'Sign the delivery note', 'Call the caterer'];
  const crowdAt = [now - 5 * 60 * 60_000, now - 2 * 60 * 60_000, now - 90 * 60_000, now + 4 * 60 * 60_000, now + 5 * 60 * 60_000];
  await rpc.call('messages.send', { conversationId: launch.id, body: crowd.map((title, index) => create({ title, dueAt: iso(crowdAt[index]), estimateMin: 10 })).join(' ') });
  await until(async () => (await Promise.all(crowd.map(todoOf))).every(Boolean), 'the crowd of asks on the list', 60_000);
  await size(390, 2400);
  await until(async () => (await view.locator('.day-stale, .day-stale-chip').count()) >= 3, 'three entries are past their time', 15_000);
  // Mika 17.11.2026: only the first asks in a box; the others are one slim line that opens the same answers.
  assert.equal(await view.locator('.day-stale').count(), 1, 'one box asks at a time');
  assert.ok((await view.locator('.day-stale-chip').count()) >= 2, 'the others are slim lines');
  const chip = view.locator('.day-stale-chip').first();
  assert.equal((await chip.textContent())?.trim(), 'Missed · Reschedule', 'the time stands in the row right above, the line does not say it twice');
  const lineHeight = (await chip.boundingBox())?.height ?? 99;
  assert.ok(lineHeight <= 44, `a slim line, not a box (${lineHeight}px)`);
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll with a full day at 390 px (${await overflow()}px)`, 5_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('p1-list-390-full-day-light');
  await chip.click();
  assert.equal(await view.locator('.day-stale').count(), 2, 'a tap opens the same answers for that row');
  const opened = (await view.locator('.day-stale').nth(1).getByRole('button').allTextContents()).map((text) => text.trim());
  assert.ok(opened[0] === 'Now' && opened.at(-1) === 'Not needed', `the opened line offers the same answers: ${opened.join(' | ')}`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('p1-list-390-full-day-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
