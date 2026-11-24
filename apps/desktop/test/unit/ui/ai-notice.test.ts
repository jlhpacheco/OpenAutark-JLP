// B-051 L7: Home's "No AI is connected yet" line (src/ui/onboarding/ai-notice.ts) – after the first run, while
// no model can answer, Home's one notice band says so with [Connect] (Settings › Models); it goes as
// soon as a model can answer. Regression: setup could be finished with nothing that answers and nothing said so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { AI_NOTICE_ID, AI_NOTICE_TEXT, aiNotice, type AiNoticeInput } from '../../../src/ui/onboarding/ai-notice.ts';
import { resetClock } from '../../../src/ui/lib/limits.ts';
import { NOTICE_PRIORITY } from '../../../src/ui/shell/notices.ts';

const account = (extra: Partial<Account> = {}): Account => ({ id: 'acc', provider: 'codex', auth: 'cli', enabled: true, state: 'ok', priority: 0, ...extra }) as Account;
const model = (extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'codex:m', provider: 'codex', model: 'm', name: 'M', available: true, strengths: {}, accounts: [], tier: 'small', ...extra }) as ModelInfo;
const input = (extra: Partial<AiNoticeInput> = {}): AiNoticeInput => ({
  onboarding: { completed: true, step: 'done' }, home: true, loaded: true, readable: true, models: [], accounts: [], ...extra,
});

test('after the first run with nothing that answers: one warn line on Home with Connect', () => {
  const opened: string[] = [];
  const notice = aiNotice(input({ accounts: [account({ state: 'needs_login' })] }), () => opened.push('models'));
  assert.equal(notice?.id, AI_NOTICE_ID);
  assert.equal(notice?.text, "No AI is connected yet – your team can't start.");
  assert.equal(AI_NOTICE_TEXT, notice?.text);
  assert.equal(notice?.tone, 'warn');
  assert.equal(notice?.priority, NOTICE_PRIORITY.setup);
  assert.equal(notice?.onDismiss, undefined, 'a status, not an offer to dismiss');
  assert.deepEqual(notice?.actions?.map((action) => action.label), ['Connect']);
  notice?.actions?.[0].run();
  assert.deepEqual(opened, ['models']);
});

test('gone as soon as a model can answer – a loaded model list or, before it, an account that serves one', () => {
  assert.equal(aiNotice(input({ models: [model()] }), () => undefined), null);
  assert.equal(aiNotice(input({ accounts: [account({ state: 'cooling' })] }), () => undefined), null);
  assert.notEqual(aiNotice(input({ models: [model({ available: false })], accounts: [account()] }), () => undefined), null, 'a loaded list decides');
});

test('only on Home, after the snapshots, after the first run, where the accounts can be read', () => {
  assert.equal(aiNotice(input({ home: false }), () => undefined), null, 'away from Home');
  assert.equal(aiNotice(input({ loaded: false }), () => undefined), null, 'before the snapshots: not "nothing connected"');
  assert.equal(aiNotice(input({ readable: false }), () => undefined), null, 'a phone that may not read the accounts');
  assert.equal(aiNotice(input({ onboarding: { completed: false, step: 'ai' } }), () => undefined), null, 'the first run shows its own card');
  assert.equal(aiNotice(input({ onboarding: undefined }), () => undefined), null, 'settings not loaded');
  assert.notEqual(aiNotice(input({ onboarding: { completed: false, step: 'done' } }), () => undefined), null, 'the cards are through');
});

test('registered once by the status line; Connect leads to Settings › Models', () => {
  const ui = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui');
  const sources = readFileSync(path.join(ui, 'shell', 'StatusLine.tsx'), 'utf8');
  assert.equal(sources.match(/registerAiNotice\(\)/g)?.length, 1);
  assert.match(readFileSync(path.join(ui, 'onboarding', 'ai-notice.ts'), 'utf8'), /navigate\(\{ view: 'settings', section: 'models' \}\)/);
});
const at = Date.UTC(2026, 10, 24, 20);
const full = (reset: number, extra: Partial<Account> = {}): Account => account({
  ...extra, limits: { windows: [{ name: '5h', usedPercent: 100, windowMinutes: 300, resetsAt: reset }], readAt: at },
});

test('an exhausted account was Connected: show the quota notice in Home and chats, with the earliest reset and an account picker', () => {
  const first = at + 60_000;
  const second = at + 120_000;
  const open: string[] = [];
  const accounts = [
    full(second), full(first, { id: 'claude', provider: 'claude' }),
    account({ id: 'off', enabled: false }), account({ id: 'media', provider: 'elevenlabs' }),
    account({ id: 'decision', provider: 'decision-api' }), account({ id: 'signed-out', state: 'needs_login' }),
  ];
  for (const home of [true, false]) {
    const notice = aiNotice(input({ home, chat: !home, accounts, models: [model()] }), () => open.push('models'), at);
    assert.equal(notice?.id, AI_NOTICE_ID);
    assert.equal(notice?.text, `Model accounts used up until ${resetClock(first, at)}`);
    assert.deepEqual(notice?.actions?.map((action) => action.label), ['Use another account']);
    notice?.actions?.[0].run();
  }
  assert.deepEqual(open, ['models', 'models']);
  assert.equal(aiNotice(input({ accounts, home: false }), () => {}, at), null, 'the notice is not shown alongside the settings picker');
  assert.equal(aiNotice(input({ accounts, readable: false }), () => {}, at), null, 'do not expose account health to an unauthorized window');
  assert.equal(aiNotice(input({ accounts, models: [model()] }), () => {}, first), null, 'an expired reset does not keep the banner');
});

test('a free accepted account, an unknown reading or explicitly permitted extra usage are not a quota outage', () => {
  const used = full(at + 60_000);
  const scoped = { ...used, limits: { ...used.limits!, windows: [{ ...used.limits!.windows[0], name: 'weekly-opus' }] } };
  const noBanner = (accounts: Account[]) => aiNotice(input({ models: [model()], accounts }), () => {}, at);
  assert.equal(noBanner([used, account({ id: 'other', provider: 'claude' })]), null);
  assert.equal(noBanner([used, account({ id: 'other', provider: 'claude', state: 'unknown' })]), null);
  assert.equal(noBanner([{ ...used, extraUsage: true }]), null);
  assert.equal(noBanner([scoped]), null, 'a model-specific window does not exhaust the account');
});
