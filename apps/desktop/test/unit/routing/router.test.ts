// Router: pins, return rule (D1), weak-prior switch, needs filter, cost modes, policy bounds,
// account exclusion, effort precedence + clamping, paid spill-over, decision tie-break, errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_LINE, account, agent, mode, setup, standardSetup } from '../models/harness.ts';
import { NO_MODEL_MESSAGE } from '../../../src/runtime/routing/router.ts';
import { setPolicy } from '../../../src/runtime/routing/policies.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { DecisionRequest, DecisionService, RouteRequest } from '../../../src/runtime/contracts.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Priors } from '../../../src/runtime/models/priors.ts';

const chat = mode('chat');
const video = mode('video-animation', { minTier: 'strong' });

function request(patch: Partial<RouteRequest> = {}): RouteRequest {
  return { agent: agent('ag_1'), mode: chat, ...patch };
}

test('rules: balanced chat picks the best fit; the category comes from the mode or the text', async () => {
  const h = await standardSetup();
  const plain = await h.router.route(request());
  assert.equal(plain.modelId, 'codex:gpt-6.1-sol');
  assert.equal(plain.engine, 'codex');
  assert.equal(plain.accountId, 'acc_codex');
  assert.equal(plain.category, 'chat');
  assert.equal(plain.by, 'rules');
  assert.equal(plain.effort, 'medium');
  assert.equal(plain.alternatives.length, 3);
  assert.ok(!plain.alternatives.includes(plain.modelId));

  const inferred = await h.router.route(request({ text: 'Bitte schneide das Musikvideo und baue eine Intro-Animation in Remotion.' }));
  assert.equal(inferred.category, 'video-animation');
  assert.equal(inferred.modelId, 'claude:claude-opus-5-5');
  assert.equal(inferred.effort, 'medium'); // Runde „Halb“ 21.11.2026: medium unweighed, no category default (video: high) for an agent's turn
  assert.match(inferred.reason, /video animation/);
});

test('cost modes: economy prefers small/cheap models, best prefers frontier', async () => {
  const h = await standardSetup();
  h.settings.update({ routing: { costMode: 'economy' } });
  const cheap = await h.router.route(request());
  assert.equal(h.catalog.get(cheap.modelId)!.tier, 'small');
  h.settings.update({ routing: { costMode: 'best' } });
  const best = await h.router.route(request());
  assert.equal(h.catalog.get(best.modelId)!.tier, 'frontier');
  // The agent's own cost mode beats the global setting.
  const economyAgent = await h.router.route(request({ agent: agent('ag_2', { modelPolicy: { costMode: 'economy' } }) }));
  assert.equal(h.catalog.get(economyAgent.modelId)!.tier, 'small');
});

test('start model: the agent\'s start model, also beside a chat suggestion (13.11.2026: never a route); an unusable one falls back with a reason', async () => {
  const h = await standardSetup();
  const pinnedAgent = agent('ag_1', { modelPolicy: { pin: 'claude:claude-opus-5-5' } });
  h.addChat('ch_1', ['ag_1'], { modelHints: { ag_1: 'claude:claude-haiku-5-5' }, models: { ag_1: 'claude:claude-haiku-5-5' } }, PERSON_LINE);
  for (const conversationId of [undefined, 'ch_1']) {
    const own = await h.router.route(request({ agent: pinnedAgent, conversationId }));
    assert.deepEqual([own.modelId, own.by], ['claude:claude-opus-5-5', 'pin'], conversationId);
    assert.match(own.reason, /^my start model/);
  }

  const missing = await h.router.route(request({ agent: agent('ag_1', { modelPolicy: { pin: 'claude:claude-fable-5-1' } }) }));
  assert.equal(missing.by, 'fallback');
  assert.match(missing.reason, /^pinned model unavailable/);
  assert.equal(missing.modelId, 'codex:gpt-6.1-sol');

  const excluded = await h.router.route(request({ agent: pinnedAgent, exclude: ['claude:claude-opus-5-5'] }));
  assert.equal(excluded.by, 'fallback');
  assert.notEqual(excluded.modelId, 'claude:claude-opus-5-5');
});

