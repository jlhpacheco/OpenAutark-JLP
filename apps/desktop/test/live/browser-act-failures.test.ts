// LIVE (opt-in): the browser-act-failures fixes (B-080 live verdicts, built 09.11.2026) in an agent's own browser,
// against the installed Chrome/Edge (playwright-core, own temporary profile) and three local fixture pages this test
// serves from 127.0.0.1 – no real site, no person's profile, no mouse or keyboard input of the person's.
// Covers, each the owner-facing outcome of one fix:
//   Fix 4 (page.ts translateError): a click blocked by a full-screen overlay fails with the covering element NAMED
//          ("<div …> lies over it"), not a blind "did not become ready".
//   Fix 3 (service.ts review): a step that navigates to a genuinely slow tab counts as done and the page is reported
//          changed – a submit that went through is never reported as failed. (The exact catch branch – state() throws
//          mid-navigation – is timing-bound in a real browser; it is covered deterministically in the unit test
//          service.test.ts. Here the owner-facing guarantee is checked end to end.)
//   Fix 5 (tools.ts browser.open): a url given as secret://<id> opens its real value in the real browser, and the
//          tool's output shows only the handle (the link's token never reaches the model).
// Reports the timings (test diagnostics – the numbers for the build log).
//   WORKFORCE_LIVE=1 node --test test/live/browser-act-failures.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../../src/runtime/browser/service.ts';
import { browserTools } from '../../src/runtime/browser/tools.ts';
import { MemoryLogger } from '../unit/fakes.ts';
import type { ToolDef } from '../../src/runtime/tools/types.ts';
import type { SecretInfo } from '../../src/shared/model/security.ts';
import { toolCtx, textOf } from '../unit/browser/b055-fakes.ts';

const AGENT = 'ag_ada';
const SLOW_MS = 6000; // longer than the step's own domcontentloaded wait (5 s) and review's settle (5 s)

/** The fixture pages. `/slow` answers only after SLOW_MS; everything else at once. */
const PAGES: Record<string, string> = {
  '/landing': '<!doctype html><meta charset=utf-8><title>Landing</title><h1>Reached through a stored link</h1>',
  // Fixed geometry on both, so Playwright finds the button instantly stable and proceeds to the hit-test (where the
  // overlay intercepts) instead of occasionally timing out on "not stable" while the layout settles.
  '/cover': '<!doctype html><meta charset=utf-8><title>Cover</title>'
    + '<button id="go" style="position:absolute;top:80px;left:80px;width:120px;height:44px" onclick="document.title=\'clicked\'">Go</button>'
    + '<div id="ov" data-cover="yes" style="position:fixed;top:0;left:0;right:0;bottom:0;background:#80808088;z-index:99"></div>',
  // The click schedules the navigation for the next tick, so the click itself completes at once (the step is done) and
  // the slow page only then starts loading – review() must read back a tab that is still loading, not a navigating click.
  '/start': '<!doctype html><meta charset=utf-8><title>Start</title><button id="go" onclick="setTimeout(function(){location.href=\'/slow\'},0)">to the slow page</button>',
};

async function timed<T>(step: () => Promise<T>): Promise<[T, number]> {
  const began = performance.now();
  const value = await step();
  return [value, Math.round(performance.now() - began)];
}

