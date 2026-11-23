// 17.11.2026 – the model settles, only the effort moves per turn (routing/router.ts, routing/kind.ts, routing/previous.ts).
// Measured 15.–17.11.: 177 model switches in 1,474 runs, 147 on a live one-hour cache, 60 % undone within two runs.
// Off a boundary (RouteRequest.boundary false) the turn runs on the model its session is on – a start model set since, the
// Work model and my own model.set wait, and the reason names what waits; only a model that cannot run and my own model.set
// with now move it. At a boundary: my own request, the start model, then Auto – the model I am on while it fits my kind
// (leading: the strongest tier, executing: the strong tier), else my kind's default with the reason in plain words.
// A person's line raises the effort to high on the model I am on. An effort someone asked for names whose it is. A fresh
// part without a named model runs on the executing default when its origin is above it.
// Owns: these assertions only. Never: real engines, accounts or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_LINE, account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { kindTier } from '../../../src/runtime/routing/kind.ts';
import { leads } from '../../../src/runtime/org/standard.ts';
import { returnChoice } from '../../../src/runtime/agents/next-route.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Effort, ModelInfo } from '../../../src/shared/model/providers.ts';

const OPUS = 'claude:claude-opus-5-5';
const SONNET = 'claude:claude-sonnet-5-5';
const HAIKU = 'claude:claude-haiku-5-5';
const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const caps = { vision: true, tools: true, structuredOutput: true };
const PRIORS = Priors.parse({
  version: 'test-settled', categories: {},
  models: [
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, smarts: 94, caps, efforts: ALL, strengths: { chat: 0.4, 'video-animation': 0.9 } },
    { match: 'claude-sonnet-5-5*', name: 'Claude Sonnet 5.5', tier: 'strong', relCost: 0.3, smarts: 88, caps, efforts: ALL, strengths: { chat: 0.4 } },
    { match: 'claude-haiku-5-5*', name: 'Claude Haiku 5.5', tier: 'small', relCost: 0.03, smarts: 74, caps, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4 } },
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, smarts: 93, caps, efforts: ['low', 'medium', 'high', 'xhigh'], strengths: { chat: 0.4, 'video-animation': -0.7 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, smarts: 72, caps: { tools: true, structuredOutput: true }, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4 } },
  ],
});

/** Claude Code and Codex plans with a frontier, a strong and a small tier; Konrad leads Felix. */
async function world() {
  const h = setup({ priors: PRIORS });
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh'], vision: true }, { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high'], vision: false }]);
  h.engine('claude').lists.set('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ model, name: model, efforts: model.includes('haiku') ? ['low', 'medium', 'high'] as Effort[] : ALL, vision: true })));
  await h.catalog.refresh({ force: true });
  const konrad = agent('ag_konrad', { name: 'Konrad' });
  const felix = agent('ag_felix', { name: 'Felix', managerId: 'ag_konrad' });
  for (const item of [konrad, felix]) h.agents.set(item.id, item);
  Object.assign(h.services.org, { list: () => [...h.agents.values()] });
  const route = (who: Agent, patch: Partial<RouteRequest> = {}) => h.router.route({ agent: who, mode: mode('chat'), ...patch });
  const tier = (id: string) => h.catalog.get(id)!.tier;
  return { ...h, konrad, felix, route, tier };
}

let seq = 0;
/** One of Felix's runs, newest first in the lists below. */
function run(patch: Partial<Run>): Run {
  seq += 1;
  return { id: `run_${seq}`, agentId: 'ag_felix', conversationId: 'ch_1', trigger: 'message', status: 'done', startedAt: 1_000 - seq, ...patch };
}

