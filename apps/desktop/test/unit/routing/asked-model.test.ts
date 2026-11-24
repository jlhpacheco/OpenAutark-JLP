// B-083 D1 (routing/router.ts, routing/unfit.ts askedMiss) – a model I named that cannot run now: my turn stays on the model
// it is on (RouteRequest.previous.from), else on the strongest model at least at its tier and at most its list price, else
// the rules; the reason leads with "asked for <name> – <why>". Live 09.11.: Opus asked for while the Claude plan sat at
// 100 % of its week ran as "best value" Luna with no word why. D8: "paused" only for a short cooling after a provider error.
// Economy cost mode, as on the owner's PC.
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_LINE, T0, account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { selectCandidates } from '../../../src/runtime/accounts/candidates.ts';
import { LIMITED_MESSAGE, PAUSED_MESSAGE } from '../../../src/runtime/routing/unfit.ts';
import { modelList } from '../../../src/runtime/routing/model-list.ts';
import { listPrice } from '../../../src/runtime/routing/score.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Effort, EngineId } from '../../../src/shared/model/providers.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const HAIKU = 'claude:claude-haiku-5-5';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const caps = { vision: true, tools: true, structuredOutput: true };
const NAMES: Record<string, string> = {
  'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-luna': 'GPT-6 Luna', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5',
};
const PRIORS = Priors.parse({
  version: 'test-asked', categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ALL, strengths: { chat: 0.4, research: 0.8 } },
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, caps, efforts: ALL, strengths: { chat: 0.4, research: 0.6 } },
    { match: 'claude-sonnet-5-5*', name: 'Claude Sonnet 5.5', tier: 'strong', relCost: 0.2, caps, efforts: ALL, strengths: { chat: 0.4, research: 0.5 } },
    { match: 'claude-haiku-5-5*', name: 'Claude Haiku 5.5', tier: 'small', relCost: 0.03, caps, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4, research: 0.1 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, caps, efforts: ['none', 'low', 'medium', 'high'], strengths: { chat: 0.4 } },
  ],
});
const ASKED_OPUS = { modelId: OPUS, effort: 'high' as Effort, explicit: true };

