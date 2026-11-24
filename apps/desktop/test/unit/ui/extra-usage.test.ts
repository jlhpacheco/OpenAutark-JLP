// 17.11.2026 (Konrad task_bgykyzcx): the words of the account row's extra-usage switch and of the offer for a found plan login
// (settings/extra-usage.ts). The cost line says where to enable it at the provider and that it costs money; where a provider has none the switch says why;
// a key or a local server has no such switch at all. The offer says what stays true until "Use": not used, not shared with the company's other PCs.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Account, FoundLogin } from '../../../src/shared/model/providers.ts';
import { extraUsageView, foundText } from '../../../src/ui/settings/extra-usage.ts';
import { planLabel } from '../../../src/ui/settings/providers.ts';

const plan = (provider: Account['provider'], patch: Partial<Account> = {}): Pick<Account, 'auth' | 'provider' | 'plan' | 'extraUsage'> => ({ auth: 'cli', provider, ...patch });

test('extra usage view: Claude Code and Codex plans carry the switch with their provider\'s own words and where to enable it', () => {
  const claude = extraUsageView(plan('claude', { plan: 'max' }))!;
  assert.deepEqual([claude.label, claude.possible], ['When the plan runs out: continue with paid extra usage', true]);
  assert.match(claude.hint, /^Billed by Claude at API rates.*usage credits.*claude\.ai › Settings › Usage.*Off: the plan waits for its reset\.$/);
  const claudeOn = extraUsageView(plan('claude', { plan: 'max', extraUsage: true }))!;
  assert.match(claudeOn.hint, /^On: costs money .*billed by Claude at API rates.*Plans with quota left run first\.$/);

  const codex = extraUsageView(plan('codex', { plan: 'pro' }))!;
  assert.deepEqual([codex.label, codex.possible], ['When the plan runs out: continue with ChatGPT credits', true]);
  assert.match(codex.hint, /Codex Settings › Usage › Credits.*Off: the plan waits for its reset\.$/);
  assert.match(extraUsageView(plan('codex', { extraUsage: true }))!.hint, /^On: costs money .*billed by OpenAI/);
});

test('extra usage view: where the provider has none the switch is impossible and says why; keys and servers have no such switch', () => {
  for (const provider of ['gemini-cli', 'copilot', 'kimi-cli'] as const) {
    const view = extraUsageView(plan(provider))!;
    assert.equal(view.possible, false, provider);
    assert.equal(view.hint, 'No paid extra usage for this plan – it waits for its reset.', provider);
  }
  const consoleLogin = extraUsageView(plan('claude', { plan: 'api' }))!;
  assert.equal(consoleLogin.possible, false);
  assert.match(consoleLogin.hint, /^Signed in with an API key: billed per use already/);
  for (const account of [{ auth: 'api_key', provider: 'anthropic' }, { auth: 'env', provider: 'openai' }, { auth: 'local', provider: 'ollama' }] as const) {
    assert.equal(extraUsageView({ ...account }), undefined, `${account.provider} ${account.auth}`);
  }
});

test('plan label: the tier as the person knows it; an unknown tier stays as the provider wrote it', () => {
  assert.deepEqual(['max', 'Pro', 'plus', 'free', 'api', 'Ultra', 'Copilot Business', '', undefined].map((plan) => planLabel(plan)), ['Max plan', 'Pro plan', 'Plus plan', 'Free plan', 'API key', 'Ultra plan', 'Copilot Business', undefined, undefined]);
});

test('found text: what is on offer and what stays true until "Use"; a declined one says so and stays on the PC', () => {
  const here: FoundLogin = { key: 'codex:default', provider: 'codex', where: 'this-pc' };
  assert.deepEqual(foundText(here, { method: 'ChatGPT' }), {
    label: 'Found: Codex (ChatGPT login) – use in this company?',
    hint: 'Not used, and not shared with this company\'s other PCs, until you say Use.',
  });
  assert.equal(foundText(here).label, 'Found: Codex (signed in on this PC) – use in this company?', 'no method known');
  const other: FoundLogin = { key: 'claude:acc_lena', provider: 'claude', where: 'other-company', email: 'lena@example.com' };
  assert.equal(foundText(other).label, 'Found: Claude Code (l…@example.com) – use in this company?', '24.11.2026: the address masked (ui/lib/email-mask.ts)');
  assert.equal(foundText(other, undefined, (email) => email.toUpperCase()).label, 'Found: Claude Code (LENA@EXAMPLE.COM) – use in this company?', 'the mask the screen passes');
  assert.equal(foundText({ ...other, email: undefined } as FoundLogin).label, 'Found: Claude Code (signed in in another company on this PC) – use in this company?');
  assert.deepEqual(foundText({ ...other, declined: true }), {
    label: 'Not used here: Claude Code (l…@example.com)',
    hint: 'You chose not to use this sign-in in this company. It stays on this PC.',
  });
});
