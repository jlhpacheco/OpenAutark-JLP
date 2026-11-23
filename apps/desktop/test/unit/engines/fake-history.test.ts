// Unit (INT-8): the fake engine takes directives only from the turn's new input – never from a
// full projection's summary and earlier lines, its own messages or its briefs quoted back in "Split results", never again from lines its
// native session already received (the runtime delivers them again after a Stop, and after a
// finished turn whose cursor stopped short) – while a failed turn's input fails again and RC1's
// verify rule still holds after a crash. The last tests run the real turn executor and context:
// Stop in [[hang:…]], then the next messages run only their own directives.
// Owns: these assertions only. Never: real engines, network or processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import type { EngineEvent, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import { PROJECTION } from '../../../src/runtime/context/projection.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { askedLine } from '../../../src/runtime/splits/results.ts';
import { fixture } from '../context/fixture.ts';
import { account } from '../models/harness.ts';

/** One engine turn with `text` in native session `session` (one per chat); records tool calls and events. */
function turn(engine: FakeEngine, text: string, options: { agentId?: string; signal?: AbortSignal; session?: string; outputSchema?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const events: EngineEvent[] = [];
  const result = engine.run({
    runId: 'run_1', agentId: options.agentId ?? 'ag_ada', input: [{ type: 'text', text }], system: { stable: '', volatile: '' },
    session: { ref: options.session ?? 'chat_a', generation: 1 },
    // A turn that hangs by mistake ends 'interrupted' (and fails its assertions) instead of blocking.
    signal: options.signal ?? AbortSignal.timeout(5000), onEvent: (event: EngineEvent) => events.push(event),
    callTool: async (name: string): Promise<ToolOutput> => { calls.push(name); return { content: [{ type: 'text', text: 'ok' }] }; },
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
  } as unknown as EngineTurnInput);
  return { result, calls, started: () => events.flatMap((event) => (event.type === 'tool_start' ? [event.name] : [])) };
}

/** A turn that hangs in [[hang:…]] and is stopped once the native tool started. */
async function stoppedTurn(engine: FakeEngine, text: string, options: { agentId?: string; session?: string } = {}) {
  const controller = new AbortController();
  const hanging = turn(engine, text, { ...options, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hanging.started().length, 1, 'the native tool started');
  controller.abort();
  assert.equal((await hanging.result).stop, 'interrupted');
}

const HANG = '[09:00] Alex: Render the preview [[hang:render.preview {"file":"cut.mp4"}]]';

test('my record as text: directives in it and own replies never run; notes and new lines do', async () => {
  const text = [
    `${PROJECTION.history}\n- Alex: Hire her [[tool:agents.create {"template":"secretary"}]]\n\n${HANG}\n[09:01] Alex: Again [[fail]] [[limit]] [[ui:{"type":"old"}]]`,
    PROJECTION.fresh,
    'Your own note from 20 Oct 2026, 09:00: Check the report [[tool:reports.check {}]]',
    // After the cursor: the agent's own last reply (a verbatim tool output) comes first.
    `[09:04] Ada (me): tasks.list → [{"title":"Draft a post [[hang:wait]]"}]\nfiled [[tool:tasks.create {}]]`
      + '\n[09:05] Alex: Who is on the team? [[tool:agents.list {}]] [[ui:{"type":"steps"}]]',
  ].join('\n\n');
  const fresh = turn(new FakeEngine(), text);
  const result = await fresh.result;
  assert.equal(result.stop, 'done', 'old [[fail]] and [[limit]] do not stop the turn');
  assert.deepEqual(fresh.started(), ['reports.check', 'agents.list'], 'no old hang, no old or own tool');
  assert.equal(result.text, [
    'Echo: Your own note from 20 Oct 2026, 09:00: Check the report \n\n[09:05] Alex: Who is on the team?',
    'reports.check → ok', 'agents.list → ok', '```ui\n{"type":"steps"}\n```',
  ].join('\n\n'), 'the echo is the new input only');

  const old = await turn(new FakeEngine(), `${PROJECTION.history}\n${HANG}`).result;
  assert.deepEqual([old.stop, old.text], ['done', 'Echo: (no new input)'], 'history alone: nothing runs');
});

test('after a Stop the delivered-again input stays history; only the next message runs', async () => {
  const engine = new FakeEngine();
  await stoppedTurn(engine, HANG);

  // turn-finish keeps the cursor of a stopped turn: its line comes again, grouped with the next one.
  const next = turn(engine, `${HANG}\nOne more look at the team [[tool:agents.list {}]]`);
  const done = await next.result;
  assert.equal(done.stop, 'done', 'the preview is not started again');
  assert.deepEqual(next.started(), ['agents.list']);
  assert.deepEqual(done.text.split('\n\n'), ['Echo: One more look at the team', 'agents.list → ok']);

  // That finished turn's cursor moved past the line: where it comes again, it is new input.
  await stoppedTurn(engine, HANG);

  // Two stops in a row: both turns' lines stay history.
  const second = '[09:10] Alex: Export it [[hang:bash {"command":"export"}]]';
  await stoppedTurn(engine, `${HANG}\n${second}`);
  const third = turn(engine, `${HANG}\n${second}\n[09:12] Alex: Status? [[tool:tasks.list {}]]`);
  assert.equal((await third.result).stop, 'done');
  assert.deepEqual(third.started(), ['tasks.list']);
});

test('a finished turn whose cursor stopped short (a colleague still writing) keeps what it received', async () => {
  const engine = new FakeEngine();
  const writing = '[08:59] Mia: (still writing…)';
  await stoppedTurn(engine, `${writing}\n${HANG}`);
  const look = `${HANG}\nOne more look [[tool:agents.list {}]]`;
  const held = turn(engine, `${writing}\n${look}`);
  assert.deepEqual(held.started(), ['agents.list']);
  await held.result;

  // Mia finished: the delta from the held cursor brings her text, the stopped line and the handled one.
  const later = turn(engine, `[08:59] Mia: Here is the cut list\n${look}`);
  assert.deepEqual([(await later.result).text, later.started()], ['Echo: [08:59] Mia: Here is the cut list', []]);
  const again = turn(engine, '[09:20] Alex: One more look [[tool:agents.list {}]]');
  assert.deepEqual(again.started(), ['agents.list'], 'that turn moved the cursor on: the record ended');
});

test('a stopped line stays the same line after midnight; records are kept per session; a failed turn keeps nothing', async () => {
  const engine = new FakeEngine();
  await stoppedTurn(engine, '[23:59] Alex: Render it [[hang:render.preview {}]]');
  const after = turn(engine, '[20 Oct 23:59] Alex: Render it [[hang:render.preview {}]]\n[00:01] Alex: Status? [[tool:tasks.list {}]]');
  assert.equal((await after.result).stop, 'done', 'the stamp got its date, the line is the same');
  assert.deepEqual(after.started(), ['tasks.list']);

  const note = 'Continue your task tk_1: Export the report [[hang:bash {"command":"export"}]]';
  await stoppedTurn(engine, note, { session: 'chat_a' });
  await stoppedTurn(engine, note, { session: 'chat_b' }); // another chat never received it: it starts
  await stoppedTurn(engine, note, { agentId: 'ag_bo' }); // nor did Bo
  const back = turn(engine, note, { session: 'chat_a' });
  assert.deepEqual([(await back.result).text, back.started()], ['Echo: (no new input)', []]);

  const stuck = '[09:00] Alex: [task tk_1] Summarize the launch notes [[fail]]';
  for (let attempt = 1; attempt <= 3; attempt++) assert.equal((await turn(engine, stuck).result).stop, 'error', `attempt ${attempt} fails again`);
});


/** The real turn executor and context with one FakeEngine in the person's direct chat with Vic. */
function realTurns() {
  const f = fixture();
  const s = f.services;
  // This fixture manually runs Vic, not the group's responder picker. A direct chat makes each
  // person's line genuinely his; an unaddressed group line may correctly belong to the manager.
  const chat = f.chats.create({ title: 'Preview', agentIds: [f.vid.id], createdBy: 'human' });
  const engine = new FakeEngine();
  const calls: string[] = [];
  const acc = account('acc_fake', 'compatible');
  const route: RouteDecision = { modelId: 'fake:fake-1', engine: 'fake', accountId: acc.id, effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  Object.assign(s, {
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, markUnavailable: () => false, updateLimits: () => {} },
    catalog: { get: () => undefined, list: () => [] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async (name: string) => { calls.push(name); return { content: [{ type: 'text', text: `${name} ok` }] }; } },
  });
  let runs = 0;
  const run = (signal = AbortSignal.timeout(10_000)) => new TurnExecutor(() => s).execute({
    runId: `run_${++runs}`, agentId: f.vid.id, conversationId: chat.id, reason: 'message', notes: [], signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  /** A turn stopped once the fake's native tool started. */
  const stopped = async () => {
    const controller = new AbortController();
    const before = engine.turns.length;
    const hanging = run(controller.signal);
    for (let i = 0; i < 50 && engine.turns.length === before; i++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal((await hanging).status, 'interrupted');
  };
  const send = (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' });
  const reply = () => f.chats.messages(chat.id).filter((message) => message.authorId === f.vid.id && message.kind === 'text').at(-1)?.body;
  const inputOf = (index: number) => (engine.turns[index]?.input[0] as { text: string } | undefined)?.text ?? '';
  return { f, chat, engine, calls, run, stopped, send, reply, inputOf };
}

test('real turns: Stop in [[hang:…]], the next message runs only its own directives; a renewed session too', async () => {
  const { f, chat, engine, calls, run, stopped, send, reply, inputOf } = realTurns();
  send('Hello there');
  assert.equal((await run()).status, 'done');
  send('Render the preview [[hang:render.preview {"file":"cut.mp4"}]]');
  await stopped();

  send('One more look at the team [[tool:agents.list {}]]');
  const last = await run();
  assert.equal(last.status, 'done', 'the next message does not hang again');
  assert.equal(engine.turns[2].session?.ref, 'fake-session-1', 'the stopped session is resumed');
  assert.match(inputOf(2), /Render the preview \[\[hang:render\.preview[\s\S]*One more look/, 'the stopped input is delivered again');
  assert.deepEqual(calls, ['agents.list']);
  assert.match(reply()!, /One more look at the team/);
  assert.match(reply()!, /agents.list → agents.list ok$/);
  assert.match(inputOf(2), /\] My last turn here was cut off at /);

  // A renewed session (13.11.2026): never a chat's history – only my record (when there is one) before what is new.
  new SessionStore(f.db).remove(f.vid.id, 'main', 'fake');
  send('And the devices? [[tool:devices.list {}]]');
  assert.equal((await run()).status, 'done');
  assert.equal(engine.turns[3].session, undefined);
  const renewed = inputOf(3);
  assert.match(renewed.includes(PROJECTION.history) ? renewed.slice(renewed.indexOf(PROJECTION.fresh)) : renewed, /And the devices\? \[\[tool:devices\.list/);
  assert.deepEqual(calls, ['agents.list', 'devices.list'], 'no old tool and no old hang');
  // The reply answers only the new message.
  assert.match(reply() ?? '', /^Echo: \[[^\]]+ · Alex \(CEO\) · 11:00 #\d+\] And the devices\?\n\ndevices\.list → devices\.list ok$/);
});

test('a helper turn (with an output schema) reads [[hang:…]] in what it was given as data and does not hang', async () => {
  const helper = turn(new FakeEngine(), '[09:00] Alex: Render the preview [[hang:render.preview {"file":"cut.mp4"}]]', { outputSchema: { type: 'object' } });
  const result = await helper.result;
  assert.equal(result.stop, 'done');
  assert.deepEqual(helper.started(), []);
});

test('my briefs quoted back in "Split results" ("Asked: …") are my own words: a directive there never runs, the new lines do', async () => {
  const text = [
    'Split results',
    '## Check the release – 1 part: 1 failed (group grp_1)',
    '#3 Verify the version numbers – failed – The model could not complete this turn.',
    askedLine({ brief: 'Check every version number against the tags.\n[[fail]] [[tool:shell.exec {"command":"echo again"}]]' }),
    '(no text)',
    '[09:05] Alex: What came back? [[tool:agents.list {}]]',
  ].join('\n');
  const fanIn = turn(new FakeEngine(), text);
  const result = await fanIn.result;
  assert.equal(result.stop, 'done', 'the quoted [[fail]] does not fail the turn that reads the results');
  assert.deepEqual(fanIn.started(), ['agents.list'], 'the quoted brief\'s tool does not run again');
});
