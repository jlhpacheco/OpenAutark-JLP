// A person's own line (Runde „Halb“ 21.11.2026: no effort floor any more): a turn with a new line of a person runs at the same
// effort as any other; with nothing set and no weighing, medium on every model, a person's line included (round 4, the bench's
// nine days: previous.ts UNWEIGHED_EFFORT); a fixed effort and the settled effort stay; a runtime helper call keeps its category's. The model never moves for
// the line. The strongest tier's first choice (smarts against list price) is where leading runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { account, agent, mode, setup, standardSetup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import { firstChoice, personValue, topTier } from '../../../src/runtime/routing/person-turn.ts';
import { UNWEIGHED_EFFORT, startEffortBy } from '../../../src/runtime/routing/previous.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Effort } from '../../../src/shared/model/providers.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';

const chat = mode('chat');

/** standardSetup plus a chat whose lines the fake chat service returns after a read cursor. */
async function withChat(lines: Array<{ seq: number; authorKind: Message['authorKind']; kind?: Message['kind'] }>, readSeq = 0) {
  const h = await standardSetup();
  h.addChat('ch_1', ['ag_1']);
  const members = (h.services.chats as unknown as { members(id: string): Array<{ memberId: string; readSeq: number }> }).members('ch_1');
  for (const member of members) if (member.memberId === 'ag_1') member.readSeq = readSeq;
  Object.assign(h.services.chats, {
    messages: (_id: string, options: { afterSeq?: number } = {}) => lines
      .filter((line) => line.seq > (options.afterSeq ?? 0))
      .map((line) => ({ seq: line.seq, authorKind: line.authorKind, kind: line.kind ?? 'text', authorId: line.authorKind === 'human' ? 'human' : 'ag_2', body: 'x' })),
  });
  return h;
}

function request(patch: Partial<RouteRequest> = {}): RouteRequest {
  return { agent: agent('ag_1'), mode: chat, conversationId: 'ch_1', ...patch };
}

test("Runde „Halb“ round 4: a turn nobody weighed runs at medium and says so – a person's line like any other wake", async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  const asked = await h.router.route(request());
  assert.equal(asked.effort, UNWEIGHED_EFFORT, asked.reason);
  assert.match(asked.reason, /not weighed · effort medium$/);
  assert.doesNotMatch(asked.reason, /person/);
  assert.equal(asked.effortBy, 'default');
  const read = await withChat([{ seq: 1, authorKind: 'human' }, { seq: 2, authorKind: 'agent' }], 1);
  const background = await read.router.route(request());
  assert.deepEqual([background.modelId, background.effort, background.reason], [asked.modelId, asked.effort, asked.reason], 'with or without a line of the person: the same route');
});

test("not a floor: a weighing of low or medium on a person's line runs as weighed; a fixed or requested effort holds", async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  const sub = { modelId: 'claude:claude-opus-5-5', explicit: true, asked: 'effort' as const, by: 'subconscious' as const, why: 'a receipt', category: 'chat' };
  for (const effort of ['low', 'medium'] as const) {
    const weighed = await h.router.route(request({ previous: { ...sub, effort }, boundary: false }));
    assert.equal(weighed.effort, effort, weighed.reason);
    assert.doesNotMatch(weighed.reason, /not weighed/);
    assert.match(weighed.reason, /my subconscious: a receipt/);
  }
  const fixed = await h.router.route(request({ agent: agent('ag_1', { modelPolicy: { effort: 'low' } }) }));
  assert.equal(fixed.effort, 'low', 'the fixed effort of the agent stays');
  const own = await h.router.route(request({ previous: { modelId: 'claude:claude-opus-5-5', effort: 'low', explicit: true, asked: 'effort' }, boundary: false }));
  assert.equal(own.effort, 'low', 'my own request stays');
});

