// B-044 model choice in routing: the one cost preference (Best | Balanced | Cheaper) as the agent's
// "Model preference" line and in models.list; the work plan's score bonus (agents only, while the plan
// has quota, never a pin) – the Work use naming a plan, by default Claude Code while its plan login is on; plain
// conversation routed like any agent turn (the interim small-model chat default is gone, and the return
// rule never continues from a run it routed); the chat hint's Now line and model.set note (the soft
// guide is gone); the weak task lean; B-083: the models.list footer names the start model in my voice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, account, agent, mode, standardSetup } from '../models/harness.ts';
import { workPlanOf } from '../../../src/runtime/routing/preference.ts';
import { effectiveWorkPlan } from '../../../src/shared/model/model-guide.ts';
import { returnChoice } from '../../../src/runtime/agents/next-route.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { WORK_PLAN_BONUS, workPlanBonus } from '../../../src/runtime/routing/score.ts';
import { modelList } from '../../../src/runtime/routing/model-list.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';

const LUNA = 'codex:gpt-6-luna';
const SOL = 'codex:gpt-6.1-sol';
const OPUS = 'claude:claude-opus-5-5';
const HAIKU = 'claude:claude-haiku-5-5';
const system = agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } });
const chat = (patch: Partial<RouteRequest> = {}): RouteRequest => ({ agent: agent('ag_1'), mode: mode('chat'), ...patch });
const low = (left: number) => ({ windows: [{ name: '5h', windowMinutes: 300, usedPercent: 100 - left, resetsAt: T0 + 3_600_000 }], readAt: T0 });


test('work plan: a bonus for the preferred plan while it has quota – agents only, never a pin', async () => {
  assert.equal(workPlanBonus(account('acc_claude', 'claude'), 'claude', T0), WORK_PLAN_BONUS);
  assert.equal(workPlanBonus(account('acc_codex', 'codex'), 'claude', T0), 0);
  assert.equal(workPlanBonus(account('acc_api', 'claude', { plan: 'api' }), 'claude', T0), 0, 'an API-key login pays per use: no plan');
  assert.equal(workPlanBonus(account('acc_claude', 'claude', { limits: low(10) }), 'claude', T0), 0, 'too little quota left');
  assert.equal(workPlanBonus(account('acc_claude', 'claude'), undefined, T0), 0);

  const h = await standardSetup(); // the harness's Work use names a plan it has no login of: no plan preferred
  const coding = (patch: Partial<RouteRequest> = {}) => h.router.route(chat({ mode: mode('coding'), ...patch }));
  assert.equal((await coding()).modelId, SOL, 'no plan preferred: the rules pick Sol for coding');
  h.settings.update({ routing: { work: 'claude' } });
  const preferred = await coding();
  assert.deepEqual([preferred.modelId, preferred.by], [OPUS, 'rules']);
  assert.equal((await coding({ previous: { modelId: SOL, effort: 'medium', explicit: true } })).modelId, SOL, 'the agent may still ask for another model');
  assert.equal((await h.router.route({ agent: system, mode: mode('cheap-chat'), text: 'decision' })).modelId, LUNA, 'helper calls stay on the Luna helper');
  h.settings.update({ routing: { work: 'auto' } });
  assert.equal((await coding()).modelId, OPUS, 'auto: the enabled Claude Code plan login is preferred, exactly as if "claude" were chosen');
  h.accounts.upsert(account('acc_claude', 'claude', { limits: low(15) }), false);
  assert.equal((await coding()).modelId, SOL, 'a nearly used-up plan is not preferred');
  h.settings.update({ routing: { work: 'kimi-cli' } });
  assert.equal((await coding()).modelId, SOL, 'a work plan without a usable login changes nothing');
});

