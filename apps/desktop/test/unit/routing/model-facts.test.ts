// B-078 (D16): the models line of every agent's prompt (routing/model-facts.ts factsLine; B-089, 11.11.2026: the volatile
// section 'models' – its moves keep the stable prompt, test/unit/agents/session-prompt-key.test.ts): at most 8 connected work
// models, the smartest first, each with its list price, smarts and how a turn is paid – the same text for the same
// connections (the prompt cache holds), no specialists, about 150 tokens. B-083 (live 09.11.): a model whose engine sends a
// temperature beside its thinking carries "takes temperature" there and in models.list (owner 09.11.: no "at effort none" tag –
// thinking is never given up for a temperature).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACTS_MODELS, factsLine, priceText, sourceOf, temperatureTag } from '../../../src/runtime/routing/model-facts.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';

function model(id: string, patch: Partial<ModelInfo> = {}): ModelInfo {
  return { id, provider: 'claude', model: id, name: id, engine: 'claude', efforts: [], caps: {}, tier: 'frontier', strengths: { chat: 0.3 }, available: true, accounts: ['acc_plan'], ...patch };
}
const ACCOUNTS: Account[] = [
  { id: 'acc_plan', provider: 'claude', label: 'Claude Code', auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0 },
  { id: 'acc_key', provider: 'openrouter', label: 'OpenRouter', auth: 'api_key', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0 },
  { id: 'acc_local', provider: 'ollama', label: 'Ollama', auth: 'local', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0 },
];

test('price text: "$4/$20", "$0.1/$0.5"; none without a price', () => {
  assert.equal(priceText({ price: { inputPerM: 4, outputPerM: 20, source: 'priors' } }), '$4/$20');
  assert.equal(priceText({ price: { inputPerM: 0.1, outputPerM: 0.5, source: 'priors' } }), '$0.1/$0.5');
  assert.equal(priceText({}), undefined);
});

test('the facts line: smartest first, price · smarts · plan/API key/local, specialists and unavailable models left out', () => {
  const models = [
    model('Claude Fable 5.1', { smarts: 92, price: { inputPerM: 10, outputPerM: 50, source: 'priors' } }),
    model('Claude Opus 5.5', { smarts: 94, price: { inputPerM: 4, outputPerM: 20, source: 'priors' } }),
    model('Mistral Large', { provider: 'openrouter', engine: 'compatible', accounts: ['acc_key'], price: { inputPerM: 2, outputPerM: 6, source: 'feed' } }),
    model('qwen3.8', { provider: 'ollama', engine: 'compatible', tier: 'local', accounts: ['acc_local'], smarts: 62 }),
    model('whisper', { functions: ['stt'], strengths: { stt: 0.9, chat: -1 } }),
    model('Gone', { available: false, smarts: 99 }),
  ];
  const line = factsLine(models, ACCOUNTS);
  assert.equal(line, 'Models I can use ($ in/out per 1M tokens · smarts 0–100 · how a turn is paid): Claude Opus 5.5 $4/$20 · 94 · plan; Claude Fable 5.1 $10/$50 · 92 · plan; qwen3.8 · 62 · local · takes temperature; Mistral Large $2/$6 · API key · takes temperature. A plan costs me nothing per turn while its quota lasts, an API key pays every token, a local model costs nothing.');
  assert.equal(factsLine([...models].reverse(), ACCOUNTS), line, 'the order of the catalog does not change it (cache)');
  assert.equal(factsLine([], ACCOUNTS), '');
});

test(`at most ${FACTS_MODELS} models (the rest counted), duplicates of one model once, about 150 tokens`, () => {
  const many = Array.from({ length: 12 }, (_, i) => model(`Model ${String(i).padStart(2, '0')}`, { smarts: 80 + i, price: { inputPerM: 1, outputPerM: 5, source: 'priors' } }));
  const twice = [...many, model('Model 11', { id: 'other:Model 11', smarts: 91, price: { inputPerM: 1, outputPerM: 5, source: 'priors' } })];
  const line = factsLine(twice, ACCOUNTS);
  assert.equal((line.match(/ · plan/g) ?? []).length, FACTS_MODELS);
  assert.match(line, /\(\+4 more in models\.list\)/);
  assert.ok(line.length < 700, `${line.length} characters`);
});