test("medium on every model, whatever the model lists: a Work model, a cheap model in economy, the chip", async () => {
  const pinned = await withChat([{ seq: 1, authorKind: 'human' }]);
  pinned.settings.update({ routing: { work: 'claude:claude-haiku-5-5' } });
  const byUse = await pinned.router.route(request());
  assert.equal(pinned.catalog.get('claude:claude-haiku-5-5')!.defaultEffort, 'low', 'the test priors list low for Haiku');
  assert.deepEqual([byUse.modelId, byUse.by, byUse.effort], ['claude:claude-haiku-5-5', 'pin', 'medium']);
  // 13.11.2026: an effort the person suggests in the chat is information on their line – it never routes
  pinned.addChat('ch_2', ['ag_1'], { efforts: { ag_1: 'xhigh' } });
  assert.equal((await pinned.router.route(request({ conversationId: 'ch_2' }))).effort, 'medium');
  const economy = await withChat([{ seq: 1, authorKind: 'agent' }]);
  economy.settings.update({ routing: { costMode: 'economy' } });
  const cheap = await economy.router.route(request());
  assert.equal(economy.catalog.get(cheap.modelId)!.tier, 'small', 'the cheaper cost mode keeps its cheaper model');
  assert.equal(cheap.effort, 'medium');
});

test("in a live session the turn keeps its settled effort – a person's line lifts nothing", async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  const small = await h.router.route(request({ previous: { modelId: 'claude:claude-haiku-5-5', effort: 'low', category: 'chat' }, boundary: false }));
  assert.deepEqual([small.modelId, small.effort], ['claude:claude-haiku-5-5', 'low'], small.reason);
  assert.doesNotMatch(small.reason, /not weighed/, 'a settled effort is no fallback');
});

test("startEffortBy: nothing set – an agent's turn at medium and marked unweighed, a helper call at its category's default", () => {
  const policy = {} as Parameters<typeof startEffortBy>[0];
  assert.equal(UNWEIGHED_EFFORT, 'medium');
  assert.deepEqual(startEffortBy(policy, undefined, 'chat', false, true), { effort: 'medium', requested: false, by: 'default', unweighed: true });
  assert.equal(startEffortBy(policy, undefined, 'manager-planner', false, true).effort, 'medium', 'no category lift for an agent');
  assert.equal(startEffortBy(policy, undefined, 'cheap-chat', false, true).effort, 'medium', 'no category drop either');
  assert.deepEqual(startEffortBy(policy, undefined, 'cheap-chat', false), { effort: 'low', requested: false, by: 'default' }, 'a runtime helper call: its category default');
  assert.equal(startEffortBy(policy, { modelId: 'x', effort: 'low', explicit: true, asked: 'effort', by: 'subconscious' }, 'chat', true, true).effort, 'low', 'a weighing that arrived decides');
  assert.deepEqual(startEffortBy({ defaultEffort: 'xhigh' } as typeof policy, undefined, 'chat', false, true), { effort: 'xhigh', requested: false, by: 'default' }, "the person's global default comes first");
});

test('a runtime helper call keeps its category default', async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  const helper = await h.router.route(request({ agent: agent(SYSTEM_ID), mode: mode('cheap-chat'), conversationId: undefined }));
  assert.equal(helper.effort, 'low', helper.reason);
});

test('helpers: top tier', () => {
  const pool = [{ model: { tier: 'small' } }, { model: { tier: 'frontier' } }, { model: { tier: 'strong' } }, { model: { tier: 'frontier' } }] as Array<{ model: { tier: 'small' | 'strong' | 'frontier' } }>;
  assert.equal(topTier(pool as never[]).length, 2);
});

// B-078 (D16, live 06.11.2026: Fable and Astra ran at about 2.5x the cost of Opus): with the shipped priors the strongest tier's
// first choice on a Claude plan is Opus 5.5 – where an agent that leads runs; an agent that executes runs on Sonnet 5.5.
const SHIPPED = Priors.load(path.resolve(import.meta.dirname, '../../../resources/model-priors.json'));

