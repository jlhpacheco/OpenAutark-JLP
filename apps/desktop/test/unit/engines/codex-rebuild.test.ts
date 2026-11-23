// B-048 E2 (TRANSFER) – Codex native rebuild over a scripted app-server: the translation of every ledger item
// kind to raw Responses items, chunked thread/inject_items, the items/list check (a mismatch deletes the thread
// and throws), the rebuilt thread's first turn (the live context block as on every turn; a refused turn reports the session
// ended with rebuild 'failed'), the model-free probe ('count' / 'accepted' / refused) with the version from initialize, and
// the native tool output capture (command output, file diffs, bounded). B-080: each inject_items chunk waits THREAD_OPEN_MS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { chunks, injectHistory, responseItems, startRebuiltThread } from '../../../src/runtime/engines/codex/rebuild.ts';
import { THREAD_OPEN_MS } from '../../../src/runtime/engines/codex/helper-thread.ts';
import type { RpcClient } from '../../../src/runtime/engines/codex/rpc.ts';
import { nativeOutput } from '../../../src/runtime/engines/codex/turn.ts';
import { boundOutput, modelFamily } from '../../../src/runtime/engines/rebuild-text.ts';
import { OUTPUT_CAP } from '../../../src/runtime/engines/output.ts';
import type { RebuildItem } from '../../../src/runtime/engines/types.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput, type FakeChild } from './fakes.ts';

interface ServerOptions { listed?: number | 'unsupported'; refuseInject?: boolean; onTurn?: (child: FakeChild, msg: any) => void }

