// RT4 – model knowledge for agents: models.list through the models harness (real catalog, priors,
// accounts and router): video animation lists Opus above Sol and shows Sol's negative fit; a
// ceiling 'strong' agent sees no frontier models; models without a usable account are hidden unless asked for; output stays within
// 30 lines / 2,500 characters; agents.update checks a pin against the catalog (bare ids and names
// resolve, a model several providers list pins its plan copy before an API key, unknown models and
// specialists fail and point to models.list); models.list is a core tool offered in
// the video mode; the rules name the model need (model.set need, routing picks) as another route
// where model.set is offered (B-047 D6: no Models how-to; B-048 E8); decisions and embeddings answer with what runs
// them now and only the models made for them (B-072); B-083: the footer names my start model as where I start, then
// how model.set changes it (13.11.2026: the person's suggestion in a chat stands on their line); a model whose engine sends a temperature carries that tag.
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { T0, account, agent, mode, setup, standardSetup } from '../models/harness.ts';
import { modelTools } from '../../../src/runtime/tools/builtin/models.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import { MODEL_PROPERTY } from '../../../src/runtime/tools/types.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { MAX_CHARS, MAX_MODELS, modelList } from '../../../src/runtime/routing/model-list.ts';
import { effortRange, signed, sourceOf, specialistKinds } from '../../../src/runtime/routing/model-facts.ts';
import { parseMode } from '../../../src/runtime/modes/service.ts';
import { fixture, route, RESOURCES, VIDEO_MODE } from '../context/fixture.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Effort, ModelInfo } from '../../../src/shared/model/providers.ts';

const OPUS = 'claude:claude-opus-5-5';
const SOL = 'codex:gpt-6.1-sol';
const MODES: Record<string, ModeInfo> = {
  general: mode('chat', { key: 'general' }),
  video: mode('video-animation', { key: 'video', minTier: 'strong' }),
  manager: mode('manager-planner', { key: 'manager' }),
};
const listTool = modelTools.find((tool) => tool.name === 'models.list')!;
const updateTool = agentTools.find((tool) => tool.name === 'agents.update')!;

const textOf = (out: ToolOutput) => out.content.map((part) => ('text' in part ? part.text : '')).join('\n');
const lineOf = (text: string, id: string) => text.split('\n').find((line) => line.startsWith(`- ${id} `)) ?? '';

function withModes(services: RuntimeServices): RuntimeServices {
  Object.assign(services, { modes: { get: (key: string) => { if (!MODES[key]) throw new Error(`unknown mode ${key}`); return MODES[key]; }, list: () => Object.values(MODES) } });
  return services;
}

function ctxFor(services: RuntimeServices, who: Agent, modeKey: string): ToolContext {
  return { agent: who, runId: 'run_rt4', mode: modeKey, services, signal: new AbortController().signal, status: () => {} };
}

async function list(services: RuntimeServices, who: Agent, modeKey: string, args: Record<string, unknown> = {}): Promise<string> {
  const out = await listTool.run(args, ctxFor(withModes(services), who, modeKey));
  assert.equal(out.isError, undefined);
  return textOf(out);
}