test('browser-act-failures: covered click named (4), slow nav not falsely failed (3), stored link opens & masks (5)', {
  skip: process.env.WORKFORCE_LIVE === '1' ? false : 'starts a real browser: set WORKFORCE_LIVE=1', timeout: 120_000,
}, async (t) => {
  // --- a local server for the three fixtures (sockets tracked, so the slow route never holds the close up) ---
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/slow')) {
      // Commit at once (headers + a first chunk, so the click's navigation succeeds and the step counts), then hold the
      // rest of the body for SLOW_MS: the tab is still loading when review() reads it back – the condition Fix 3 guards.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.write('<!doctype html><meta charset=utf-8><title>Slow</title><h1>the slow page body has not arrived yet</h1>');
      const timer = setTimeout(() => res.end('<p>and now it is here</p>'), SLOW_MS);
      (timer as { unref?: () => void }).unref?.();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    res.end(PAGES[url] ?? PAGES['/start']);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-browser-act-'));
  const browser = new BrowserService({ paths: { data: dir, workspace: path.join(dir, 'work') }, log: new MemoryLogger(), settleMs: 200, actionTimeoutMs: 4000 });
  t.after(async () => {
    await browser.close().catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  // ===================================================================== Fix 4: the covering element is named
  await browser.open(AGENT, { url: `${base}/cover` });
  let covered!: Awaited<ReturnType<typeof browser.batch>>;
  let coveredMs = 0;
  for (let attempt = 1; attempt <= 3; attempt++) { // a covered click can first report "not stable"; retry until Playwright hit-tests the overlay
    [covered, coveredMs] = await timed(() => browser.batch(AGENT, { steps: [{ action: 'click', target: { role: 'button', name: 'Go' } }], motion: 'instant' }));
    if (/lies over it|intercepts pointer events/.test(covered.failure ?? '')) break;
  }
  t.diagnostic(`Fix 4 covered click: done=${covered.done} ${coveredMs}ms failure=${covered.failure ?? '(none)'}`);
  assert.equal(covered.done, 0, 'the click is blocked by the overlay, so no step is done');
  assert.ok(covered.failure, 'the blocked click reports a failure');
  assert.match(covered.failure!, /lies over it/, 'the fix says the element lies over it, not a blind "not ready"');
  assert.match(covered.failure!, /<div id="ov"/, 'and names the overlay element from Playwright\'s log');

  // ===================================================================== Fix 3: a slow tab does not falsely fail
  await browser.open(AGENT, { url: `${base}/start`, newTab: true });
  const [slow, slowMs] = await timed(() => browser.batch(AGENT, { steps: [{ action: 'click', target: { role: 'button', name: 'to the slow page' } }], motion: 'instant' }));
  const reviewCaught = /reads it once it is there/.test(slow.changes.text); // the unique Fix 3 catch-branch message
  t.diagnostic(`Fix 3 slow nav: done=${slow.done} changed=${slow.changed} urlChanged=${slow.urlChanged} reviewCaught=${reviewCaught} ${slowMs}ms url=${slow.url}`);
  assert.equal(slow.done, 1, 'the click on a slow link counts as done – a submit that went through is not reported as failed');
  assert.ok(slow.changed, 'the page is reported as changed');
  assert.ok(slow.url.includes('/slow'), 'the tab did move to the slow page');

  // ===================================================================== Fix 5: a stored link opens and is masked
  const tools: ToolDef[] = browserTools(browser);
  const open = tools.find((entry) => entry.name === 'browser.open')!;
  const secretId = 'lnk_test1';
  const linkValue = `${base}/landing`;
  const ctxRig = toolCtx(); // a real tool context (pointer hub, host, clock) on this PC
  (ctxRig.ctx.services as { secrets: unknown }).secrets = {
    redact: (text: string) => text,
    list: () => [{ id: secretId, label: 'Test link', kind: 'note' } as unknown as SecretInfo],
    use: async () => linkValue, // the vault hands back the real link at the last moment
  };
  const [opened, openMs] = await timed(() => open.run({ url: `secret://${secretId}` }, ctxRig.ctx));
  const body = textOf(opened);
  const structuredUrl = (opened.structured as { url?: string } | undefined)?.url ?? '';
  const tabs = await browser.tabs(AGENT);
  const reached = tabs.tabs.some((tab) => tab.url === linkValue);
  t.diagnostic(`Fix 5 stored link: reached=${reached} ${openMs}ms structured.url=${structuredUrl}`);
  assert.ok(reached, 'the real browser opened the link the handle resolved to');
  assert.match(body, /secret:\/\/lnk_test1/, 'the output shows the handle');
  assert.ok(!body.includes('127.0.0.1'), 'the output never shows the real host of the stored link');
  assert.ok(!body.includes('landing'), 'nor the real path of the stored link');
  assert.ok(!structuredUrl.includes('127.0.0.1') && structuredUrl.includes('secret://'), 'structured.url is masked too');
});
