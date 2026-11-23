// Eine-ID addendum (owner 22.11.2026: "erst wenn man dieses erste Startmenü fertig gemacht hat"): a company exists once its
// first run is done (settings.onboarding.step 'done'). devices/connect.ts holds the one gate: before, this PC is not
// findable – no LAN answer, no meeting-server listing, no incoming request – whatever devices.findable says; and once
// my own request is accepted and linked, the first run is done (finishFirstRun, once). Review L6: once done, a kv mark
// keeps it a company – "Set up team again" opens the first run but leaves the IDs and requests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishFirstRun, findableNow, isSetUp } from '../../../src/runtime/devices/connect.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { memoryDb } from './fakes.ts';

function settings(step: string, findable?: boolean) {
  const updates: unknown[] = [];
  const value = { onboarding: { completed: step === 'done', step }, devices: { ...(findable === undefined ? {} : { findable }) } };
  const s = {
    db: memoryDb(),
    settings: {
      get: () => value,
      update: (patch: { onboarding?: { completed: boolean; step: string } }) => { updates.push(patch); if (patch.onboarding) value.onboarding = patch.onboarding; },
    },
  } as unknown as Pick<RuntimeServices, 'settings' | 'db'>;
  return { s, updates, value };
}

test('findable only once the company exists, requests are on and the listener may open', () => {
  assert.equal(findableNow(settings('ai').s, 'lan'), false, 'first run open: nobody finds this PC');
  assert.equal(findableNow(settings('about', true).s, 'lan'), false, 'even with requests on');
  assert.equal(findableNow(settings('done').s, 'lan'), true);
  assert.equal(findableNow(settings('done', false).s, 'lan'), false, 'requests off');
  assert.equal(findableNow(settings('done').s, 'off'), false, 'no peer listener');
  assert.equal(isSetUp(settings('tour').s), false);
  assert.equal(isSetUp(settings('done').s), true);
});

test('review L6: once done it stays a company – "Set up team again" (step back to \'ai\') keeps it findable', () => {
  const company = settings('done');
  assert.equal(isSetUp(company.s), true);
  company.value.onboarding = { completed: false, step: 'ai' };
  assert.equal(isSetUp(company.s), true, 'the mark stays');
  assert.equal(findableNow(company.s, 'lan'), true);
});

test('my accepted request finishes the first run once; a set-up company is left as it is', () => {
  const open = settings('tour');
  finishFirstRun(open.s);
  assert.deepEqual(open.updates, [{ onboarding: { completed: true, step: 'done' } }]);
  assert.equal(findableNow(open.s, 'lan'), true, 'findable from now on');
  finishFirstRun(open.s);
  assert.equal(open.updates.length, 1, 'once');
  const done = settings('done');
  finishFirstRun(done.s);
  assert.deepEqual(done.updates, []);
});

test('Fest: the name I joined with as a new member becomes this PC\'s person\'s name where none is set; a set one stays', () => {
  const joined = settings('tour');
  (joined.value as Record<string, unknown>).profile = { name: '' };
  finishFirstRun(joined.s, ' Lena Berg ');
  assert.deepEqual(joined.updates, [{ profile: { name: 'Lena Berg' } }, { onboarding: { completed: true, step: 'done' } }]);
  const named = settings('tour');
  (named.value as Record<string, unknown>).profile = { name: 'Lena' };
  finishFirstRun(named.s, 'Lena Berg');
  assert.deepEqual(named.updates, [{ onboarding: { completed: true, step: 'done' } }], 'a name the person has stays');
  const device = settings('tour');
  finishFirstRun(device.s);
  assert.deepEqual(device.updates, [{ onboarding: { completed: true, step: 'done' } }], 'one of my devices: no name comes with it');
});
