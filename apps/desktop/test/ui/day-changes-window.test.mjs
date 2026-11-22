// "My day" package 2 in the real window (17.11.2026, Konrad #88/#117): an agent closes a to-do of the person and moves another one's time; under "Next" two
// muted lines say so ("Manager closed as not needed …", "Manager moved the time of …") with "Undo"; Undo brings the to-do back as it was (tasks.undo – the
// closed one is in the list again, the moved one has its old time) and the line goes. The agent acts through its own tools (the fake engine's tool markers), so
// the change log carries the agent's id, not the person's. Photos (SCREENSHOTS=<dir>) at 1280 and 390 px, light and dark; the window really is that wide.
// Owns: this check. Never: a real model or a signed package.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('My day: what an agent closed or moved is said under Next and Undo takes it back', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-day-changes-'));
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
  const until = async (check, what, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) assert.fail(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  await size(1280, 820);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Tidy up', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks', `chat:${chat.id}`] });

  const added = async (text) => {
    const before = (await rpc.call('todos.list', { limit: 200 })).map((task) => task.id);
    await rpc.call('todos.add', { text });
    let found;
    await until(async () => { found = (await rpc.call('todos.list', { limit: 200 })).find((task) => !before.includes(task.id)); return Boolean(found); }, `to-do "${text}"`);
    return found;
  };
  const toClose = await added('Release the memory');
  const toMove = await added('Call the tax office');
  const dueBefore = Date.now() + 5 * 3600_000;
  await rpc.call('tasks.update', { id: toMove.id, patch: { dueAt: dueBefore } });

  // The agent acts with its own tools: its id lands in the log.
  const tool = async (name, args) => {
    const sent = await rpc.call('messages.send', { conversationId: chat.id, body: `Done. [[tool:${name} ${JSON.stringify(args)}]]` });
    let answer;
    await until(async () => { answer = (await rpc.call('messages.list', { conversationId: chat.id, limit: 10 })).find((message) => message.authorId === manager.id && message.state === 'final' && message.seq > sent.seq); return Boolean(answer); }, `the manager's answer to ${name}`, 60_000);
    assert.doesNotMatch(answer.body, /Invalid arguments|error/i, answer.body);
  };
  await tool('tasks.finish', { taskId: toClose.id, status: 'dropped', summary: 'No longer needed' });
  await tool('tasks.update', { taskId: toMove.id, dueAt: new Date(dueBefore + 2 * 3600_000).toISOString() });
  const closed = await rpc.call('tasks.get', { id: toClose.id });
  assert.equal(closed.status, 'dropped');
  assert.equal(closed.ledger.changes?.at(-1)?.by, manager.id, 'the log names the agent');
  assert.equal((await rpc.call('tasks.get', { id: toMove.id })).dueAt, dueBefore + 2 * 3600_000);

  await page.evaluate(() => { location.hash = '#/day'; });
  const lines = page.locator('.day-view .day-changes .day-change');
  await until(async () => (await lines.count()) === 2, 'two change lines');
  const texts = (await lines.locator('.day-change-text').allTextContents()).map((text) => text.trim());
  assert.ok(texts.some((text) => /^Manager closed as not needed "Release the memory"$/.test(text)), texts.join(' | '));
  assert.ok(texts.some((text) => /^Manager moved the time of "Call the tax office"$/.test(text)), texts.join(' | '));
  await shot('day-changes-1280-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('day-changes-1280-dark');
  await size(390, 844);
  await page.waitForTimeout(600);
  const inner = await page.evaluate(() => window.innerWidth);
  assert.ok(inner <= 400, `the window really is phone wide (${inner})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, true, 'no sideways scroll');
  await shot('day-changes-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('day-changes-390-light');

  // Undo: the closed to-do is open again in the list, the moved one has its time back, the lines go.
  await lines.filter({ hasText: 'Release the memory' }).getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await rpc.call('todos.list', { limit: 200 })).some((task) => task.id === toClose.id), 'the closed to-do is back in the list');
  assert.equal((await rpc.call('tasks.get', { id: toClose.id })).status, 'open');
  await until(async () => (await lines.count()) === 1, 'its line is gone');
  await lines.filter({ hasText: 'Call the tax office' }).getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await rpc.call('tasks.get', { id: toMove.id })).dueAt === dueBefore, 'the time is back');
  await until(async () => (await lines.count()) === 0, 'no line left');
  const facts = (await rpc.call('tasks.get', { id: toClose.id })).ledger.facts ?? [];
  assert.ok(facts.some((fact) => /^Undone by You: it was closed as dropped\.$/.test(fact)), 'the owner reads why it is open again');
  await shot('day-changes-390-after-undo-light');
  assert.deepEqual(errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text)), [], 'no renderer errors');
});