test('B-079/B-083: the start model is where I begin – the agent\'s own request beats it', async () => {
  const h = await standardSetup();
  const haiku = agent('ag_1', { modelPolicy: { pin: 'claude:claude-haiku-5-5', effort: 'low' } });
  const route = (patch: Partial<RouteRequest> = {}) => h.router.route(request({ agent: haiku, ...patch }));
  const start = await route();
  assert.deepEqual([start.modelId, start.effort, start.temperature, start.by], ['claude:claude-haiku-5-5', 'low', undefined, 'pin']);
  // The agent names a model: it runs there (its fixed effort still holds).
  const named = await route({ previous: { modelId: 'codex:gpt-6.1-sol', effort: 'low', explicit: true, asked: 'model' } });
  assert.deepEqual([named.modelId, named.effort, named.by], ['codex:gpt-6.1-sol', 'low', 'request']);
  // A need: the kind it asked for.
  const stronger = await route({ previous: { modelId: 'claude:claude-haiku-5-5', effort: 'low', explicit: true, asked: 'model', need: { kind: 'stronger', from: 'claude:claude-haiku-5-5' } } });
  assert.equal(h.catalog.get(stronger.modelId)!.tier, 'frontier');
  assert.equal(stronger.by, 'request');
  // An effort alone: the start model at the agent's effort.
  const effort = await route({ previous: { modelId: '', effort: 'high', explicit: true, asked: 'effort' } });
  assert.deepEqual([effort.modelId, effort.effort, effort.by], ['claude:claude-haiku-5-5', 'high', 'request']);
  assert.match(effort.reason, /^my start model · .*effort requested by the agent/);
  // A request nothing meets leaves the start model in place.
  const unmet = await route({ previous: { modelId: 'claude:claude-haiku-5-5', effort: 'low', explicit: true, asked: 'model', need: { kind: 'faster', from: 'claude:claude-haiku-5-5' } } });
  assert.equal(unmet.modelId, 'claude:claude-haiku-5-5', unmet.reason);
  assert.match(unmet.reason, /^no faster model fits · my start model/);
});

test('the model I am on: in a live session it continues (with its effort) while it can run; the rest is settled-model.test.ts', async () => {
  const h = await standardSetup();
  const kept = await h.router.route(request({ previous: { modelId: 'codex:gpt-6-luna', effort: 'high' }, boundary: false }));
  assert.equal(kept.modelId, 'codex:gpt-6-luna');
  assert.equal(kept.by, 'previous');
  assert.equal(kept.effort, 'high');
  // It cannot run (excluded after a failure) → my kind's default, and the reason leads with why.
  const moved = await h.router.route(request({ previous: { modelId: 'codex:gpt-6-luna', effort: 'high' }, boundary: false, exclude: ['codex:gpt-6-luna'] }));
  assert.equal(moved.by, 'rules');
  assert.notEqual(moved.modelId, 'codex:gpt-6-luna');
  assert.match(moved.reason, /^GPT-6 Luna cannot run now – it just failed in this turn/);
});

test('weak prior: a previous model clearly bad at the category stays while it fits the kind\'s tier – the tier decides, not the turn\'s words', async () => {
  const h = await standardSetup();
  const route = await h.router.route(request({ mode: video, previous: { modelId: 'codex:gpt-6.1-sol', effort: 'medium' } }));
  assert.deepEqual([route.modelId, route.by, route.reason], ['codex:gpt-6.1-sol', 'previous', 'continues on my model · video animation']);
});

test('explicit agent requests beat weak priors and default pins, never the policy band', async () => {
  const h = await standardSetup();
  setPolicy(h.services, {}, { pin: 'claude:claude-haiku-5-5' });
  const asked = await h.router.route(request({ mode: video, previous: { modelId: 'codex:gpt-6.1-sol', effort: 'xhigh', explicit: true } }));
  assert.equal(asked.modelId, 'codex:gpt-6.1-sol');
  assert.equal(asked.by, 'request'); // RT2: the run is skipped when the next turn looks for the model to return to
  assert.equal(asked.effort, 'xhigh');
  assert.match(asked.reason, /requested by the agent/);
  // Without the explicit flag the default pin applies (it is usable: video has no minimum tier here).
  const defaulted = await h.router.route(request({ mode: mode('video-animation'), previous: { modelId: 'codex:gpt-6.1-sol', effort: 'xhigh' } }));
  assert.equal(defaulted.modelId, 'claude:claude-haiku-5-5');
  assert.equal(defaulted.by, 'pin');
  // Outside the agent's band the request is ignored.
  const capped = await h.router.route(request({ agent: agent('ag_1', { modelPolicy: { ceilingTier: 'small' } }), previous: { modelId: 'codex:gpt-6.1-sol', effort: 'high', explicit: true } }));
  assert.notEqual(capped.modelId, 'codex:gpt-6.1-sol');
});

