// Settings › Models: a connected sign-in can be out of quota; an overload pause is different.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliRowView, FREE_PLAN_LABEL, FREE_PLAN_ROW, SHORT_PAUSE_LABEL, stateLabel } from '../../../src/ui/settings/providers.ts';
import { resetClock } from '../../../src/ui/lib/limits.ts';
import type { Account, LimitWindow } from '../../../src/shared/model/providers.ts';

const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);

function cooling(windows: LimitWindow[], patch: Partial<Account> = {}): Account {
  return {
    id: 'acc_codex', provider: 'codex', label: 'Codex', auth: 'cli', state: 'cooling', coolingUntil: NOW + 60_000, priority: 0,
    enabled: true, detected: false, createdAt: NOW, limits: { windows, readAt: NOW - 60_000 }, ...patch,
  };
}

test('state chip: a used-up window shows its reset time, an overload pause says so briefly', () => {
  const used: LimitWindow = { name: 'weekly', windowMinutes: 10080, usedPercent: 100, resetsAt: NOW + 3600_000 };
  const label = 'Used up until ' + resetClock(used.resetsAt!, NOW);
  assert.equal(stateLabel(cooling([used]), NOW), label);
  assert.equal(stateLabel(cooling([{ ...used, usedPercent: 40 }]), NOW), SHORT_PAUSE_LABEL);
  assert.equal(stateLabel(cooling([{ ...used, resetsAt: NOW - 1 }]), NOW), SHORT_PAUSE_LABEL, 'a passed reset no longer limits');
  assert.equal(stateLabel(cooling([], { limits: undefined }), NOW), SHORT_PAUSE_LABEL);
  assert.equal(stateLabel(cooling([used], { state: 'ok' }), NOW), label, 'a full account cannot read Connected while still signed in');
  assert.equal(stateLabel(cooling([used], { state: 'error' }), NOW), 'Error');
  assert.equal(stateLabel(cooling([used], { state: 'disabled', enabled: false }), NOW), 'Off');
  assert.equal(stateLabel(cooling([used], { state: 'ok', extraUsage: true }), NOW), 'Included quota used up until ' + resetClock(used.resetsAt!, NOW));
  const later = NOW + 7200_000;
  assert.equal(stateLabel(cooling([used, { ...used, name: '5h', resetsAt: later }]), NOW), 'Used up until ' + resetClock(later, NOW));
  assert.equal(stateLabel(cooling([{ ...used, name: 'weekly-opus' }], { state: 'ok' }), NOW), 'Connected', 'Sonnet can still run');
  assert.equal(stateLabel(cooling([{ ...used, resetsAt: NOW }], { state: 'ok' }), NOW), 'Connected', 'the reset has arrived');
});

test('B-051 L5: a Claude Free login says it needs Pro or Max – on its chip and on its PC row, never "Signed in"', () => {
  const free = cooling([], { id: 'acc_claude', provider: 'claude', label: 'Claude Code', state: 'error', plan: 'Free', coolingUntil: undefined, limits: undefined });
  assert.equal(stateLabel(free, NOW), FREE_PLAN_LABEL);
  const row = cliRowView({ provider: 'claude', path: '/home/p/.local/bin/claude', loggedIn: true, method: 'claude.ai', version: '2.1.0' }, [free]);
  assert.equal(row.hint, `${FREE_PLAN_ROW} · 2.1.0`);
  assert.equal(row.action, undefined);
  assert.equal(stateLabel({ ...free, plan: 'pro' }, NOW), 'Error', 'another error keeps its label');
  assert.equal(stateLabel({ ...free, provider: 'codex', plan: 'free' }, NOW), 'Error', 'Codex is not blocked by plan');
  assert.match(cliRowView({ provider: 'claude', path: '/bin/claude', loggedIn: true, method: 'claude.ai' }, [{ ...free, state: 'ok', plan: 'max' }]).hint, /^Signed in · claude\.ai$/);
});

test('the PC row of Codex reads the found account, which runs on a copy in a home of its own', () => {
  const found = cooling([], { state: 'needs_login', detected: true, home: '/accounts/codex/acc_codex', coolingUntil: undefined, limits: undefined });
  const row = cliRowView({ provider: 'codex', path: '/bin/codex', loggedIn: true, method: 'ChatGPT' }, [found]);
  assert.equal(row.account?.id, 'acc_codex');
  assert.match(row.hint, /^Not signed in/, 'Autark\'s copy needs a sign-in although the default home is signed in');
  const added = { ...found, id: 'acc_codex_2', detected: false };
  assert.equal(cliRowView({ provider: 'codex', path: '/bin/codex', loggedIn: true }, [added]).account, undefined, 'an account added in Autark is not the found login');
});
