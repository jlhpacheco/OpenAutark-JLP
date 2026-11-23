// B-080 (live 08.11.2026, a starved PC: Codex took 2.4–9.5 min to abort a turn, and every request on that thread queued
// behind it): a request Codex queues behind the thread's running turn waits as long as the turn lives – turn/start, an agent
// turn's thread open and the subconscious's inject have no timer; the turn's signal (a Stop, the stall watch, a helper call's
// limit) ends the wait, and a turn Codex starts after that is interrupted at once, so none runs with nobody listening (a thread
// a late thread/start opened leaves again). The open and the inject hold the app-server against its idle shutdown; a connection
// that closes while turn/start or the open waits is our own engine process (details.local): one failover, no account cools.
// Owns: these assertions only. Never: a real Codex (scripted app-server over fakes.ts, mock timers).

import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { RpcClient } from '../../../src/runtime/engines/codex/rpc.ts';
import { recordAccountFailure } from '../../../src/runtime/accounts/failure.ts';
import { runWithNativeTimeouts } from '../../../src/runtime/agents/native-timeout.ts';
import { canFailover, runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { STALL_IDLE_MS } from '../../../src/runtime/agents/stall-watch.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import { FakeChild, account, fakeFinder, fakeSpawn, testSupervisor, tick, turnInput } from './fakes.ts';
import { setup } from '../agents/fixture.ts';
import { openedBefore } from './managed-fixture.ts';

afterEach(() => mock.timers.reset());

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await tick();
}

/** A scripted app-server; `hold` keeps the answers of those methods until `answer` (optionally with the turn id to start). */
function appServer(options: { hold?: string[]; onTurn?: (child: FakeChild, msg: any, turnId: string) => void; startError?: { code: number; message: string } } = {}) {
  const requests: any[] = [];
  const held: any[] = [];
  let child!: FakeChild;
  let turns = 0;
  const reply = (msg: any, turnId?: string) => {
    if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
    else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
    else if (msg.method === 'thread/resume') child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
    else if (msg.method === 'thread/inject_items') child.send({ id: msg.id, result: {} });
    else if (msg.method === 'turn/start' && options.startError) child.send({ id: msg.id, error: options.startError });
    else if (msg.method === 'turn/start') {
      const id = turnId ?? `turn_${++turns}`;
      child.send({ id: msg.id, result: { turn: { id, status: 'inProgress' } } });
      options.onTurn?.(child, msg, id);
    } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
  };
  const { spawn } = fakeSpawn(({ child: c }) => {
    child = c;
    c.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (options.hold?.includes(msg.method)) held.push(msg);
      else reply(msg);
    };
  });
  return {
    spawn, child: () => child,
    sent: (method: string) => requests.filter((r) => r.method === method),
    held: (method: string) => held.filter((r) => r.method === method),
    answer: (method: string, turnId?: string) => { const msg = held.find((r) => r.method === method); held.splice(held.indexOf(msg), 1); reply(msg, turnId); },
  };
}

const engine = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', realpath: async (dir) => dir });
const answered = (text: string) => (child: FakeChild, msg: any, turnId: string) => {
  const params = { threadId: msg.params.threadId, turnId };
  child.send({ method: 'item/agentMessage/delta', params: { ...params, itemId: `m_${turnId}`, delta: text } });
  child.send({ method: 'item/completed', params: { ...params, item: { id: `m_${turnId}`, type: 'agentMessage', phase: 'final_answer', text } } });
  child.send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
};

/** What recordAccountFailure does to the account: [failure, cooled]. */
function recorded(result: EngineTurnResult): [string | undefined, boolean] {
  let cooled = false;
  const accounts = { get: () => undefined, markLimited: () => { cooled = true; }, markUnavailable: () => { cooled = true; return true; } };
  return [recordAccountFailure({ accounts: accounts as never, clock: { now: () => 0 } as never }, account(), 'gpt-test', result), cooled];
}

