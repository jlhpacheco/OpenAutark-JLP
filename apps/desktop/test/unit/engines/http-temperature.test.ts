// B-078 (D14, D16): the agent's temperature (EngineTurnInput.temperature, model.set) on the HTTP API engines – the OpenAI
// Responses API sends it to models without reasoning (0..2) and drops it for the reasoning families; the Anthropic API sends
// it to models without thinking (clamped to its 0..1) and drops it for the adaptive models; without one nothing is sent;
// engines/http/temperature.ts answers model.set's "does it reach" from the same rules. B-083: effort none goes on the wire
// and a reasoning model that takes none gets the temperature there; Gemini 3+ on a compatible server keeps its default;
// takesTemperature reads the step's effort, so model.set's answer matches what the engine sends. B-083 (live 09.11.2026):
// Claude samples only without thinking (4.6 and older, claudeSamples); Opus 4.7+, every 5.x, Fable and Mythos never. Owner
// 09.11.: thinking is never turned off for it – a 4.6 model keeps adaptive thinking and its own setting, Claude Code sends
// none, a gateway's Claude ids get one only at effort none; the older models the API runs without thinking anyway take it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEngine, anthropicTemperature, claudeSamples } from '../../../src/runtime/engines/http/anthropic.ts';
import { compatibleTemperature } from '../../../src/runtime/engines/http/compatible.ts';
import { OpenAiEngine, openAiTemperature } from '../../../src/runtime/engines/http/openai.ts';
import { takesTemperature } from '../../../src/runtime/engines/http/temperature.ts';
import { account, turnInput } from './fakes.ts';
import { sendSse, serve } from './http-fixture.ts';

const KEY = 'sk-test-0123456789abcdef';

const anthropicText = [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ok.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const openAiText = [{ type: 'response.output_text.delta', delta: 'Ok.' }, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Ok.', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } } }];

async function body(kind: 'anthropic' | 'openai', model: string, temperature: number | undefined, effort?: string) {
  const server = await serve((_req, res) => sendSse(res, kind === 'anthropic' ? anthropicText : openAiText));
  const engine = kind === 'anthropic' ? new AnthropicEngine({ apiKey: async () => KEY }) : new OpenAiEngine({ apiKey: async () => KEY });
  const acc = account({ provider: kind, auth: 'api', baseUrl: `${server.url}/v1` });
  const result = await engine.run(turnInput({ account: acc, model, ...(effort ? { effort } : {}), ...(temperature !== undefined ? { temperature } : {}) }).input);
  await server.close();
  assert.equal(result.stop, 'done');
  return server.requests[0].body;
}

test('openai: a model without reasoning gets the temperature; a reasoning model and a turn without one send none', async () => {
  assert.equal((await body('openai', 'gpt-4.1', 1.3, 'none')).temperature, 1.3);
  assert.equal((await body('openai', 'gpt-6.1-sol', 1.3, 'high')).temperature, undefined, 'the reasoning family refuses the field');
  assert.equal((await body('openai', 'o4-mini', 0.2, 'low')).temperature, undefined);
  assert.equal((await body('openai', 'gpt-4.1', undefined, 'none')).temperature, undefined);
  assert.equal(openAiTemperature('gpt-4o', 5), 2, 'clamped to 0..2');
  assert.equal(openAiTemperature('gpt-4o', Number.NaN), undefined);
  assert.equal(openAiTemperature('codex-mini-latest', 0.5), undefined, 'codex-mini reasons too');
});

test('openai (B-083): effort none goes on the wire; a reasoning model takes the temperature only there and only when it takes none', async () => {
  const none = await body('openai', 'gpt-6-sol', 0.3, 'none');
  assert.deepEqual(none.reasoning, { effort: 'none' }, 'left out, the model would reason at its default medium');
  assert.equal(none.temperature, 0.3);
  const low = await body('openai', 'gpt-6-sol', 0.3, 'low');
  assert.deepEqual(low.reasoning, { effort: 'low', summary: 'auto' });
  assert.equal(low.temperature, undefined, 'above none the field is refused');
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    const refused = await body('openai', model, 0.3, 'none');
    assert.deepEqual(refused.reasoning, { effort: 'low', summary: 'auto' }, `${model} refuses none, so it runs at low`);
    assert.equal(refused.temperature, undefined);
  }
  assert.equal((await body('openai', 'gpt-4.1', 0.3, 'none')).reasoning, undefined, 'a model without reasoning gets no reasoning field');
  assert.equal(openAiTemperature('gpt-6-luna', 0.5, 'none'), 0.5);
  assert.equal(openAiTemperature('gpt-6.1-terra', 0.5, 'none'), 0.5);
  assert.equal(openAiTemperature('gpt-6-sol', 0.5), undefined, 'without an effort a reasoning model counts as reasoning');
  assert.equal(openAiTemperature('o4-mini', 0.5, 'none'), undefined);
});

test('openai (Fest 22.11.2026): every gpt generation from 5 up and the o-series reason – no list of generation numbers', async () => {
  for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5.1', 'gpt-6-sol', 'gpt-7', 'gpt-7.2-luna', 'gpt-8-terra', 'gpt-9.1', 'gpt-10', 'gpt-12.3-sol', 'o1', 'o3-mini', 'o4-mini', 'o5']) {
    assert.equal(openAiTemperature(model, 0.5, 'high'), undefined, `${model} above none: the field is refused`);
    assert.equal(openAiTemperature(model, 0.5), undefined, `${model} without an effort counts as reasoning`);
    assert.equal(takesTemperature('openai', model, 'medium'), false, model);
  }
  for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-3.5-turbo', 'gpt-image-1', 'gpt-realtime', 'gpt-oss-120b', 'chatgpt-4o-latest', 'omni-moderation-latest']) {
    assert.equal(openAiTemperature(model, 0.5), 0.5, `${model} has no reasoning`);
  }
  const later = await body('openai', 'gpt-7.2-luna', 0.4, 'none');
  assert.deepEqual(later.reasoning, { effort: 'none' }, 'a later generation takes none like gpt-5.1 and later');
  assert.equal(later.temperature, 0.4);
  const high = await body('openai', 'gpt-7', 0.4, 'high');
  assert.deepEqual(high.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(high.temperature, undefined, 'before: gpt-7 counted as a model without reasoning and got the temperature');
  assert.equal(compatibleTemperature('openai/gpt-7-sol', 0.4), undefined, 'a gateway\'s later GPT id follows the same rule');
});