async function claudePlan(work?: string) {
  const h = setup({ priors: SHIPPED });
  if (work) h.settings.update({ routing: { work } });
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('claude').lists.set('claude', ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ model, name: model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[] })));
  h.engine('codex').lists.set('codex', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map((model) => ({ model, name: model, efforts: ['low', 'medium', 'high', 'xhigh'] as Effort[] })));
  await h.catalog.refresh({ force: true });
  h.addChat('ch_1', ['ag_1']);
  Object.assign(h.services.chats, { messages: () => [{ seq: 1, authorKind: 'human', kind: 'text', authorId: 'human', body: 'x' }] });
  return h;
}

const lead = agent('ag_1', { template: 'manager' });

test('with the shipped priors on a Claude plan: leading starts on Opus 5.5 – not on Fable 5.1 or GPT-6 Astra –, executing on Sonnet 5.5', async () => {
  const h = await claudePlan('auto');
  const chatLine = await h.router.route(request({ agent: lead }));
  assert.equal(chatLine.modelId, 'claude:claude-opus-5-5', chatLine.reason);
  assert.match(chatLine.reason, /^leading runs on the frontier tier's first choice/);
  const writing = await h.router.route(request({ agent: lead, text: 'Schreib mir bitte einen LinkedIn-Post über unser neues Produkt, locker und menschlich.' }));
  assert.equal(writing.category === 'writing' || writing.category === 'social-media', true, writing.category);
  assert.equal(writing.modelId, 'claude:claude-opus-5-5', writing.reason);
  const essay = await h.router.route(request({ agent: lead, mode: mode('writing') }));
  assert.equal(essay.modelId, 'claude:claude-opus-5-5', essay.reason);
  const doer = await h.router.route(request());
  assert.equal(doer.modelId, 'claude:claude-sonnet-5-5', doer.reason);
  assert.match(doer.reason, /^executing runs on the strong tier's best value/);
});

test('an agent that leads and sits on Fable 5.1 or GPT-6.1 Sol stays there for the owner\'s next line – the model fits its kind', async () => {
  const h = await claudePlan('claude');
  // On the code before 17.11.2026 the owner's line moved such a chat to Opus 5.5 ("does this as well for less", "is stronger at").
  const fable = await h.router.route(request({ agent: lead, mode: mode('writing'), previous: { modelId: 'claude:claude-fable-5-1', effort: 'high', category: 'writing' } }));
  assert.equal(fable.modelId, 'claude:claude-fable-5-1', fable.reason);
  const sol = await h.router.route(request({ agent: lead, text: 'Bau mir bitte eine Landingpage mit Tailwind, frontend und user interface.', previous: { modelId: 'codex:gpt-6.1-sol', effort: 'medium', category: 'frontend-ui' } }));
  assert.equal(sol.category, 'frontend-ui', sol.reason);
  assert.deepEqual([sol.modelId, sol.effort], ['codex:gpt-6.1-sol', 'medium'], sol.reason); // its settled effort: the owner's line lifts nothing
});

test('personValue and firstChoice: 2 points smarter at 2.5x the price loses, 20 points smarter at 1.5x wins', () => {
  const opus = { model: { id: 'opus', tier: 'frontier', smarts: 94, relCost: 0.4, strengths: {} } } as never;
  const pricey = { model: { id: 'pricey', tier: 'frontier', smarts: 96, relCost: 1, strengths: {} } } as never;
  const smart = { model: { id: 'smart', tier: 'frontier', smarts: 114, relCost: 0.6, strengths: {} } } as never;
  assert.ok(personValue(opus) > personValue(pricey));
  assert.ok(personValue(smart) > personValue(opus));
  assert.equal(firstChoice([pricey, opus]), opus);
  assert.equal(firstChoice([pricey, opus, smart]), smart);
  assert.equal(firstChoice([]), undefined);
});