test('the work plan rule: a plan named by the Work use wins, a model pins (no plan), auto = Claude Code while an enabled Claude Code plan login exists', async () => {
  const claude = account('acc_claude', 'claude');
  assert.deepEqual(effectiveWorkPlan(undefined, [claude]), { plan: 'claude', byDefault: true });
  assert.deepEqual(effectiveWorkPlan(undefined, [{ ...claude, enabled: false }]), { byDefault: false }, 'a disabled login');
  assert.deepEqual(effectiveWorkPlan(undefined, [{ ...claude, plan: 'api' }]), { byDefault: false }, 'Claude Code signed in with an API key pays per use');
  assert.deepEqual(effectiveWorkPlan(undefined, [account('acc_codex', 'codex')]), { byDefault: false });
  assert.deepEqual(effectiveWorkPlan('auto', [claude]), { plan: 'claude', byDefault: true });
  assert.deepEqual(effectiveWorkPlan(SOL, [claude]), { byDefault: false }, 'a chosen model pins; no plan preference');
  assert.deepEqual(effectiveWorkPlan('codex', [claude]), { plan: 'codex', byDefault: false });
  const h = await standardSetup();
  h.settings.update({ routing: { work: 'auto' } });
  assert.equal(workPlanOf(h.services), 'claude');
  h.settings.update({ routing: { work: SOL } });
  assert.equal(workPlanOf(h.services), undefined);
});

test('plain conversation is routed like any agent turn: no small-model default, a Work model chosen in Settings pins', async () => {
  const h = await standardSetup();
  for (const work of ['gemini-cli', 'auto']) {
    h.settings.update({ routing: { work } });
    const plain = await h.router.route(chat());
    assert.equal(plain.by, 'rules', `work ${work}`);
    assert.doesNotMatch(plain.reason, /small model for conversation/);
    assert.notEqual(plain.modelId, LUNA, 'Balanced: Luna is for helper calls and compaction');
  }
  h.settings.update({ routing: { work: HAIKU } });
  const settingsChat = await h.router.route(chat());
  assert.deepEqual([settingsChat.modelId, settingsChat.reason], [HAIKU, 'the Work model in Settings · chat · not weighed · effort medium']);
  h.settings.update({ routing: { work: LUNA } });
  assert.deepEqual([(await h.router.route(chat())).modelId, (await h.router.route(chat())).by], [LUNA, 'pin'], 'the person may choose Luna for work');
});

test('17.11.2026: a turn starts from the model I am on – my session\'s, else my newest done run\'s, whatever shaped it – with my settled effort there', () => {
  const run = (id: string, model: string, effort: string, by = 'rules', effortBy?: string) => ({ id, agentId: 'ag_1', conversationId: 'ch_1', model, effort, status: 'done', route: { reason: 'chat', by, category: 'chat', ...(effortBy ? { effortBy } : {}) } }) as unknown as Run;
  const older = run('run_1', SOL, 'high');
  const receipt = run('run_2', LUNA, 'low', 'request', 'request');
  // The return rule of before 17.11.2026 skipped a run a request shaped and went back to Sol, several runs old (36 switches measured).
  assert.deepEqual(returnChoice([receipt, older], undefined), { modelId: LUNA }, 'the model I am on; its low was one message\'s, so no effort is carried');
  assert.deepEqual(returnChoice([receipt, older], undefined, { on: SOL }), { modelId: SOL, effort: 'high', category: 'chat' }, 'the session\'s model over my newest run\'s');
  const asked = run('run_3', SOL, 'max', 'request', 'request');
  assert.deepEqual(returnChoice([asked, older], undefined), { modelId: SOL, effort: 'high', category: 'chat' }, 'an effort set for one turn does not carry over: my settled one returns');
  assert.deepEqual(returnChoice([run('run_4', SOL, 'xhigh', 'request', 'previous'), older], undefined)?.effort, 'xhigh', 'a requested model at its own effort is settled');
  assert.equal(returnChoice([run('run_5', SOL, 'max', 'request'), older], undefined)?.effort, 'high', 'a run of before B-089: by its route');
  assert.equal(returnChoice([], undefined), undefined);
});



test('B-083 models.list: the start model is where I begin, with who set it (13.11.2026: a chat suggestion is no start model)', async () => {
  const h = await standardSetup();
  const own = agent('ag_1', { modelPolicy: { pin: SOL, pinBy: { name: 'Stanislaus', at: T0 } } });
  const mine = modelList({ services: h.services, agent: own, mode: mode('chat'), category: 'chat' });
  assert.match(mine, /\nMy start model is GPT-6\.1 Sol \(Stanislaus set it\); I run on it from my next context.\n/);
  assert.match(mine, /^- codex:gpt-6\.1-sol .* · my start model$/m);
  assert.doesNotMatch(mine, /pinned|cannot change/);
  assert.match(mine, /\nI ask for one with model\.set/);
  assert.doesNotMatch(mine, /suggested/);
});
