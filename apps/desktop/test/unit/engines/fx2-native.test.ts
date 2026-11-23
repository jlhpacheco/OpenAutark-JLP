// FX2 of the Sicher-Runde (19.11.2026), M3 and the mode change: a native step's fingerprint holds what it does (command,
// files, URL), never the description or title the model words anew; every engine's request carries the turn's run (the
// service finds its chat and task); a Codex thread loaded under another security mode leaves memory and is resumed, so
// no "for the session" approval of Trust mode reaches a Secure turn – and a turn in the same mode resumes nothing.
// Owns: these assertions only. Never: a real Claude Code, Codex or ACP CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectOf, gateNative, nativeFingerprint } from '../../../src/runtime/engines/codex/native-gate.ts';
import { acpStep } from '../../../src/runtime/engines/acp/permissions.ts';
import { secureTurn } from '../../../src/runtime/engines/claude/permissions.ts';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';
import { fakeSecurity } from './security-fake.ts';

test('effectOf keeps what a step does and drops free text', () => {
  assert.deepEqual(effectOf({ command: 'npm test', description: 'Run the tests', timeout: 60_000 }), { command: 'npm test' });
  assert.deepEqual(effectOf({ file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }), { file_path: '/w/a.ts' });
  assert.deepEqual(effectOf({ url: 'https://x.test', prompt: 'summarise' }), { url: 'https://x.test' });
  assert.deepEqual(effectOf({ mode: 'plan', title: 'Switch' }), { mode: 'plan' }, 'nothing known: all but free text');
  assert.equal(nativeFingerprint('claude', 'Bash', { b: 1, a: 2 }), nativeFingerprint('claude', 'Bash', { a: 2, b: 1 }), 'keys sorted');
});

test('claude: the same command with another description is the same step; another command is not', async () => {
  const fake = fakeSecurity();
  const turn = secureTurn(fake.service, { agentId: 'ag_1', runId: 'run_9' }, 'linux');
  const ask = (input: Record<string, unknown>) => turn.answer({ tool_name: 'Bash', input }, new AbortController().signal);
  await ask({ command: 'npm install', description: 'Install deps' });
  await ask({ command: 'npm install', description: 'Install the dependencies again', timeout: 120000 });
  await ask({ command: 'npm ci', description: 'Install deps' });
  const [a, b, c] = fake.gates.map((g) => g.fingerprint);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(fake.gates.every((g) => g.runId === 'run_9' && g.agentId === 'ag_1'), 'the run goes with every request');
});

test('acp: the title the CLI words is not part of the step', () => {
  const one = acpStep({ kind: 'execute', title: 'Running the tests', rawInput: { command: 'npm test', description: 'tests' } });
  const two = acpStep({ kind: 'execute', title: 'Run tests now', rawInput: { command: 'npm test' } });
  assert.deepEqual(one?.args, two?.args);
  assert.notDeepEqual(one?.args, acpStep({ kind: 'execute', rawInput: { command: 'npm ci' } })?.args);
});

test('gateNative passes the run along', async () => {
  const fake = fakeSecurity();
  await gateNative(fake.service, { agentId: 'ag_1', runId: 'run_3', capability: 'commands', summary: 'Run: x', fingerprint: 'f' });
  assert.equal(fake.gates[0].runId, 'run_3');
});

/** An app-server whose turns end at once; it answers thread/start, thread/resume and thread/unsubscribe. */
function appServer() {
  const requests: any[] = [];
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id === undefined || !msg.method) return;
      requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start' || msg.method === 'thread/resume') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'thread/unsubscribe') child.send({ id: msg.id, result: { status: 'unsubscribed' } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        setImmediate(() => child.send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } }));
      } else child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  return { spawn, requests };
}

test('codex: a thread loaded under Trust AI mode is resumed anew for the first Secure turn – not for a turn in the same mode', async () => {
  const trust = fakeSecurity({ mode: 'trust' });
  const secure = fakeSecurity({ mode: 'secure', gate: () => ({ ok: true }) });
  let lookup = trust.lookup;
  const server = appServer();
  const e = new CodexEngine({ supervisor: testSupervisor(server.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', realpath: async (dir) => dir, security: () => lookup() });
  const session = { ref: 'thr_1', generation: 1 };
  assert.equal((await e.run(turnInput().input)).stop, 'done');
  assert.equal((await e.run(turnInput({ session }).input)).stop, 'done');
  const methods = () => server.requests.map((r) => r.method).filter((m) => m.startsWith('thread/'));
  assert.deepEqual(methods(), ['thread/start'], 'the same mode: the loaded thread goes on');
  lookup = secure.lookup;
  assert.equal((await e.run(turnInput({ session }).input)).stop, 'done');
  assert.deepEqual(methods(), ['thread/start', 'thread/unsubscribe', 'thread/resume'], 'out of memory and back, its history kept');
  assert.equal((await e.run(turnInput({ session }).input)).stop, 'done');
  assert.deepEqual(methods(), ['thread/start', 'thread/unsubscribe', 'thread/resume'], 'once per mode change');
  await e.dispose();
});
