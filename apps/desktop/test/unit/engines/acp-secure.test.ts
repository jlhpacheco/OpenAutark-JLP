// Sicher-Runde 19.11.2026: ACP agents in Secure mode – an own tool call's `session/request_permission` is answered from the
// gate (execute → commands, edit → write with its files, think through at once); our hub's tools stay allowed (the
// registry gates them). Trust mode keeps allowing at once.
// Owns: these assertions only. Never: a real ACP agent (scripted agent over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpStep } from '../../../src/runtime/engines/acp/permissions.ts';
import { turnInput } from './fakes.ts';
import { OPTIONS, setup } from './acp-fixture.ts';
import { fakeSecurity } from './security-fake.ts';

test('acp secure: tool kinds map to switches with their files', () => {
  assert.deepEqual(acpStep({ kind: 'execute', title: 'npm install', rawInput: { command: 'npm install' } })?.capability, 'commands');
  assert.equal(acpStep({ kind: 'execute', title: 'Shell', rawInput: { command: 'npm install' } })?.summary, 'Run: npm install');
  const edit = acpStep({ kind: 'edit', title: 'Edit a.ts', locations: [{ path: '/elsewhere/a.ts' }] });
  assert.deepEqual([edit?.capability, edit?.paths, edit?.summary], ['write', ['/elsewhere/a.ts'], 'Edit a.ts']);
  assert.equal(acpStep({ kind: 'read', rawInput: { path: '/x/y.md' } })?.capability, 'read');
  assert.equal(acpStep({ kind: 'search', title: 'grep' })?.capability, 'read');
  assert.equal(acpStep({ kind: 'fetch', title: 'https://example.test' })?.capability, 'web');
  assert.equal(acpStep({ kind: 'switch_mode', title: 'yolo' })?.capability, 'commands');
  assert.equal(acpStep({ title: 'something' })?.capability, 'commands', 'no kind: asked like a command');
  assert.equal(acpStep({ kind: 'think', title: 'plan' }), undefined, 'thinking needs nobody');
});

function run(security: () => any) {
  const { agent, engine } = setup({
    onPrompt: (t) => {
      t.request(901, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c1', title: 'npm install', kind: 'execute', rawInput: { command: 'npm install' } }, options: OPTIONS });
      t.request(902, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c2', title: 'Edit a.ts', kind: 'edit', locations: [{ path: '/elsewhere/a.ts' }] }, options: OPTIONS });
      t.request(903, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c3', title: 'mcp__workforce__tasks__create', kind: 'other' }, options: OPTIONS });
      t.request(904, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c4', title: 'Edit b.ts', kind: 'edit', locations: [{ path: '/work/b.ts' }] }, options: OPTIONS });
    },
  }, { security });
  agent.state.onReply = () => {
    if (agent.state.replies.size < 4) return;
    const pending = [...agent.state.prompts.values()][0];
    agent.calls[0].child.send({ jsonrpc: '2.0', id: pending.id, result: { stopReason: 'end_turn' } });
  };
  return { agent, engine };
}

test('acp secure: own steps are answered from the gate; the hub and open files pass without it', async () => {
  const fake = fakeSecurity({ gate: (request) => (request.capability === 'write' ? { ok: true } : { ok: false, text: 'waiting' }) });
  const { agent, engine } = run(fake.lookup);
  const result = await engine.run(turnInput().input);
  await engine.dispose();
  assert.equal(result.stop, 'done');
  const outcome = (id: number) => agent.state.replies.get(id).result.outcome;
  assert.deepEqual(outcome(901), { outcome: 'selected', optionId: 'no' }, 'the command waits for the person');
  assert.deepEqual(outcome(902), { outcome: 'selected', optionId: 'yes' });
  assert.deepEqual(outcome(903), { outcome: 'selected', optionId: 'yes' }, 'our tool: the registry gates it');
  assert.deepEqual(outcome(904), { outcome: 'selected', optionId: 'yes' }, 'an open file');
  assert.deepEqual(fake.gates.map((g) => [g.capability, g.path, g.summary]), [['commands', undefined, 'Run: npm install'], ['write', '/elsewhere/a.ts', 'Edit a.ts']]);
  assert.ok(fake.gates.every((g) => g.agentId === 'ag_1' && g.signal instanceof AbortSignal && g.fingerprint.startsWith('acp:')));
});

test('acp secure: a Trust-mode company allows at once, as today', async () => {
  const fake = fakeSecurity({ mode: 'trust' });
  const { agent, engine } = run(fake.lookup);
  assert.equal((await engine.run(turnInput().input)).stop, 'done');
  await engine.dispose();
  for (const id of [901, 902, 903, 904]) assert.deepEqual(agent.state.replies.get(id).result.outcome, { outcome: 'selected', optionId: 'yes' });
  assert.equal(fake.gates.length, 0);
});
