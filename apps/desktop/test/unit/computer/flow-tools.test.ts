// KI-Runde 17.11.2026 (package T): computer.wait and computer.batch (computer/flow-tools.ts) over a real ComputerService
// whose helper answers from a table, and a ui_tree search that passes its maxNodes on and says how to get the rest.
// Owns: these assertions only. Never: PowerShell, a screen or a real pointer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import { computerTools } from '../../../src/runtime/computer/tools.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import { MemoryLogger } from '../fakes.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { agent } from '../chat/harness.ts';

const BOUNDED = { timeout: 15_000 };

function rig(answers: Partial<Record<HelperOp, (args: Record<string, unknown>) => unknown>>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const helper: HelperClient = {
    async call<T>(op: HelperOp, args: Record<string, unknown> = {}): Promise<T> { calls.push([op, args]); return (answers[op] ? answers[op]!(args) : { done: true }) as T; },
    running: () => true,
    async dispose() {},
  };
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds() { return 60; },
  } as Host;
  const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'win32' });
  const ctx = { agent: agent('ag_david', 'David'), runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const all = new Map(computerTools(computer).map((tool) => [tool.name, tool]));
  const run = async (name: string, args: Record<string, unknown>): Promise<ToolOutput> => (await all.get(name)!.run(args, ctx)) as ToolOutput;
  const textOf = (out: ToolOutput) => out.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
  return { run, textOf, calls, all };
}

const FAVORIT = { d: 0, p: -1, rid: '1.4', role: 'button', name: 'Favorit', patterns: ['invoke'] };

test('computer.wait: until an element shows (its line with a ref), until a window is open, or for a time', BOUNDED, async () => {
  let looks = 0;
  const r = rig({
    find: () => (++looks < 2 ? { hwnd: 7, nodes: [] } : { hwnd: 7, nodes: [FAVORIT] }),
    windows: () => [{ hwnd: 9, title: 'TikTok – Chrome', process: 'chrome', pid: 1 }],
  });
  const came = r.textOf(await r.run('computer.wait', { text: 'Favorit', ms: 5_000 }));
  assert.match(came, /^Waited \d+(\.\d)? s: it came\.\n.*"Favorit".*\[ref=/s);
  assert.equal(looks, 2, 'looked again about a second later');
  assert.match(r.textOf(await r.run('computer.wait', { title: 'tiktok' })), /^Waited \d+(\.\d)? s: it came – window 9 "TikTok – Chrome" · chrome\.$/);
  assert.match(r.textOf(await r.run('computer.wait', { ms: 150 })), /^Waited 0\.\d s\.$/);
  await assert.rejects(r.run('computer.wait', {}), /Give text, title or ms/);
  const late = rig({ find: () => ({ hwnd: 7, nodes: [] }) });
  assert.match(late.textOf(await late.run('computer.wait', { text: 'Never', ms: 500 })), /it did not come in time\.$/);
});

test('computer.batch: steps in order in one call, each checked as its own tool; it stops at the first that fails', BOUNDED, async () => {
  const r = rig({});
  const batch = r.all.get('computer.batch')!;
  assert.deepEqual((batch.inputSchema as { properties: { steps: { items: { properties: { tool: { enum: string[] } } } } } }).properties.steps.items.properties.tool.enum,
    ['act', 'click', 'type', 'key', 'scroll', 'drag', 'wait']);
  const done = await r.run('computer.batch', { steps: [{ tool: 'key', args: { keys: 'ctrl+l' } }, { tool: 'key', args: { keys: 'enter' } }, { tool: 'wait', args: { ms: 100 } }] });
  assert.ok(!done.isError, r.textOf(done));
  assert.match(r.textOf(done), /^Ran 3 of 3 steps\.\n#1 computer\.key: Pressed ctrl\+l\.[\s\S]*\n#2 computer\.key: Pressed enter\.[\s\S]*\n#3 computer\.wait: Waited/);

  const stopped = await r.run('computer.batch', { steps: [{ tool: 'key', args: { keys: 'ctrl+s' } }, { tool: 'key', args: {} }, { tool: 'key', args: { keys: 'enter' } }] });
  assert.equal(stopped.isError, true);
  assert.match(r.textOf(stopped), /^Ran 1 of 3 steps\. Stopped: #2 computer\.key: invalid arguments – keys/);
  assert.ok(!r.textOf(stopped).includes('Pressed enter'), 'nothing after the failed step runs');

  const described = batch.describe!({ steps: [{ tool: 'key', args: { keys: 'ctrl+s' } }, { tool: 'wait', args: { ms: 100 } }] } as never, { agent: agent('ag_david', 'David'), runId: 'run_1', mode: 'computer' } as unknown as ToolContext);
  assert.match(described.summary, /^Batch of 2: Press ctrl\+s; Wait 0\.1 s$/);
});

test('computer.ui_tree search: maxNodes goes on as the search limit, and a cut search says how to get the rest', BOUNDED, async () => {
  const r = rig({ find: () => ({ hwnd: 7, truncated: true, nodes: [FAVORIT, { ...FAVORIT, rid: '1.5' }] }) });
  const out = r.textOf(await r.run('computer.ui_tree', { name: 'Favorit', maxNodes: 60 }));
  assert.equal(r.calls.find(([op]) => op === 'find')?.[1].max, 60);
  assert.match(out, /^2 matches \(search stopped at 2 – maxNodes up to 100 finds more, a narrower name or role fewer\):/);
});
