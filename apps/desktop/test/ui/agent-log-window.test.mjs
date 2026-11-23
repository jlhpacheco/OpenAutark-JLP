// Electron window check of the agent's activity log (Team › agent, team/AgentLog.tsx) with the fake engine in an
// isolated profile:
//   * every turn is there by itself, oldest on top: a muted system line (time, "Message · <chat> · <model>"), its step
//     lines (one per journaled tool call, the tool name as title, opening to Input/Output), its answer open as words,
//     and a closing system line ("Done · …");
//   * opening a step moves nothing above it;
//   * live: a new turn comes in at the bottom while the page is open, with a spinner and Stop; Stop ends it and its
//     closing line says "Stopped";
//   * the agents.log RPC holds the same turns (the AI's agents.log tool: test/unit/runs/agent-log.test.ts);
//   * light, dark and phone (390×844, no horizontal page scroll); no renderer errors.
// Run: npm run build && node --test test/ui/agent-log-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect, MESSAGE_EVENTS, waitForNew } from '../e2e/lib/runtime-client.mjs';
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('Agent activity log: every turn in order, steps open in place, live turns with Stop', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-agent-log-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 300); win.setSize(w, h); }, [width, height]);
  await size(1280, 800);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const box = (selector) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Launch prep', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'org', `chat:${chat.id}`] });
  const answer = async (body) => {
    const sent = await rpc.call('messages.send', { conversationId: chat.id, body });
    return rpc.waitFor(MESSAGE_EVENTS, (message) => message.conversationId === chat.id && message.authorId === manager.id
      && message.state === 'final' && message.seq > sent.seq, 60_000);
  };
  await answer('Hello there');
  const worked = await answer('Who is on the team? [[tool:agents.list {}]] [[tool:app.status {}]]');
  const calls = (await rpc.call('runs.items', { runId: worked.runId })).filter((item) => item.kind === 'tool_call');
  assert.ok(calls.length >= 2, 'the run journaled its tool calls');

  // The RPC: the latest turns, oldest first, with their items.
  const logged = await rpc.call('agents.log', { id: manager.id });
  const ids = logged.runs.map((run) => run.id);
  assert.ok(ids.includes(worked.runId), 'the worked turn is in the log');
  assert.deepEqual(logged.runs.map((run) => run.startedAt), logged.runs.map((run) => run.startedAt).sort((a, b) => a - b), 'oldest first');
  assert.ok(logged.items.some((item) => item.runId === worked.runId && item.kind === 'tool_call'));

  // The page: the turn's system line, step lines, the answer open, the closing line.
  await page.evaluate((id) => { location.hash = `#/team/${id}/work`; }, manager.id);
  const turn = page.locator('.agent-log .log-turn', { has: page.locator('.run-item.tool .run-item-head[title="agents.list"]') }).last();
  await turn.waitFor({ timeout: 20_000 });
  await turn.scrollIntoViewIfNeeded();
  assert.equal((await page.locator('.agent-log .agent-section-title').textContent())?.trim(), 'Activity log');
  const start = ((await turn.locator('.log-system').first().locator('.log-system-text').textContent()) ?? '').trim();
  assert.match(start, /^Message · (?:.+ · )?Launch prep · fake-1$/, `the start line says what started it and where (${start})`);
  assert.match(((await turn.locator('.log-system').first().locator('.log-time').textContent()) ?? '').trim(), /^\d{1,2}:\d{2}/);
  assert.equal(await turn.locator('.run-item.tool').count(), calls.length, 'one step line per tool call');
  const answerText = turn.locator('.run-item.answer .run-item-text');
  assert.equal(await answerText.count(), 1, 'the answer reads open');
  assert.ok(((await answerText.textContent()) ?? '').trim().length > 0, 'the answer has its words');
  assert.match(((await turn.locator('.log-end .log-system-text').textContent()) ?? '').trim(), /^Done · \d+ s/);
  assert.ok(await page.locator('.agent-log .log-day').count() >= 1, 'a day line');
  assert.equal(await page.locator('.agent-log .log-turn').count(), logged.runs.length, 'every turn of the page');
  await shot('agent-log-01-light');

  // A step opens in place; nothing above it moves.
  const first = page.locator('.agent-log .log-turn').first().locator('.log-system').first();
  await first.evaluate((el) => el.setAttribute('data-test-first', ''));
  const head = turn.locator('.run-item.tool .run-item-head').first();
  const before = [await box('[data-test-first]'), await box('.agent-log .agent-section-title')];
  await head.click();
  await turn.locator('.run-item-body').first().waitFor({ timeout: 5_000 });
  assert.match((await turn.locator('.run-item-body').first().textContent()) ?? '', /Input|Output/);
  assert.deepEqual([await box('[data-test-first]'), await box('.agent-log .agent-section-title')], before, 'nothing above the opened step moved');
  await shot('agent-log-02-step-open');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('agent-log-03-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Live: a new turn comes in at the bottom with a spinner and Stop; Stop ends it.
  const count = await page.locator('.agent-log .log-turn').count();
  await rpc.call('messages.send', { conversationId: chat.id, body: 'Render the preview [[hang:render.preview {"file":"cut.mp4"}]]' });
  const live = page.locator('.agent-log .log-turn').nth(count);
  await live.waitFor({ timeout: 30_000 });
  assert.equal(await live.evaluate((el) => el.matches('.log-turn:last-child')), true, 'the new turn is the last one');
  await live.locator('.log-system .button', { hasText: 'Stop' }).waitFor({ timeout: 15_000 });
  assert.equal(await live.locator('.log-mark .spinner').count(), 1, 'a running turn spins in its mark');
  await live.locator('.run-item.tool.running').first().waitFor({ timeout: 15_000 });
  await live.scrollIntoViewIfNeeded();
  await shot('agent-log-04-live');
  const idle = waitForNew(rpc, 'agent.activity', ({ active }) => !active.some((entry) => entry.agentId === manager.id), 30_000);
  await live.locator('.log-system .button', { hasText: 'Stop' }).click();
  await idle;
  await live.locator('.log-end .log-system-text', { hasText: /^Stopped/ }).waitFor({ timeout: 15_000 });
  assert.equal(await live.locator('.log-system .button').count(), 0, 'no Stop once it ended');

  // Phone width: the log fits, no horizontal page scroll.
  await size(390, 844);
  await page.waitForTimeout(800);
  await page.locator('.agent-log .log-turn').last().scrollIntoViewIfNeeded();
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  await shot('agent-log-05-phone');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('agent-log-06-phone-dark');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
