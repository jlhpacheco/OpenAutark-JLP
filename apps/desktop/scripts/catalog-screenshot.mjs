// Catalog screenshot: the real main window of Autark with made-up demo data, as a PNG for the AppImage/AppStream
// catalog (resources/linux/com.teydralab.workforce.metainfo.xml → docs/screenshots/main-window.png).
//
// It starts the built app (npm run build first) with the fake engine and an empty, throw-away data folder – the same way
// the window tests under test/ui/ do – sets up a made-up company ("Northwind Studio", person "Alex Morgan"), a small team
// and a conversation with the personal manager (one line from the person, answers of the fake engine, a task that is
// running right now), sizes the window to 1600×900 and saves the window's content as PNG. Nothing of a real profile is
// read: no real names, mails, tokens or addresses are in it.
//
// Run:  npm run build && node scripts/catalog-screenshot.mjs [outDir]      (on a headless Linux box: xvfb-run -a node …)
// Out:  <outDir>/main-window.png (the catalog image) plus stage-*.png (what the window showed on the way, for debugging).
// Owns: the demo story and the capture. Never: touches the user's data folder or any network.

import { testNetworkEnv } from './test-network-env.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { connect, MESSAGE_EVENTS } from '../test/e2e/lib/runtime-client.mjs';
import { runtimeInfo } from '../test/ui/lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const out = path.resolve(process.argv[2] ?? 'out');
const WIDTH = 1600;
const HEIGHT = 900;

const PERSON = 'Alex Morgan';
const COMPANY = 'Northwind Studio';
/** The fake engine answers a line that holds only a [[ui:…]] directive with exactly that rich block (engines/fake.ts). */
const ui = (block) => `[[ui:${JSON.stringify(block)}]]`;
const FIRST_ASK = 'Can you plan the launch of our spring collection? Ideally everything is ready by Friday.';
const FIRST_ANSWER = {
  type: 'steps',
  items: [
    { title: 'Collect product photos and prices', status: 'done' },
    { title: 'Write the announcement', text: 'Quill drafts the newsletter and three social posts.', status: 'active' },
    { title: 'Design the banner set', status: 'todo' },
    { title: 'Schedule everything for Friday, 9:00', status: 'todo' },
  ],
};
const SECOND_ASK = 'Perfect. Start with the announcement and tell me here when the first draft is ready.';
const SECOND_ANSWER = { type: 'callout', tone: 'info', text: 'Quill is writing the announcement now – you get the first draft here in about ten minutes.' };
const TEAM = [
  { name: 'Quill', role: 'Writer' },
  { name: 'Scout', role: 'Researcher' },
  { name: 'Pixel', role: 'Designer' },
  { name: 'Ledger', role: 'Bookkeeper' },
];
const OTHER_CHATS = [['Weekly newsletter', 'Quill'], ['Supplier invoices', 'Ledger'], ['Website refresh', 'Pixel']];

const log = (...args) => console.log('[catalog-screenshot]', ...args);