test('rpc: timeoutMs 0 sets no timer – the request waits for the answer; close() still rejects it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const rpc = new RpcClient(new FakeChild() as never);
  let settled = false;
  const pending = rpc.request('turn/start', {}, 0).finally(() => { settled = true; });
  mock.timers.tick(24 * 3_600_000);
  await tick();
  assert.equal(settled, false, 'a day later it still waits');
  const limited = rpc.request('model/list', {}, 1000);
  mock.timers.tick(1000);
  await assert.rejects(limited, /codex did not answer model\/list/, 'a request with a limit still times out');
  rpc.close(new Error('codex connection closed (exit)'));
  await assert.rejects(pending, /connection closed/);
});

test('a turn/start Codex answers 5 min late runs: done with its text, never "could not start"', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer({ hold: ['turn/start'], onTurn: answered('Late but done.') });
  const e = engine(fake.spawn);
  const running = e.run(turnInput().input);
  await until(() => fake.held('turn/start').length > 0);
  mock.timers.tick(5 * 60_000);
  await tick();
  fake.answer('turn/start');
  const result = await running;
  assert.deepEqual([result.stop, result.text], ['done', 'Late but done.']);
  mock.timers.reset();
  await e.dispose();
});

test('the signal ends a pending turn/start: interrupted; the turn Codex starts afterwards is interrupted at once and reaches nobody', async () => {
  const fake = appServer({ hold: ['turn/start'], onTurn: answered('Nobody hears this.') });
  const e = engine(fake.spawn);
  const controller = new AbortController();
  const { input, events } = turnInput({ signal: controller.signal });
  const running = e.run(input);
  await until(() => fake.held('turn/start').length > 0);
  controller.abort();
  const result = await running;
  assert.deepEqual([result.stop, result.error?.code], ['interrupted', 'cancelled']);
  const seen = events.length;
  fake.answer('turn/start', 'turn_x');
  await until(() => fake.sent('turn/interrupt').length > 0);
  assert.deepEqual(fake.sent('turn/interrupt').map((r) => r.params), [{ threadId: 'thr_1', turnId: 'turn_x' }]);
  await tick();
  assert.equal(events.length, seen, 'none of turn_x\'s notifications reach the ended turn');
  await e.dispose();
});

test('an interrupt Codex does not confirm in 10 s, then the native-timeout continuation: it waits for Codex and ends done', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer({
    hold: ['turn/interrupt', 'thread/inject_items'],
    onTurn: (child, msg, turnId) => {
      if (turnId === 'turn_1') child.send({ method: 'item/started', params: { threadId: msg.params.threadId, turnId, item: { id: 'c1', type: 'commandExecution', command: 'npm install', cwd: '/work' } } });
      else answered('Continued.')(child, msg, turnId);
    },
  });
  const e = engine(fake.spawn);
  const { input, events } = turnInput();
  const ctx = { signal: input.signal, services: { secrets: { redact: (text: string) => text } } } as unknown as ToolContext;
  const running = runWithNativeTimeouts(e, input, ctx, { initial: () => 1, review: async () => ({ action: 'abort', reason: 'No progress' }) });
  await until(() => events.some((event: any) => event.type === 'tool_start'));
  mock.timers.tick(1000); // the call's deadline: the review stops it
  await until(() => fake.sent('turn/interrupt').length > 0);
  mock.timers.tick(10_000); // Codex never confirms: the turn counts as ended
  await until(() => fake.held('thread/inject_items').length > 0);
  mock.timers.tick(5 * 60_000); // minutes later Codex has aborted the old turn
  fake.child().send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'interrupted' } } });
  fake.answer('thread/inject_items');
  const result = await running;
  assert.deepEqual([result.stop, result.text], ['done', 'Continued.']);
  assert.ok(events.some((event: any) => event.type === 'text' && event.delta === 'Continued.'), 'the continuation\'s events reach the turn');
  const second = fake.sent('turn/start')[1].params.input.map((part: any) => part.text ?? '').join('\n');
  assert.doesNotMatch(second, /<tool_call/, 'the decision went in as the real call, not also as text');
  mock.timers.reset();
  await e.dispose();
});

