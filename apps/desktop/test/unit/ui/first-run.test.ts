// First-run layer, pure rules (src/ui/onboarding/first-run-model.ts): when the layer shows, the card order
// (B-085: the choice card first, then AI, About you – no voice, team or permission card; the AI card goes back to the
// choice), whether any model can answer and the About card's profile write (name, company; the security mode's write is
// security-model.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import {
  CARDS, TOUR_STEP, firstRunShown, libraryPatch, nextStep, noUsableModel, previousStep, profilePatch, stepText,
} from '../../../src/ui/onboarding/first-run-model.ts';

const account = (extra: Partial<Account> = {}): Account => ({ id: 'acc', provider: 'codex', auth: 'cli', enabled: true, state: 'ok', ...extra }) as Account;
const model = (extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'codex:m', provider: 'codex', model: 'm', name: 'M', available: true, strengths: {}, accounts: [], tier: 'small', ...extra }) as ModelInfo;
const onboarding = (step: Settings['onboarding']['step']) => ({ onboarding: { completed: false, step } });

test('the layer shows on the owner\'s window until its step is done, never in a preview', () => {
  assert.equal(firstRunShown(onboarding('ai'), true, false), true);
  assert.equal(firstRunShown(onboarding('about'), true, false), true);
  assert.equal(firstRunShown(onboarding('done'), true, false), false);
  assert.equal(firstRunShown(onboarding('ai'), false, false), false, 'a phone or a person never sees it');
  assert.equal(firstRunShown(onboarding('ai'), true, true), false, 'a hidden preview page draws Home');
  assert.equal(firstRunShown(null, true, false), false, 'settings not loaded yet');
});

test('B-085: the choice, then two cards in order – AI, About you; AI goes back to the choice, the last leads to done', () => {
  assert.deepEqual(CARDS, ['ai', 'about']);
  assert.equal(TOUR_STEP, 'tour', 'the choice card keeps the stored step id: no migration');
  assert.deepEqual([nextStep(TOUR_STEP), nextStep('ai'), nextStep('about'), nextStep('done')], ['ai', 'about', 'done', 'done']);
  assert.deepEqual([previousStep('about'), previousStep('ai'), previousStep(TOUR_STEP)], ['ai', TOUR_STEP, TOUR_STEP]);
  assert.deepEqual([stepText(TOUR_STEP), stepText('ai'), stepText('about')], ['', 'Step 1 of 2', 'Step 2 of 2'], 'no step text on the choice card');
});

test('About you writes the trimmed name and company, only what changed', () => {
  assert.deepEqual(profilePatch({ name: '', company: '' }, '  Ada ', ' Lovelace GmbH '), { name: 'Ada', company: 'Lovelace GmbH' });
  assert.deepEqual(profilePatch({ name: 'Ada', company: 'X' }, 'Ada', 'Y'), { company: 'Y' });
  assert.equal(profilePatch({ name: 'Ada', company: '' }, ' Ada', ''), undefined, 'nothing changed: no write');
  assert.equal(profilePatch(undefined, 'a'.repeat(300), '')?.name?.length, 120, 'within the setting\'s limit');
});

test('the public-library tick writes only a change: left ticked nothing, unticked publish false', () => {
  assert.equal(libraryPatch(undefined, true), undefined, 'a new PC, left ticked: absent counts as on, no write');
  assert.deepEqual(libraryPatch(undefined, false), { publish: false }, 'unticked on the first run');
  assert.deepEqual(libraryPatch({ publish: true }, false), { publish: false });
  assert.equal(libraryPatch({ publish: false }, false), undefined, 'set up again with sharing already off: kept');
  assert.deepEqual(libraryPatch({ publish: false }, true), { publish: true }, 'ticked again');
});

test('no usable model: a loaded list decides, else a connected account that can serve', () => {
  assert.equal(noUsableModel([model()], []), false);
  assert.equal(noUsableModel([model({ available: false })], [account()]), true, 'a loaded list decides');
  assert.equal(noUsableModel([model({ functions: ['stt'] })], [account()]), true, 'a speech specialist cannot answer');
  assert.equal(noUsableModel([model({ strengths: { chat: -1 } })], [account()]), true, 'nor a model never used for chat');
  assert.equal(noUsableModel([], []), true, 'nothing connected');
  assert.equal(noUsableModel([], [account({ state: 'cooling' })]), false, 'list not loaded yet: a connected account may serve');
  assert.equal(noUsableModel([], [
    account({ state: 'needs_login' }), account({ state: 'error' }), account({ enabled: false }),
  ]), true, 'signed out, broken and off serve no chat');
  assert.equal(noUsableModel([], [account({ provider: 'kimi-cli' })]), false, 'a plan CLI on the ACP engine runs turns like any other');
});

test('the first run has only the AI and About cards: the voice, team, key-dialog and setup-notice files are gone', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui', 'onboarding');
  for (const gone of ['TeamCard.tsx', 'KeyDialog.tsx', 'ModelRows.tsx', 'VoiceCard.tsx', 'voice-model.ts', 'setup-notice.ts']) assert.equal(existsSync(path.join(root, gone)), false, gone);
  assert.ok(existsSync(path.join(root, 'AboutCard.tsx')));
});

test('B-085: the first screen is the choice card, not the feedback video; the video stays one click away', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui', 'onboarding');
  const firstRun = readFileSync(path.join(root, 'FirstRun.tsx'), 'utf8');
  assert.ok(!/TourPlayer/.test(firstRun.replace(/^\/\/.*$/gm, '')), 'no player in the layer');
  assert.match(firstRun, /<ChoiceCard key="choice" onConnect=\{connect\} \/>/);
  const choice = readFileSync(path.join(root, 'ChoiceCard.tsx'), 'utf8');
  for (const text of ['Set up a new company', 'Connect with an ID', 'Watch how it works', 'openTour']) assert.ok(choice.includes(text), text);
  assert.match(readFileSync(path.join(root, 'AiCard.tsx'), 'utf8'), /previousStep\('ai'\)[\s\S]*>Back</, 'the AI card has Back');
});