test('off a boundary the turn runs on the model its session is on – a start model set since and my own model.set wait, and the reason names what waits', async () => {
  const w = await world();
  const pinned = { ...w.felix, modelPolicy: { pin: SONNET } };
  // On the code before 17.11.2026 the start model took the turn at once, on a live cache.
  const live = await w.route(pinned, { previous: { modelId: OPUS, effort: 'high' }, boundary: false });
  assert.deepEqual([live.modelId, live.by, live.effort], [OPUS, 'previous', 'high'], live.reason);
  assert.equal(live.reason, 'continues on my model · Claude Sonnet 5.5 from my next context · chat');
  const fresh = await w.route(pinned, { previous: { modelId: OPUS, effort: 'high' }, boundary: true });
  assert.deepEqual([fresh.modelId, fresh.by], [SONNET, 'pin'], fresh.reason);

  // My own model.set: it waits off a boundary, runs at one, and runs at once with now.
  const asked = { modelId: SONNET, effort: 'high' as Effort, explicit: true, asked: 'model' as const, from: OPUS };
  const waits = await w.route(w.konrad, { previous: asked, boundary: false });
  assert.deepEqual([waits.modelId, waits.by], [OPUS, 'previous'], waits.reason);
  assert.match(waits.reason, /^continues on my model · Claude Sonnet 5\.5 from my next context/);
  const applied = await w.route(w.konrad, { previous: asked, boundary: true });
  assert.deepEqual([applied.modelId, applied.by], [SONNET, 'request'], applied.reason);
  assert.match(applied.reason, /^requested by the agent/);
  const now = await w.route(w.konrad, { previous: { ...asked, now: true }, boundary: false });
  assert.deepEqual([now.modelId, now.by], [SONNET, 'request'], now.reason);

  // The Work model of Settings waits the same way.
  w.settings.update({ routing: { work: HAIKU } });
  const work = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'medium' }, boundary: false });
  assert.equal(work.modelId, SONNET, work.reason);
  assert.match(work.reason, /Claude Haiku 5\.5 from my next context/);
  assert.equal((await w.route(w.felix, { previous: { modelId: SONNET, effort: 'medium' }, boundary: true })).modelId, HAIKU);
});

test('the effort is free on every turn: a request for it runs on the model I am on, off a boundary too', async () => {
  const w = await world();
  const route = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'xhigh', explicit: true, asked: 'effort' }, boundary: false });
  assert.deepEqual([route.modelId, route.effort, route.by, route.effortBy], [SONNET, 'xhigh', 'request', 'request']);
  assert.equal(route.reason, 'continues on my model · chat · effort requested by the agent');
});

test('a model that cannot run now moves the turn inside a live session, and the reason leads with it', async () => {
  const w = await world();
  // every Claude account just failed in this turn
  const failed = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'high' }, boundary: false, exclude: ['acc_claude'] });
  assert.equal(w.catalog.get(failed.modelId)!.provider, 'codex', failed.reason);
  assert.match(failed.reason, /^Claude Sonnet 5\.5 cannot run now – it just failed in this turn/);
  // a need the model cannot meet: images on a model that reads none
  const blind = await w.route(w.felix, { previous: { modelId: LUNA, effort: 'low' }, boundary: false, needs: { vision: true } });
  assert.notEqual(blind.modelId, LUNA);
  assert.match(blind.reason, /^GPT-6 Luna cannot run now – needs vision/);
  // while another account of the model runs, the model stays
  w.accounts.upsert(account('acc_claude_2', 'claude'), false);
  await w.catalog.refresh({ force: true });
  const other = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'high' }, boundary: false, exclude: ['acc_claude'] });
  assert.deepEqual([other.modelId, other.accountId], [SONNET, 'acc_claude_2'], other.reason);
});

test('who leads: an agent with reports, or one hired from the manager or head template', async () => {
  const w = await world();
  assert.equal(leads(w.services.org, w.konrad), true, 'Felix reports to Konrad');
  assert.equal(leads(w.services.org, w.felix), false);
  assert.equal(leads(w.services.org, agent('ag_new', { template: 'head' })), true, 'a head before its first hire');
  assert.equal(leads(w.services.org, agent('ag_new', { template: 'manager' })), true);
  assert.equal(leads(w.services.org, agent('ag_new', { template: 'researcher' })), false);
  // one leads() for the standard text and for routing (review 2, 17.11.2026: routing's own copy counted archived
  // reports, so a manager whose only report left read the agent standard yet ran on the leading tier)
  w.agents.set(w.felix.id, { ...w.felix, archivedAt: 5 });
  assert.equal(leads(w.services.org, w.konrad), false, 'an archived report leads nobody');
  const alone = await w.route(w.konrad);
  assert.deepEqual([alone.modelId, alone.reason], [SONNET, "executing runs on the strong tier's best value · chat · not weighed · effort medium"]);
  assert.equal(leads({} as never, w.felix), false, 'an org without a list');
});

