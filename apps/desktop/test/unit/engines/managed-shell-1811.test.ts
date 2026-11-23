// The 18.11.2026 leak, replayed (0.3.19, the masked engine shell): a Stripe live key printed by a command an agent ran in
// Claude Code's native Bash reached the model provider – the CLI ran the tool and sent its output on before Autark saw it.
// Now an agent turn has no native shell to run it in: Claude Code gets no Bash/PowerShell tool, a Codex agent thread opens
// (and forks) with its native shells off. A command runs through Autark's shell.exec instead, whose output reaches the
// model only masked: a catalog value as its secret:// handle, a key by its shape as ‹secret:…›. So the model's request
// (the tool result Codex is sent), the run journal and the chat line (the model's answer quoting the output) carry markers
// only. A journal row from before – a native shell call with the raw output – is never replayed into a rebuilt session.
// Red on main before 0.3.19 (6fa75ef): Bash in --tools, no shell switches in thread/start or thread/fork, the old row
// replayed. Owns: these assertions only. Never: a real key – the values below are synthetic; never a real binary or shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { fileTools, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { responseItems } from '../../../src/runtime/engines/codex/rebuild.ts';
import { transcriptMessages } from '../../../src/runtime/engines/claude/transcript.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RebuildItem } from '../../../src/runtime/engines/types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { claudeAccount, claudeSetup, kindOf } from './claude-fixture.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';
import { ManualClock } from '../fakes.ts';
import { setup as toolSetup } from '../tools/helpers.ts';

const CATALOG = 'synthetic-catalog-fixture-9ACD7';
const STRIPE = `sk_live_${'d3adb33f'.repeat(6)}`;
const raw = (text: string) => text.includes(CATALOG) || text.includes(STRIPE) || text.includes('d3adb33fd3adb33f');
const NATIVE_SHELLS = ['shell_tool', 'unified_exec', 'shell_snapshot', 'shell_zsh_fork', 'js_repl'];

/** A Codex app-server whose model runs `cat .env` through shell.exec in the turn and answers by quoting what came back. */
function codexModel() {
  const requests: any[] = [];
  const replies: any[] = [];
  let threads = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    let turn: { threadId: string; id: string } | undefined;
    child.onLine = (msg) => {
      if (!msg.method) {
        if (msg.id !== 900 || !turn) return;
        replies.push(msg); // what goes back to the model: the request the provider gets next
        const said = (msg.result?.contentItems ?? []).map((part: { text?: string }) => part.text ?? '').join('\n');
        child.send({ method: 'item/completed', params: { threadId: turn.threadId, turnId: turn.id, item: { id: 'm1', type: 'agentMessage', text: `Here is what it printed:\n${said}` } } });
        child.send({ method: 'turn/completed', params: { threadId: turn.threadId, turn: { id: turn.id, status: 'completed' } } });
        return;
      }
      requests.push(msg);
      if (msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'codex_cli_rs/0.167.0-alpha.3.2 (Windows 11; x86_64) fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/fork': child.send({ id: msg.id, result: { thread: { id: 'thr_fork_1', forkedFromId: msg.params.threadId }, cwd: msg.params.cwd, model: 'gpt-test' } }); break;
        case 'turn/start': {
          turn = { threadId: msg.params.threadId, id: 'turn_1' };
          child.send({ id: msg.id, result: { turn: { id: turn.id, status: 'inProgress' } } });
          child.send({ id: 900, method: 'item/tool/call', params: { threadId: turn.threadId, turnId: turn.id, callId: 'c1', tool: 'shell__exec', namespace: null, arguments: { command: 'cat .env' } } });
          break;
        }
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, replies, sent: (method: string) => requests.filter((r) => r.method === method) };
}

/** The hub as composed: the real tool registry and secret vault, shell.exec over a shell that prints a .env file. */
async function hub() {
  const h = toolSetup();
  const db = new Db(':memory:');
  migrate(db);
  const host = {
    encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
    decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
  };
  const vault = new SecretVault({ db, host, clock: new ManualClock() });
  const saved = await vault.save({ label: 'Database password', kind: 'password', value: CATALOG });
  const items: Array<{ id: string; kind: string; name?: string; data: Record<string, unknown> }> = [];
  Object.assign(h.services, {
    secrets: vault,
    runs: {
      item: (_runId: string, item: { kind: string; name?: string; data: Record<string, unknown> }) => { const row = { ...item, id: `ri_${items.length + 1}` }; items.push(row); return row; },
      updateItem: (id: string, patch: { data?: Record<string, unknown> }) => { const row = items.find((entry) => entry.id === id); if (row && patch.data) row.data = patch.data; },
    },
  });
  const shell: ShellSpawn = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: null, kill: () => true });
    setImmediate(() => { child.stdout.emit('data', Buffer.from(`DATABASE_PASSWORD=${CATALOG}\nSTRIPE_SECRET_KEY=${STRIPE}\n`)); child.emit('close', 0); });
    return child as unknown as ReturnType<ShellSpawn>;
  };
  const registry = new Registry({ services: () => h.services as RuntimeServices });
  const exec = fileTools({ shell }).find((tool) => tool.name === 'shell.exec')!;
  registry.register(exec);
  const base: Omit<ToolContext, 'services'> = { agent: h.tom, runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  const callTool = (name: string, args: unknown, callId: string) => registry.call(name, args, base, callId);
  return { exec, callTool, items, handle: `secret://${saved.id}` };
}

