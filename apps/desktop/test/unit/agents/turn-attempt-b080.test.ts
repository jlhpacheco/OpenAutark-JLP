// B-080 – one engine attempt (agents/turn-attempt.ts): a failed engine-native call's journaled result carries its
// summary and output as `preview`; a fresh native session the engine announces is bound at once with the turn's start
// cursor, so a turn that dies afterwards still leaves it bound; an in-turn model switch moves the turn's route, the run's
// books and the activity row (B-083: with the turn's temperature), ends my now-request and names the model of my first
// requests in the route's reason (FIXES-3 C1) and posts the quiet switch line with the agent's name;
// the plan's temperature reaches the engine, else (B-083) the person's suggestion on the route; a stall note names how long
// the engine was silent (quietMs), not only how long the attempt ran.
// Owns: these assertions only. Never: real engines.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { STALL_IDLE_MS } from '../../../src/runtime/agents/stall-watch.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { pendingRoute, setNextRoute } from '../../../src/runtime/agents/next-route.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { TurnPlan, TurnRoute } from '../../../src/runtime/agents/turn-types.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import { setup } from './fixture.ts';

const MINUTE = 60_000;

function journal(h: ReturnType<typeof setup>) {
  const items: Array<{ kind: string; data: Record<string, unknown> }> = [];
  Object.assign(h.services, { runs: {
    list: () => [], start: () => {}, finish: () => {}, updateItem: () => {},
    item: (_runId: string, item: { kind: string; data?: Record<string, unknown> }) => { items.push({ kind: item.kind, data: { ...(item.data ?? {}) } }); return { id: `ri_${items.length}` }; },
  } });
  return items;
}

const planOf = (h: ReturnType<typeof setup>, patch: Partial<TurnPlan> = {}) =>
  ({ agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, thread: 'main', memberCursor: 7, focus: '', ...patch }) as unknown as TurnPlan;

test('a failed engine-native call is journaled with its summary and output as preview', async () => {
  const h = setup();
  const items = journal(h);
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'c1', name: 'shell', args: { command: 'python x.py' }, own: true });
    input.onEvent({ type: 'tool_end', callId: 'c1', ok: false, summary: 'exit 1', output: 'Traceback (most recent call last):\nValueError: bad' });
    return { text: 'Failed.', stop: 'done' };
  };
  await runAttempt(h.services, planOf(h), h.routed(), h.request(), undefined);
  const result = items.find((item) => item.kind === 'tool_result')!;
  assert.equal(result.data.preview, 'exit 1\nTraceback (most recent call last):\nValueError: bad');
  assert.equal(result.data.summary, 'exit 1', 'the short line stays');
});

test('native tool results store marks for a catalog value and a shaped secret', async () => {
  const h = setup();
  const items = journal(h);
  const catalogFixture = 'synthetic-catalog-redaction-fixture';
  const stripeFixture = 'sk_live_' + 'SyntheticFixtureOnly123456';
  h.services.secrets.redact = (text) => text.replaceAll(catalogFixture, 'secret://fixture');
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'c1', name: 'shell', args: {}, own: true });
    input.onEvent({ type: 'tool_end', callId: 'c1', ok: false, summary: 'exit 1', output: catalogFixture + ' ' + stripeFixture });
    return { text: 'Failed.', stop: 'done' };
  };
  await runAttempt(h.services, planOf(h), h.routed(), h.request(), undefined);
  const result = items.find((item) => item.kind === 'tool_result')!;
  assert.equal(result.data.output, 'secret://fixture ‹secret:stripe-live›');
  assert.equal(result.data.preview, 'exit 1\nsecret://fixture ‹secret:stripe-live›');
});

test('native tool results suppress all raw fields when catalog masking fails', async () => {
  const h = setup();
  const items = journal(h);
  const fixture = 'synthetic-catalog-redaction-fixture';
  const redact = h.services.secrets.redact.bind(h.services.secrets);
  h.services.secrets.redact = (text) => {
    if (text.includes(fixture)) throw new Error('fixture redactor unavailable');
    return redact(text);
  };
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'c1', name: 'shell', args: {}, own: true });
    input.onEvent({ type: 'tool_end', callId: 'c1', ok: false, summary: fixture, output: fixture });
    return { text: 'Failed.', stop: 'done' };
  };
  await runAttempt(h.services, planOf(h), h.routed(), h.request(), undefined);
  const result = items.find((item) => item.kind === 'tool_result')!;
  assert.ok(result);
  for (const key of ['summary', 'preview', 'output']) {
    assert.equal(typeof result.data[key], 'string');
    assert.ok(!String(result.data[key]).includes(fixture), key + ': no unverified raw text');
  }
  assert.equal(result.data.ok, false);
});

test('a fresh session the engine announces is bound at once with the start cursor – also when the attempt dies after it', async () => {
  const h = setup({ sessions: true });
  journal(h);
  h.state.script = async (input) => {
    input.onEvent({ type: 'session', ref: 'thr_fresh', generation: 3 });
    throw new Error('killed mid-turn');
  };
  const attempt = await runAttempt(h.services, planOf(h), h.routed(), h.request(), undefined);
  assert.equal(attempt.result.stop, 'error');
  const bound = new SessionStore(h.services.db).get(h.tom.id, 'main', 'claude');
  assert.equal(bound?.ref, 'thr_fresh');
  assert.equal(bound?.generation, 3);
  assert.equal(bound?.cursorSeq, 7, "the turn's start cursor: its input is read again on resume");
  assert.equal(bound?.accountId, 'acc_claude');
  assert.equal(bound?.model, 'claude:claude-opus-5-5');
});

