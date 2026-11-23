// LIVE (opt-in, B-080 own-chrome-blank-page): browser.open where: 'chrome' against the person's real Chrome or Edge. It
// opens one new window of it at https://example.com/, brings that window to the front over whatever is in front (live
// 09.11.: a maximized app, and each such window read as a blank page) and reads its UI tree, which then holds the page
// document. The window is closed at the end. It changes the foreground and opens a window of the person's browser, so it
// runs only with both switches (ask the person first):
//   WORKFORCE_LIVE=1 WORKFORCE_LIVE_COMPUTER=1 node --test test/live/own-chrome-front.test.ts
// It runs once through the route the app takes – the desktop broker where it is installed (computer/drivers.ts; its SYSTEM
// worker compiles the C# of resources/computer/windows-helper.ps1 into resources/broker/AutarkDesktopBroker.exe, so it
// checks the installed build) – and once through the PowerShell helper script itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openInOwnChrome } from '../../src/runtime/browser/own-chrome.ts';
import { brokerState, localBroker, type BrokerAccess } from '../../src/runtime/computer/broker.ts';
import { createHelper } from '../../src/runtime/computer/drivers.ts';
import { ComputerService } from '../../src/runtime/computer/service.ts';
import { Supervisor } from '../../src/runtime/system/supervisor.ts';
import { MemoryLogger } from '../unit/fakes.ts';
import type { Host } from '../../src/runtime/host.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const live = process.env.WORKFORCE_LIVE === '1' && process.env.WORKFORCE_LIVE_COMPUTER === '1' && process.platform === 'win32';
const DOCUMENT = /^\s*- document /m;
const noBroker: BrokerAccess = { reachable: () => false, lease: () => { throw new Error('the PowerShell helper serves this run'); } };
const routes: Array<{ via: 'broker' | 'powershell'; broker: BrokerAccess }> = [{ via: 'broker', broker: localBroker() }, { via: 'powershell', broker: noBroker }];

for (const route of routes) {
  const skip = !live ? 'opt-in: WORKFORCE_LIVE=1 WORKFORCE_LIVE_COMPUTER=1' : route.via === 'broker' && !route.broker.reachable() ? 'no desktop broker installed on this PC' : false;
  test(`B-080 (${route.via}): a page opened in the person's own Chrome comes to the front and its UI tree holds the page document`, { skip, timeout: 90_000 }, async (t) => {
    const log = new MemoryLogger();
    const resourcesDir = path.join(root, 'resources');
    const helper = createHelper('win32', { supervisor: new Supervisor({ log }), resourcesDir, log, unpacked: (file) => file, broker: route.broker });
    const host = {
      kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
      openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
      app: { version: '0.0.0', packaged: false, resourcesDir: root, dataDir: root, executable: process.execPath },
      async idleSeconds() { return 600; },
    } as Host;
    const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('the helper is injected'); } }, resourcesDir, log, helper, platform: 'win32' });
    t.after(async () => { await computer.dispose(); });

    const before = (await computer.windows()).find((window) => window.foreground);
    assert.equal(brokerState.via, route.via, `served by the ${route.via}`);
    const opened = await openInOwnChrome('https://example.com/', computer, {});
    t.after(async () => { await computer.act({ window: opened.window.hwnd, action: 'window_close' }).catch(() => undefined); });
    const firstRead = DOCUMENT.test(opened.tree.text);
    // The first read comes right after the window came up; a page still loading shows its document a moment later.
    let text = opened.tree.text;
    for (let i = 0; i < 20 && !DOCUMENT.test(text); i++) {
      await delay(500);
      text = (await computer.uiTree({ window: opened.window.hwnd })).text;
    }
    t.diagnostic(`via ${brokerState.via}; in front before: "${before?.title ?? '-'}"; opened ${opened.browser} window ${opened.window.hwnd} "${opened.tree.window.title}", focused ${opened.focused}, ${opened.tree.count} elements, document in the first read: ${firstRead}`);
    assert.equal(opened.focused, true, 'the new window came to the front');
    assert.equal((await computer.windows()).find((window) => window.hwnd === opened.window.hwnd)?.foreground, true, 'Windows lists it in front');
    assert.match(text, DOCUMENT, 'its UI tree holds the page document');
  });
}
