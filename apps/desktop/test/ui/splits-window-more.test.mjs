// Electron window check of B-057 Splits, part 2 – what test/ui/splits-window.test.mjs leaves out – with the fake engine
// in an isolated test profile. The Manager's home is a git repository in the workspace ('site'). Two groups are made
// through the fake engine's scripted [[tool:agents.split …]] (the parts' own directives are JSON unicode escapes):
//   1. "Site title" chat: three worktree parts change the same line of index.html with their own shell.exec (no
//      approval any more – agents may do everything); all end done, committed on their branches;
//   2. "Launch check" chat: #1 hangs ([[hang:bash]] – running until stopped), #2 answers, #3 waits for #1 (after).
// Checked:
//   (a) the chat: the header's live line says "1 of 3 parts working" and opens the live bar's lines; the running part's
//       line ("#1 …", no Stop of its own) opens to its steps and its group's split rows (spinner / done / waiting), a
//       part row to its steps; the header, the composer and the line keep their boxes (20.11.2026: the bar replaced the
//       working popover), and opening a part row moves none of the part rows above it (the bar keeps its height and
//       scrolls inside);
//   (b) Team › agent › Work › Activity log: the turn that split shows its agents.split call as "Split · 1 of 3 done" (spinner,
//       the goal as title), open from the start as columns – #1 and #2 side by side, then #1 alone once #2 is back
//       ("Done · … · back to <agent>"), #3 waiting below, the parts' own steps in their columns; closing and opening
//       move nothing above; no sideways page scroll at phone width;
//   (c) the worktree parts: each branch holds its own title; the main checkout is untouched (merging is the agent's
//       job – split_merge – the split page has no Merge / Discard cell any more); scrolled to its end in a low window,
//       closing a step and the brief moves nothing above (lib/kept-page.ts, as on the agent page);
//   (d) the team sidebar: every group starts with its goal line (one static line, ellipsis, tooltip, no button; it
//       sticks to the block's top while its group is scrolled half away); a row click moves no goal line, row or block;
//   light and dark at 1280×800 and 390×844 for every view (the sidebar, which a phone does not have: 720×800, its
//   narrowest window); no layout problems; no renderer errors.
// Run: npm run build && node --test test/ui/splits-window-more.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
/** The agents.split directive; the parts' own [[…]] directives are JSON-escaped (only the part's turn runs them). */
const splitCall = (goal, parts) => `[[tool:agents.split ${JSON.stringify({ goal, parts }).split('[[').join('\\u005b\\u005b').split(']]').join('\\u005d\\u005d')}]]`;
const byIdx = (group) => group.splits.slice().sort((a, b) => a.idx - b.idx);
const IDEAS = ['A', 'B', 'C'];

/** The test's stand-in for an agent editing its own worktree: shell.exec runs in the workspace or the part's worktree
 *  (the command names the helper by its full path), so this finds the
 *  part's worktree by its branch (wf/split-<slug of the part's title, cut>-<id6>) and writes the title into its index.html. */
const EDIT_TITLE = [
  "import { execFileSync } from 'node:child_process';",
  "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "import path from 'node:path';",
  "const [slug, title] = process.argv.slice(2);",
  "const repo = existsSync('site') ? 'site' : '.'; // the workspace, or already a folder of the repository (the part's worktree)",
  "const log = (line) => appendFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'edit-title.log'), line + '\\n');",
  "log(JSON.stringify({ cwd: process.cwd(), slug, title }));",
  "for (let i = 0; i < 50; i++) {",
  "  const out = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });",
  "  const tree = out.split(/\\r?\\n\\r?\\n/).map((block) => ({ dir: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch refs\\/heads\\/(.+)$/m.exec(block)?.[1] }))",
  "    .find((entry) => entry.dir && entry.branch?.startsWith('wf/split-') && slug.startsWith(entry.branch.slice(9).replace(/-[a-z0-9]{6}$/, '')));",
  "  if (tree) { writeFileSync(path.join(tree.dir, 'index.html'), '<h1>' + title + '</h1>\\n'); log('wrote ' + tree.dir); console.log('wrote ' + title); process.exit(0); }",
  "  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);",
  "}",
  "log('no worktree for ' + slug); console.log('no worktree for ' + slug); process.exit(1);",
].join('\n');