test('Settings uses: the Work model for every agent turn it can do, the Decisions model for runtime helpers', async () => {
  const h = await standardSetup();
  h.settings.update({ routing: { work: 'claude:claude-haiku-5-5', decision: 'claude:claude-haiku-5-5' } });
  const plain = await h.router.route(request());
  assert.equal(plain.modelId, 'claude:claude-haiku-5-5');
  assert.match(plain.reason, /the Work model in Settings/);
  assert.equal((await h.router.route(request({ mode: video }))).modelId, 'claude:claude-haiku-5-5', "every kind of work (a mode's tier is a preference)");
  h.settings.update({ routing: { work: 'codex:gpt-6.1-sol' } });
  const vision = await h.router.route(request({ needs: { vision: true } }));
  assert.equal(vision.modelId, 'codex:gpt-6.1-sol');
  h.settings.update({ routing: { work: 'codex:gpt-6-luna' } });
  const unfit = await h.router.route(request({ needs: { vision: true } }));
  assert.notEqual(unfit.modelId, 'codex:gpt-6-luna', 'a Work model that cannot do the turn falls through');
  assert.match(unfit.reason, /pinned model unsuitable/);
  h.settings.update({ routing: { work: 'claude:claude-haiku-5-5' } });
  const helper = await h.router.route(request({ agent: agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } }), mode: mode('cheap-chat'), text: 'compact' }));
  assert.equal(helper.modelId, 'claude:claude-haiku-5-5', 'the Decisions model, not the Codex helper default');
  assert.match(helper.reason, /the Decisions model in Settings/);
  h.settings.update({ routing: { work: 'codex', decision: 'auto' } });
  assert.equal((await h.router.route(request())).by, 'rules', 'a plan as the Work use is a preference, no pin');
  assert.match((await h.router.route(request({ agent: agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } }), mode: mode('cheap-chat'), text: 'decision' }))).reason, /helper default/);
});

test('needs: vision and computer use filter the candidates; nothing capable is a clear error', async () => {
  const h = await standardSetup();
  const lunaFan = agent('ag_1', { modelPolicy: { prefer: ['codex:gpt-6-luna'], costMode: 'economy' } });
  assert.equal((await h.router.route(request({ agent: lunaFan }))).modelId, 'codex:gpt-6-luna');
  const seeing = await h.router.route(request({ agent: lunaFan, needs: { vision: true } }));
  assert.notEqual(seeing.modelId, 'codex:gpt-6-luna');
  assert.equal(h.catalog.get(seeing.modelId)!.caps.vision, true);
  assert.equal((await h.router.route(request({ needs: { computerUse: true } }))).modelId, 'claude:claude-opus-5-5');

  const blind = setup();
  blind.accounts.upsert(account('acc_codex', 'codex'), false);
  blind.engine('codex').lists.set('codex', [{ model: 'gpt-6-luna', name: 'Luna', efforts: ['low'], vision: false }]);
  await blind.catalog.refresh({ force: true });
  await assert.rejects(blind.router.route(request({ needs: { vision: true } })), (error: unknown) =>
    error instanceof WorkforceError && error.code === 'unavailable' && error.message === 'No connected model can read images.'
    && error.details?.need === 'vision'); // the turn falls back to a run without images on exactly this
});