test('18.11: a Claude Code agent turn has no native Bash or PowerShell tool', async () => {
  const { engine, cli } = claudeSetup();
  const result = await engine.run(turnInput({ account: claudeAccount(), model: 'claude-opus-5-5' }).input);
  assert.equal(result.stop, 'done');
  const args = cli.calls.find((call) => kindOf(call.args) === 'turn')!.args;
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.length > 0 && tools.includes('Read'), 'the native file tools stay');
  for (const shell of ['Bash', 'PowerShell']) assert.equal(tools.includes(shell), false, `${shell} is not offered`);
});

test('18.11: a Codex agent thread opens and forks with its native shells off', async () => {
  const fake = codexModel();
  const e = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir: string) => dir });
  const { input } = turnInput({ callTool: async () => ({ content: [{ type: 'text', text: 'exit 0' }] }) });
  const first = await e.run(input);
  await e.fork({ runId: 'run_w1', agentId: 'ag_1', account: account(), parentRef: first.session!.ref, cwd: '/work', model: 'gpt-test' });
  for (const method of ['thread/start', 'thread/fork']) {
    const [opened] = fake.sent(method);
    const features = opened.params.config?.features ?? {};
    for (const name of NATIVE_SHELLS) assert.equal(features[name], false, `${method}: ${name} off`);
  }
  await e.dispose();
});

test('18.11: shell.exec returns a catalog value and a live key only as markers – in the model\'s request, the run journal and the chat line', async () => {
  const h = await hub();
  const fake = codexModel();
  const e = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir: string) => dir });
  const { input } = turnInput({ tools: [{ name: 'shell.exec', description: h.exec.description, inputSchema: h.exec.inputSchema }], callTool: h.callTool });
  const result = await e.run(input);
  assert.equal(result.stop, 'done');

  const [reply] = fake.replies;
  const request = JSON.stringify(reply);
  assert.ok(!raw(request), 'the model\'s request holds no raw value');
  assert.ok(request.includes(h.handle), 'the catalog value as its handle');
  assert.match(request, /‹secret:stripe-[^›]+›/, 'the live key by its shape');

  const journal = JSON.stringify(h.items);
  assert.ok(h.items.some((item) => item.kind === 'tool_result'), 'the call is journaled');
  assert.ok(!raw(journal), 'the journal holds no raw value');
  assert.ok(journal.includes(h.handle));

  assert.ok(!raw(result.text), 'the chat line (the answer quoting the output) holds no raw value');
  assert.ok(result.text.includes(h.handle) && /‹secret:stripe-[^›]+›/.test(result.text));
  await e.dispose();
});

test('18.11: a journal row of a native shell call from before is never replayed into a rebuilt Claude or Codex session', () => {
  const leaked = `DATABASE_PASSWORD=${CATALOG}\nSTRIPE_SECRET_KEY=${STRIPE}\n`;
  const items: RebuildItem[] = [
    { itemId: 'm1', kind: 'm', role: 'user', text: '[18.11. 10:00] Stanislaus: check the payment setup' },
    { itemId: 't2', kind: 't', role: 'tool', text: '', call: { own: true, name: 'Bash', args: { command: 'cat .env' }, callId: 'toolu_1', output: leaked }, origin: { engine: 'claude' } },
    { itemId: 't3', kind: 't', role: 'tool', text: '', call: { own: true, name: 'shell', args: { command: ['cat', '.env'] }, callId: 'call_2', output: leaked }, origin: { engine: 'codex' } },
    { itemId: 'a4', kind: 'a', role: 'assistant', text: 'The payment setup is complete.' },
  ];
  const offered = new Set(['shell.exec']);
  const claude = JSON.stringify(transcriptMessages(items, { offered, accountId: 'acc_claude', model: 'claude-opus-5-5', platform: 'win32' }));
  const codex = JSON.stringify(responseItems(items, { offered, accountId: 'acc_test', model: 'gpt-test', platform: 'win32' }));
  for (const [name, text] of [['Claude', claude], ['Codex', codex]]) {
    assert.ok(!raw(text), `${name}: no raw value`);
    assert.ok(!text.includes('cat .env'), `${name}: not even the command`);
    assert.match(text, /payment setup is complete/, `${name}: the rest of the history stays`);
  }
});
