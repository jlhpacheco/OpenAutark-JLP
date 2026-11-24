// 24.11.2026 (Konrad #390 "Der Fallback darf nicht still auf ein langsames Modell springen"): SYSTEM calls of "auto" that stop getting the
// helper default say so in the log – once per switch, with the reason, the model before and after and each plan's quota – and the
// fallback prefers a model the subconscious measured fast; with none known fast the subconscious runs beside the turns.
// Owns: these assertions only. Never: real engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, account, agent, mode, standardSetup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { HELPER_FAST_MS, helperAway, noteHelperTime } from '../../../src/runtime/routing/helper-default.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import type { RouteRequest, RuntimeServices } from '../../../src/runtime/contracts.ts';

const system = agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } });
const LUNA = 'codex:gpt-6-luna';
const HAIKU = 'claude:claude-haiku-5-5';
const helper = (text: string, patch: Partial<RouteRequest> = {}): RouteRequest => ({ agent: system, mode: mode('cheap-chat'), text, ...patch });
const weekly = (used: number) => ({ windows: [{ name: 'weekly', windowMinutes: 10080, usedPercent: used, resetsAt: T0 + 3_600_000 }], readAt: T0 });

type Setup = Awaited<ReturnType<typeof standardSetup>>;
interface Line { level: string; message: string; data?: Record<string, unknown> }

/** The setup with a log that keeps every line, and the Codex plan at `used` percent of its week. */
async function lane(used = 10, options: Parameters<typeof standardSetup>[0] = {}): Promise<{ h: Setup; lines: Line[]; use: (percent: number) => void }> {
  const h = await standardSetup(options);
  const lines: Line[] = [];
  const keep = (level: string) => (message: string, data?: Record<string, unknown>) => { lines.push({ level, message, data }); };
  (h.services as { log: unknown }).log = { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
  const use = (percent: number) => h.accounts.upsert(account('acc_codex', 'codex', { limits: weekly(percent) }), false);
  use(used);
  return { h, lines, use };
}
const helperLines = (lines: Line[]) => lines.filter((line) => /helper calls/.test(line.message));

test('"auto" leaving the helper default for a low Codex plan is logged once, with the reason, both models and each plan\'s quota', async () => {
  const { h, lines, use } = await lane(10);
  assert.equal((await h.router.route(helper('decision'))).modelId, LUNA);
  assert.deepEqual(helperLines(lines), [], 'on the default nothing is said');

  use(91); // the live case of 24.11.: the weekly window at 91 % used
  const fallback = await h.router.route(helper('decision'));
  assert.equal(fallback.modelId, HAIKU);
  assert.deepEqual(helperLines(lines), [{
    level: 'warn', message: 'helper calls left the helper default',
    data: {
      reason: 'codex plan headroom 9 % < 20 %', from: LUNA, to: HAIKU, quota: 'acc_codex 9 %',
      speed: 'not measured yet', subconscious: 'runs beside the turns (no model known fast)',
    },
  }]);
});

test('no log spam: many calls, failover routes and other purposes in the same state add no line; the way back is one line', async () => {
  const { h, lines, use } = await lane(10);
  await h.router.route(helper('decision'));
  use(95);
  for (let i = 0; i < 25; i++) await h.router.route(helper(i % 2 ? 'verify' : 'decision'));
  await h.router.route(helper('decision', { exclude: ['claude:claude-haiku-5-5'] })).catch(() => undefined); // a failover's route is no switch
  assert.equal(helperLines(lines).length, 1, 'one line for the whole stretch on the fallback');
  assert.equal(helperAway(h.services), HAIKU);

  use(30); // quota is enough again
  for (let i = 0; i < 5; i++) assert.equal((await h.router.route(helper('decision'))).modelId, LUNA);
  const all = helperLines(lines);
  assert.equal(all.length, 2, 'and one line on the way back');
  assert.deepEqual([all[1].level, all[1].message, all[1].data?.from, all[1].data?.to, all[1].data?.quota], ['info', 'helper calls are back on the helper default', HAIKU, LUNA, 'acc_codex 70 %']);
  assert.equal(helperAway(h.services), undefined);
  use(95); // a second stretch is a second transition
  await h.router.route(helper('decision'));
  assert.equal(helperLines(lines).length, 3);
  assert.equal(helperLines(lines)[2].data?.from, LUNA, 'the model before is the one the default ran on');
});

test('a Decisions model chosen in Settings and routes of agents write no line, whatever the quota', async () => {
  const { h, lines } = await lane(95);
  h.settings.update({ routing: { decision: HAIKU } });
  await h.router.route(helper('decision'));
  await h.router.route({ agent: agent('ag_1'), mode: mode('chat') });
  assert.deepEqual(helperLines(lines), []);
  assert.equal(helperAway(h.services), undefined);
});

test('no plan login at all: the reason says so', async () => {
  const { h, lines } = await lane(10);
  h.accounts.remove('acc_codex');
  await h.catalog.refresh({ force: true });
  await h.router.route(helper('decision'));
  assert.equal(helperLines(lines)[0].data?.reason, 'no Codex plan login connected');
  assert.equal(helperLines(lines)[0].data?.quota, 'no Codex plan login');
});

test('the fallback prefers a model the subconscious measured fast – on an account with quota left, never the low plan', async () => {
  const small = (match: string, name: string, cheap: number) => ({ match, name, tier: 'small', relCost: 0.03, caps: { tools: true, structuredOutput: true }, efforts: ['low', 'medium'], defaultEffort: 'low', strengths: { 'cheap-chat': cheap } });
  const priors = Priors.parse({ version: 'test', categories: {}, models: [small('claude-haiku-5-5*', 'Claude Haiku 5.5', 0.8), small('gpt-6-luna*', 'GPT-6 Luna', 0.8), small('swift*', 'Swift', 0.2),
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, strengths: { chat: 0.4 } }, { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, strengths: { chat: 0.4 } }] });
  const { h, lines } = await lane(91, { priors });
  h.engine('claude').lists.set('claude', [
    ...(await h.engine('claude').listModels(account('acc_claude', 'claude'))),
    { model: 'swift-1', name: 'Swift', efforts: ['low'], vision: false },
  ]);
  await h.catalog.refresh({ force: true });
  assert.equal((await h.router.route(helper('decision'))).modelId, HAIKU, 'by score, as before, while nobody is measured');
  noteHelperTime(h.services, HAIKU, 22_000);
  noteHelperTime(h.services, LUNA, 3_000); // fast, but on the plan that is kept for agent work
  assert.equal((await h.router.route(helper('decision'))).modelId, HAIKU, 'the low plan is not taken for being fast');
  noteHelperTime(h.services, 'claude:swift-1', 3_100);
  const decision = await h.router.route(helper('decision'));
  assert.equal(decision.modelId, 'claude:swift-1');
  assert.match(decision.reason, /measured fast \(median 3\.1 s\)/);
  assert.equal(decision.accountId, 'acc_claude');
  const last = helperLines(lines).at(-1)!;
  assert.deepEqual([last.data?.from, last.data?.to, last.data?.speed, last.data?.subconscious], [HAIKU, 'claude:swift-1', 'median 3.1 s', 'waits for it']);
  noteHelperTime(h.services, 'claude:swift-1', HELPER_FAST_MS); // not under the line any more
  assert.equal((await h.router.route(helper('decision'))).modelId, HAIKU);
});

