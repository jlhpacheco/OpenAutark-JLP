// B-081: the watcher's picture box as the page's viewport (src/main/side-driver/caster.ts, cast-params.ts, tab.ts,
// read.ts) on a fake DevTools debugger and a manual clock: sideCast `view` is checked (whole px, 200–4096, nothing else);
// the cast gives the page the box as its size on the off-screen host (deps.size; no DevTools viewport override: measured
// 08.11. that the screencast then still shows the view's own box) before the screencast, a renewal with a changed box applies it again, an unchanged one sends nothing and one naming no box
// clears it; the end of the cast clears it; a press of the person here (not the watcher's echo, not an agent's) gives
// the page back its own size GIVE_BACK_MS after its release ('up', never between its down and up; a watcher's press
// meanwhile keeps the watcher's) and the end of the watcher's next press takes it again; without a box nothing of this runs; an agent's
// screenshot stays capturePage (the view itself has the box).
// Owns: these assertions only. Never: Electron, real pages or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIVE_BACK_MS, SideCaster } from '../../../src/main/side-driver/caster.ts';
import { castView } from '../../../src/main/side-driver/cast-params.ts';
import { screenshot } from '../../../src/main/side-driver/read.ts';
import { SideTab, WATCHER_ECHO_MS } from '../../../src/main/side-driver/tab.ts';
import type { SideBrowserCall } from '../../../src/shared/model/side-browser.ts';
import { FakeContents } from './side-driver-fakes.ts';

const TAB = 'web-1234';
const VIEW = { width: 420, height: 860 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (error: unknown) => (error as { code?: string }).code;
const OVERRIDE = 'Emulation.setDeviceMetricsOverride';

function rig() {
  const clock = { now: 50_000 };
  const contents = new FakeContents(clock);
  const tab = new SideTab(TAB, contents, { now: () => clock.now, person: () => {} });
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const setTimer = (fn: () => void, ms: number) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; };
  const clearTimer = (handle: unknown) => { (handle as { live: boolean }).live = false; };
  const sized: Array<{ width: number; height: number } | undefined> = [];
  const caster = new SideCaster({ tab: (id) => (id === TAB ? tab : undefined), send: () => {}, now: () => clock.now, setTimer, clearTimer, size: (_id, box) => { sized.push(box); return true; } });
  const dbg = contents.debugger;
  const sizes = () => sized.filter((box) => box !== undefined);
  const clears = () => sized.filter((box) => box === undefined).length;
  const mouse = (type: string) => ({ method: 'Input.dispatchMouseEvent', params: { type, x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } });
  /** The give-backs that wait. */
  const waiting = () => timers.filter((t) => t.live && t.ms === GIVE_BACK_MS);
  /** GIVE_BACK_MS went by: the waiting give-back runs. */
  const later = async () => { for (const timer of waiting()) { timer.live = false; timer.fn(); } await tick(); };
  return { clock, contents, tab, caster, dbg, sizes, clears, mouse, waiting, later };
}

test('sideCast view: none, or whole px within 200–4096 with exactly width and height', async () => {
  assert.equal(castView(undefined), undefined);
  assert.equal(castView(null), undefined);
  assert.deepEqual(castView({ width: 420, height: 860 }), VIEW);
  for (const bad of [{ width: 420.5, height: 860 }, { width: 199, height: 860 }, { width: 420, height: 4097 }, { width: 420 }, { width: 420, height: 860, x: 1 }, [420, 860], 'big', { width: '420', height: 860 }]) {
    assert.throws(() => castView(bad), (error: unknown) => code(error) === 'bad_request', JSON.stringify(bad));
  }
  const r = rig();
  await assert.rejects(r.caster.cast({ tab: TAB, on: true, view: { width: 10, height: 10 } }), (error: unknown) => code(error) === 'bad_request');
  assert.equal(r.caster.watched(TAB), false, 'a refused box starts nothing');
});

