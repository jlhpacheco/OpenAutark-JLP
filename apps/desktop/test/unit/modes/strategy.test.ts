// Mode strategy (23.10.2026, modes/strategy.ts + agents.handoff / agents.delegate / modes.list): the
// agent chooses its mode. A switch (handoff to a mode key) is refused only into the mode the run already works in –
// no cap on switches; a colleague who works in the target mode is named as advice; modes.list marks the current mode
// and names such colleagues; the tool descriptions carry the rule; general has no specialists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { checkModeSwitch, specialistsFor } from '../../../src/runtime/modes/strategy.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { modeTools } from '../../../src/runtime/tools/builtin/modes.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const MODES = [{ key: 'general', name: 'General', description: 'Everyday' }, { key: 'video', name: 'Video', description: 'Cut' }, { key: 'computer', name: 'Computer', description: 'Click' }];

function fixture() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: chat.id, title: 'Teaser', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: 'human' });
  const f = { ...h, chat, task };
  f.org.add(agent('ag_vid', 'Vid', { mode: 'video', managerId: 'ag_mara' }));
  f.org.add(agent('ag_old', 'Old', { mode: 'video', archivedAt: 5 }));
  f.org.add(agent('ag_rest', 'Rest', { mode: 'video', status: 'paused' }));
  (f.services as { modes: unknown }).modes = { list: () => MODES, get: (key: string) => MODES.find((mode) => mode.key === key) };
  const ctx = (mode = 'general', taskId: string | undefined = f.task.id): ToolContext => ({
    agent: f.org.get('ag_tom')!, runId: 'run_modes', conversationId: f.chat.id, taskId, mode,
    services: f.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  });
  return { ...f, ctx };
}

const tool = (list: ToolDef[], name: string) => list.find((entry) => entry.name === name)!;
const text = (result: unknown) => JSON.stringify(result);

test('specialists: active agents whose own mode it is, never the caller, none for general', () => {
  const f = fixture();
  assert.deepEqual(specialistsFor(f.services, 'video', 'ag_tom'), [{ id: 'ag_vid', name: 'Vid' }], 'archived and paused agents are not offered');
  assert.deepEqual(specialistsFor(f.services, 'video', 'ag_vid'), []);
  assert.deepEqual(specialistsFor(f.services, 'general'), []);
});

test('checkModeSwitch: switching my own mode names a colleague who works in it (advice only)', () => {
  const f = fixture();
  assert.deepEqual(checkModeSwitch(f.services, { agentId: 'ag_tom', mode: 'video', to: 'video' }), {});
  const check = checkModeSwitch(f.services, { agentId: 'ag_tom', mode: 'general', to: 'video' });
  assert.match(check.advice ?? '', /^Vid \(ag_vid\) works in video mode\. A part that stands on its own I can give them \(tasks\.add, or tasks\.update with for\)/);
  assert.deepEqual(checkModeSwitch(f.services, { agentId: 'ag_tom', mode: 'general', to: 'computer' }), {});
});


test('modes.list marks the current mode and names the colleagues of each mode', async () => {
  const f = fixture();
  const list = JSON.parse(String(((await tool(modeTools, 'modes.list').run({}, f.ctx('computer'))) as { content: Array<{ text: string }> }).content[0].text)) as Array<{ key: string; current?: boolean; specialists?: unknown }>;
  assert.deepEqual(list.map((mode) => [mode.key, mode.current ?? false]), [['general', false], ['video', false], ['computer', true]]);
  assert.deepEqual(list.find((mode) => mode.key === 'video')?.specialists, [{ id: 'ag_vid', name: 'Vid' }]);
  assert.equal(list.find((mode) => mode.key === 'general')?.specialists, undefined);
});

