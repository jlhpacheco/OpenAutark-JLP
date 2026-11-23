// B-085 – AUTARK_AGENT names the agent whose process it is, so its `wf` writes as that agent: engines/wf-shim.ts
// (asAgent, withShim, agentEnv: an inherited value is dropped, a given one set), a Codex thread's shells
// (isolation.ts threadIsolation via engine.ts settings – start and resume), a Claude agent turn's CLI (not a helper
// turn's), and shell.exec (tools/builtin/command.ts: the calling agent, never a linked PC's).
// Owns: these assertions only. Never: real CLIs or the person's env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { agentEnv, asAgent, withShim } from '../../../src/runtime/engines/wf-shim.ts';
import { threadIsolation } from '../../../src/runtime/engines/codex/isolation.ts';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { runCommand } from '../../../src/runtime/tools/builtin/command.ts';
import { AGENT_ENV } from '../../../src/shared/api/protocol.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup } from './claude-fixture.ts';
import { agentIdentity } from '../../../src/runtime/security/agent-proof.ts';

test('asAgent, withShim and agentEnv drop an inherited AUTARK_AGENT and set the given one', () => {
  assert.equal(AGENT_ENV, 'AUTARK_AGENT');
  const inherited = { PATH: '/bin', AUTARK_AGENT: 'ag_parent' };
  assert.equal(asAgent(inherited, undefined, 'linux').AUTARK_AGENT, undefined);
  assert.equal(asAgent(inherited, 'ag_1', 'linux').AUTARK_AGENT, 'ag_1');
  assert.equal(inherited.AUTARK_AGENT, 'ag_parent', 'the input stays as it was');
  assert.deepEqual(Object.keys(asAgent({ autark_agent: 'x' }, 'ag_1', 'win32')), ['AUTARK_AGENT', 'AUTARK_AGENT_PROOF'], 'Windows: any spelling is replaced; the proof rides along (FX3)');
  assert.equal(withShim(inherited, '/data', undefined, 'linux').AUTARK_AGENT, undefined, 'the shared engine env carries none');
  assert.equal(withShim(inherited, '/data', undefined, 'linux', 'ag_2').AUTARK_AGENT, 'ag_2');
  const none = agentEnv('/data', { env: inherited, platform: 'linux', entry: '/nowhere/wf.mjs' });
  assert.equal(none.AUTARK_AGENT, undefined);
  assert.equal(none.AUTARK_DATA, '/data');
  assert.equal(agentEnv('/data', { env: inherited, platform: 'linux', entry: '/nowhere/wf.mjs', agent: 'ag_3' }).AUTARK_AGENT, 'ag_3');
});

test("a Codex thread's shells get its agent's id (start and resume); none without an agent", async () => {
  assert.deepEqual(threadIsolation(['/a'], { GIT_PAGER: 'cat' }, 'ag_1').config.shell_environment_policy, { set: { GIT_PAGER: 'cat', ...agentIdentity('ag_1') } });
  assert.deepEqual(threadIsolation(['/a']).config.shell_environment_policy, { set: {} });
  const requests: any[] = [];
  const fake = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) return;
      if (msg.method) requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'thread/resume') child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
      } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  const engine = new CodexEngine({
    supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/data/engine-cwd', version: '0.2.0',
    env: { PATH: '/bin' }, shellEnv: { GIT_PAGER: 'cat' }, realpath: async (dir) => dir,
  });
  try {
    assert.equal((await engine.run(turnInput({ cwd: '/home/w', agentId: 'ag_ava' }).input)).stop, 'done');
    assert.equal((await engine.run(turnInput({ cwd: '/home/w', agentId: 'ag_bo', session: { ref: 'thr_9', generation: 1 } }).input)).stop, 'done');
    const set = (method: string) => requests.find((r) => r.method === method)?.params.config.shell_environment_policy.set;
    assert.deepEqual(set('thread/start'), { GIT_PAGER: 'cat', ...agentIdentity('ag_ava') });
    assert.deepEqual(set('thread/resume'), { GIT_PAGER: 'cat', ...agentIdentity('ag_bo') });
    assert.equal(fake.calls[0]!.options.env?.AUTARK_AGENT, undefined, 'the shared app-server carries none');
  } finally {
    await engine.dispose();
  }
});

test("a Claude agent turn's CLI names its agent; a helper turn (no tools, no hub) does not", async () => {
  const h = claudeSetup();
  const input = (patch: Record<string, unknown>) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), cwd: '/fake-home/Workforce', agentId: 'ag_ava', ...patch }).input;
  assert.equal((await h.engine.run(input({}))).stop, 'done');
  assert.equal((await h.engine.run(input({ tools: [] }))).stop, 'done');
  const [agentTurn, helperTurn] = h.cli.of('turn');
  assert.equal(agentTurn!.options.env?.AUTARK_AGENT, 'ag_ava');
  assert.equal(helperTurn!.options.env?.AUTARK_AGENT, undefined);
});

test("shell.exec's command names the calling agent, never a linked PC's", async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const shell = ((_command: string, options: { env: NodeJS.ProcessEnv }) => {
    seen.push(options.env);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as never;
  const ctx = (patch: Record<string, unknown> = {}) => ({
    agent: { id: 'ag_ava', name: 'Ava' }, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => {},
    services: { paths: undefined, secrets: { redact: (text: string) => text, list: () => [] } }, ...patch,
  }) as never;
  await runCommand(shell, ctx(), { command: 'wf send x hi', cwd: '/tmp' });
  await runCommand(shell, ctx({ fromPc: 'Laptop' }), { command: 'wf send x hi', cwd: '/tmp' });
  assert.equal(seen[0]!.AUTARK_AGENT, 'ag_ava');
  assert.equal(seen[1]!.AUTARK_AGENT, undefined);
});