test('the page takes the watcher\'s box between the focus emulation and the screencast; a changed box applies again, the end clears it', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true, view: VIEW });
  const order = r.dbg.calls.map((c) => c.method).filter((m) => m.startsWith('Emulation.') || m === 'Page.startScreencast');
  assert.deepEqual(order, ['Emulation.setFocusEmulationEnabled', 'Page.startScreencast'], 'no viewport override');
  assert.deepEqual(r.sizes(), [VIEW]);
  assert.deepEqual(r.tab.watcherView, VIEW, 'read.ts knows the page has the watcher\'s viewport');
  await r.caster.cast({ tab: TAB, on: true, view: VIEW });
  assert.equal(r.sizes().length, 1, 'an unchanged box sends nothing');
  await r.caster.cast({ tab: TAB, on: true });
  await tick();
  assert.equal(r.clears(), 1, 'a renewal naming no box (no watcher has one any more): the page\'s own size');
  assert.equal(r.tab.watcherView, undefined);
  await r.caster.cast({ tab: TAB, on: true });
  assert.equal(r.clears(), 1, 'and only once');
  await r.caster.cast({ tab: TAB, on: true, view: { width: 600, height: 860 } });
  await tick();
  assert.deepEqual(r.sizes().map((s) => s.width), [420, 600], 'a box again: at once');
  await r.caster.cast({ tab: TAB, on: true, view: { width: 640, height: 860 } });
  await tick();
  assert.deepEqual(r.sizes().map((s) => s.width), [420, 600, 640], 'the box changed: at once');
  await r.caster.cast({ tab: TAB, on: false });
  await tick();
  assert.equal(r.clears(), 2, 'the end of the watch gives the page its own size');
  assert.equal(r.tab.watcherView, undefined);
  assert.equal(r.tab.localPress, undefined, 'no press here acts for an ended cast');
});

test('a press here gives the page back its pane\'s size; the end of the watcher\'s next press takes it again; echoes and agents do not count', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true, view: VIEW });
  await r.caster.input({ tab: TAB, commands: [r.mouse('mousePressed')] });
  assert.equal(r.tab.watcherAt, r.clock.now);
  r.clock.now += WATCHER_ECHO_MS - 200;
  r.dbg.report({ k: 'in', e: 'click', x: 10, y: 20 }, 99); // the page reports the watcher's own click
  r.dbg.report({ k: 'in', e: 'up', x: 10, y: 20 }, 99);
  assert.equal(r.waiting().length + r.clears(), 0, 'the watcher\'s echo is no press here');
  r.clock.now += 5000;
  r.dbg.report({ k: 'in', e: 'move', x: 30, y: 40 }, 99);
  assert.equal(r.clears(), 0, 'moving the mouse here keeps the watcher\'s size');
  r.dbg.report({ k: 'in', e: 'click', x: 30, y: 40 }, 99); // reported on its mouse down
  await tick();
  assert.equal(r.waiting().length, 0, 'nothing waits between the click\'s down and up (a held drag too): the click lands where it was seen');
  r.dbg.report({ k: 'in', e: 'up', x: 30, y: 40 }, 99);
  r.dbg.report({ k: 'in', e: 'click', x: 30, y: 40 }, 99); // a double click
  r.dbg.report({ k: 'in', e: 'up', x: 30, y: 40 }, 99);
  assert.equal(r.waiting().length, 1, 'one give-back waits, from the last release');
  await r.later();
  assert.equal(r.clears(), 1, 'GIVE_BACK_MS after the release: the page fits its pane here again');
  assert.equal(r.tab.watcherView, undefined);
  r.dbg.report({ k: 'in', e: 'type', key: 'a' }, 99);
  await r.later();
  assert.equal(r.clears(), 1, 'given back once');
  await r.caster.input({ tab: TAB, commands: [r.mouse('mouseMoved')] });
  await r.caster.input({ tab: TAB, commands: [r.mouse('mousePressed')] });
  assert.equal(r.sizes().length, 1, 'a move, or the press while it is held, does not resize under the button');
  await r.caster.input({ tab: TAB, commands: [r.mouse('mouseReleased')] });
  assert.equal(r.sizes().length, 2, 'the watcher\'s press ended: the page takes the watcher\'s box again');
  assert.deepEqual(r.tab.watcherView, VIEW);
  r.clock.now += 5000;
  r.tab.agentKey(); // an agent types here
  r.dbg.report({ k: 'in', e: 'type', key: 'x' }, 99);
  await tick();
  assert.deepEqual(r.tab.watcherView, VIEW, 'an agent\'s key is no press of the person');
  assert.equal(r.clears(), 1);
});