test('compatible (B-083): Gemini 3 and later keep their default temperature; Gemini 2.5 and other models get it', () => {
  for (const model of ['gemini-3-pro-preview', 'google/gemini-3.8-flash', 'models/gemini-3-flash', 'Gemini-4-Argon']) assert.equal(compatibleTemperature(model, 0.2), undefined, model);
  assert.equal(compatibleTemperature('gemini-2.5-flash', 0.2), 0.2);
  assert.equal(compatibleTemperature('google/gemini-2.5-pro', 0.2), 0.2);
  assert.equal(compatibleTemperature('llama3.3', 3), 2, 'clamped to 0..2');
  assert.equal(compatibleTemperature('llama3.3', undefined), undefined);
});

test('compatible (B-083 review): a gateway\'s Claude ids follow the Claude rule (0..1), its GPT-5+/6 and o-series ids the OpenAI rule', () => {
  for (const model of ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-4.7', 'claude-haiku-5-5', 'anthropic/claude-sonnet-4.6', 'openai/gpt-6.1-sol', 'openai/gpt-6-sol', 'gpt-5.2', 'openai/o4-mini']) {
    assert.equal(compatibleTemperature(model, 0.2, 'none'), undefined, model);
    assert.equal(takesTemperature('compatible', model, 'none'), false, model);
  }
  assert.equal(compatibleTemperature('anthropic/claude-3.7-sonnet', 1.5, 'none'), 1, 'the Claude range ends at 1');
  assert.equal(compatibleTemperature('us.anthropic.claude-haiku-4-5-20251001-v1:0', 0.2, 'none'), 0.2);
  for (const effort of ['low', 'high', undefined] as const) {
    assert.equal(compatibleTemperature('us.anthropic.claude-haiku-4-5-20251001-v1:0', 0.2, effort), undefined, `owner 09.11.: above none the gateway thinks (${effort})`);
    assert.equal(takesTemperature('compatible', 'anthropic/claude-3.7-sonnet', effort), false, String(effort));
  }
  for (const model of ['openai/gpt-4.1', 'gpt-4o', 'openai/gpt-oss-120b', 'gpt-oss:20b']) assert.equal(compatibleTemperature(model, 1.5), 1.5, model);
});

