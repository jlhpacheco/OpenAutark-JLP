// B-049 F2: every Claude Code turn starts one way – our stable prompt replaces Claude Code's (`--system-prompt-file`), built-in
// tools cut to the execution core for an agent turn and to none for a helper turn (`--tools`), no skills/slash commands, no hooks
// (`--settings`), no CLAUDE.md/auto memory/git workflow text (env), the hub's tools upfront (alwaysLoad). The live context is the
// first block of every user message, never in the prompt file. A CLI that refuses a flag fails the turn (no second form).
// Owns: nothing in production. Never starts a real binary (scripted CLI from claude-fixture.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ENV, CORE_TOOLS, HUB_CALL_MS, LEAN_ENV, LEAN_SETTINGS, coreTools, promptArgs } from '../../../src/runtime/engines/claude/lean.ts';
import { CLAUDE_AUTOCOMPACT } from '../../../src/runtime/agents/compaction-policy.ts';
import { tick, turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup, until } from './claude-fixture.ts';

const HUB = { url: 'http://127.0.0.1:4555/mcp', token: 'hub-token-for-test' };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), cwd: '/fake-home/Workforce', ...patch });

function assertLean(args: string[], label: string, tools: string[] = coreTools()): void {
  assert.ok(flag(args, '--system-prompt-file'), `${label}: our prompt replaces Claude Code's`);
  assert.equal(args.includes('--append-system-prompt-file'), false, `${label}: nothing appended to Claude Code's prompt`);
  assert.equal(args.filter((arg) => arg === '--tools').length, 1, `${label}: one tool list`);
  assert.deepEqual(flag(args, '--tools')!.split(',').filter(Boolean), tools, `${label}: only these built-in tools`);
  assert.ok(args.includes('--disable-slash-commands'), `${label}: no skills or slash commands`);
  assert.deepEqual(JSON.parse(flag(args, '--settings')!), { disableAllHooks: true }, `${label}: only a narrowing setting`);
}