test('Auto at a boundary: leading runs on the strongest tier\'s first choice, executing on the strong tier\'s best value; a model that fits stays, a drifted one moves and says why', async () => {
  const w = await world();
  // a first turn: no model to be on
  const lead = await w.route(w.konrad);
  assert.equal(w.tier(lead.modelId), 'frontier', lead.reason);
  assert.deepEqual([lead.by, lead.reason], ['rules', "leading runs on the frontier tier's first choice · chat · not weighed · effort medium"]);
  const doer = await w.route(w.felix);
  assert.deepEqual([doer.modelId, doer.by, doer.reason], [SONNET, 'rules', "executing runs on the strong tier's best value · chat · not weighed · effort medium"]);

  // On the code before 17.11.2026 the previous model simply continued: every employee stayed on its manager's model.
  const drifted = await w.route(w.felix, { previous: { modelId: OPUS, effort: 'high' }, boundary: true });
  assert.deepEqual([drifted.modelId, drifted.by], [SONNET, 'rules'], drifted.reason);
  assert.match(drifted.reason, /^executing runs on the strong tier's best value/);
  const small = await w.route(w.felix, { previous: { modelId: HAIKU, effort: 'low' }, boundary: true });
  assert.equal(small.modelId, SONNET, 'a detour onto the small tier ends at the next boundary too');
  const up = await w.route(w.konrad, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.equal(w.tier(up.modelId), 'frontier', up.reason);

  // a model that fits its kind stays – also one that is not the tier's first choice
  const fits = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.deepEqual([fits.modelId, fits.by, fits.reason, fits.effort], [SONNET, 'previous', 'continues on my model · chat', 'high']);
  const other = lead.modelId === OPUS ? SOL : OPUS;
  const stays = await w.route(w.konrad, { previous: { modelId: other, effort: 'high' }, boundary: true });
  assert.equal(stays.modelId, other, stays.reason);

  // off a boundary nothing of this moves a turn
  const live = await w.route(w.felix, { previous: { modelId: OPUS, effort: 'high' }, boundary: false });
  assert.deepEqual([live.modelId, live.reason], [OPUS, 'continues on my model · chat']);

  // fits means my kind's tier, nothing else: a frontier model whose prior is weak for this turn's work stays (review
  // 17.11.2026: one keyword flipped a lead between Opus and Sol at every boundary)
  const weak = await w.route(w.konrad, { mode: mode('video-animation'), previous: { modelId: SOL, effort: 'high' }, boundary: true });
  assert.deepEqual([weak.modelId, weak.by, weak.reason], [SOL, 'previous', 'continues on my model · video animation']);
});

test('a stand-in taken while my model could not run is no model of mine: at my next boundary where mine runs again my kind decides', async () => {
  const w = await world();
  // every Claude account fails: Sonnet's live session moves, and the route says it stands in
  const stood = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'high' }, boundary: false, exclude: ['acc_claude'] });
  assert.equal(w.catalog.get(stood.modelId)!.provider, 'codex', stood.reason);
  assert.equal(stood.standIn, true);
  // its run keeps the mark (turn-finish.ts), and my next turn's previous carries it (next-route.ts returnChoice)
  const ran = run({ model: stood.modelId, effort: 'high', route: { reason: stood.reason, by: stood.by, category: stood.category, standIn: true } });
  assert.equal(returnChoice([ran], undefined)?.standIn, true);
  assert.equal(returnChoice([run({ model: SONNET, effort: 'high', route: { reason: 'x', by: 'rules', category: 'chat' } }), ran], undefined)?.standIn, undefined, 'back on a model of my own: no mark');
  // off a boundary the turn stays on the stand-in, still marked as one
  const still = await w.route(w.felix, { previous: { modelId: stood.modelId, effort: 'high', standIn: true }, boundary: false });
  assert.deepEqual([still.modelId, still.standIn], [stood.modelId, true]);
  // at the next boundary Claude runs again: my kind's default, not the stand-in
  const back = await w.route(w.felix, { previous: { modelId: stood.modelId, effort: 'high', standIn: true }, boundary: true });
  assert.deepEqual([back.modelId, back.standIn], [SONNET, undefined], back.reason);
  // a model of my own in my kind's tier is no stand-in and stays
  const own = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.deepEqual([own.modelId, own.standIn], [SONNET, undefined]);
  // a fold turn on the stand-in carries the mark like any turn there (agents/context-fold.ts planFold), and my next
  // boundary reads it from that newest run (review 2, 17.11.2026: an unmarked fold run settled the stand-in for good)
  const fold = run({ trigger: 'fold', model: stood.modelId, effort: 'high', route: { reason: 'context fold', by: 'request', category: 'chat', standIn: true } });
  assert.equal(returnChoice([fold, ran], undefined, { on: stood.modelId })?.standIn, true);
});