test('anthropic: a model that still samples gets the temperature clamped to 0..1; a newer model sends none', async () => {
  assert.equal((await body('anthropic', 'claude-haiku-4-5', 0.4)).temperature, 0.4);
  assert.equal((await body('anthropic', 'claude-haiku-4-5', 1.6)).temperature, 1, 'the API\'s range ends at 1');
  const newer = await body('anthropic', 'claude-opus-5-5', 0.4, 'medium');
  assert.equal(newer.temperature, undefined, '"temperature is deprecated for this model"');
  assert.deepEqual(newer.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal((await body('anthropic', 'claude-haiku-4-5', undefined)).temperature, undefined);
  assert.equal(anthropicTemperature('claude-opus-4-5', -1), 0);
});

test('anthropic (owner 09.11.): a 4.6 model with a temperature keeps adaptive thinking and its effort; the temperature is not sent', async () => {
  const warm = await body('anthropic', 'claude-sonnet-4-6', 0.4, 'high');
  assert.equal(warm.temperature, undefined, 'thinking is never turned off for a temperature');
  assert.deepEqual(warm.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(warm.output_config.effort, 'high');
  assert.equal((await body('anthropic', 'claude-opus-4-6', 0.2, 'low')).temperature, undefined, 'at low effort too');
  assert.equal(anthropicTemperature('claude-sonnet-4-6', 0.4), undefined);
  for (const model of ['claude-opus-4-7', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
    const refused = await body('anthropic', model, 0.4, 'medium');
    assert.equal(refused.temperature, undefined, model);
    assert.equal(refused.thinking.type, 'adaptive', model);
  }
});

test('claudeSamples (B-083, live): 4.6 and older sample; Opus 4.7+, every 5.x, Fable, Mythos and unknown families do not', () => {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805',
    'claude-sonnet-4-20250514', 'claude-opus-4', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-latest', 'claude-sonnet-4-6-1m',
    'claude-sonnet-4-5@20250929', 'claude-opus-4@20250514', 'claude-sonnet-4.6', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-3.5-sonnet',
    'us.anthropic.claude-sonnet-4-6-v1:0', 'anthropic.claude-3-5-sonnet-20240620-v1:0']) assert.equal(claudeSamples(model), true, model);
  for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
    'claude-fable-5-1', 'claude-mythos-1', 'claude-nova-1', 'gpt-6-sol', 'any',
    'claude-opus-4.7', 'claude-opus-4.8', 'anthropic/claude-opus-4.7', 'anthropic/claude-opus-5.5', 'us.anthropic.claude-opus-4-8-v1:0', 'claude-5-opus']) assert.equal(claudeSamples(model), false, model);
});

test('takesTemperature: compatible and the APIs per model, Claude Code, Codex and ACP never', () => {
  assert.equal(takesTemperature('compatible', 'llama3.3'), true);
  assert.equal(takesTemperature('openai', 'gpt-4.1'), true);
  assert.equal(takesTemperature('openai', 'gpt-5.2'), false);
  assert.equal(takesTemperature('anthropic', 'claude-haiku-4-5'), true);
  assert.equal(takesTemperature('anthropic', 'claude-sonnet-4-6'), false, 'owner 09.11.: it thinks, and thinking stays');
  assert.equal(takesTemperature('anthropic', 'claude-opus-5-5'), false);
  for (const engine of ['codex', 'claude', 'acp']) assert.equal(takesTemperature(engine, 'any'), false);
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-opus-4-7', 'claude-opus-5-5', 'claude-fable-5-1']) assert.equal(takesTemperature('claude', model, 'high'), false, `Claude Code always thinks: ${model}`);
  for (const model of ['gpt-6-sol', 'gpt-6.1-terra']) assert.equal(takesTemperature('codex', model, 'none'), false, `Codex: ${model}`);
});

test('takesTemperature (B-083): with the step\'s effort it answers what the adapter sends – none on the OpenAI API, Gemini 3+ on compatible', () => {
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-terra']) {
    assert.equal(takesTemperature('openai', model, 'none'), true, `${model} at none`);
    assert.equal(takesTemperature('openai', model, 'low'), false, `${model} above none`);
    assert.equal(takesTemperature('openai', model), false, `${model} without an effort counts as reasoning`);
  }
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) assert.equal(takesTemperature('openai', model, 'none'), false, `${model} refuses none`);
  assert.equal(takesTemperature('openai', 'gpt-4.1', 'medium'), true, 'no reasoning: any effort');
  for (const model of ['gemini-3-pro-preview', 'google/gemini-3.8-flash']) assert.equal(takesTemperature('compatible', model), false, model);
  assert.equal(takesTemperature('compatible', 'google/gemini-2.5-pro'), true);
  assert.equal(takesTemperature('anthropic', 'claude-opus-5-5', 'none'), false, 'adaptive thinking at every effort');
  assert.equal(takesTemperature('claude', 'claude-haiku-4-5', 'none'), false, 'owner 09.11.: Claude Code keeps its thinking');
  assert.equal(takesTemperature('claude', 'claude-opus-5-5', 'none'), false, 'the newest Claude models keep their own');
  assert.equal(takesTemperature('fake', 'any'), true);
});