test('a watcher\'s press while a give-back waits keeps the watcher\'s size; the end of the cast drops a waiting one', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true, view: VIEW });
  r.clock.now += 5000;
  r.dbg.report({ k: 'in', e: 'click', x: 30, y: 40 }, 99);
  r.dbg.report({ k: 'in', e: 'up', x: 30, y: 40 }, 99);
  assert.equal(r.waiting().length, 1);
  await r.caster.input({ tab: TAB, commands: [r.mouse('mousePressed')] });
  assert.equal(r.waiting().length, 0, 'the watcher used it last');
  await r.caster.input({ tab: TAB, commands: [r.mouse('mouseReleased')] });
  assert.deepEqual(r.tab.watcherView, VIEW);
  assert.equal(r.clears() + r.sizes().length, 1, 'no clear and no second override: the page never moved');
  r.clock.now += 5000;
  r.dbg.report({ k: 'in', e: 'click', x: 30, y: 40 }, 99);
  r.dbg.report({ k: 'in', e: 'up', x: 30, y: 40 }, 99);
  await r.caster.cast({ tab: TAB, on: false });
  assert.equal(r.waiting().length, 0, 'an ended cast leaves no give-back behind');
  await tick();
  assert.equal(r.clears(), 1, 'only the end\'s own clear');
});

test('without a box nothing changes: no override, no clear, a press here does nothing', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true });
  r.clock.now += 5000;
  r.dbg.report({ k: 'in', e: 'click', x: 1, y: 1 }, 99);
  await r.caster.input({ tab: TAB, commands: [r.mouse('mouseReleased')] });
  await r.caster.cast({ tab: TAB, on: false });
  await tick();
  assert.equal(r.sizes().length + r.clears() + r.dbg.named(OVERRIDE).length, 0);
});

test('an agent\'s screenshot is capturePage, also while the watcher\'s box is on (the view itself has that size)', async () => {
  const r = rig();
  let captured = 0;
  const capture = r.contents.capturePage.bind(r.contents);
  r.contents.capturePage = async () => { captured++; return capture(); };
  r.dbg.handlers['Page.getLayoutMetrics'] = () => ({ cssVisualViewport: { clientWidth: 420, clientHeight: 860 } });
  r.dbg.handlers['Page.captureScreenshot'] = () => ({}); // no picture: the call says so (no Electron in a unit test)
  const call = { action: 'screenshot', agent: { id: 'ag_1', name: 'Ada' } } as unknown as SideBrowserCall;
  const shot = await screenshot(r.tab, call);
  assert.equal(captured, 1);
  assert.equal(shot.image?.width, 420);
  r.tab.watcherView = VIEW;
  const again = await screenshot(r.tab, call);
  assert.equal(captured, 2, 'the view itself has the watcher\'s box');
  assert.equal(again.image?.width, 420);
  assert.equal(r.dbg.named('Page.captureScreenshot').length, 0);
});

test('a frame whose JPEG does not have its metadata\'s shape (the one right after a resize) is dropped; unreadable data passes', async () => {
  const { frameFits } = await import('../../../src/main/side-driver/cast-params.ts');
  /** SOI, then a SOF0 segment with the given size (enough header for the check). */
  const jpeg = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]).toString('base64');
  assert.equal(frameFits(jpeg(625, 1280), { deviceWidth: 420, deviceHeight: 860 }), true, 'the watcher\'s shape');
  assert.equal(frameFits(jpeg(625, 391), { deviceWidth: 420, deviceHeight: 860 }), false, 'the old landscape picture under the new size');
  assert.equal(frameFits(jpeg(1280, 800), { deviceWidth: 1280, deviceHeight: 800 }), true);
  assert.equal(frameFits('abc', { deviceWidth: 420, deviceHeight: 860 }), true, 'not a JPEG header: passes');
  assert.equal(frameFits(jpeg(625, 391), {}), true, 'no metadata size: passes');
});