test('policy bounds and mode tiers are never exceeded silently', async () => {
  const h = await standardSetup();
  const capped = await h.router.route(request({ agent: agent('ag_1', { modelPolicy: { ceilingTier: 'small' } }), mode: mode('video-animation') }));
  assert.equal(h.catalog.get(capped.modelId)!.tier, 'small');
  await assert.rejects(
    h.router.route(request({ agent: agent('ag_1', { name: 'Editor', modelPolicy: { ceilingTier: 'small' } }), mode: video })),
    (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /model policy of Editor/.test(error.message),
  );
  // "−1" priors mean never: Haiku is not a harness model even when it is the only small one allowed.
  const harness = await h.router.route(request({ mode: mode('harness-self-modification', { minTier: 'frontier' }) }));
  assert.equal(h.catalog.get(harness.modelId)!.tier, 'frontier');
});

test('excluding a failed account moves to another account of the same model', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_c1', 'claude'), false);
  h.accounts.upsert(account('acc_c2', 'claude', { priority: 1 }), false);
  h.engine('claude').lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] }]);
  await h.catalog.refresh({ force: true });
  const first = await h.router.route(request({ mode: video }));
  assert.equal(first.accountId, 'acc_c1');
  const failover = await h.router.route(request({ mode: video, previous: { modelId: first.modelId, effort: first.effort }, exclude: ['acc_c1'] }));
  assert.equal(failover.modelId, 'claude:claude-opus-5-5');
  assert.equal(failover.accountId, 'acc_c2');
  await assert.rejects(h.router.route(request({ mode: video, exclude: ['acc_c1', 'acc_c2'] })), /limited right now/);
});

test('effort: agent policy > default (a chat\'s suggested effort is no route); clamped to what the model supports', async () => {
  const h = await standardSetup();
  h.addChat('ch_1', ['ag_1'], { models: { ag_1: 'codex:gpt-6.1-sol' }, efforts: { ag_1: 'low' } });
  assert.equal((await h.router.route(request({ conversationId: 'ch_1' }))).effort, 'medium', 'the chip\'s effort is information on the person\'s line');
  const fixed = agent('ag_1', { modelPolicy: { effort: 'max' } });
  assert.equal((await h.router.route(request({ agent: fixed, conversationId: 'ch_1' }))).effort, 'xhigh'); // Sol tops out at xhigh
  const none = agent('ag_1', { modelPolicy: { pin: 'claude:claude-opus-5-5', effort: 'none' } });
  assert.equal((await h.router.route(request({ agent: none }))).effort, 'low'); // Opus cannot switch thinking off
  // Runde „Halb“ 21.11.2026: an agent's turn with nothing set runs at medium, not at its category's default (cheap chat: low)
  const cheap = await h.router.route(request({ mode: mode('cheap-chat') }));
  assert.equal(cheap.effort, 'medium', cheap.reason);
  setPolicy(h.services, {}, { effort: 'high' });
  assert.equal((await h.router.route(request())).effort, 'high'); // global default policy
});

test('pay-per-use API keys are only a spill-over unless allowed', async () => {
  const h = await standardSetup();
  h.accounts.upsert(account('acc_oa', 'openai'), false);
  h.engine('openai').lists.set('openai', [{ model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'] }]);
  await h.catalog.refresh({ force: true });
  const fan = agent('ag_1', { modelPolicy: { prefer: ['openai:gpt-6-astra'] } });
  assert.notEqual((await h.router.route(request({ agent: fan }))).modelId, 'openai:gpt-6-astra');
  h.settings.update({ routing: { allowPaidFallback: true } });
  assert.equal((await h.router.route(request({ agent: fan }))).modelId, 'openai:gpt-6-astra');
  h.settings.update({ routing: { allowPaidFallback: false } });
  // Plans limited → the API key is the only way left, so it is used.
  const astra = await h.router.route(request({ exclude: ['acc_codex', 'acc_claude'] }));
  assert.equal(astra.accountId, 'acc_oa');
});


test('no connected model: refreshes once, then fails with the settings hint', async () => {
  const h = setup();
  await assert.rejects(h.router.route(request()), (error: unknown) =>
    error instanceof WorkforceError && error.code === 'unavailable' && error.message === NO_MODEL_MESSAGE);
  assert.ok(h.db.get('SELECT value FROM kv WHERE ns = ? AND key = ?', ['catalog', 'refreshed_at']), 'route triggered a catalog refresh');
});

test('the Work use (also set as a global default pin) stays inside the agent band; runtime helpers keep their Decisions model', async () => {
  const h = await standardSetup();
  setPolicy(h.services, {}, { pin: 'claude:claude-opus-5-5' });
  const free = await h.router.route(request());
  assert.deepEqual([free.modelId, free.by], ['claude:claude-opus-5-5', 'pin']);
  // The agent's own ceiling overrides the global default pin (it is not silently exceeded).
  const small = agent('ag_1', { modelPolicy: { ceilingTier: 'small' } });
  const capped = await h.router.route(request({ agent: small }));
  assert.equal(h.catalog.get(capped.modelId)!.tier, 'small');
  assert.equal(capped.by, 'fallback');
  assert.match(capped.reason, /outside the model policy/);
  // A Work model inside the band applies.
  h.settings.update({ routing: { work: 'claude:claude-haiku-5-5', decision: 'claude:claude-haiku-5-5' } });
  const viaSettings = await h.router.route(request({ agent: small }));
  assert.equal(viaSettings.modelId, 'claude:claude-haiku-5-5');
  assert.match(viaSettings.reason, /the Work model in Settings/);
  // Runtime helpers: the Decisions model; a global default pin is the Work use and never reaches them.
  setPolicy(h.services, {}, { pin: 'codex:gpt-6-luna' });
  assert.equal(h.settings.get().routing.work, 'codex:gpt-6-luna');
  const helper = await h.router.route(request({ agent: agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } }), mode: mode('cheap-chat'), text: 'compact' }));
  assert.equal(helper.modelId, 'claude:claude-haiku-5-5');
});

