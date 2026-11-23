// B-080 – a pin that cannot run now gets a stand-in at most at its own list price (router.ts, score.ts listPrice). Live
// 07.11.2026: GPT-6.1 Sol (relCost 0.3) pinned, the Codex plan at its limit → "pinned model unavailable · research ·
// strongest fit" on Opus (0.4) at max for hours, and the previous-model rule kept it. Here: Sonnet stands in, also
// after an Opus turn and for a person's line; only Opus connected → Opus (the work goes on); the agent's own model.set
// (step 2) and the Settings Work model still choose freely; a pin unfit for the work sets no price cap.
// D3 (B-083, live 08.11.: Luna, Haiku and an unprofiled vercel nano stood in for Opus, Sol and Terra pins in economy): the
// stand-in comes from the strongest tier inside that price – the cost mode chooses within it.
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { listPrice } from '../../../src/runtime/routing/score.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Effort } from '../../../src/shared/model/providers.ts';

const SOL = 'codex:gpt-6.1-sol';
const OPUS = 'claude:claude-opus-5-5';
const SONNET = 'claude:claude-sonnet-5-5';
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const caps = { vision: true, tools: true, structuredOutput: true };
const PRIORS = Priors.parse({
  version: 'test-stand-in', categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ALL, strengths: { research: 0.8, chat: 0.4 } },
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.4, caps, efforts: ALL, strengths: { research: 0.6, chat: 0.4 } },
    { match: 'claude-sonnet-5-5*', name: 'Claude Sonnet 5.5', tier: 'strong', relCost: 0.2, caps: { tools: true, structuredOutput: true }, efforts: ALL, strengths: { research: 0.5, chat: 0.4 } },
    { match: 'claude-haiku-5-5*', name: 'Claude Haiku 5.5', tier: 'small', relCost: 0.03, caps, efforts: ['low', 'medium', 'high'], strengths: { research: 0.1, chat: 0.4 } },
    { match: 'gpt-6.1-terra*', name: 'GPT-6.1 Terra', tier: 'strong', relCost: 0.25, caps, efforts: ALL, strengths: { research: 0.6, chat: 0.4, coding: 0.7 } },
  ],
});
const research = mode('research');