test('an engine without sessions binds nothing', async () => {
  const h = setup({ sessions: false });
  journal(h);
  h.state.script = async (input) => { input.onEvent({ type: 'session', ref: 'x', generation: 1 }); return { text: 'ok', stop: 'done' }; };
  await runAttempt(h.services, planOf(h), h.routed(), h.request(), undefined);
  assert.equal(new SessionStore(h.services.db).get(h.tom.id, 'main', 'claude'), undefined);
});

test('an in-turn model switch moves the route, the books and the activity row; the temperature reaches the engine', async () => {
  const h = setup();
  journal(h);
  Object.assign(h.services, { catalog: { get: () => undefined, list: () => [
    { id: 'claude:claude-sonnet-5', model: 'claude-sonnet-5', name: 'Claude Sonnet 5', engine: 'claude' },
    { id: 'codex:claude-sonnet-5', model: 'claude-sonnet-5', name: 'Not this one', engine: 'codex' },
  ] } });
  const routes: TurnRoute[] = [];
  let seen: EngineTurnInput | undefined;
  h.state.script = async (input) => {
    seen = input;
    input.onEvent({ type: 'model', model: 'claude-sonnet-5', effort: 'high' });
    return { text: 'Done.', stop: 'done' };
  };
  const turn = h.routed();
  setNextRoute(h.services.db, h.tom.id, { modelId: 'claude:claude-sonnet-5', now: true, temperature: 0.7, at: 1 }); // my model.set now
  await runAttempt(h.services, planOf(h, { temperature: 0.3 }), turn, h.request({ onRoute: (route) => routes.push(route) }), undefined);
  assert.equal(seen?.temperature, 0.3);
  // FIXES-3 C1: the engine ran a request on it – the request is used up (its temperature stays for my next turn), and the
  // route's reason names the model my first requests ran on
  assert.equal(pendingRoute(h.services.db, h.tom.id, undefined, () => false)?.modelId, undefined);
  assert.equal(pendingRoute(h.services.db, h.tom.id, undefined, () => false)?.temperature, 0.7);
  assert.equal(turn.route.reason, `${h.route.reason} · first requests on Claude Opus 5.5`);
  assert.equal(turn.route.modelId, 'claude:claude-sonnet-5');
  assert.equal(turn.route.effort, 'high');
  assert.equal(turn.model, 'claude-sonnet-5');
  assert.equal(turn.modelName, 'Claude Sonnet 5');
  assert.equal(h.route.modelId, 'claude:claude-opus-5-5', "the router's decision object stays as it was");
  assert.deepEqual(routes, [{ model: 'claude:claude-sonnet-5', modelName: 'Claude Sonnet 5', effort: 'high', engine: 'claude', accountId: turn.account.id, temperature: 0.3, temperatureSent: false }], 'on the same account');
  // B-083: the switch inside the turn is a quiet line of the run, with the agent's name (Claude Code keeps its own temperature: stance)
  const [line] = h.chats.messages(h.chat.id).filter((message) => message.meta.status?.type === 'model_switched');
  assert.equal(line?.body, 'Tom → Claude Sonnet 5 · high · temperature 0.3 (stance) – requested by me');
  assert.equal(line?.meta.fromRun, 'run_1');
  assert.deepEqual(line?.meta.status?.details, { from: 'claude:claude-opus-5-5', to: 'claude:claude-sonnet-5', effort: 'high', inTurn: true });
});

test('B-083: without a request of mine the person\'s suggested temperature (on the route) reaches the engine; an unchanged model posts no line', async () => {
  const h = setup();
  journal(h);
  Object.assign(h.services, { catalog: { get: () => undefined, list: () => [] } });
  let seen: EngineTurnInput | undefined;
  h.state.script = async (input) => {
    seen = input;
    input.onEvent({ type: 'model', model: 'claude-opus-5-5', effort: 'medium' }); // the same model and effort: nothing to say
    return { text: 'Done.', stop: 'done' };
  };
  const turn = { ...h.routed(), route: { ...h.route, temperature: 0.2 } };
  await runAttempt(h.services, planOf(h), turn, h.request(), undefined);
  assert.equal(seen?.temperature, 0.2);
  assert.equal(h.chats.messages(h.chat.id).filter((message) => message.meta.status?.type === 'model_switched').length, 0);
  await runAttempt(h.services, planOf(h, { temperature: 0.6 }), turn, h.request({ runId: 'run_2' }), undefined);
  assert.equal(seen?.temperature, 0.6, 'my own request wins');
});

test('a stalled attempt journals how long the engine was silent (quietMs), beside how long the attempt ran (afterMs)', async () => {
  const h = setup();
  const items = journal(h);
  let engineInput!: EngineTurnInput;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  h.state.script = (input) => new Promise((resolve) => {
    engineInput = input;
    started();
    input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted' }), { once: true });
  });
  const pass = (ms: number) => { h.clock.advance(ms); mock.timers.tick(ms); };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const attempt = runAttempt(h.services, planOf(h), h.routed(), h.request(), undefined);
    await running;
    pass(3 * MINUTE);
    engineInput.onEvent({ type: 'status', note: 'still working' }); // the last sign of the engine
    pass(7 * MINUTE);
    pass(3 * MINUTE); // 10 min of silence: the cut
    const result = await attempt;
    assert.equal(result.result.error?.details?.stalled, true);
    const note = items.find((item) => item.kind === 'note' && item.data.stalled)?.data.stalled;
    assert.deepEqual(note, { engine: 'claude', quietMs: STALL_IDLE_MS, afterMs: 13 * MINUTE });
  } finally { mock.timers.reset(); }
});
