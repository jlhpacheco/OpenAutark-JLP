// End-to-end (RT10, the P14 scenario): automatic model routing over the real headless runtime
// (built app/runtime-cli.mjs) with real WebSocket RPC. The deterministic fake engine lists real
// model ids (WORKFORCE_FAKE_MODELS), so the catalog merges them with the shipped priors – real
// names, tiers, efforts and strengths – and every turn goes through the real router.
// Covers: a coding text runs on GPT-6.1 Sol; 17.11.2026 (the model settles) – a Remotion animation in the same chat, minutes
// later in the same live session, stays on GPT-6.1 Sol and the chat gets no line (the model moves where the context starts
// anew: test/unit/routing/settled-model.test.ts); the agent's own model.set {effort: max} holds for its next turn only with
// its quiet model_switched line, then its settled effort returns without one (RT2); routing.preview names what a chat's first
// turn runs on – the model the agent is on.
// Runde „Halb“ 21.11.2026: the fake engine's subconscious answer names no effort, so no turn here is weighed – a turn with no
// settled effort for its work runs at medium with "not weighed · effort medium" in its reason (routing/previous.ts
// UNWEIGHED_EFFORT), a person's line included; one on the same work keeps its settled effort.
// (Escalating stuck work to a stronger model went – Umbau Einfachheit.)
// The route without a person's line and at a boundary is pinned in test/unit/routing/p14-routing.test.ts.
// Run: npm run build && node --test test/e2e/runtime-routing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_EVENTS, runEndedAfter, startRuntime, waitForNew, waitModels } from './lib/runtime-client.mjs';

/** No fake-1: a strong-tier fake-1 would be the "stronger" model above Haiku. */
const MODELS = 'gpt-6.1-sol,claude-opus-5-5,claude-haiku-5-5';
const SOL = 'compatible:gpt-6.1-sol';
const OPUS = 'compatible:claude-opus-5-5';
const HAIKU = 'compatible:claude-haiku-5-5';
const CODING = 'Fix the TypeScript bug in the parser and add a unit test.';
const REMOTION = 'Now build a Remotion animation of the parser results with smooth keyframes.';
/** routing/router.ts ON_TEXT: the route reason of a turn that goes on where the agent is. */
const ON = 'continues on my model';
/** routing/previous.ts UNWEIGHED_TEXT: the route reason's part for a turn nobody weighed. */
const UNWEIGHED = 'not weighed · effort medium';

const isSwitch = (conversationId) => (message) => message.conversationId === conversationId && message.kind === 'status' && message.meta?.status?.type === 'model_switched';
/** The chat's model_switched lines so far. */
const switchLines = async (client, conversationId) => (await client.call('messages.list', { conversationId, limit: 100 })).filter(isSwitch(conversationId));