async function main() {
  await mkdir(out, { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autark-catalog-'));
  const linux = process.platform === 'linux';
  const app = await electron.launch({
    executablePath: electronPath,
    // A CI box has no setuid sandbox helper; the window only shows made-up data of a throw-away profile.
    args: [root, ...(linux ? ['--no-sandbox', '--disable-gpu', '--password-store=gnome-libsecret'] : [])],
    cwd: root, timeout: 90_000,
    env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', WORKFORCE_FAKE_MODELS: 'claude-opus-5-5', ELECTRON_ENABLE_LOGGING: '0' }),
  });
  let rpc;
  let page;
  const errors = [];
  const appLog = [];
  app.process().stdout?.on('data', (chunk) => appLog.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => appLog.push(String(chunk)));
  try {
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('.shell', { timeout: 90_000 });
    log('window is up');
    const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(out, `${name}.png`) }); log('saved', name); };
    await shot('stage-0-fresh');

    const info = await runtimeInfo(profile, 90_000);
    rpc = await connect(info.port, info.token, 'cli');

    // The made-up company: the person and the company name, the first run done (as the window tests do).
    await rpc.call('settings.update', { profile: { name: PERSON, company: COMPANY }, onboarding: { completed: true, step: 'done' } });

    const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager' && !agent.archivedAt);
    const team = {};
    for (const member of TEAM) team[member.name] = await rpc.call('agents.create', { name: member.name, role: member.role, managerId: manager.id });
    log('team:', Object.keys(team).join(', '));

    const chat = await rpc.call('chats.create', { title: 'Spring launch', agentIds: [manager.id, team.Quill.id] });
    await rpc.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system', `chat:${chat.id}`] });
    for (const [title, who] of OTHER_CHATS) await rpc.call('chats.create', { title, agentIds: [manager.id, team[who].id] });

    // A line of the person that holds only a directive, and the fake engine's answer to it. Both lines of the person are
    // rewritten to what a person would say afterwards (an edit tells the agent quietly – no turn, no echo).
    const asked = [];
    const exchange = async (answer) => {
      const sent = await rpc.call('messages.send', { conversationId: chat.id, body: ui(answer), mentions: [manager.id] });
      await rpc.waitFor(MESSAGE_EVENTS, (message) => message.conversationId === chat.id && message.authorId === manager.id
        && message.state === 'final' && message.seq > sent.seq, 60_000);
      asked.push(sent.id);
    };
    await exchange(FIRST_ANSWER);
    await exchange(SECOND_ANSWER);
    await rpc.call('messages.edit', { id: asked[0], body: FIRST_ASK });
    await rpc.call('messages.edit', { id: asked[1], body: SECOND_ASK });

    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    await page.locator('.message-scroller').waitFor({ timeout: 30_000 });
    await page.locator('.composer').waitFor({ timeout: 30_000 });
    await shot('stage-1-chat');

    // Work in progress right now: Quill works on the announcement (a tool that never ends – the fake engine's [[hang:…]]).
    const working = rpc.waitFor('agent.activity', (event) => event.active.some((run) => run.agentId === team.Quill.id && run.conversationId === chat.id), 60_000);
    const task = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Write the spring announcement [[hang:web.search {"query":"spring collection announcement"}]]', to: team.Quill.id });
    await working;
    await rpc.call('tasks.update', { id: task.id, patch: { title: 'Write the spring announcement' } });
    await page.locator('.live-bar .live-bar-line').first().waitFor({ timeout: 30_000 });

    // The window: 1600×900 content, calm look, the edit marks of the rewritten lines out of the picture.
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const [win] = BrowserWindow.getAllWindows();
      win.setMinimumSize(640, 480);
      win.setContentSize(w, h);
      win.center();
    }, [WIDTH, HEIGHT]);
    // The fake engine puts "Echo: <the line's envelope>" before a scripted block; the picture shows the block only.
    await page.addStyleTag({ content: '.edited-marker, .catalog-hide { display: none !important; }' });
    await page.evaluate(() => {
      const hide = () => {
        for (const p of document.querySelectorAll('.message.agent .message-content p')) {
          if ((p.textContent ?? '').trim().startsWith('Echo:')) p.classList.add('catalog-hide');
        }
      };
      hide();
      new MutationObserver(hide).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.locator('.message-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await sleep(2500); // the live line's text and clock settle
    await shot('stage-2-before-final');

    const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    log('viewport', size.join('x'));
    await page.screenshot({ path: path.join(out, 'main-window.png') });
    log('saved main-window.png');

    // The agent's Work page (Now / Active tasks) as a second look, only for checking.
    await page.evaluate((id) => { location.hash = `#/team/${id}/work`; }, team.Quill.id);
    await sleep(1500);
    await shot('stage-3-quill-work');

    await writeFile(path.join(out, 'report.json'), JSON.stringify({ viewport: size, errors, profile: path.basename(profile) }, null, 2));
    if (errors.length) log('renderer errors:', errors.slice(0, 5).join(' | '));
  } catch (error) {
    // What the window showed when it went wrong, for the CI artifact.
    try { await page?.screenshot({ path: path.join(out, 'failure.png') }); } catch { /* the window may be gone */ }
    try { await writeFile(path.join(out, 'failure.txt'), [String(error), '', 'URL: ' + page?.url(), '', 'Renderer errors:', ...errors, '', 'Body text:', (await page?.evaluate(() => document.body.innerText)) ?? '', '', 'App output:', appLog.join('').slice(-6000)].join('\n')); } catch { /* ignore */ }
    throw error;
  } finally {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