test('claude lean: the core tools offer file operations and search, but never a native shell', () => {
  assert.deepEqual([...CORE_TOOLS], ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  assert.deepEqual(coreTools('linux'), ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  assert.deepEqual(coreTools('darwin'), ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  assert.deepEqual(coreTools('win32'), ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  for (const gone of ['Bash', 'PowerShell', 'WebFetch', 'Agent', 'Task', 'TodoWrite', 'TaskCreate', 'NotebookEdit', 'Skill', 'ToolSearch', 'Monitor', 'CronCreate', 'LSP']) {
    assert.equal(coreTools('win32').includes(gone), false, `${gone} is not offered`);
  }
  assert.deepEqual(promptArgs('/p.md', coreTools('linux')), ['--system-prompt-file', '/p.md', '--tools', 'Read,Edit,Write,Glob,Grep,WebSearch', '--disable-slash-commands', '--settings', LEAN_SETTINGS]);
  assert.deepEqual(promptArgs(undefined, []), ['--tools', '', '--disable-slash-commands', '--settings', LEAN_SETTINGS], 'no prompt: Claude Code\'s own, still no built-in tool');
});

test('claude lean: a new hub turn – the stable prompt only, the live context first in the message, core tools, hub upfront, no CLAUDE.md/memory/git text', async () => {
  const h = claudeSetup();
  const result = await h.engine.run(input({ mcp: HUB }).input);
  assert.equal(result.stop, 'done');
  const [call] = h.cli.of('turn');
  assertLean(call.args, 'hub turn');
  assert.equal(h.written.get(flag(call.args, '--system-prompt-file')!), 'STABLE', 'never the live context in the prompt file');
  const user = call.child.lines.find((line: any) => line?.type === 'user') as any;
  assert.equal(user.message.content[0].text, '<live>\nVOLATILE\n</live>', 'a new session gets it in the message too');
  const config = JSON.parse(h.written.get(flag(call.args, '--mcp-config')!)!);
  assert.equal(config.mcpServers.workforce.alwaysLoad, true, 'startup waits for the hub, its tools are in the first request');
  assert.equal(config.mcpServers.workforce.timeout, HUB_CALL_MS, 'a long hub call is not cut at the CLI\'s 60 s');
  assert.equal(flag(call.args, '--permission-mode'), 'bypassPermissions', 'Claude Code never asks');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.deepEqual(flag(call.args, '--setting-sources'), 'user');
  for (const [name, value] of Object.entries(LEAN_ENV)) assert.equal(call.options.env?.[name], value, `${name}=${value}`);
  assert.deepEqual(Object.keys(LEAN_ENV).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS']);
  assert.deepEqual(AGENT_ENV, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  assert.equal(call.options.env?.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h', 'KI-Runde 17.11.2026: an agent turn asks for the one-hour cache, whatever login the account has');
  assert.equal(call.options.env?.CLAUDE_CODE_DISABLE_CRON, '1', 'the CLI cron stays off');
  assert.equal(call.args.includes('--autocompact'), false, 'no CLI version known yet: the turn runs as before');
});

test('claude lean (Runde "Halb"): --autocompact once the CLI\'s --help lists it – one look per version, never in a turn\'s way; a CLI without it runs as before', async () => {
  const h = claudeSetup({ version: '2.1.329', help: '  --autocompact <auto|tokens>  Auto-compact window size\n' });
  await h.engine.run(input({ mcp: HUB }).input);
  await until(() => h.cli.of('help').length > 0);
  await tick(); await tick();
  await h.engine.run(input({ runId: 'run_2', mcp: HUB }).input);
  await h.engine.run(input({ runId: 'run_3', tools: [] }).input);
  const [first, second, helper] = h.cli.of('turn');
  assert.equal(first.args.includes('--autocompact'), false, 'the first turn names the version; the look runs after it');
  assert.equal(flag(second.args, '--autocompact'), String(CLAUDE_AUTOCOMPACT), 'the session compacts near the run ceiling, not at the window\'s edge');
  assert.equal(helper.args.includes('--autocompact'), false, 'a helper turn keeps Claude Code\'s own window');
  assert.equal(h.cli.of('help').length, 1, 'one look per CLI version');

  const old = claudeSetup({ version: '2.1.200' });
  await old.engine.run(input({ mcp: HUB }).input);
  await until(() => old.cli.of('help').length > 0);
  await tick(); await tick();
  const result = await old.engine.run(input({ runId: 'run_2', mcp: HUB }).input);
  assert.equal(result.stop, 'done');
  assert.equal(old.cli.of('turn')[1].args.includes('--autocompact'), false, 'a CLI that does not list the flag never gets it');
});

test('claude lean: a resumed hub turn has the same prompt file; the live context travels in the message', async () => {
  const h = claudeSetup();
  const fresh = await h.engine.run(input({ mcp: HUB }).input);
  const resumed = await h.engine.run(input({ runId: 'run_2', mcp: HUB, session: fresh.session }).input);
  assert.equal(resumed.stop, 'done');
  const second = h.cli.of('turn')[1];
  assertLean(second.args, 'resumed turn');
  assert.equal(flag(second.args, '--resume'), fresh.session!.ref);
  assert.equal(h.written.get(flag(second.args, '--system-prompt-file')!), 'STABLE');
  const user = second.child.lines.find((line: any) => line?.type === 'user') as any;
  assert.equal(user.message.content[0].text, '<live>\nVOLATILE\n</live>');
});

test('claude lean: an agent turn without the hub is lean too (nothing that would prompt runs: --permission-prompts none)', async () => {
  const h = claudeSetup();
  await h.engine.run(input().input);
  const [call] = h.cli.of('turn');
  assertLean(call.args, 'turn without hub');
  assert.equal(flag(call.args, '--permission-prompts'), 'none');
  assert.equal(call.args.includes('--no-session-persistence'), false);
});

test('claude lean: helper turns run on our system prompt only, with no built-in tool, without CLAUDE.md and memory', async () => {
  const h = claudeSetup();
  await h.engine.run(input({ tools: [] }).input);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  await h.engine.run(input({ runId: 'run_2', tools: [], outputSchema: schema }).input);
  const [reader, decision] = h.cli.of('turn');
  for (const [call, label] of [[reader, 'helper turn'], [decision, 'schema turn']] as const) {
    assertLean(call.args, label, []);
    assert.ok(call.args.includes('--no-session-persistence'), `${label}: no transcript`);
    for (const [name, value] of Object.entries(LEAN_ENV)) assert.equal(call.options.env?.[name], value);
    assert.equal(call.options.env?.CLAUDE_CODE_PROMPT_CACHE_TTL, undefined, `${label}: never resumed – it keeps Claude Code's own cache lifetime`);
    assert.equal(call.args.includes('--autocompact'), false, `${label}: short, it keeps Claude Code's own compact window`);
  }
  assert.equal(h.written.get(flag(reader.args, '--system-prompt-file')!), 'STABLE');
});

test('claude lean: a helper turn without a system prompt runs on Claude Code\'s own, still without any built-in tool', async () => {
  const h = claudeSetup();
  await h.engine.run(input({ tools: [], system: { stable: '', volatile: '' } }).input);
  const [call] = h.cli.of('turn');
  assert.equal(flag(call.args, '--system-prompt-file'), undefined);
  assert.equal(call.args.includes('--append-system-prompt-file'), false);
  assert.equal(flag(call.args, '--tools'), '', 'no built-in tool at all');
});

test('claude lean: an agent turn with an output schema starts the same way (the schema keeps its answer tool)', async () => {
  const h = claudeSetup({ turn: (_call, session) => [{ type: 'result', subtype: 'success', is_error: false, result: '{}', structured_output: { ok: true }, session_id: session }] });
  await h.engine.run(input({ mcp: HUB, outputSchema: { type: 'object' } }).input);
  const [call] = h.cli.of('turn');
  assertLean(call.args, 'agent schema turn');
  assert.ok(flag(call.args, '--json-schema'));
});

test('claude lean: a CLI that refuses a flag fails the turn clearly – no second start in another form', async () => {
  const h = claudeSetup({ refuse: () => true });
  const failed = await h.engine.run(input({ mcp: HUB }).input);
  assert.equal(failed.stop, 'error');
  assert.match(failed.error?.message ?? '', /older than Autark needs/, 'says that updating Claude Code fixes it');
  assert.equal(h.cli.of('turn').length, 1, 'one start');
  assert.ok(h.removed.includes(flag(h.cli.of('turn')[0].args, '--system-prompt-file')!), 'temp files deleted');
});