/** Sol on a Codex plan that is at its limit (cooling), Opus/Sonnet/Haiku (or only Opus) on a Claude plan; balanced. */
async function standIn(options: { onlyOpus?: boolean; personLine?: boolean } = {}) {
  const h = setup({ priors: PRIORS });
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL }]);
  h.engine('claude').lists.set('claude', [
    { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL },
    ...(options.onlyOpus ? [] : [{ model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ALL }, { model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'] as Effort[] }]),
  ]);
  await h.catalog.refresh({ force: true });
  h.accounts.markLimited('acc_codex', T0 + 5 * 3_600_000); // the Codex plan at its limit: Sol has no account now
  h.addChat('ch_1', ['ag_1']);
  if (options.personLine) {
    Object.assign(h.services.chats, { messages: () => [{ seq: 1, authorKind: 'human', kind: 'text', authorId: 'human', body: 'Recherchiere das bitte.' }] });
  }
  const route = (patch: Partial<RouteRequest> = {}) => h.router.route({ agent: agent('ag_1', { modelPolicy: { pin: SOL } }), mode: research, conversationId: 'ch_1', ...patch });
  return { ...h, route };
}

test('listPrice: the relCost, else a guess from the tier', () => {
  assert.equal(listPrice({ relCost: 0.3, tier: 'frontier' }), 0.3);
  assert.equal(listPrice({ tier: 'frontier' }), 0.6);
  assert.equal(listPrice({ tier: 'small' }), 0.05);
});

test('Sol pinned and at its limit: Sonnet stands in, not Opus – also after an Opus turn', async () => {
  const h = await standIn();
  const first = await h.route();
  assert.equal(first.modelId, SONNET, first.reason);
  assert.equal(first.by, 'fallback');
  assert.match(first.reason, /^pinned model unavailable · executing runs on the strong tier's first choice · research/);
  assert.equal(first.effort, 'medium');

  const afterOpus = await h.route({ previous: { modelId: OPUS, effort: 'max', category: 'research' } });
  assert.equal(afterOpus.modelId, SONNET, 'the previous-model rule no longer keeps an Opus stand-in');
  assert.match(afterOpus.reason, /^pinned model unavailable/);
});

test("a person's unweighed line on top of the failover: Sonnet at medium, and the reason says nobody weighed it", async () => {
  const h = await standIn({ personLine: true });
  const person = await h.route();
  assert.equal(person.modelId, SONNET, person.reason);
  assert.equal(person.effort, 'medium');
  assert.match(person.reason, /^pinned model unavailable · .*not weighed · effort medium$/);
});

test('nothing that cheap connected: the whole pool runs (Opus), the work goes on', async () => {
  const h = await standIn({ onlyOpus: true });
  const only = await h.route();
  assert.equal(only.modelId, OPUS);
  assert.equal(only.by, 'fallback');
});

test("my own model.set and the Settings Work model choose freely; a pin unfit for the work sets no cap", async () => {
  const h = await standIn();
  // A chat's suggested Sol (B-083: my own request comes first, the suggestion is not tried): my need 'stronger' from
  // the Sonnet stand-in gets Opus.
  h.addChat('ch_2', ['ag_1'], { models: { ag_1: SOL } });
  const stronger = await h.route({ agent: agent('ag_1'), conversationId: 'ch_2', previous: { modelId: SONNET, effort: 'medium', explicit: true, asked: 'model', need: { kind: 'stronger', from: SONNET } } });
  assert.equal(stronger.modelId, OPUS, stronger.reason);
  assert.equal(stronger.by, 'request');
  const named = await h.route({ agent: agent('ag_1'), conversationId: 'ch_2', previous: { modelId: OPUS, effort: 'high', explicit: true, asked: 'model' } });
  assert.deepEqual([named.modelId, named.by], [OPUS, 'request'], 'a model I name myself');
  // My own agent pin: my request leaves it (B-079), the cap never applies.
  const own = await h.route({ previous: { modelId: SONNET, effort: 'medium', explicit: true, asked: 'model', need: { kind: 'stronger', from: SONNET } } });
  assert.equal(own.modelId, OPUS);

  h.settings.update({ routing: { work: OPUS } });
  const work = await h.route();
  assert.equal(work.modelId, OPUS, 'the Settings Work model');
  assert.match(work.reason, /^pinned model unavailable · the Work model in Settings/);
  h.settings.update({ routing: { work: 'gemini-cli' } });

  // Sonnet pinned for work with images it cannot read: unfit, not "cannot run" – the usual rules, no cap at its price
  // (with one, Haiku would take it).
  const unfit = await h.route({ agent: agent('ag_1', { modelPolicy: { pin: SONNET } }), needs: { vision: true } });
  assert.match(unfit.reason, /^pinned model unsuitable \(needs vision\)/);
  assert.equal(unfit.modelId, OPUS);
});

test('D3: economy – the stand-in for a Sol pin comes from the strongest tier at its price: Sonnet, not Haiku, for any work', async () => {
  const h = await standIn();
  h.settings.update({ routing: { costMode: 'economy' } });
  for (const category of ['research', 'chat', 'coding']) {
    const route = await h.route({ mode: mode(category) });
    assert.equal(route.modelId, SONNET, `${category}: ${route.reason}`);
    assert.match(route.reason, /^pinned model unavailable/);
  }
  const afterHaiku = await h.route({ previous: { modelId: 'claude:claude-haiku-5-5', effort: 'low', category: 'research' } });
  assert.equal(afterHaiku.modelId, SONNET, 'a small earlier stand-in is not kept');

  const only = await standIn({ onlyOpus: true });
  only.settings.update({ routing: { costMode: 'economy' } });
  assert.equal((await only.route()).modelId, OPUS, 'nothing that cheap: the whole pool');
});

test('D3: a Terra pin cooling – the strong model at its price stands in, not an unprofiled nano on a credits key', async () => {
  const h = setup({ priors: PRIORS });
  h.settings.update({ routing: { costMode: 'economy' } });
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_key', 'openai', { credits: true }), false);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ALL }]);
  h.engine('claude').lists.set('claude', [{ model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ALL }]);
  h.engine('openai').lists.set('openai', [{ model: 'gpt-5-nano-batch', name: 'gpt-5-nano-batch', efforts: ['none'] }]);
  await h.catalog.refresh({ force: true });
  assert.equal(h.catalog.list().find((model) => model.model === 'gpt-5-nano-batch')?.tier, 'small', 'no priors: small by its name');
  h.accounts.markLimited('acc_codex', T0 + 5 * 60_000);
  const route = await h.router.route({ agent: agent('ag_1', { modelPolicy: { pin: 'codex:gpt-6.1-terra' } }), mode: mode('chat') });
  assert.equal(route.modelId, SONNET, route.reason);
  assert.match(route.reason, /^pinned model unavailable/);
});