test('routing: the first model by kind and work, the model settles, model.set for one step, the preview', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime({ env: { WORKFORCE_FAKE_MODELS: MODELS } });
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const models = new Map((await waitModels(client, [SOL, OPUS, HAIKU])).map((model) => [model.id, model]));
  assert.equal(models.get(OPUS).name, 'Claude Opus 5.5', 'the catalog merged the listing with the shipped priors');
  assert.equal(models.get(HAIKU).tier, 'small');
  assert.ok(!models.has('compatible:fake-1'), 'only the listed models');

  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const vera = await client.call('agents.create', { name: 'Vera', managerId: manager.id, mode: 'general' });
  await client.call('events.subscribe', { topics: [`runs:${vera.id}`] });

  /** Sends a message as the person and resolves with Vera's turn on it once it ended. */
  const say = (conversationId, body) => runEndedAfter(client,
    (run) => run.agentId === vera.id && run.conversationId === conversationId && run.trigger === 'message',
    () => client.call('messages.send', { conversationId, body }));
  const chat = await client.call('chats.create', { title: 'Parser', agentIds: [vera.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });

  await t.test('a coding text runs on GPT-6.1 Sol', async () => {
    const run = await say(chat.id, CODING);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.model, SOL);
    assert.equal(run.effort, 'medium', "nobody weighed it: medium, a person's line included");
    assert.equal(run.route.category, 'coding');
    assert.equal(run.route.by, 'rules');
    // no strong tier is listed here, so executing runs on the strongest one (routing/kind.ts)
    assert.equal(run.route.reason, `executing runs on the frontier tier's first choice · coding · ${UNWEIGHED}`);
  });

  await t.test('a Remotion animation in the live session stays on GPT-6.1 Sol at medium; the chat gets no line', async () => {
    const run = await say(chat.id, REMOTION);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.model, SOL, 'the model the session is on: another one would write the whole context again');
    assert.equal(run.effort, 'medium', 'another kind of work, nobody weighed it: medium');
    assert.equal(run.route.category, 'video-animation');
    assert.equal(run.route.reason, `${ON} · video animation · ${UNWEIGHED}`);
    assert.deepEqual(await switchLines(client, chat.id), [], 'no switch, no line');
  });

  await t.test('model.set {effort: max} holds for the next turn only, then the previous effort returns', async () => {
    const reply = waitForNew(client, MESSAGE_EVENTS, (message) => message.conversationId === chat.id && message.authorId === vera.id
      && message.state === 'final' && message.body.includes('model.set → '), 90_000);
    reply.catch(() => undefined);
    const asking = await say(chat.id, 'The Remotion animation timing is tricky. [[tool:model.set {"effort":"max","reason":"tricky timing"}]]');
    assert.equal(asking.status, 'done', asking.error);
    assert.deepEqual([asking.model, asking.effort], [SOL, 'medium'], 'the asking turn itself keeps its route');
    assert.match((await reply).body, /"appliesTo":"next turn"/);

    // The requested turn runs at an effort I asked for: its quiet line (RT2); my settled effort after it leaves none.
    const liftedLine = waitForNew(client, 'message.created', isSwitch(chat.id), 90_000);
    liftedLine.catch(() => undefined);
    const lifted = await say(chat.id, 'Continue the Remotion animation.');
    assert.equal(lifted.status, 'done', lifted.error);
    assert.deepEqual([lifted.model, lifted.effort, lifted.route.by], [SOL, 'max', 'request']);
    const liftedStatus = await liftedLine;
    assert.equal(liftedStatus.authorId, vera.id, 'the agent\'s own quiet line');
    assert.equal(liftedStatus.silent, true);
    assert.equal(liftedStatus.body, 'Vera → GPT-6.1 Sol · max – effort requested by me'); // B-083: the agent's name
    assert.deepEqual(['from', 'to', 'effort', 'by'].map((key) => liftedStatus.meta.status.details[key]), [SOL, SOL, 'max', 'request']);

    const back = await say(chat.id, 'Polish the Remotion animation.');
    assert.equal(back.status, 'done', back.error);
    assert.deepEqual([back.model, back.effort], [SOL, 'medium'], 'back to my settled effort');
    assert.notEqual(back.route.by, 'request');
    assert.deepEqual((await switchLines(client, chat.id)).map((line) => line.id), [liftedStatus.id], 'the return leaves no line');
  });

  await t.test('routing.preview names the model, effort and work of a chat\'s first turn, and the turn runs on what it named', async () => {
    for (const [text, effort, work] of [[CODING, 'medium', 'coding'], [REMOTION, 'medium', 'video animation']]) {
      const fresh = await client.call('chats.create', { title: `Preview ${effort}`, agentIds: [vera.id] });
      await client.call('events.subscribe', { topics: [`chat:${fresh.id}`] });
      const preview = await client.call('routing.preview', { agentId: vera.id, conversationId: fresh.id, text });
      // One context per agent (13.11.2026): a new chat is no new start – the agent stays on the model its session is on
      // (17.11.2026), so the preview names that model with the work's effort, and the turn runs on what the preview named.
      assert.equal(preview.effort, effort);
      assert.equal(preview.modelId, SOL);
      const run = await say(fresh.id, text);
      assert.equal(run.status, 'done', run.error);
      // its work differs from the settled one each time: nobody weighed it, so medium, on the model the preview named
      assert.deepEqual(
        { modelId: run.model, effort: run.effort, category: run.route.category, reason: run.route.reason },
        { modelId: preview.modelId, effort, category: preview.category, reason: `${ON} · ${work} · ${UNWEIGHED}` },
      );
    }
  });
});