function appServer(options: ServerOptions = {}) {
  const state = { requests: [] as any[], threads: 0 };
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.method) state.requests.push(msg);
      if (msg.id === undefined || !msg.method) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.165.0-alpha.1.2 (Windows 10.0; x86_64) xterm (workforce; 0.2.0)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++state.threads}` } } }); break;
        case 'thread/inject_items':
          if (options.refuseInject) child.send({ id: msg.id, error: { code: -32600, message: 'items[0] is not a valid response item' } });
          else child.send({ id: msg.id, result: {} });
          break;
        case 'thread/items/list':
          if (options.listed === 'unsupported') child.send({ id: msg.id, error: { code: -32601, message: 'thread/items/list is not supported yet' } });
          else child.send({ id: msg.id, result: { data: Array.from({ length: options.listed ?? 0 }, (_, i) => ({ id: `it${i}` })), nextCursor: null } });
          break;
        case 'thread/delete': child.send({ id: msg.id, result: {} }); break;
        case 'turn/start':
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          options.onTurn?.(child, msg);
          break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, calls, state };
}

const engine = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', realpath: async (dir) => dir });
const offered = new Set(['tasks.create', 'context.hide']);

const ITEMS: RebuildItem[] = [
  { itemId: 'm3', kind: 'm', role: 'user', text: '[10:00] Lena: build the export' },
  { itemId: 'a1', kind: 'a', role: 'assistant', text: 'On it.' },
  { itemId: 't2', kind: 't', role: 'tool', text: 'created', call: { name: 'tasks.create', args: { title: 'Export' }, callId: 'toolu_01', output: 'created tsk_1' }, origin: { engine: 'claude', model: 'claude:opus' } },
  { itemId: 't3', kind: 't', role: 'tool', text: 'ok', call: { own: true, name: 'Bash', args: { command: 'npm test' }, callId: 'toolu_02', output: '12 passing' }, origin: { engine: 'claude' } },
  { itemId: 'r4', kind: 'r', role: 'assistant', text: 'Weighing the CSV against JSON.', origin: { engine: 'claude', model: 'claude:opus' } },
  { itemId: 'r5', kind: 'r', role: 'assistant', text: 'Same thread of thought.', origin: { engine: 'codex', model: 'codex:gpt-6.1-sol', accountId: 'acc_test' }, reasoning: { encrypted: 'ENC' } },
  { itemId: 'r6', kind: 'r', role: 'assistant', text: 'Another account.', origin: { engine: 'codex', model: 'codex:gpt-6.1-sol', accountId: 'acc_other' }, reasoning: { encrypted: 'ENC2' } },
  { itemId: 'f7', kind: 'f', role: 'tool', text: 'file body\n{"compacted":"f7","was":"900 tokens","restore":"context.restore"}' },
  { itemId: 't8', kind: 't', role: 'tool', text: 'x', call: { name: 'tasks.create', args: '{"title":"Again"}', callId: 'toolu_01', output: 'created tsk_2' } },
];

test('codex rebuild: every ledger item kind becomes the right Responses item', () => {
  const out = responseItems(ITEMS, { offered, accountId: 'acc_test', model: 'gpt-6.1-sol', platform: 'win32' });
  assert.deepEqual(out[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[10:00] Lena: build the export' }] });
  assert.deepEqual(out[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] });
  // Our hub tool: a paired function_call/function_call_output with the dynamic tool's wire name.
  assert.deepEqual(out[2], { type: 'function_call', name: 'tasks__create', arguments: '{"title":"Export"}', call_id: 'toolu_01' });
  assert.deepEqual(out[3], { type: 'function_call_output', call_id: 'toolu_01', output: 'created tsk_1' });
  // No native shell command, output or function pair survives the projection.
  assert.deepEqual(out[4], { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Earlier native shell or script calls omitted: 1. Their results are not available in the rebuilt context.]' }] });
  assert.doesNotMatch(JSON.stringify(out), /npm test|12 passing|toolu_02/);
  // Codex reasoning of the same account and family → a reasoning item; Claude thinking and another account's reasoning cannot replay: they leave nothing (no text the model never said).
  assert.deepEqual(out[5], { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Same thread of thought.' }], encrypted_content: 'ENC' });
  assert.ok(!JSON.stringify(out).includes('(thinking:'));
  // A tool-side item without a call: user text with its id; the condensed stamp stays verbatim.
  assert.match((out[6] as any).content[0].text, /^\[f7\]\nfile body\n\{"compacted":"f7","was":"900 tokens","restore":"context.restore"\}$/);
  // A repeated call id is made unique; a string argument stays as it is.
  assert.deepEqual(out[7], { type: 'function_call', name: 'tasks__create', arguments: '{"title":"Again"}', call_id: 'toolu_01_t8' });
  assert.equal((out[8] as any).call_id, 'toolu_01_t8');
  assert.equal(out.length, 9);
  // Not offered now: our own tool still replays as the real call it was (owner 01.11.2026: as if it had made it itself).
  const real = responseItems([ITEMS[2]], { offered: new Set(), accountId: 'acc_test', model: 'gpt-6.1-sol' });
  assert.deepEqual(real[0], { type: 'function_call', name: 'tasks__create', arguments: '{"title":"Export"}', call_id: 'toolu_01' });
  assert.equal(modelFamily('codex:gpt-6.1-sol-mini'), 'gpt-6.1');
});

test('codex rebuild (B-049 neutral mapping): Claude Read → files.read, a Codex PowerShell line is withheld, an Edit → a note with its diff', () => {
  const items: RebuildItem[] = [
    { itemId: 't1', kind: 't', role: 'tool', text: '', call: { own: true, name: 'Read', args: { file_path: 'C:\\w\\a.ts', offset: 5 }, callId: 'toolu_r', output: '     5\tconst a = 1;' }, origin: { engine: 'claude' } },
    { itemId: 't2', kind: 't', role: 'tool', text: '', call: { own: true, name: 'shell', args: { command: '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-ChildItem\'', cwd: 'C:\\w' }, callId: 'exec-1', output: 'a.ts' }, origin: { engine: 'codex' } },
    { itemId: 't3', kind: 't', role: 'tool', text: '', call: { own: true, name: 'Edit', args: { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, callId: 'toolu_e', output: 'The file a.ts has been updated.' }, origin: { engine: 'claude' } },
  ];
  const out = responseItems(items, { offered: new Set(['files.read']), accountId: 'acc_test', model: 'gpt-6.1-sol', platform: 'win32' });
  assert.deepEqual(out.slice(0, 3), [
    { type: 'function_call', name: 'files__read', arguments: '{"path":"C:\\\\w\\\\a.ts","fromLine":5}', call_id: 'toolu_r' },
    { type: 'function_call_output', call_id: 'toolu_r', output: '     5\tconst a = 1;' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Earlier native shell or script calls omitted: 1. Their results are not available in the rebuilt context.]' }] },
  ]);
  // BEFUND §3 (17.11.2026): one user-side record with its diff and output, never assistant text
  assert.deepEqual(out[3], { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[record of an earlier call, not replayable here – Edit: a.ts]\n-const a = 1;\n+const a = 2;\n[its output]\nThe file a.ts has been updated.' }] });
  assert.equal(out.length, 4);
  assert.doesNotMatch(JSON.stringify(out), /Get-ChildItem|exec-1/);
});

test('codex rebuild: chunks keep the item and character bounds and the order', () => {
  const items = Array.from({ length: 95 }, (_, i) => ({ i }));
  const parts = chunks(items, 40, 1_000_000);
  assert.deepEqual(parts.map((part) => part.length), [40, 40, 15]);
  assert.deepEqual(parts.flat(), items);
  const big = [{ t: 'x'.repeat(600) }, { t: 'y'.repeat(600) }, { t: 'z' }];
  assert.deepEqual(chunks(big, 40, 1000).map((part) => part.length), [1, 2], 'a chunk closes before it passes the character bound');
});

test('codex rebuild: thread/start with the turn settings and dynamic tools, inject_items in chunks, the ref of a loaded thread', async () => {
  const fake = appServer({ listed: 'unsupported' });
  const e = engine(fake.spawn);
  const { input } = turnInput();
  const items = Array.from({ length: 45 }, (_, i): RebuildItem => ({ itemId: `m${i + 1}`, kind: 'm', role: 'user', text: `line ${i}` }));
  const result = await e.rebuild({
    runId: 'run_1', agentId: 'ag_1', account: account(), model: 'gpt-test', cwd: '/work', items, tools: input.tools, toolNames: ['tasks.create'],
    system: { stable: 'STABLE', volatile: 'VOLATILE' }, generation: 3, probe: { version: '0.165.0', ok: true, verify: 'accepted', at: 1 },
  });
  assert.deepEqual(result, { ref: 'thr_1', generation: 3, items: 45 });
  const start = fake.state.requests.find((r) => r.method === 'thread/start');
  assert.equal(start.params.baseInstructions, 'STABLE');
  assert.equal(start.params.developerInstructions, undefined, 'the live context goes with the first turn, never in the instructions');
  assert.equal(start.params.cwd, '/work');
  assert.deepEqual(start.params.dynamicTools.map((tool: any) => tool.name), ['tasks__create']);
  const injects = fake.state.requests.filter((r) => r.method === 'thread/inject_items');
  assert.deepEqual(injects.map((r) => r.params.items.length), [40, 5]);
  assert.ok(injects.every((r) => r.params.threadId === 'thr_1'));
  assert.equal(fake.state.requests.some((r) => r.method === 'thread/items/list'), false, "verify 'accepted' does not list");

  // A hub-only tool of Claude's turns replays as the real call it was too (reached through tools.find if the model wants it again).
  const other = appServer({ listed: 'unsupported' });
  await engine(other.spawn).rebuild({
    runId: 'run_2', agentId: 'ag_1', account: account(), model: 'gpt-test', cwd: '/work', tools: input.tools, toolNames: ['secrets.run', 'tasks.create'],
    items: [{ itemId: 'm1', kind: 'm', role: 'user', text: 'hi' }, { itemId: 't2', kind: 't', role: 'tool', text: '', call: { name: 'secrets.run', args: { command: 'deploy' }, callId: 'toolu_9', output: 'ok' } }],
    system: { stable: 'S', volatile: 'V' }, generation: 1, probe: { version: '0.165.0', ok: true, verify: 'accepted', at: 1 },
  });
  const injected = other.state.requests.filter((r) => r.method === 'thread/inject_items').flatMap((r) => r.params.items);
  assert.deepEqual(injected[1], { type: 'function_call', name: 'secrets__run', arguments: '{"command":"deploy"}', call_id: 'toolu_9' });
});

test('codex rebuild: an items/list mismatch or a refused chunk deletes the new thread and throws', async () => {
  const mismatch = appServer({ listed: 1 });
  const e = engine(mismatch.spawn);
  const { input } = turnInput();
  const base = { runId: 'run_1', agentId: 'ag_1', account: account(), model: 'gpt-test', cwd: '/work', tools: input.tools, toolNames: ['tasks.create'], system: { stable: 'S', volatile: 'V' }, generation: 1 };
  await assert.rejects(e.rebuild({ ...base, items: ITEMS.slice(0, 2), probe: { version: 'v', ok: true, verify: 'count', at: 1 } }), /item mismatch: 1 listed, at least 2 expected/);
  assert.ok(mismatch.state.requests.some((r) => r.method === 'thread/delete' && r.params.threadId === 'thr_1'));

  const refused = appServer({ refuseInject: true });
  await assert.rejects(engine(refused.spawn).rebuild({ ...base, items: ITEMS.slice(0, 2) }), /thread\/inject_items refused chunk 1/);
  assert.ok(refused.state.requests.some((r) => r.method === 'thread/delete'));

  const ok = appServer({ listed: 2 });
  assert.equal((await engine(ok.spawn).rebuild({ ...base, items: ITEMS.slice(0, 2), probe: { version: 'v', ok: true, verify: 'count', at: 1 } })).ref, 'thr_1');
  await assert.rejects(engine(appServer().spawn).rebuild({ ...base, items: [] }), /nothing to rebuild/);
});

test('codex rebuild: the first turn sends the context block like every turn; a refused first turn reports the session ended (rebuild failed)', async () => {
  let status = 'failed';
  const fake = appServer({
    listed: 'unsupported',
    onTurn: (child, msg) => child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status, error: { message: 'Bad request' } } } }),
  });
  const e = engine(fake.spawn);
  const { input } = turnInput();
  const base = { runId: 'run_1', agentId: 'ag_1', account: account(), model: 'gpt-test', cwd: '/work', tools: input.tools, toolNames: ['tasks.create'], system: { stable: 'S', volatile: 'V' }, generation: 2 };
  const built = await e.rebuild({ ...base, items: ITEMS.slice(0, 2) });
  const first = await e.run(turnInput({ session: { ref: built.ref, generation: 2 } }).input);
  const starts = () => fake.state.requests.filter((r) => r.method === 'turn/start');
  assert.equal(starts()[0].params.input[0].text, '<live>\nVOLATILE\n</live>', 'the rebuilt thread\'s first turn carries the live context');
  assert.equal(fake.state.requests.some((r) => r.method === 'thread/resume'), false, 'the rebuilt thread is loaded');
  assert.equal(first.stop, 'error');
  assert.equal(first.error?.details?.rebase, true);
  assert.equal(first.error?.details?.rebuild, 'failed');
  assert.equal(first.session, undefined);

  status = 'completed';
  const second = await e.run(turnInput({ session: { ref: built.ref, generation: 2 } }).input);
  assert.equal(second.stop, 'done');
  assert.equal(starts()[1].params.input[0].text, '<live>\nVOLATILE\n</live>', 'later turns carry the volatile block again');
});

test('codex rebuild probe: model-free (no turn), the version from initialize, verify by what items/list shows, the thread deleted', async () => {
  const accepted = appServer({ listed: 0 });
  const e = engine(accepted.spawn);
  assert.equal(await e.rebuildVersion(account()), '0.165.0-alpha.1.2');
  const probe = await e.probeRebuild(account(), '/work');
  assert.deepEqual({ ...probe, at: 0 }, { version: '0.165.0-alpha.1.2', ok: true, verify: 'accepted', custom: true, at: 0 });
  const methods = accepted.state.requests.map((r) => r.method);
  // B-049 F9: an exec pair is injected after the listing (custom).
  assert.deepEqual(methods.filter((m) => m.startsWith('thread/') || m.startsWith('turn/')), ['thread/start', 'thread/inject_items', 'thread/items/list', 'thread/inject_items', 'thread/delete']);
  const inject = accepted.state.requests.find((r) => r.method === 'thread/inject_items');
  assert.deepEqual(inject.params.items.map((item: any) => item.type), ['message', 'function_call', 'function_call_output', 'message']);
  const start = accepted.state.requests.find((r) => r.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only');
  assert.deepEqual(start.params.dynamicTools.map((tool: any) => tool.name), ['workforce_probe']);

  const listing = appServer({ listed: 3 });
  assert.equal((await engine(listing.spawn).probeRebuild(account(), '/work')).verify, 'count');
  const refused = appServer({ refuseInject: true });
  const failed = await engine(refused.spawn).probeRebuild(account(), '/work');
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /not a valid response item/);
  assert.ok(refused.state.requests.some((r) => r.method === 'thread/delete'), 'the probe thread is deleted also after a refusal');
});

test('codex native output: command output and file diffs ride on tool_end.output, bounded to 64k (head and tail)', () => {
  assert.deepEqual(nativeOutput('commandExecution', { aggregatedOutput: '12 passing\n' }), { output: '12 passing\n' });
  assert.deepEqual(nativeOutput('fileChange', { changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }, { path: 'b.ts', kind: 'add' }] }),
    { output: 'update a.ts\n@@ -1 +1 @@\n-a\n+b\nadd b.ts' });
  assert.deepEqual(nativeOutput('mcpToolCall', { result: { content: [{ type: 'text', text: 'found 3' }] } }), { output: 'found 3' });
  assert.deepEqual(nativeOutput('commandExecution', {}), {});
  const long = `HEAD${'x'.repeat(100_000)}TAIL`;
  const cut = nativeOutput('commandExecution', { aggregatedOutput: long }).output!;
  assert.ok(cut.length <= OUTPUT_CAP + 80);
  assert.ok(cut.startsWith('HEAD') && cut.endsWith('TAIL') && /characters cut/.test(cut));
  assert.equal(boundOutput('short'), 'short');
});

test('codex turn: a completed command item emits tool_end with its aggregated output', async () => {
  const fake = appServer({
    onTurn: (child, msg) => {
      const threadId = msg.params.threadId;
      child.send({ method: 'item/started', params: { threadId, turnId: 'turn_1', item: { id: 'c1', type: 'commandExecution', command: 'npm test', cwd: '/work' } } });
      child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: '12 passing' } } });
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
    },
  });
  const { input, events } = turnInput();
  await engine(fake.spawn).run(input);
  assert.deepEqual(events.filter((event: any) => event.type === 'tool_end'), [{ type: 'tool_end', callId: 'c1', ok: true, summary: 'exit 0', output: '12 passing' }]);
});

test('B-080: every inject_items chunk of a rebuild waits THREAD_OPEN_MS (the thread still opens on the account\'s shared app-server)', async () => {
  const limits: Array<[string, number | undefined]> = [];
  const rpc = { request: async (method: string, _params: unknown, timeoutMs?: number) => { limits.push([method, timeoutMs]); return method === 'thread/start' ? { thread: { id: 'thr_r' } } : {}; } } as unknown as RpcClient;
  const items = Array.from({ length: 45 }, (_, i) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `line ${i}` }] }));
  await injectHistory(rpc, 'thr_1', items, 'accepted');
  assert.deepEqual(limits, [['thread/inject_items', THREAD_OPEN_MS], ['thread/inject_items', THREAD_OPEN_MS]]);
  limits.length = 0;
  assert.equal(await startRebuiltThread(rpc, { cwd: '/work' }, items.slice(0, 2), 'accepted'), 'thr_r');
  assert.deepEqual(limits, [['thread/start', THREAD_OPEN_MS], ['thread/inject_items', THREAD_OPEN_MS]]);
});