test('B-083: a key holding a plan\'s monthly API credits is paid like a plan, as routing and booking treat it', () => {
  const key: Account = { ...ACCOUNTS[1], id: 'acc_anthropic', provider: 'anthropic', label: 'Anthropic' };
  const opus = model('Claude Opus 5.5', { provider: 'anthropic', engine: 'anthropic', accounts: ['acc_anthropic'], smarts: 94 });
  assert.equal(sourceOf(opus, key), 'API key');
  assert.equal(sourceOf(opus, { ...key, credits: true }), 'plan');
  assert.equal(sourceOf(opus, { ...key, auth: 'env', credits: true }), 'plan');
  assert.match(factsLine([opus], [{ ...key, credits: true }]), /Claude Opus 5\.5 · 94 · plan\./);
});

test('B-083 (owner 09.11.): the temperature tag marks only models that take one beside their thinking – never Claude Code, a thinking Claude or a reasoning GPT', () => {
  const at = (engine: string, id: string) => temperatureTag({ engine, model: id });
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-fable-5-1']) assert.equal(at('claude', id), undefined, `plan ${id}`);
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-5-5']) assert.equal(at('anthropic', id), undefined, `API ${id} thinks`);
  assert.equal(at('anthropic', 'claude-haiku-4-5'), 'takes temperature', 'runs without thinking on the API anyway');
  assert.equal(at('compatible', 'llama3.3'), 'takes temperature');
  assert.equal(at('compatible', 'gemini-3-pro-preview'), undefined, 'Gemini 3+ keeps its default');
  assert.equal(at('openai', 'gpt-4.1'), 'takes temperature');
  for (const id of ['gpt-6-sol', 'gpt-6.1-sol']) assert.equal(at('openai', id), undefined, `${id}: only without reasoning`);
  assert.equal(at('codex', 'gpt-6-sol'), undefined, 'Codex keeps its own');
  // a gateway's older Claude runs at its only effort none (no reasoning sent): it takes one; with efforts above none it would think
  assert.equal(temperatureTag({ engine: 'compatible', model: 'anthropic/claude-haiku-4.5', efforts: ['none'] }), 'takes temperature');
  assert.equal(temperatureTag({ engine: 'compatible', model: 'anthropic/claude-haiku-4.5', efforts: ['low', 'high'] }), undefined);
  assert.equal(temperatureTag({ engine: 'compatible', model: 'anthropic/claude-sonnet-4.6', efforts: ['none'] }), undefined, 'adaptive thinking');
  const sonnet = model('Claude Sonnet 4.6', { model: 'claude-sonnet-4-6', smarts: 80 });
  assert.match(factsLine([sonnet], ACCOUNTS), /Claude Sonnet 4\.6 · 80 · plan\./);
});

test('a model of an ACP plan CLI is paid by its plan, with or without the account at hand', () => {
  for (const provider of ['gemini-cli', 'copilot', 'kimi-cli'] as const) {
    const acp = model(`${provider} model`, { provider, engine: 'acp', accounts: [] });
    assert.equal(sourceOf(acp), 'plan', provider);
    assert.equal(sourceOf(acp, { ...ACCOUNTS[0], id: `acc_${provider}`, provider }), 'plan', provider);
  }
  assert.equal(sourceOf(model('Claude Opus 5.5', { accounts: [] })), 'plan');
  assert.equal(sourceOf(model('gpt-6', { provider: 'openai', engine: 'openai', accounts: [] })), 'API key');
  assert.equal(sourceOf(model('llama', { provider: 'ollama', engine: 'compatible', accounts: [] })), 'local');
  assert.equal(sourceOf(model('Claude Opus 5.5'), { ...ACCOUNTS[0], plan: 'api' }), 'API key', 'Claude Code signed in with an API key');
  assert.equal(sourceOf(model('x'), { ...ACCOUNTS[1], provider: 'compatible', auth: 'none' }), 'endpoint');
});