test('a first turn in an outage stands in: the own model of my kind was left out only because it cannot run now', async () => {
  const w = await world();
  // review 2, 17.11.2026: a lead hired while the Claude plans cooled took the strongest tier that ran, unmarked, and stayed
  const first = await w.route(w.felix, { boundary: true, exclude: ['acc_claude'] });
  assert.equal(w.catalog.get(first.modelId)!.provider, 'codex', first.reason);
  assert.equal(first.standIn, true);
  const back = await w.route(w.felix, { previous: { modelId: first.modelId, effort: 'high', standIn: true }, boundary: true });
  assert.deepEqual([back.modelId, back.standIn], [SONNET, undefined], back.reason);
  // a cooling plan the same way (accounts.candidates leaves it out)
  w.accounts.upsert({ ...w.accounts.get('acc_claude')!, state: 'cooling', coolingUntil: w.clock.now() + 3_600_000 }, false);
  const cooled = await w.route(w.felix, { boundary: true });
  assert.deepEqual([w.catalog.get(cooled.modelId)!.provider, cooled.standIn], ['codex', true], cooled.reason);
  // nothing missing: the kind's default is no stand-in
  w.accounts.upsert({ ...w.accounts.get('acc_claude')!, state: 'ok', coolingUntil: undefined }, false);
  assert.equal((await w.route(w.konrad, { boundary: true })).standIn, undefined);
  // a stand-in that is my kind's own pick once everything runs is mine from here: the mark goes
  const own = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'high', standIn: true }, boundary: true });
  assert.deepEqual([own.modelId, own.standIn], [SONNET, undefined], own.reason);
});

test('the person\'s Model choice shifts the kind\'s tier: Best puts everyone on the strongest, Cheaper one tier lower; the tiers come from what is connected', async () => {
  const w = await world();
  w.settings.update({ routing: { costMode: 'best' } });
  assert.equal(w.tier((await w.route(w.felix)).modelId), 'frontier');
  w.settings.update({ routing: { costMode: 'economy' } });
  assert.equal(w.tier((await w.route(w.konrad)).modelId), 'strong');
  assert.equal(w.tier((await w.route(w.felix)).modelId), 'small');
  const pool = (...tiers: ModelInfo['tier'][]) => tiers.map((item) => ({ model: { tier: item } as ModelInfo }));
  assert.equal(kindTier(pool('frontier', 'small'), false, 'balanced'), 'frontier', 'no strong tier connected: executing runs on the strongest');
  assert.equal(kindTier(pool('small', 'local'), true, 'balanced'), 'small');
  assert.equal(kindTier(pool('strong', 'small'), true, 'balanced'), 'strong');
  assert.equal(kindTier([], true, 'balanced'), undefined);
});

test("Runde „Halb“: a person's new line lifts no effort and moves no model – the weighing decides for every wake alike", async () => {
  const w = await world();
  w.addChat('ch_1', ['ag_felix'], {}, PERSON_LINE);
  // On the code before 17.11.2026 the person rule moved the turn to the strongest model; before 21.11.2026 it was a floor at high.
  const line = await w.route(w.felix, { conversationId: 'ch_1', previous: { modelId: SONNET, effort: 'low' }, boundary: false });
  assert.deepEqual([line.modelId, line.effort], [SONNET, 'low'], line.reason);
  assert.equal(line.reason, 'continues on my model · chat');
  assert.equal(line.effortBy, 'previous');
  // my subconscious's low for their line runs as it is – not a floor
  const sub = { modelId: SONNET, explicit: true, asked: 'effort' as const, by: 'subconscious' as const, why: 'a receipt' };
  const weighed = await w.route(w.felix, { conversationId: 'ch_1', previous: { ...sub, effort: 'low' }, boundary: false });
  assert.equal(weighed.effort, 'low', weighed.reason);
  assert.equal((await w.route(w.felix, { conversationId: 'ch_1', previous: { ...sub, effort: 'xhigh' }, boundary: false })).effort, 'xhigh');
  // my own request and my fixed effort hold
  const own = await w.route(w.felix, { conversationId: 'ch_1', previous: { modelId: SONNET, effort: 'low', explicit: true, asked: 'effort' }, boundary: false });
  assert.equal(own.effort, 'low', own.reason);
  const fixed = await w.route({ ...w.felix, modelPolicy: { effort: 'medium' } }, { conversationId: 'ch_1', previous: { modelId: SONNET, effort: 'low' }, boundary: false });
  assert.equal(fixed.effort, 'medium', fixed.reason);
  // a colleague's wake keeps its effort
  const quiet = await w.route(w.felix, { previous: { modelId: SONNET, effort: 'low' }, boundary: false });
  assert.equal(quiet.effort, 'low');
});

