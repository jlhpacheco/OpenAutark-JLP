// B-044 account service additions with the account harness: accounts.useReset reaches the Codex
// engine and reads the limits again afterwards (through the RPC handler too); accounts.test lists an
// endpoint's models with the typed key in process memory for that one call only – nothing stored,
// logged or kept; an account switched back on is checked again at once.
// Owns: nothing in production. Never starts a real CLI or touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { harness, row } from './harness.ts';

const KEY = 'sk-typed-test-0123456789';

function rpc(service: unknown) {
  const table = new HandlerTable();
  registerProviders(table);
  const scope: ClientScope = { kind: 'owner' };
  const ctx = { scope, services: { accounts: service } as unknown as RuntimeServices, extras: {} as RpcExtras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) } as HandlerContext;
  return async (method: string, params?: unknown): Promise<any> => table.get(method)!.handler(params as never, ctx);
}

test('useReset: the Codex engine redeems with one key per attempt; the limits are read again afterwards', async () => {
  const sent: Array<[string, string, string | undefined]> = [];
  const h = harness({ consumeReset: async (account: Account, key: string, creditId?: string) => { sent.push([account.id, key, creditId]); return 'reset'; } });
  h.repo.save(row('acc_codex', { provider: 'codex', auth: 'cli', limits: { windows: [], readAt: 1, resets: { available: 1, credits: [{ id: 'rc_1' }] } } }));
  const call = rpc(h.service);
  assert.deepEqual(await call('accounts.useReset', { id: 'acc_codex', creditId: 'rc_1' }), { outcome: 'reset' });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][0], sent[0][2]], ['acc_codex', 'rc_1']);
  assert.match(sent[0][1], /^[0-9a-f-]{36}$/, 'a UUID per attempt');
  assert.deepEqual(h.checks, ['acc_codex'], 'the account check read the limits again');
  h.repo.save(row('acc_claude', { provider: 'claude', auth: 'cli' }));
  await assert.rejects(call('accounts.useReset', { id: 'acc_claude' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('accounts.test: the engine gets the typed key for this call only; nothing is stored or kept', async () => {
  const seen: Array<[string, string | undefined, string | undefined]> = [];
  const h = harness({ listModels: async (account, key) => { seen.push([account.provider, account.baseUrl, key]); return [{ model: 'kimi-k3' }, { model: 'kimi-k3-mini' }]; } });
  const call = rpc(h.service);
  const answer = await call('accounts.test', { provider: 'compatible', baseUrl: 'https://api.moonshot.ai/v1', apiKey: KEY });
  assert.deepEqual(answer, { models: ['kimi-k3', 'kimi-k3-mini'] });
  assert.deepEqual(seen, [['compatible', 'https://api.moonshot.ai/v1', KEY]]);
  assert.equal(h.service.list().length, 0, 'no account is added');
  assert.equal(h.vault.size, 0, 'the key never reaches the vault');
  await call('accounts.test', { provider: 'anthropic', baseUrl: 'https://llm.example.test/v1' });
  assert.deepEqual(seen[1], ['anthropic', 'https://llm.example.test/v1', undefined], 'no key typed: none handed over (and none left from before)');
  await assert.rejects(call('accounts.test', { provider: 'compatible', baseUrl: 'http://example.test/v1' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request', 'plain http only on loopback');
});

test('an account on a catalog handle reads its key there; removing it leaves the entry, a typed key goes with its account', async () => {
  const h = harness();
  h.vault.set('deepinfra-key', KEY);
  const linked = await h.service.add({ provider: 'compatible', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'secret://deepinfra-key' });
  assert.equal(linked.secretId, 'secret://deepinfra-key');
  assert.equal(await h.service.apiKey(linked.id), KEY);
  assert.equal(h.vault.size, 1, 'nothing copied');
  await h.service.remove(linked.id);
  assert.equal(h.vault.get('deepinfra-key'), KEY, 'the person\'s catalog entry stays');
  const typed = await h.service.add({ provider: 'compatible', label: 'Other', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-typed' });
  assert.equal(h.vault.size, 2);
  await h.service.remove(typed.id);
  assert.equal(h.vault.size, 1, 'the account\'s own key goes with it');
  await assert.rejects(h.service.add({ provider: 'compatible', label: 'None', baseUrl: 'https://llm.example.test/v1', apiKey: 'secret://nothing' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('an account switched back on is checked again at once (visual pass, round 3: it stayed "unknown")', async () => {
  const h = harness();
  h.repo.save(row('acc_api', { provider: 'openai', auth: 'api_key', secretId: undefined }));
  h.answers.set('acc_api', { state: 'ok', plan: 'api' });
  assert.equal(h.service.update('acc_api', { enabled: false }).state, 'disabled');
  await h.settle();
  assert.deepEqual(h.checks, [], 'switching off checks nothing');
  assert.equal(h.service.update('acc_api', { enabled: true }).state, 'unknown', 'until the check answers (Settings: "Checking…")');
  await h.settle();
  assert.deepEqual(h.checks, ['acc_api']);
  assert.equal(h.service.get('acc_api')?.state, 'ok');
  h.service.update('acc_api', { label: 'Renamed' });
  await h.settle();
  assert.deepEqual(h.checks, ['acc_api'], 'other changes start no check');
});

test('accounts.test: a refusing server answers with a user-safe message', async () => {
  const h = harness({ listModels: async () => { throw new Error(`HTTP 401 for ${KEY}`); } });
  await assert.rejects(h.service.test({ provider: 'openai', apiKey: KEY }), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && !error.message.includes(KEY));
});
