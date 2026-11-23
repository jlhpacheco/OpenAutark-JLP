// 23.11.2026 (Stanislaus, Konrad task_pkzytj9m): Settings › Models names a Claude plan as Anthropic does today – Max with 20× usage
// is "Ultra" (auth status: subscriptionType "max", planTier "max_20x"); each Claude plan row offers its monthly API credits (Max,
// Ultra, Team) or else an API key as reserve; a key pasted there is stored in the catalog only – the account row names its handle,
// no row, event or log line holds the value; "Let the AI set it up" gives the personal manager one to-do, written as the person's.
// Owns: these assertions. Never: a real CLI, the network or a real key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudePlan, parseClaudeStatus } from '../../../src/runtime/accounts/cli.ts';
import { planLabel } from '../../../src/ui/settings/providers.ts';
import { apiCreditsView, creditsKeyLabel, creditsKeyOf } from '../../../src/ui/settings/api-credits.ts';
import { CREDITS_SUFFIX as RUNTIME_SUFFIX, setupCredits } from '../../../src/runtime/accounts/credits-setup.ts';
import { CREDITS_SUFFIX } from '../../../src/ui/settings/api-credits.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { harness } from './harness.ts';
import { agent, harness as chatHarness } from '../chat/harness.ts';

const plan = (patch: Partial<Account>): Account => ({ id: 'acc_c', provider: 'claude', label: 'Claude Code', auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: true, createdAt: 0, ...patch });

test('plan name: Max 20× reads "Ultra plan", Max 5× stays "Max plan", an answer of "ultra" passes', () => {
  assert.equal(claudePlan('max', 'max_20x'), 'ultra');
  assert.equal(claudePlan('max', 'default_claude_max_20x'), 'ultra');
  assert.equal(claudePlan('max', 'max_5x'), 'max');
  assert.equal(claudePlan('max'), 'max');
  assert.equal(claudePlan('ultra'), 'ultra');
  assert.equal(claudePlan('pro', 'pro'), 'pro');
  assert.equal(claudePlan(undefined), undefined);
  const status = parseClaudeStatus(0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', planTier: 'max_20x' }));
  assert.equal(status.plan, 'ultra');
  assert.equal(planLabel(status.plan), 'Ultra plan');
  assert.equal(planLabel('max'), 'Max plan');
});

test('the block: monthly API credits for Ultra, Max and Team; an API key as reserve for Pro; none for keys, Free, Codex', () => {
  const ultra = apiCreditsView(plan({ plan: 'ultra' }), false)!;
  assert.equal(ultra.title, 'Monthly API credits of this plan');
  assert.equal(ultra.monthly, true);
  assert.match(ultra.hint, /claude\.ai › Settings › Billing › API credits/);
  assert.equal(apiCreditsView(plan({ plan: 'max' }), false)!.monthly, true);
  const pro = apiCreditsView(plan({ plan: 'pro' }), false)!;
  assert.equal(pro.title, 'API key as reserve');
  assert.equal(pro.monthly, false);
  assert.match(apiCreditsView(plan({ plan: 'ultra' }), true)!.hint, /^Key stored ✓/);
  assert.equal(apiCreditsView(plan({ plan: 'api' }), false), undefined, 'a Claude Code signed in with a key pays per use already');
  assert.equal(apiCreditsView(plan({ plan: 'free' }), false), undefined);
  assert.equal(apiCreditsView(plan({ provider: 'codex', plan: 'pro' }), false), undefined);
  assert.equal(apiCreditsView(plan({ provider: 'anthropic', auth: 'api_key' }), false), undefined);
  for (const view of [ultra, pro]) assert.doesNotMatch(view.hint, /\.$/, 'a one-sentence hint has no final period');
  assert.equal(CREDITS_SUFFIX, RUNTIME_SUFFIX, 'the row and the manager\'s to-do name the key account alike');
});

test('a pasted key: stored in the catalog only, the row names its handle; the plan row finds it by name', async () => {
  const h = harness();
  const KEY = 'sk-ant-api03-TESTKEY-not-real-0123456789';
  const owner = plan({ plan: 'ultra', label: 'Claude Code 2' });
  const added = await h.service.add({ provider: 'anthropic', label: creditsKeyLabel(owner), apiKey: KEY });
  await h.service.update(added.id, { credits: true });
  const saved = h.repo.get(added.id)!;
  assert.equal(saved.label, 'Claude Code 2 · API credits');
  assert.equal(saved.credits, true);
  assert.ok(saved.secretId, 'the account names the catalog entry');
  assert.equal(h.vault.get(saved.secretId!.replace(/^secret:\/\//, '')) ?? [...h.vault.values()][0], KEY);
  assert.ok(!JSON.stringify(saved).includes(KEY), 'not in the account row');
  assert.ok(!JSON.stringify(h.upserts).includes(KEY), 'not in any account event (windows, phone, other PCs)');
  const rows = h.db.all<Record<string, unknown>>('SELECT * FROM accounts');
  assert.ok(!JSON.stringify(rows).includes(KEY), 'not in the database row');
  assert.equal(creditsKeyOf(owner, h.repo.list())?.id, added.id);
  assert.equal(creditsKeyOf(plan({ plan: 'ultra', label: 'Claude Code 3' }), h.repo.list()), undefined, 'another plan has its own');
  await h.service.dispose();
});

test('"Let the AI set it up": one to-do for the personal manager, as the person\'s request, with the safe way; once per plan', () => {
  const h = chatHarness();
  const store = new Map<string, Account>([['acc_c', plan({ plan: 'ultra', label: 'Claude Code 2' })], ['acc_x', plan({ id: 'acc_x', provider: 'codex', plan: 'pro' })]]);
  Object.assign(h.services, { accounts: { get: (id: string) => store.get(id), list: () => [...store.values()] } });
  h.org.add(agent('ag_lukas', 'Lukas', { mode: 'manager' }));
  const first = setupCredits(h.services, 'acc_c');
  assert.equal(first.assignee, 'Lukas');
  assert.equal(first.task.assigneeKind, 'agent');
  assert.equal(first.task.assigneeId, 'ag_lukas');
  assert.equal(first.task.createdBy, HUMAN_ID);
  assert.equal(first.task.title, 'Set up the monthly API credits of Claude Code 2');
  assert.match(first.task.notes, /browser\.save_secret/);
  assert.match(first.task.notes, /Link organization/);
  assert.match(first.task.notes, /"Claude Code 2 · API credits"/);
  assert.match(first.task.notes, /credits: true/);
  assert.match(first.task.notes, /Only a step only I can do/);
  assert.equal(setupCredits(h.services, 'acc_c').task.id, first.task.id, 'a second click finds the open one');
  assert.throws(() => setupCredits(h.services, 'acc_x'), /Only a Claude Code plan/);
});