/** A Codex plan (Sol, Luna) and a Claude plan (Opus, Sonnet, Haiku) unless named; economy; model windows bind per model. */
async function asked(options: { codex?: string[]; claude?: string[]; providers?: Record<string, object> } = {}) {
  const h = setup({ priors: PRIORS });
  h.settings.update({ routing: { costMode: 'economy' }, ...(options.providers ? { providers: options.providers } : {}) } as never);
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.candidates = (engine: EngineId, model?: string) => selectCandidates(h.accounts.accounts, engine, h.clock.now(), model);
  const listed = (model: string) => ({ model, name: NAMES[model], efforts: PRIORS.forModel(model)?.efforts ?? ALL });
  h.engine('codex').lists.set('codex', (options.codex ?? ['gpt-6.1-sol', 'gpt-6-luna']).map(listed));
  h.engine('claude').lists.set('claude', (options.claude ?? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']).map(listed));
  await h.catalog.refresh({ force: true });
  h.addChat('ch_1', ['ag_1']);
  const route = (patch: Partial<RouteRequest> = {}) => h.router.route({ agent: agent('ag_1'), mode: mode('chat'), conversationId: 'ch_1', ...patch });
  /** The Claude plan at 100 % of a window (account-wide 'weekly', or 'weekly-opus') until T0 + 3 days. */
  const limitClaude = (name = 'weekly') => h.accounts.updateLimits('acc_claude', { windows: [{ name, windowMinutes: 10080, usedPercent: 100, resetsAt: T0 + 3 * DAY }], readAt: T0 });
  return { ...h, route, limitClaude };
}

const unavailable = (message: string, retryAfterMs?: number) => (error: unknown) =>
  error instanceof WorkforceError && error.code === 'unavailable' && error.message === message && error.retryAfterMs === retryAfterMs;

test('D1: Opus asked for while its plan is at its week – my turn stays on Sol, the model it is on; the reason says why first', async () => {
  const h = await asked();
  h.limitClaude();
  const stays = await h.route({ previous: { ...ASKED_OPUS, from: SOL } });
  assert.deepEqual([stays.modelId, stays.by, stays.effort], [SOL, 'request', 'high'], stays.reason);
  assert.match(stays.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(limited until .+\) · continues on my model/);

  // Not on a model yet: the strongest model at least at its tier and at most its price – Sol, never Haiku or Luna.
  const like = await h.route({ previous: ASKED_OPUS });
  assert.deepEqual([like.modelId, like.by], [SOL, 'request'], like.reason);
  assert.match(like.reason, /^asked for Claude Opus 5\.5 – no account of it can run now .* · strongest stand-in/);

  // After the reset: Opus, by my request.
  h.clock.advance(3 * DAY + MINUTE);
  const back = await h.route({ previous: { ...ASKED_OPUS, from: SOL } });
  assert.deepEqual([back.modelId, back.by], [OPUS, 'request'], back.reason);
  assert.match(back.reason, /^requested by the agent/);
});

test('D1: nothing at its tier – the rules run (my start model first), the reason still leads with what I asked for', async () => {
  const h = await asked({ codex: ['gpt-6-luna'], claude: ['claude-opus-5-5', 'claude-haiku-5-5'] });
  h.limitClaude();
  const started = await h.route({ agent: agent('ag_1', { modelPolicy: { pin: LUNA } }), previous: { ...ASKED_OPUS, from: SOL } });
  assert.equal(started.modelId, LUNA, started.reason);
  assert.match(started.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(limited until .+\) · my start model/);
  const rules = await h.route({ previous: ASKED_OPUS });
  assert.equal(rules.modelId, LUNA);
  assert.match(rules.reason, /^asked for Claude Opus 5\.5 – /);
});

test('D1: why it cannot run – failed in this turn, outside my policy, not connected', async () => {
  const h = await asked();
  const failed = await h.route({ previous: { ...ASKED_OPUS, from: SOL }, exclude: ['acc_claude'] });
  assert.equal(failed.modelId, SOL);
  assert.match(failed.reason, /^asked for Claude Opus 5\.5 – it just failed in this turn · continues on my model/);
  const capped = await h.route({ agent: agent('ag_1', { modelPolicy: { ceilingTier: 'strong' } }), previous: { ...ASKED_OPUS, from: SOL } });
  assert.match(capped.reason, /^asked for Claude Opus 5\.5 – outside the model policy · /);
  assert.notEqual(h.catalog.get(capped.modelId)!.tier, 'frontier');
  const gone = await h.route({ previous: { ...ASKED_OPUS, modelId: 'claude:claude-fable-5-1', from: SOL } });
  assert.match(gone.reason, /^asked for claude:claude-fable-5-1 – no account of it is connected · continues on my model/);
});

test("D1 for a split's part: on its parent's model, else a frontier stand-in at most at Opus's price", async () => {
  const h = await asked();
  h.limitClaude();
  const split = { splitId: 'sp_1' };
  const on = await h.route({ split, previous: { ...ASKED_OPUS, asked: 'model', from: SOL } });
  assert.equal(on.modelId, SOL);
  assert.match(on.reason, /^asked for Claude Opus 5\.5 – no account of it can run now/);
  const like = await h.route({ split, previous: { ...ASKED_OPUS, asked: 'model' } });
  const model = h.catalog.get(like.modelId)!;
  assert.equal(model.tier, 'frontier');
  assert.ok(listPrice(model) <= 0.6);
});

test('D5: a request stored in an older id form meets its model', async () => {
  const bare = await asked();
  const plain = await bare.route({ previous: { ...ASKED_OPUS, modelId: 'claude-opus-5-5' } });
  assert.deepEqual([plain.modelId, plain.by], [OPUS, 'request']);

  const renamed = await asked({ providers: { acc_claude: {} } });
  const opus = renamed.catalog.list().find((model) => model.model === 'claude-opus-5-5')!;
  assert.equal(opus.id, 'acc_claude:claude-opus-5-5', 'the connection names itself');
  const older = await renamed.route({ previous: ASKED_OPUS });
  assert.deepEqual([older.modelId, older.by], [opus.id, 'request'], older.reason);
});

test("D1 before D2: on a person's turn my request for a limited Opus stays on Sol, not on the chat's Haiku", async () => {
  const h = await asked();
  h.limitClaude('weekly-opus'); // Haiku and Sonnet run on the same plan
  h.addChat('ch_2', ['ag_1'], { modelHints: { ag_1: HAIKU } }, PERSON_LINE);
  const mine = await h.route({ conversationId: 'ch_2', previous: { ...ASKED_OPUS, from: SOL } });
  assert.equal(mine.modelId, SOL, mine.reason);
  assert.match(mine.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(limited until .+\) · continues on my model/);
  assert.equal((await h.route({ conversationId: 'ch_2' })).modelId, HAIKU, 'without my request the suggestion starts the answer');
});

test('D8: a short cooling after a provider error reads "paused"; a long cooling or a used-up window "used up" (F28: by account)', async () => {
  const paused = await asked();
  for (const id of ['acc_codex', 'acc_claude']) paused.accounts.markLimited(id, T0 + 5 * MINUTE);
  await assert.rejects(paused.route(), unavailable('acc_codex, acc_claude paused until 09:05', 5 * MINUTE));

  const credit = await asked();
  for (const id of ['acc_codex', 'acc_claude']) credit.accounts.markLimited(id, T0 + 6 * 60 * MINUTE);
  await assert.rejects(credit.route(), unavailable('acc_codex, acc_claude used up until 15:00', 6 * 60 * MINUTE), 'a 402 cools 6 h');

  const week = await asked();
  week.limitClaude();
  week.accounts.updateLimits('acc_codex', { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 100, resetsAt: T0 + 10 * MINUTE }], readAt: T0 });
  await assert.rejects(week.route(), unavailable('acc_codex used up until 09:10 · acc_claude used up until 20 Oct 09:00', 10 * MINUTE), 'a used-up window is a limit, however soon it resets');
  assert.ok(PAUSED_MESSAGE.includes('paused') && LIMITED_MESSAGE.includes('limited'), 'the fixed sentences stay for a reason no account explains (unfit-accounts.test.ts)');
});