async function until(read, check, label, ms = 120_000) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (check(value)) return value;
    await sleep(400);
  }
  assert.fail(`${label} (last: ${JSON.stringify(value)?.slice(0, 600)})`);
}

/** Sideways scrolling, children sticking out of the split boxes, overlapping row slots, texts cut without an ellipsis
 *  and one-line texts that could wrap. */
function layoutProblems() {
  const out = [];
  const shown = (el) => el.getClientRects().length > 0;
  for (const el of [document.documentElement, ...document.querySelectorAll('.shell, .mobile-shell, .message-scroller, .agent-scroll, .team-nav, .team-splits, .live-bar')]) {
    if (shown(el) && el.scrollWidth > el.clientWidth + 1) out.push(`${el.className || el.tagName} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
  }
  for (const box of document.querySelectorAll('.split-rows, .split-facts, .team-split-group, .live-bar-parts')) {
    if (!shown(box)) continue;
    const b = box.getBoundingClientRect();
    for (const kid of box.children) {
      const r = kid.getBoundingClientRect();
      if (r.width && (r.right > b.right + 0.5 || r.left < b.left - 4.5)) out.push(`${kid.className || kid.tagName} sticks out of ${box.className} (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(b.left)}–${Math.round(b.right)})`);
    }
  }
  for (const head of document.querySelectorAll('.split-row-head, .team-split-row, .live-bar-row, .split-branch-line')) {
    if (!shown(head)) continue;
    const box = head.getBoundingClientRect();
    const kids = [...head.children].filter((kid) => shown(kid) && kid.getBoundingClientRect().width > 0);
    kids.forEach((kid, index) => {
      const r = kid.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${kid.className} sticks out of ${head.className}`);
      const next = kids[index + 1]?.getBoundingClientRect();
      if (next && next.top < r.bottom - 0.5 && r.right > next.left + 0.5) out.push(`${kid.className} overlaps ${kids[index + 1].className} in ${head.className}`);
    });
  }
  for (const el of document.querySelectorAll('.split-row-model, .split-row-time, .team-split-time, .split-branch, .split-branch-cell, .split-facts dd, .split-step > .run-item-head .run-item-target')) {
    if (shown(el) && el.scrollWidth > el.clientWidth + 1) out.push(`${el.className || el.tagName} cut: "${el.textContent?.trim()}" (${el.scrollWidth} > ${el.clientWidth})`);
  }
  for (const el of document.querySelectorAll('.team-split-goal-text, .split-row-title, .team-split-title, .live-bar-text')) {
    const style = shown(el) ? getComputedStyle(el) : undefined;
    if (style && (style.whiteSpace !== 'nowrap' || style.textOverflow !== 'ellipsis')) out.push(`${el.className} may wrap or be cut without an ellipsis`);
  }
  return out;
}