test('video animation: Opus is listed above Sol, Sol shows its negative fit; facts per line', async () => {
  const h = await standardSetup();
  const text = await list(h.services, agent('ag_ada'), 'general', { category: 'video-animation' });
  const opus = text.indexOf(`- ${OPUS} `);
  const sol = text.indexOf(`- ${SOL} `);
  assert.ok(opus >= 0 && sol > opus, `Opus above Sol:\n${text}`);
  assert.match(lineOf(text, SOL), /fit -0\.70/);
  assert.equal(lineOf(text, OPUS), `- ${OPUS} (Claude Opus 5.5) · frontier · plan · low–max · fit +0.90`); // TEST_PRIORS carry no prices or smarts
  assert.match(text, /^Models I can use for video animation, best first/);
  assert.match(text, /model\.set/);
  assert.ok(!text.includes('AA '), 'no AA data without AA rows');

  // The video mode's own work: its minimum tier (strong) drops the small models, lines add strong/weak kinds.
  const own = await list(h.services, agent('ag_vic', { mode: 'video' }), 'video');
  assert.match(own, /^Models I can use for video animation \(my mode's kind of work/);
  assert.ok(own.indexOf(`- ${OPUS} `) < own.indexOf(`- ${SOL} `));
  assert.ok(!own.includes('claude-haiku-5-5') && !own.includes('gpt-6-luna'), 'below the mode tier');
  assert.match(lineOf(own, SOL), /fit -0\.70 · strong: coding \+0\.80, research \+0\.80, chat \+0\.40$/);
  assert.match(lineOf(own, OPUS), /strong: coding \+0\.70, chat \+0\.40 · weak: cheap chat -0\.60/);
});

test('a ceiling-strong agent sees no frontier models', async () => {
  const h = await standardSetup();
  const capped = agent('ag_cap', { modelPolicy: { ceilingTier: 'strong' } });
  const text = await list(h.services, capped, 'general', { category: 'chat' });
  assert.ok(!text.includes(OPUS) && !text.includes(SOL), `no frontier model:\n${text}`);
  assert.match(text, /spans local to strong models/);
  assert.equal(lineOf(text, 'codex:gpt-6-luna'), '- codex:gpt-6-luna (GPT-6 Luna) · small · plan · none–high · fit +0.40');
  const free = await list(h.services, agent('ag_free'), 'general', { category: 'chat' });
  assert.ok(free.includes(OPUS) && free.includes(SOL));
});

test('B-083 footer: my start model is where a fresh context of mine runs; model.set names another from the next one on', async () => {
  const h = await standardSetup();
  const pinned = agent('ag_pin', { modelPolicy: { pin: SOL } });
  const own = modelList({ services: h.services, agent: pinned, mode: MODES.general, category: 'chat' });
  assert.match(own, /\nMy start model is GPT-6\.1 Sol; I run on it from my next context\.\nI ask for one with model\.set \(.*\): it runs from my next context, or at once with now: true, and stays my start model until I, my lead or the person names another.$/);
  assert.doesNotMatch(own, /cannot change it/);
});

test('B-083 (audit fix 3): a start model that cannot run says until when, and what my turns start on until then', async () => {
  const h = await standardSetup();
  h.accounts.updateLimits('acc_codex', { windows: [{ name: 'weekly', windowMinutes: 10080, usedPercent: 100, resetsAt: T0 + 3 * 86_400_000 }], readAt: T0 });
  const pinned = agent('ag_pin', { modelPolicy: { pin: SOL, pinBy: { name: 'Stanislaus', at: T0 } } });
  const text = modelList({ services: h.services, agent: pinned, mode: MODES.general, category: 'chat', includeUnavailable: true });
  assert.match(text, /\nMy start model is GPT-6\.1 Sol \(Stanislaus set it\); it cannot run now \(limited until 20 Oct 09:00\) – until then my turns start on a model from the strongest tier that runs at most at its price\.\n/);
  assert.match(lineOf(text, SOL), / · limited until 20 Oct 09:00 · my start model$/);
  assert.match(lineOf(text, 'codex:gpt-6-luna'), / · limited until 20 Oct 09:00$/);
  // A model the person must sign in again for: no time known.
  h.accounts.upsert(account('acc_codex', 'codex', { state: 'needs_login' }), false);
  assert.match(modelList({ services: h.services, agent: pinned, mode: MODES.general, category: 'chat' }), /it cannot run now \(limited right now\) – /);
});

test('B-083 (owner 09.11.): no Claude on the plan carries the temperature tag – Claude Code keeps its thinking; nor Opus 5.5 or Codex', async () => {
  const h = await standardSetup();
  h.engine('claude').lists.set('claude', [
    { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', vision: true },
    { model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'], vision: true },
  ]);
  await h.catalog.refresh({ force: true });
  const text = modelList({ services: h.services, agent: agent('ag_ada'), mode: MODES.general, category: 'chat' });
  assert.doesNotMatch(lineOf(text, 'claude:claude-sonnet-4-6'), /temperature/);
  assert.doesNotMatch(lineOf(text, OPUS), /temperature/);
  assert.doesNotMatch(lineOf(text, SOL), /temperature/);
});

test('the mode\'s minimum tier is a preference as in routing: with none at or above it connected, the list shows what the router runs', async () => {
  const h = await standardSetup();
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6-luna', name: 'gpt-6-luna', efforts: ['none', 'low', 'medium', 'high'], vision: false }]);
  h.engine('claude').lists.set('claude', [{ model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'], vision: true }]);
  await h.catalog.refresh({ force: true });
  const vic = agent('ag_vic', { mode: 'video' });
  const text = await list(h.services, vic, 'video');
  const routed = await h.router.route({ agent: vic, mode: MODES.video });
  assert.ok(lineOf(text, routed.modelId), `the model the router runs (${routed.modelId}) is listed:\n${text}`);
  assert.ok(lineOf(text, 'claude:claude-haiku-5-5') && lineOf(text, 'codex:gpt-6-luna'), text);
  assert.doesNotMatch(text, /No model I can use fits/);
});

test('models without a usable account are hidden unless includeUnavailable asks for them', async () => {
  const h = await standardSetup();
  h.accounts.upsert(account('acc_claude', 'claude', { state: 'needs_login' }), false);
  await h.catalog.refresh({ force: true });
  assert.equal(h.catalog.get(OPUS)?.available, false);
  const vic = agent('ag_vic', { mode: 'video' });
  const text = await list(h.services, vic, 'video');
  assert.ok(!text.includes(`- ${OPUS} `));
  assert.match(text, /1 more cannot run right now \(includeUnavailable: true lists it with the reason\)/);
  const all = await list(h.services, vic, 'video', { includeUnavailable: true });
  assert.match(lineOf(all, OPUS), /· no usable account$/);
  assert.ok(all.indexOf(`- ${SOL} `) < all.indexOf(`- ${OPUS} `), 'usable models first');
});

test('a big catalog stays within 30 lines and 2,500 characters', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('codex').lists.set('codex', [
    { model: 'gpt-solo', name: 'gpt-solo', efforts: ['low', 'medium', 'high'] },
    ...Array.from({ length: 44 }, (_, i) => ({ model: `gpt-test-${String(i).padStart(2, '0')}-preview-long-name`, name: `Test model number ${i} with a long display name`, efforts: ['low', 'high'] as Effort[] })),
  ]);
  await h.catalog.refresh({ force: true });
  const text = modelList({ services: h.services, agent: agent('ag_ada'), mode: MODES.general });
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(text.length <= MAX_CHARS, `${text.length} chars`);
  assert.ok(lines.length > 5 && lines.length <= MAX_MODELS, `${lines.length} lines`);
  assert.match(text, new RegExp(`… ${45 - lines.length} more not shown \\(category narrows it\\)\\.`));
  assert.equal(lineOf(text, 'codex:gpt-solo'), '- codex:gpt-solo · strong · plan · low–high · fit +0.00', 'a name equal to the id is not repeated; unknown models are neutral');
});

test('decisions and embeddings: what answers them now, then only the models made for them – no chat model by fit', async () => {
  const h = await standardSetup();
  const ada = agent('ag_ada');
  const embeddings = await list(h.services, ada, 'general', { category: 'embeddings' });
  assert.match(embeddings, /^Now: Decisions: GPT-6 Luna on acc_codex \(a chat model; no decision model connected\) · Search by meaning: /);
  assert.match(embeddings, /\nEmbedding models connected: none/);
  const decision = await list(h.services, ada, 'general', { category: 'decision' });
  assert.match(decision, /\nDecision models connected: none/);
  for (const text of [embeddings, decision]) {
    for (const id of [SOL, OPUS, 'codex:gpt-6-luna', 'claude:claude-haiku-5-5']) assert.ok(!text.includes(`- ${id}`), `${id} is a chat model:\n${text}`);
    assert.doesNotMatch(text, /fit [+-]/);
  }

  h.engine('compatible').lists.set('ollama', [{ model: 'nimble:latest', name: 'nimble:latest', efforts: [] }, { model: 'bge-m3', name: 'bge-m3', efforts: [] }]);
  h.accounts.upsert(account('acc_ollama', 'ollama', { baseUrl: 'http://127.0.0.1:11434' }), false);
  await h.catalog.refresh({ force: true });
  const local = await list(h.services, ada, 'general', { category: 'embeddings' });
  assert.match(local, /Search by meaning: off/, 'connected is not chosen: finding goes by words until routing.embeddings names it');
  assert.match(local, /\n- ollama:bge-m3 · local$/m);
  h.settings.update({ routing: { embeddings: 'ollama:bge-m3' } });
  assert.match(await list(h.services, ada, 'general', { category: 'embeddings' }), /Search by meaning: bge-m3 on acc_ollama/);
  assert.ok(!local.includes('nimble'), 'a decision model is no embedding model');
  const typed = await list(h.services, ada, 'general', { category: 'decision' });
  assert.match(typed, /\n- ollama:nimble:latest[ (].*· local$/m);
  assert.ok(!typed.includes('- ollama:bge-m3'));
  assert.match(typed, /^Now: Decisions: GPT-6 Luna on acc_codex \(a chat model; no decision model chosen\)/, 'one is connected, the chat model still answers');
  h.settings.update({ routing: { decision: 'ollama:nimble:latest' } });
  assert.match(await list(h.services, ada, 'general', { category: 'decision' }), /^Now: Decisions: nimble \(decision\) on acc_ollama \(a decision model\)/);
});

test('agents.update checks the pin against the catalog and stores its catalog id', async () => {
  const h = await standardSetup();
  const boss = agent('ag_boss', { mode: 'manager' });
  const report = agent('ag_rep', { managerId: 'ag_boss' });
  h.agents.set(boss.id, boss);
  h.agents.set(report.id, report);
  Object.assign(h.services.org, { canManage: () => true, spaces: () => [] });
  const update = async (args: Record<string, unknown>, who = boss) => updateTool.run(args, ctxFor(withModes(h.services), who, who.mode));

  const bad = await update({ agentId: report.id, model: 'claude-opus-9' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Unknown model "claude-opus-9"\. models\.list shows the models I can pin/);
  assert.equal(h.agents.get(report.id)!.modelPolicy.pin, undefined, 'nothing stored');
  assert.equal((await update({ agentId: report.id, model: 'openai:claude-opus-5-5' })).isError, true, 'a provider-qualified id never moves provider');

  const bare = await update({ agentId: report.id, model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(bare.isError, undefined, textOf(bare));
  assert.deepEqual(h.agents.get(report.id)!.modelPolicy, { pin: OPUS, effort: 'high', pinBy: { name: 'ag_boss', at: T0 } }, 'B-083: who set it');
  assert.equal((bare.structured as { model?: string }).model, OPUS);
  assert.equal((await update({ agentId: report.id, model: 'GPT-6.1 Sol' })).isError, undefined);
  assert.equal(h.agents.get(report.id)!.modelPolicy.pin, SOL, 'a display name resolves');
  assert.equal((await update({ agentId: report.id, model: '' })).isError, undefined);
  assert.equal(h.agents.get(report.id)!.modelPolicy.pin, undefined, "'' = automatic routing");
  assert.equal((await update({ model: OPUS }, report)).isError, undefined, 'an agent may pin its own model');

  // A model without a usable account is pinned with a note; a specialist cannot run an agent.
  h.accounts.upsert(account('acc_claude', 'claude', { state: 'needs_login' }), false);
  await h.catalog.refresh({ force: true });
  const later = await update({ agentId: report.id, model: OPUS });
  assert.match((later.structured as { note?: string }).note ?? '', /no usable account right now/);
  const tts: ModelInfo = { id: 'openai:gpt-6-luna-tts', provider: 'openai', model: 'gpt-6-luna-tts', name: 'Luna TTS', engine: 'openai', efforts: [], caps: {}, tier: 'small', strengths: { chat: -1, tts: 0 }, available: true, accounts: ['acc_oa'], functions: ['tts'] };
  assert.deepEqual(specialistKinds(tts), ['tts']);
  assert.equal(specialistKinds(h.catalog.get(SOL)!), undefined);
  const real = h.services.catalog;
  h.services.catalog = { ...real, list: () => [...real.list(), tts], get: (id: string) => (id === tts.id ? tts : real.get(id)), refresh: async () => {} } as typeof real;
  const special = await update({ agentId: report.id, model: tts.id });
  assert.match(textOf(special), /Luna TTS is a specialist model \(tts\) and cannot run an agent\. models\.list/);
});

test('agents.update pins the plan copy of a model several providers list, not the API key', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_anth', 'anthropic'), false);
  h.accounts.upsert(account('acc_oa', 'openai'), false);
  const opus = [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] as Effort[], vision: true }];
  for (const engine of ['claude', 'anthropic', 'openai'] as const) h.engine(engine).lists.set(engine, opus);
  await h.catalog.refresh({ force: true });
  assert.deepEqual(h.catalog.list().filter((model) => model.model === 'claude-opus-5-5').map((model) => model.id), ['anthropic:claude-opus-5-5', OPUS, 'openai:claude-opus-5-5'], 'the API-key copy comes first in catalog order');
  const boss = agent('ag_boss', { mode: 'manager' });
  const report = agent('ag_rep', { managerId: 'ag_boss' });
  h.agents.set(boss.id, boss);
  h.agents.set(report.id, report);
  Object.assign(h.services.org, { canManage: () => true, spaces: () => [] });
  const update = async (args: Record<string, unknown>) => updateTool.run(args, ctxFor(withModes(h.services), boss, boss.mode));
  const pinned = () => h.agents.get(report.id)!.modelPolicy.pin;

  for (const pin of ['claude-opus-5-5', 'Claude Opus 5.5']) {
    const out = await update({ agentId: report.id, model: pin });
    assert.equal(out.isError, undefined, textOf(out));
    assert.equal(pinned(), OPUS, `${pin} pins the plan copy`);
    assert.equal((out.structured as { note?: string }).note,
      `Several models match "${pin}": pinned ${OPUS} (plan); also anthropic:claude-opus-5-5 (API key), openai:claude-opus-5-5 (API key). Pass one of those ids to pin it instead.`);
  }
  const decision = await h.router.route({ agent: h.agents.get(report.id)!, mode: MODES.general, text: 'hello there' });
  assert.equal(decision.modelId, OPUS);
  assert.equal(decision.accountId, 'acc_claude', 'the pinned report runs on the plan');

  const explicit = await update({ agentId: report.id, model: 'anthropic:claude-opus-5-5' });
  assert.equal(pinned(), 'anthropic:claude-opus-5-5', 'an exact id pins that copy');
  assert.equal((explicit.structured as { note?: string }).note, undefined);

  // Without a usable plan account the available API-key copy wins over the unavailable plan copy.
  h.accounts.upsert(account('acc_claude', 'claude', { state: 'needs_login' }), false);
  await h.catalog.refresh({ force: true });
  const fallback = await update({ agentId: report.id, model: 'Claude Opus 5.5' });
  assert.equal(pinned(), 'anthropic:claude-opus-5-5');
  const note = (fallback.structured as { note?: string }).note ?? '';
  assert.match(note, /pinned anthropic:claude-opus-5-5 \(API key\); also openai:claude-opus-5-5 \(API key\), claude:claude-opus-5-5 \(plan\)\./);
  assert.doesNotMatch(note, /no usable account/);
});

test('B-083 agents.update: a changed pin names who set it (self on my own), an unchanged one keeps its origin, a cleared one has none', async () => {
  const h = await standardSetup();
  const person = { name: 'Stanislaus', at: T0 - 1 };
  const boss = agent('ag_boss', { name: 'Konrad', mode: 'manager' });
  h.agents.set(boss.id, boss);
  h.agents.set('ag_rep', agent('ag_rep', { name: 'Lena', modelPolicy: { pin: SOL, pinBy: person } }));
  Object.assign(h.services.org, { canManage: () => true, spaces: () => [] });
  const update = async (args: Record<string, unknown>, who = boss) => updateTool.run(args, ctxFor(withModes(h.services), who, who.mode));
  const policy = () => h.agents.get('ag_rep')!.modelPolicy;
  await update({ agentId: 'ag_rep', model: SOL, effort: 'high' });
  assert.deepEqual(policy().pinBy, person, 'the same pin again keeps the person\'s origin');
  await update({ agentId: 'ag_rep', effort: 'auto' });
  assert.deepEqual(policy().pinBy, person, 'no pin argument keeps it');
  await update({ model: OPUS }, h.agents.get('ag_rep')!);
  assert.deepEqual(policy().pinBy, { name: 'Lena', at: T0, self: true }, 'my own pin');
  assert.match(modelList({ services: h.services, agent: h.agents.get('ag_rep')!, mode: MODES.general, category: 'chat' }), /\nMy start model is Claude Opus 5\.5 \(I set it myself\); I run on it from my next context./);
  await update({ agentId: 'ag_rep', model: SOL });
  assert.deepEqual(policy().pinBy, { name: 'Konrad', at: T0 }, 'a manager\'s pin names the manager');
  await update({ agentId: 'ag_rep', model: 'auto' });
  assert.equal(policy().pin, undefined);
  assert.equal(policy().pinBy, undefined, 'a cleared pin has no origin');
});

test('models.list is a core read tool, offered in the video mode; small text helpers', () => {
  assert.equal(listTool.category, 'read');
  const registry = new Registry({ services: () => ({}) as RuntimeServices });
  const dir = path.join(RESOURCES, 'modes');
  const modes = readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))
    .map((name) => parseMode(name.replace(/\.md$/, ''), readFileSync(path.join(dir, name), 'utf8')));
  const worker = agent('ag_worker', { createdAt: T0 });
  for (const key of ['video']) {
    const found = modes.find((entry) => entry.key === key);
    assert.ok(found, `mode ${key} exists`);
    assert.ok(registry.allowed(listTool, worker, found), `offered in ${key}`);
  }
  assert.equal(effortRange(['low', 'medium', 'high', 'xhigh', 'max']), 'low–max');
  assert.equal(effortRange(['none', 'high']), 'none, high');
  assert.equal(effortRange([]), undefined);
  assert.deepEqual([signed(0.9), signed(-0.7), signed(0), signed(-0.001)], ['+0.90', '-0.70', '+0.00', '+0.00']);
  // Where a model runs: a key from the environment (PR5) and a CLI signed in with an API key are pay-per-use.
  const gpt = { id: 'openai:gpt-6.1', provider: 'openai', model: 'gpt-6.1' } as ModelInfo;
  const where = (patch: Record<string, unknown>) => sourceOf(gpt, { ...account('acc_where', 'openai'), ...patch } as never);
  assert.deepEqual([where({ auth: 'env', envVar: 'OPENAI_API_KEY' }), where({ auth: 'api_key' }), where({ auth: 'cli', plan: 'api' }), where({ auth: 'cli', plan: 'plus' }), where({ auth: 'local' }), where({ auth: 'none' })],
    ['API key', 'API key', 'API key', 'plan', 'local', 'endpoint']);
});

test('B-047 D6 / B-048 E8: How I work names another model as another way in every mode; no Models how-to section', () => {
  // The compact rules replaced the old "## Models" procedure; models.list / model.set explain themselves in their tool descriptions.
  const f = fixture();
  const { stable } = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() });
  assert.doesNotMatch(stable, /## Models\n|stronger model/);
  Object.assign(f.services, { tools: { get: () => undefined, specsFor: () => [{ name: 'model.set', description: '', inputSchema: {} }] } });
  const offered = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() }).stable;
  // 14.11.: How I work stands in each agent's SYSTEM.md, starting from the standard – the same text for every mode.
  const standard = readFileSync(path.join(RESOURCES, 'prompts', 'standard-agent.md'), 'utf8');
  assert.ok(standard.includes('I take another – tool, source, mode, colleague or model – and fix the broken path'), 'a model is another way; how to pick one is the Routing CORE');
  // 17.11.2026 (contract 3): the model settles where a context starts, the subconscious sets only the effort; How I work keeps one line.
  assert.ok(standard.includes('\n- My model is settled for my kind of work'), 'the model line says the model is settled');
  assert.doesNotMatch(offered, /## Models\n/);
});

test('17.11.2026 review: the four texts that name a model say one thing – a model is named where a context starts, settles, stands until someone names another, and without one the kind settles it', () => {
  const set = modelTools.find((tool) => tool.name === 'model.set')!;
  const update = agentTools.find((tool) => tool.name === 'agents.update')!;
  const create = agentOrgTools.find((tool) => tool.name === 'agents.create')!;
  const prop = (tool: typeof set, name: string) => String((tool.inputSchema.properties as Record<string, { description?: string }>)[name]?.description ?? '');
  assert.match(set.description, /the model I settle on\. Another model rereads my whole context, so it runs from my next context/);
  assert.match(set.description, /it stays my model until I, my lead or the person names another, and auto gives it back to my kind of work\.$/);
  assert.doesNotMatch(set.description, /effort moves freely/, 'on our API engines another effort writes the cache again: the cost is the subconscious\'s line');
  assert.match(prop(update, 'model'), /^The model it settles on – the smallest that does the hardest step of its work as well as the strongest would; it runs there from its next context .* and stays on it until it, its lead or the person names another\./);
  assert.match(create.description, /without a model its kind settles one: an agent that leads runs on the frontier tier, one that executes on the strong tier/);
  assert.equal(MODEL_PROPERTY.description, 'An id from models.list: the smallest model that does the hardest step of this work as well as the strongest would.');
  assert.equal(prop(create, 'model'), MODEL_PROPERTY.description);
});