test('pins: a provider-qualified id never moves to another provider; bare ids resolve (also with a colon)', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_oa', 'openai'), false);
  h.accounts.upsert(account('acc_ollama', 'ollama'), false);
  h.engine('claude').lists.set('claude', [{ model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'] }]);
  h.engine('openai').lists.set('openai', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] }]);
  h.engine('compatible').lists.set('ollama', [{ model: 'qwen3.8:27b', name: 'qwen3.8:27b', efforts: [] }]);
  await h.catalog.refresh({ force: true });
  const pinned = (pin: string) => request({ agent: agent('ag_1', { modelPolicy: { pin } }) });
  // The Codex plan pin has no Codex account any more: never the pay-per-use OpenAI key instead.
  const moved = await h.router.route(pinned('codex:gpt-6.1-sol'));
  assert.notEqual(moved.modelId, 'openai:gpt-6.1-sol');
  assert.equal(moved.by, 'fallback');
  assert.match(moved.reason, /^pinned model unavailable/);
  assert.equal((await h.router.route(pinned('claude-haiku-5-5'))).modelId, 'claude:claude-haiku-5-5');
  const local = await h.router.route(pinned('qwen3.8:27b'));
  assert.deepEqual([local.modelId, local.accountId, local.by], ['ollama:qwen3.8:27b', 'acc_ollama', 'pin']);
});

test('B-047 D12: a Manager\'s chat or research turn takes its text\'s category – not manager-planner on the priciest frontier model at high effort', async () => {
  // The shipped priors: the owner saw GPT-6 Astra (manager-planner 0.6, relCost 1.0) on every Manager turn.
  const shipped = Priors.parse(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../resources/model-priors.json'), 'utf8')));
  const h = await standardSetup({ priors: shipped });
  h.engine('codex').lists.set('codex', [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', vision: true },
    { model: 'gpt-6-luna', name: 'gpt-6-luna', efforts: ['none', 'low', 'medium', 'high'], vision: false },
    { model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', vision: true },
  ]);
  await h.catalog.refresh({ force: true });
  const manager = mode('manager-planner', { key: 'manager', qualifiedTier: 'strong' });
  const boss = agent('ag_boss', { mode: 'manager' });
  const planning = await h.router.route({ agent: boss, mode: manager, text: 'Plan the roadmap, prioritise the milestones and delegate them to the team.' });
  assert.equal(planning.category, 'manager-planner');
  assert.equal(planning.effort, 'medium', 'Runde „Halb“: unweighed, real planning runs at medium too – the weighing lifts it');
  const chat = await h.router.route({ agent: boss, mode: manager, text: 'Hi! How are you today?' });
  assert.equal(chat.category, 'chat');
  assert.notEqual(chat.modelId, 'codex:gpt-6-astra');
  assert.equal(chat.effort, 'medium');
  const research = await h.router.route({ agent: boss, mode: manager, text: 'Recherchiere bitte die Firma Acme und vergleiche ihre Preise mit drei Quellen.' });
  assert.equal(research.category, 'research');
  assert.notEqual(research.modelId, 'codex:gpt-6-astra');
  assert.notEqual(research.effort, 'high');
  // No turn text (model lists, the qualified-tier check): the mode's own category.
  assert.equal((await h.router.route({ agent: boss, mode: manager })).category, 'manager-planner');
});