test('an effort someone asked for names whose it is; my fixed effort holds against my subconscious, not against my task or me', async () => {
  const w = await world();
  const base = { modelId: SONNET, effort: 'xhigh' as Effort, explicit: true, asked: 'effort' as const };
  // On the code before 17.11.2026 a task's request read "requested by the agent" (204 runs measured).
  const task = await w.route(w.felix, { previous: { ...base, by: 'task', why: 'given by Clara' }, boundary: false });
  assert.equal(task.reason, 'continues on my model · chat · effort from my task (given by Clara)');
  const sub = await w.route(w.felix, { previous: { ...base, by: 'subconscious', why: 'eine Entscheidung steht an' }, boundary: false });
  assert.equal(sub.reason, 'continues on my model · chat · my subconscious: eine Entscheidung steht an');
  const fixedAgent = { ...w.felix, modelPolicy: { effort: 'medium' as Effort } };
  assert.equal((await w.route(fixedAgent, { previous: { ...base, by: 'subconscious' }, boundary: false })).effort, 'medium');
  assert.equal((await w.route(fixedAgent, { previous: { ...base, by: 'task' }, boundary: false })).effort, 'xhigh');
  assert.equal((await w.route(fixedAgent, { previous: base, boundary: false })).effort, 'xhigh');
});

test('a fresh part without a named model runs on the executing default when its origin is on the frontier tier, else on its origin\'s model', async () => {
  const w = await world();
  const part = (origin: string, fresh = true) => w.route(w.konrad, { previous: { modelId: origin, effort: 'high' }, split: { splitId: 'sp_1', ...(fresh ? { fresh: true as const } : {}) } });
  // On the code before 17.11.2026 such a part ran on its origin's model as "requested by the agent" (9 of 12 on the frontier tier).
  const down = await part(OPUS);
  assert.deepEqual([down.modelId, down.reason], [SONNET, "executing runs on the strong tier's best value · chat · not weighed · effort medium"]);
  const same = await part(SONNET);
  assert.deepEqual([same.modelId, same.reason, same.effort], [SONNET, "my origin's model · chat", 'high']);
  assert.equal((await part(HAIKU)).modelId, HAIKU, 'an origin below the strong tier keeps its model');
  // a forked part, and every part past its first turn, stays where it is
  const forked = await part(OPUS, false);
  assert.deepEqual([forked.modelId, forked.reason], [OPUS, 'continues on my model · chat']);
});

test('a start model I set myself runs inside the band the person or my lead set, on the accounts Auto uses', async () => {
  const w = await world();
  const self = { name: 'Felix', at: 1, self: true as const };
  // review 2, 17.11.2026: my own pin ran unbanded, so one model.set and one boundary put an executor above its ceiling
  const above = await w.route({ ...w.felix, modelPolicy: { pin: OPUS, pinBy: self, ceilingTier: 'strong' } }, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.notEqual(above.modelId, OPUS, above.reason);
  assert.match(above.reason, /outside the model policy/);
  // the same start model set by the person runs where they put it
  const person = await w.route({ ...w.felix, modelPolicy: { pin: OPUS, pinBy: { name: 'Heike', at: 1 }, ceilingTier: 'strong' } }, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.equal(person.modelId, OPUS, person.reason);
  // Opus only on a pay-per-use login while plans run: my own pin does not spill onto the key, the person's does
  w.accounts.upsert(account('acc_claude', 'claude', { plan: 'api' }), false);
  const paid = await w.route({ ...w.felix, modelPolicy: { pin: OPUS, pinBy: self } }, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.notEqual(paid.accountId, 'acc_claude', paid.reason);
  const theirs = await w.route({ ...w.felix, modelPolicy: { pin: OPUS, pinBy: { name: 'Heike', at: 1 } } }, { previous: { modelId: SONNET, effort: 'high' }, boundary: true });
  assert.deepEqual([theirs.modelId, theirs.accountId], [OPUS, 'acc_claude'], theirs.reason);
});