test('the subconscious\'s inject answered after 11 min lands once: the app-server is held past its idle shutdown, nothing goes as text', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer({ hold: ['thread/inject_items'], onTurn: answered('Done.') });
  const e = engine(fake.spawn);
  openedBefore(e, 'thr_9'); // 0.3.19: a thread resumes only with provenance – this runtime opened it before
  const trace = { calls: [{ tool: 'subconscious', args: {}, output: 'The search found the invoice.' }] };
  const running = e.run(turnInput({ session: { ref: 'thr_9', generation: 1 }, trace }).input);
  await until(() => fake.held('thread/inject_items').length > 0);
  mock.timers.tick(11 * 60_000); // past the app-server's 10-min idle shutdown (server.ts)
  await tick();
  assert.equal(fake.child().exitCode, null, 'the waiting inject keeps the app-server up');
  fake.answer('thread/inject_items');
  const result = await running;
  assert.equal(result.stop, 'done');
  assert.equal(result.traceAsText, undefined);
  assert.doesNotMatch(JSON.stringify(fake.sent('turn/start')[0].params.input), /found the invoice/);
  mock.timers.reset();
  await e.dispose();
});

test('the connection closing while turn/start or the open waits is our own engine process: local, one failover, no cooling', async () => {
  for (const [method, message] of [['turn/start', 'The Codex connection on this PC closed before the turn started.'], ['thread/start', 'Codex could not open the session.']]) {
    const fake = appServer({ hold: [method] });
    const e = engine(fake.spawn);
    const running = e.run(turnInput().input);
    await until(() => fake.held(method).length > 0);
    fake.child().exit(1);
    const result = await running;
    await e.dispose();
    assert.deepEqual([result.error?.code, result.error?.message, result.error?.details?.local], ['unavailable', message, true], method);
    assert.deepEqual(recorded(result), ['overload', false], method);
    assert.equal(canFailover({ result, streamed: '', reasoning: '', toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, ms: 1 }, new AbortController().signal), true);
  }
});

test('a refusal Codex sends for turn/start (any code, -32000 too) is Codex\'s own answer: "could not start", the account cools as before', async () => {
  for (const code of [-32000, -32600]) {
    const refused = appServer({ startError: { code, message: 'invalid input' } });
    const e = engine(refused.spawn);
    const other = await e.run(turnInput().input);
    await e.dispose();
    assert.deepEqual([other.error?.message, other.error?.details], ['Codex could not start this turn.', undefined], String(code));
    assert.deepEqual(recorded(other), ['overload', true], String(code));
  }
});

test('the signal ends a pending agent thread/start: the thread Codex opens afterwards leaves the app-server again', async () => {
  const fake = appServer({ hold: ['thread/start'] });
  const e = engine(fake.spawn);
  const controller = new AbortController();
  const { input, events } = turnInput({ signal: controller.signal });
  const running = e.run(input);
  await until(() => fake.held('thread/start').length > 0);
  controller.abort();
  assert.equal((await running).stop, 'interrupted');
  fake.answer('thread/start');
  await until(() => fake.sent('thread/unsubscribe').length > 0);
  assert.deepEqual(fake.sent('thread/unsubscribe').map((r) => r.params), [{ threadId: 'thr_1' }]);
  assert.equal(events.some((event: any) => event.type === 'session'), false, 'the late thread is bound to nothing');
  assert.equal(fake.sent('turn/start').length, 0);
  await e.dispose();
});

test('through runAttempt (providerOutage runs): a slow Codex open or start is cut by the stall watch and pauses no account', async () => {
  for (const slow of ['thread/start', 'turn/start']) {
    const h = setup();
    const fake = appServer({ hold: [slow] });
    const codex = engine(fake.spawn);
    const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, thread: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
    const turn = { ...h.routed(), engine: codex, account: account(), model: 'gpt-test', route: { ...h.route, engine: 'codex' as const, accountId: 'acc_test' } };
    mock.timers.enable({ apis: ['setTimeout'] });
    const attempt = runAttempt(h.services, plan, turn, h.request(), undefined);
    await until(() => fake.held(slow).length > 0);
    h.clock.advance(STALL_IDLE_MS);
    mock.timers.tick(STALL_IDLE_MS);
    const done = await attempt;
    mock.timers.reset();
    assert.equal(done.result.error?.details?.stalled, true, slow);
    assert.deepEqual(recorded(done.result), ['overload', false], `${slow}: the Codex account stays usable`);
    assert.equal(canFailover(done, new AbortController().signal), true);
    await codex.dispose();
  }
});