test('backAt: every signed-in plan takes turns, so the plan back first gives the time and the word (owner 09.11.2026)', async () => {
  const h = await asked();
  h.accounts.upsert(account('acc_claude2', 'claude', { priority: 1 }), false);
  await h.catalog.refresh({ force: true });
  assert.ok(h.catalog.get(OPUS)!.accounts.includes('acc_claude2'));
  h.limitClaude();
  h.accounts.updateLimits('acc_claude2', { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 100, resetsAt: T0 + 2 * 60 * MINUTE }], readAt: T0 });
  const route = await h.route({ previous: { ...ASKED_OPUS, from: SOL } });
  // Claude Code is at its week until 20 Oct; Claude Code 2's 5h window frees it at 11:00 – that is when Opus runs again.
  assert.match(route.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(limited until 11:00\) · /);
  const list = modelList({ services: h.services, agent: agent('ag_1', { modelPolicy: { pin: OPUS } }), mode: mode('chat'), category: 'chat', includeUnavailable: true });
  assert.match(list, /it cannot run now \(limited until 11:00\)/);

  // Claude Code only cools for minutes and is back first: "paused", whatever Claude Code 2's week reads.
  const cooling = await asked();
  cooling.accounts.upsert(account('acc_claude2', 'claude', { priority: 1 }), false);
  await cooling.catalog.refresh({ force: true });
  cooling.accounts.markLimited('acc_claude', T0 + 5 * MINUTE);
  cooling.accounts.updateLimits('acc_claude2', { windows: [{ name: 'weekly', windowMinutes: 10080, usedPercent: 100, resetsAt: T0 + DAY }], readAt: T0 });
  const paused = await cooling.route({ previous: { ...ASKED_OPUS, from: SOL } });
  assert.match(paused.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(paused until 09:05\) · /);
});

test('askedMiss: "paused until" for a short cooling; no time when none is known', async () => {
  const h = await asked();
  h.accounts.markLimited('acc_claude', T0 + 5 * MINUTE);
  const paused = await h.route({ previous: { ...ASKED_OPUS, from: SOL } });
  assert.match(paused.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(paused until 09:05\) · /);

  const login = await asked();
  login.accounts.markUnavailable('acc_claude', 'needs_login'); // the catalog still lists Opus
  assert.equal(login.catalog.get(OPUS)?.available, true);
  const unknown = await login.route({ previous: { ...ASKED_OPUS, from: SOL } });
  assert.match(unknown.reason, /^asked for Claude Opus 5\.5 – no account of it can run now · continues on my model/);
});

test('an auto turn on an exhausted plan moves to an already accepted plan with quota without changing either account', async () => {
  const h = await asked({ codex: ['gpt-6.1-sol'], claude: ['claude-opus-5-5'] });
  h.limitClaude();
  const before = structuredClone(h.accounts.accounts);
  const moved = await h.route({ previous: { modelId: OPUS, from: OPUS, explicit: false }, boundary: false });
  assert.deepEqual([moved.modelId, moved.accountId, moved.standIn], [SOL, 'acc_codex', true], moved.reason);
  assert.deepEqual(h.accounts.accounts, before, 'no adoption, account setting change or reset');
});