test('splits, part 2: the live bar\'s part line, Runs › parts, merge conflict and sidebar goal lines in the real window', { timeout: 900_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-splits-more-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  mkdirSync(shots, { recursive: true });
  const emptyConfig = path.join(profile, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  const repo = path.join(profile, 'workspace', 'site');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Person']);
  git(repo, ['config', 'user.email', 'person@example.invalid']);
  writeFileSync(path.join(repo, 'index.html'), '<h1>Old title</h1>\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Initial commit']);
  writeFileSync(path.join(profile, 'workspace', 'edit-title.mjs'), EDIT_TITLE);

  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' }, { inherited: gitEnv }),
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
  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
    await page.waitForTimeout(800);
  };
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  /** The same view light, then dark (light again after). */
  const shots2 = async (name) => { await shot(`${name}-light`); await page.emulateMedia({ colorScheme: 'dark' }); await shot(`${name}-dark`); await page.emulateMedia({ colorScheme: 'light' }); };
  const noProblems = async (where) => { assert.deepEqual(await page.evaluate(layoutProblems), [], `layout at ${where}`); };
  const go = async (hash, ready) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.locator(ready).first().waitFor({ timeout: 20_000 }); };
  /** [left, top, width, height, bottom] of the first match, rounded; null when there is none. */
  const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height, r.bottom].map(Math.round) : null; }, sel);
  const present = (list) => page.evaluate((all) => all.filter((s) => document.querySelector(s)), list);
  await size(1280, 800);

  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  await rpc.call('agents.setHome', { agentId: manager.id, home: repo });
  const launch = await rpc.call('chats.create', { title: 'Launch check', agentIds: [manager.id] });
  const site = await rpc.call('chats.create', { title: 'Site title', agentIds: [manager.id] });
  const send = (chat, body) => rpc.call('messages.send', { conversationId: chat.id, body });
  const groupOf = async (goal) => (await rpc.call('splits.list', { agentId: manager.id })).find((g) => g.goal === goal);
  const groupWhen = (goal, check, label, ms = 180_000) => until(() => groupOf(goal), (g) => Boolean(g && check(g)), label, ms);

  // 1. Three worktree parts change the same line. A loaded PC can make `git worktree add` time out ("took too long"):
  // then the agent splits once more.
  const helper = path.join(profile, 'workspace', 'edit-title.mjs').split(path.sep).join('/');
  const edit = (x) => JSON.stringify({ command: `node "${helper}" title-idea-${x.toLowerCase()} "Title ${x}"` });
  let G1 = 'Try three site titles';
  let ended;
  for (const again of [false, true]) {
    if (again) G1 = 'Try three site titles, again';
    const goal = G1;
    await send(site, `Three title ideas ${splitCall(goal, IDEAS.map((x) => ({
      title: `Title idea ${x}`, brief: `Put title ${x} into index.html.\n[[tool:shell.exec ${edit(x)}]]`, context: 'brief', worktree: true,
    })))}`);
    ended = await groupWhen(goal, (g) => g.splits.every((x) => ['done', 'failed', 'stopped', 'skipped'].includes(x.status)), 'the worktree parts end', 300_000);
    if (ended.splits.every((x) => x.status === 'done') || again || !ended.splits.some((x) => /took too long/.test(x.error ?? ''))) break;
    t.diagnostic(`git was too slow for a worktree (${ended.splits.map((x) => x.error).join(' | ')}); splitting once more`);
    await groupWhen(goal, (g) => g.status === 'gathered', 'the slow group is gathered');
  }
  const g1 = await groupWhen(G1, (g) => g.status === 'gathered' && g.splits.every((x) => x.branch?.stat), 'group 1 is gathered with every branch', 240_000);
  const [partA, partB, partC] = byIdx(g1);
  assert.deepEqual(byIdx(g1).map((x) => x.status), ['done', 'done', 'done']);

  // 2. A running group: #1 hangs, #2 answers, #3 waits for #1.
  const G2 = 'Write the landing page';
  await send(launch, `Now the landing page ${splitCall(G2, [
    { title: 'Draft the landing copy', brief: 'Write the hero text and two variants.\n[[hang:bash]]', context: 'brief', effort: 'high' },
    { title: 'Collect the screenshots', brief: 'Collect the product screenshots and report the marker shots-ok.', context: 'brief' },
    { title: 'Review the draft', brief: 'Try to refute the draft of part #1.', context: 'brief', after: [1] },
  ])}`);
  const g2 = await groupWhen(G2, (g) => byIdx(g)[0].status === 'running' && byIdx(g)[1].status === 'done', 'group 2 runs #1 and finished #2');

  // (a) The live bar: the running part's line opens to its steps and its group's split rows in place.
  const bar = page.locator('.live-bar');
  const partLine = bar.locator('.live-bar-item', { has: page.locator('.live-bar-text', { hasText: '#1 Draft the landing copy' }) });
  const barParts = partLine.locator('.live-bar-parts');
  const openPart = async () => {
    await go(`#/chat/${launch.id}`, '.message-scroller');
    await page.waitForFunction(() => /1 of 3 parts working/.test(document.querySelector('.chat-sub .chat-live')?.getAttribute('title') ?? ''), null, { timeout: 20_000 });
    await partLine.waitFor({ timeout: 10_000 });
    if ((await partLine.locator('.live-bar-caret').getAttribute('aria-expanded')) !== 'true') await page.locator('.chat-sub .chat-live').click();
    await barParts.locator('.split-row').nth(2).waitFor({ timeout: 15_000 });
  };
  const chatFixed = ['.chat-header', '.chat-header .chat-title-button', '.composer'];
  await go(`#/chat/${launch.id}`, '.message-scroller');
  await expectStable(page, chatFixed, openPart);
  assert.match((await partLine.locator('.live-bar-name').textContent())?.trim() ?? '', new RegExp(manager.name));
  assert.equal(await partLine.locator('.live-bar-stop .stop-run').count(), 0, 'a part has no Stop of its own');
  assert.deepEqual((await barParts.locator('.split-row-title').allTextContents()).map((t) => t.trim()), ['#1 Draft the landing copy', '#2 Collect the screenshots', '#3 Review the draft']);
  assert.deepEqual(await barParts.locator('.split-icon').evaluateAll((icons) => icons.map((i) => i.className.replace('split-icon ', ''))), ['running', 'done', 'waiting']);
  assert.ok((await barParts.locator('.split-row-head').evaluateAll((l) => l.map((h) => Math.round(h.getBoundingClientRect().height)))).every((h) => h === 24), 'fixed 24 px rows');
  await page.waitForFunction(() => document.querySelector('.live-bar-parts .split-row:nth-child(1) .split-row-model')?.innerText.trim() === 'High', null, { timeout: 10_000 });
  await noProblems('bar part open 1280×800');
  await shots2('more-01-bar-part');
  const lineFixed = [...chatFixed, '.live-bar-parts .split-row:nth-child(1) > .split-row-head', '.live-bar-parts .split-row:nth-child(2) > .split-row-head'];
  await expectStable(page, lineFixed, async () => {
    await barParts.locator('.split-row-head').nth(1).click();
    await barParts.locator('.split-row-body .run-items').waitFor({ timeout: 15_000 });
  });
  await noProblems('bar part row open 1280×800');
  await shots2('more-02-bar-part-row-open');
  await page.locator('.chat-sub .chat-live').click();
  await barParts.waitFor({ state: 'detached', timeout: 5_000 });

  // (b) Team › agent › Work › Activity log (the log's page since F11, 16.11.2026): the turn that split; its "Split" line
  // opens to the parts; nothing above moves.
  const STEP = '[data-test-run="split"] .run-item.split-step';
  const runsOf = async () => {
    await go(`#/team/${manager.id}/work`, '.agent-log .log-turn');
    // the turn in "Launch check" that split there (group 1 was split in "Site title"); #2's return woke the Manager there
    // once more (splits/gather.ts: each part returns on its own) – that turn has no Split line
    const row = page.locator('.agent-log .log-turn', { has: page.locator('.log-system-text', { hasText: 'Launch check' }) })
      .filter({ has: page.locator('.run-item.split-step') });
    await row.first().waitFor({ timeout: 15_000 });
    assert.equal(await row.count(), 1, 'one turn of that chat split');
    const above = await row.evaluate((el) => {
      const rows = [...document.querySelectorAll('.agent-log .log-turn')];
      const index = rows.indexOf(el);
      rows.slice(0, index).forEach((other, i) => other.setAttribute('data-test-run', `above-${i}`));
      el.setAttribute('data-test-run', 'split');
      return index;
    });
    await row.locator('.run-item.split-step').waitFor({ timeout: 15_000 });
    await row.locator('.run-item.split-step').scrollIntoViewIfNeeded();
    const fixed = await present(['.agent-header', '.agent-log .agent-section-title', ...Array.from({ length: above }, (_, i) => `[data-test-run="above-${i}"]`), '[data-test-run="split"] > .log-system', `${STEP} > .run-item-head`]);
    return { row, fixed, step: row.locator('.run-item.split-step') };
  };
  let runs = await runsOf();
  assert.equal(await runs.step.count(), 1, 'one Split line in the turn');
  assert.equal((await runs.step.locator(':scope > .run-item-head .run-item-verb').textContent())?.trim(), 'Split');
  assert.equal((await runs.step.locator(':scope > .run-item-head .run-item-target').textContent())?.trim(), '· 1 of 3 done');
  assert.equal(await runs.step.locator(':scope > .run-item-head .spinner').count(), 1, 'a running group spins in its icon slot');
  assert.equal(await runs.step.locator(':scope > .run-item-head').getAttribute('title'), G2);
  // open from the start as columns: #1 and #2 side by side, then #1 alone after #2 is back; #3 waits for #1
  const parts = runs.step.locator('.split-step-body.columns');
  await parts.locator('.split-lane-row').nth(1).waitFor({ timeout: 15_000 });
  assert.equal(await runs.step.locator(':scope > .run-item-head').getAttribute('aria-expanded'), 'true', 'open from the start');
  const laneTitles = () => parts.locator('.split-lane-row').evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll(':scope > .split-lane .split-lane-title')].map((t) => t.textContent.trim())));
  assert.deepEqual(await laneTitles(), [['#1 Draft the landing copy', '#2 Collect the screenshots'], ['#1 Draft the landing copy']], 'two columns, then one when #2 is back');
  assert.match(((await parts.locator('.split-lane-end').first().textContent()) ?? '').trim(), new RegExp(`^Done · .*back to ${manager.name}$`));
  assert.match((await parts.locator('.split-lane-waiting').textContent()) ?? '', /#3 Review the draft · /);
  await parts.locator('.split-lane .run-item').first().waitFor({ timeout: 15_000 }); // the parts' own steps
  const firstRow = await parts.locator('.split-lane-row').first().locator(':scope > .split-lane').evaluateAll((lanes) => lanes.map((lane) => Math.round(lane.getBoundingClientRect().top)));
  assert.equal(firstRow[0], firstRow[1], 'side by side');
  await noProblems('log 1280×800');
  await shots2('more-03-runs-parts');
  await expectStable(page, runs.fixed, async () => { await runs.step.locator(':scope > .run-item-head').click(); await parts.waitFor({ state: 'detached', timeout: 5_000 }); });
  await expectStable(page, runs.fixed, async () => { await runs.step.locator(':scope > .run-item-head').click(); await parts.locator('.split-lane-row').nth(1).waitFor({ timeout: 5_000 }); });
  // the page scrolled to its end, the Split line in view: closing shortens the page under the view and the page keeps its
  // height (lib/kept-page.ts) – the browser would pull everything down by what is gone; scrolling up gives the room back
  const scroller = page.locator('.agent-scroll');
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  const openHeight = await scroller.evaluate((el) => el.scrollHeight);
  let headTop = (await box(`${STEP} > .run-item-head`))[1];
  if (headTop < (await box('.agent-scroll'))[1] || headTop + 24 > (await box('.agent-scroll'))[4]) {
    await runs.step.locator(':scope > .run-item-head').scrollIntoViewIfNeeded();
    headTop = (await box(`${STEP} > .run-item-head`))[1];
  }
  assert.ok(headTop >= (await box('.agent-scroll'))[1] && headTop + 24 <= (await box('.agent-scroll'))[4], `the Split line is in view (top ${headTop}), so the click scrolls nothing itself`);
  await expectStable(page, runs.fixed, async () => { await runs.step.locator(':scope > .run-item-head').click(); await parts.waitFor({ state: 'detached', timeout: 5_000 }); });
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  assert.ok(await scroller.evaluate((el) => el.scrollHeight) < openHeight - 50, 'scrolled up, the page is its natural height again');

  // (d) The team sidebar: a goal line on top of each group; a row click moves nothing in the block.
  const navRow = page.locator('.team-nav .team-row:not(.person)', { has: page.locator('.row-title', { hasText: new RegExp(`^${manager.name}$`) }) }).first();
  if (await navRow.locator('.team-caret').getAttribute('aria-expanded') !== 'true') await navRow.locator('.team-caret').click();
  const goals = page.locator('.team-splits .team-split-goal');
  await goals.first().waitFor({ timeout: 10_000 });
  const listed = (await rpc.call('splits.list', { agentId: manager.id })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4).reverse().map((g) => g.goal);
  assert.deepEqual((await goals.allTextContents()).map((s) => s.trim()), listed, 'one goal line per group, oldest first');
  assert.deepEqual(await goals.evaluateAll((list) => list.map((el) => [el.getAttribute('title'), Math.round(el.getBoundingClientRect().height), el.closest('.team-split-group')?.firstElementChild === el])),
    listed.map((goal) => [goal, 24, true]), 'a static 24 px line on top of its group, the goal as its tooltip');
  assert.equal(await page.locator('.team-splits button.team-split-goal, .team-splits .team-split-goal button').count(), 0, 'never a button');
  // opened at its end (the newest group): the older group is scrolled half away, its goal stays at the block's top with
  // a hairline under it (only there)
  assert.deepEqual(await page.evaluate(() => {
    const block = document.querySelector('.team-splits');
    const [first, second] = [...block.querySelectorAll('.team-split-goal')];
    const line = (goal) => getComputedStyle(goal.firstElementChild).boxShadow !== 'none';
    return [block.scrollTop > 0, Math.round(first.getBoundingClientRect().top - block.getBoundingClientRect().top), line(first), line(second)];
  }), [true, 0, true, false], 'the scrolled group\'s goal sticks to the block\'s top');
  await noProblems('team sidebar 1280×800');
  await shots2('more-04-sidebar-goals');
  // scrolled up to the first group (a row half under a sticky goal line would be brought into view when it opens)
  const rowB = page.locator(`.team-split-row[title="${partB.title}"]`);
  await page.evaluate(() => { document.querySelector('.team-splits').scrollTop = 0; });
  const navFixed = ['.team-nav .team-space-title', '.team-splits', ...Array.from({ length: await goals.count() }, (_, i) => `.team-split-group:nth-child(${i + 1}) > .team-split-goal`),
    `.team-split-row[title="${partB.title}"]`];
  await expectStable(page, navFixed, async () => {
    await rowB.click();
    await page.locator('.split-page-name', { hasText: '#2 Title idea B' }).waitFor({ timeout: 15_000 });
  });
  assert.equal(await page.locator('.team-split-row.active').getAttribute('title'), partB.title);

  // (c) The worktree parts: every branch holds its own title, the main checkout is untouched; no Merge cell.
  for (const [i, part] of [partA, partB, partC].entries()) {
    assert.match(git(repo, ['show', `${part.branch.name}:index.html`]).trim(), new RegExp(`<h1>Title ${IDEAS[i]}</h1>`), `part #${i + 1}'s branch`);
  }
  assert.equal(readFileSync(path.join(repo, 'index.html'), 'utf8').trim(), '<h1>Old title</h1>', 'the main checkout is untouched');
  await go(`#/team/${manager.id}/split/${partB.id}`, '.split-page-name');
  assert.equal(await page.getByRole('button', { name: 'Merge', exact: true }).count(), 0, 'no Merge cell');
  await noProblems('worktree part 1280×800');
  await shots2('more-05-worktree-part');
  // the split page keeps its height the same way (lib/kept-page.ts): in a low window, scrolled to its end, closing a step
  // and then the brief leaves the row just clicked and everything above it where it is
  await size(1280, 420);
  await page.locator('.split-brief-toggle').click();
  const lastStep = '.split-page-items .run-item:last-child .run-item-head';
  await page.locator(lastStep).click();
  await page.locator('.split-page-items .run-item:last-child .run-item-body').waitFor({ timeout: 5_000 });
  await page.locator('.agent-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  assert.ok(await page.locator('.agent-scroll').evaluate((el) => el.scrollTop) > 50, 'the open page is scrolled: closing would pull it down');
  await expectStable(page, ['.split-page-name', '.split-brief-toggle', lastStep], async () => {
    await page.locator(lastStep).click();
    await page.locator('.split-page-items .run-item:last-child .run-item-body').waitFor({ state: 'detached', timeout: 5_000 });
  });
  await expectStable(page, ['.split-page-name', '.split-brief-toggle'], async () => {
    await page.locator('.split-brief-toggle').click();
    await page.locator('.split-brief-body').waitFor({ state: 'detached', timeout: 5_000 });
  });

  // The phone (390×844): the bar's part line with its group's rows; the run's parts; the goal lines; a conflict.
  await size(390, 844);
  await openPart();
  await page.waitForTimeout(400);
  await noProblems('bar part phone');
  await shots2('more-08-bar-part-phone');
  await page.locator('.chat-sub .chat-live').click();
  await barParts.waitFor({ state: 'detached', timeout: 5_000 });
  runs = await runsOf();
  await runs.step.locator('.split-lane-row').nth(1).waitFor({ timeout: 15_000 });
  await runs.step.locator('.split-step-body').scrollIntoViewIfNeeded();
  await noProblems('runs phone');
  await shots2('more-09-runs-parts-phone');
  await go(`#/team/${manager.id}/split/${partC.id}`, '.split-page-name');
  await noProblems('worktree part phone');
  await shots2('more-10-worktree-part-phone');
  // The sidebar is there from 720 px on (a phone's Team tab is the overview): its narrowest window.
  await size(720, 800);
  await go(`#/team/${manager.id}`, '.team-splits .team-split-goal');
  assert.ok((await goals.evaluateAll((list) => list.map((el) => Math.round(el.getBoundingClientRect().height)))).every((h) => h === 24 || h === 28), 'one line (28 px on touch)');
  await noProblems('team sidebar 720×800');
  await shots2('more-11-sidebar-goals-720');
  await size(1280, 800);

  await rpc.call('splits.stop', { groupId: g2.id });
  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
