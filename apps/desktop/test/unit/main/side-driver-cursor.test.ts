// The side driver's AI cursor (B-081): the drawn cursor comes in the agent's colour (shared/model/agent-cursor.ts)
// with a lean on every step and stands upright on the target; with no motion named the pointer travels like a hand
// (21.11.2026), 'glide' with the glide's short hold, 'instant' as a jump.
// Owns: these checks. Never: the driver's other behaviour (side-driver.test.ts) or the in-page drawer (agent-cursor.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SideDriver } from '../../../src/main/side-driver/driver.ts';
import { FakeContents, checkoutTree, fakeBrowser, pageHandlers } from './side-driver-fakes.ts';

const agent = { id: 'ag_ada', name: 'Ada' };

function setup() {
  const clock = { now: 1_000_000 };
  const contents = new FakeContents(clock);
  pageHandlers(contents.debugger, { tree: checkoutTree() });
  const browser = fakeBrowser({ 'web-1': contents });
  const driver = new SideDriver({
    browser: () => browser, pointer: () => undefined, person: () => ({ kind: 'person', id: 'owner', name: 'Lukas' }),
    now: () => clock.now, sleep: async (ms) => { clock.now += ms; },
  });
  driver.tab('web-1', contents as never); // the workspace browser's hook: the tab's page was made
  return { dbg: contents.debugger, driver };
}

test('the drawn cursor comes in the agent’s colour, leans on the way and stands upright on the button', async () => {
  const { driver, dbg } = setup();
  await driver.call({ action: 'snapshot', agent });
  await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  const cursor = dbg.evals('__wfSide.cursor(');
  assert.equal(cursor.length, 1);
  assert.match(cursor[0]!, /^__wfSide\.cursor\("ag_ada", "Ada", "#0b7285", \[.*\], true\)$/, 'its colour (shared/model/agent-cursor.ts)');
  const drawn = JSON.parse(/(\[.*\])/.exec(cursor[0]!)![1]!) as Array<{ x: number; y: number; t: number; r: number }>;
  assert.ok(drawn.length > 1 && drawn.every((step) => typeof step.r === 'number'), 'every drawn step carries its lean');
  assert.ok(drawn.some((step) => step.r !== 0), 'it leans on the way');
  assert.deepEqual(drawn.at(-1), { x: 140, y: 116, t: drawn.at(-1)!.t, r: 0 }, 'upright on the button');
});

test('no motion named: the pointer travels like a hand; glide and instant only when the call passes them', async () => {
  const { driver, dbg } = setup();
  await driver.call({ action: 'snapshot', agent });
  await driver.call({ action: 'act', agent, motion: 'glide', steps: [{ action: 'click', ref: 's24' }] });

  dbg.calls = [];
  await driver.call({ action: 'act', agent, steps: [{ action: 'click', x: 600, y: 400 }] });
  const hand = dbg.named('Input.dispatchMouseEvent');
  assert.deepEqual(hand.slice(-2).map((call) => call.params.type), ['mousePressed', 'mouseReleased']);
  const held = hand.at(-1)!.at - hand.at(-2)!.at;
  assert.ok(held >= 55 && held <= 120, `the default is a hand: its own hold (${held} ms)`);
  const handMoves = hand.filter((call) => call.params.type === 'mouseMoved');
  assert.ok(handMoves.at(-1)!.at - handMoves[0]!.at > 300, 'a hand takes longer than a glide');

  dbg.calls = [];
  await driver.call({ action: 'act', agent, motion: 'glide', steps: [{ action: 'click', ref: 's24' }] });
  const glide = dbg.named('Input.dispatchMouseEvent');
  assert.equal(glide.at(-1)!.at - glide.at(-2)!.at, 25, 'glide holds the button 25 ms');

  dbg.calls = [];
  await driver.call({ action: 'act', agent, motion: 'instant', steps: [{ action: 'click', x: 300, y: 200 }] });
  const quick = dbg.named('Input.dispatchMouseEvent');
  assert.equal(quick.filter((call) => call.params.type === 'mouseMoved').length, 1, 'instant is one jump');
  assert.deepEqual(quick.slice(-2).map((call) => call.params.type), ['mousePressed', 'mouseReleased']);
  assert.equal(quick.at(-1)!.at - quick.at(-2)!.at, 0, 'with no hold');
});
