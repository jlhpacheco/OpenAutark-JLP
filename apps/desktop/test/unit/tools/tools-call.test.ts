// B-049 F4 (TOOLS-CORE) – tools.call and tools.find through the real registry pipeline (validation, run journal):
// - tools.call runs its target under the target's name and the call's id: the same validation message, journal items
//   and result as a direct call; a resend of that id gets the same result without a second run;
// - it runs every tool that can work here, in every mode (KI-Runde 17.11.2026), never itself; phone.* without a linked
//   phone is refused with the reason and the refusal is journaled; B-080: every engine reaches the same tools – Codex
//   runs files.write and, in browser mode, shell.exec with a handle in its env (the value masked in what comes back);
// - a non-core target is noted for this agent and chat and joins the offer only at promotion (never mid-session);
// - tools.find ranks by name, keywords and description, shows a full schema for an exact name, marks direct tools
//   and lists the families when nothing fits; name normalisation accepts wire and hub names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { setup, tool } from './helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { metaTools, callTarget, calledTool, normalizeName, compactArgs, purpose } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { MAX_LEARNED, learnedTools, noteLearned, promoteLearned } from '../../../src/runtime/tools/learned.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { fileTools, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';

/** A call that hangs must fail the test, never hang the run (B-050 log). */
const BOUNDED = { timeout: 10_000 };
const textOf = (output: ToolOutput) => output.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function rig(engine?: { ownTools: boolean; dynamicTools: boolean }) {
  const h = setup();
  const services = h.services as RuntimeServices;
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  services.runs = runs as unknown as RuntimeServices['runs'];
  services.modes = new ModeLibrary({ resources: path.resolve('resources'), clock: h.clock }) as unknown as RuntimeServices['modes'];
  services.dispatcher = { activity: () => (engine ? [{ agentId: 'ag_tom', runId: 'run_1', note: '', startedAt: 0, engine: 'eng' }] : []) } as unknown as RuntimeServices['dispatcher'];
  services.engines = { get: () => ({ caps: { ...engine } }) } as unknown as RuntimeServices['engines'];
  const registry = new Registry({ services: () => services });
  services.tools = registry;
  let jots = 0;
  for (const entry of metaTools) registry.register(entry);
  registry.register(tool('notes.jot', 'write_local', {
    description: 'Write a short jot into your notebook. Keeps it for later.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, pinned: { type: 'boolean' } }, required: ['text'], additionalProperties: false },
    describe: (args) => ({ summary: `Jot ${String((args as { text: string }).text)}`, reversible: true, external: false }),
    run: async (args) => { jots++; return { content: [{ type: 'text', text: `jotted ${String((args as { text: string }).text)} #${jots}` }] }; },
  }));
  registry.register(tool('tasks.remind', 'think', {
    description: 'Private reminder: at that time you get a turn with your own note (no chat post).',
    inputSchema: { type: 'object', properties: { at: { type: 'string' }, note: { type: 'string' }, repeat: { type: 'string', enum: ['daily', 'weekly'] } }, required: ['at', 'note'] },
  }));
  // 'think' like the real chat.read (tools/builtin/chat.ts).
  registry.register(tool('chat.read', 'think', { description: 'Post a message into a chat you are a member of.' }));
  registry.register(tool('computer.click', 'device', { description: 'Click at a point on the screen.', requires: 'device' }));
  registry.register(tool('phone.say', 'device', { description: 'Asks the person for a moment of their phone.', requires: 'device' }));
  registry.register(tool('files.write', 'write_local', { description: 'Create or overwrite a text file.' }));
  runs.start({ id: 'run_1', agentId: 'ag_tom', conversationId: h.chat.id, trigger: 'message' });
  const base: Omit<ToolContext, 'services'> = { agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  const items = () => runs.items('run_1').filter((item) => item.kind === 'tool_call' || item.kind === 'tool_result').map((item) => [item.kind, item.name, (item.data as { callId?: string }).callId]);
  return { h, services, registry, base, items, jots: () => jots };
}

test('tools.call runs its target as a direct call would: real name, same validation, same journal, one run per call id', BOUNDED, async () => {
  const { registry, base, items, jots } = rig();
  const direct = await registry.call('notes.jot', { text: 'a' }, base, 'c1');
  const via = await registry.call('tools.call', { name: 'notes.jot', args: { text: 'b' } }, base, 'c2');
  assert.equal(textOf(direct), 'jotted a #1');
  assert.equal(textOf(via), 'jotted b #2');
  assert.deepEqual(items(), [['tool_call', 'notes.jot', 'c1'], ['tool_result', 'notes.jot', 'c1'], ['tool_call', 'notes.jot', 'c2'], ['tool_result', 'notes.jot', 'c2']], 'journaled under the real name, no tools.call step');

  const wrongDirect = await registry.call('notes.jot', { text: '' }, base, 'c3');
  const wrongVia = await registry.call('tools.call', { name: 'notes.jot', args: { text: '' } }, base, 'c4');
  assert.equal(textOf(wrongVia), textOf(wrongDirect), 'identical validation');
  assert.match(textOf(wrongVia), /^Invalid arguments for notes\.jot/);

  const again = await registry.call('tools.call', { name: 'notes.jot', args: { text: 'b' } }, base, 'c2');
  assert.equal(textOf(again), 'jotted b #2', 'a resend of the call id gets its result');
  assert.equal(jots(), 2, 'and runs nothing twice');
});

test('tools.call runs every tool that can work here, in every mode, never itself; a refusal is journaled; every engine reaches the same tools', BOUNDED, async () => {
  const { registry, base, items } = rig();
  assert.ok(!(await registry.call('tools.call', { name: 'computer.click', args: {} }, base, 'r1')).isError, 'a device tool in general mode');
  const phone = await registry.call('tools.call', { name: 'phone.say', args: {} }, base, 'r0');
  assert.ok(phone.isError);
  assert.match(textOf(phone), /^phone\.say needs a linked phone/);
  assert.deepEqual(items().filter((item) => item[2] === 'r0'), [['tool_call', 'phone.say', 'r0'], ['tool_result', 'phone.say', 'r0']], 'the refused call is journaled under its name');
  assert.match(textOf(await registry.call('tools.call', { name: 'no.such', args: {} }, base, 'r2')), /^Unknown tool "no\.such"/);
  assert.match(textOf(await registry.call('tools.call', { name: 'tools.call', args: { name: 'notes.jot' } }, base, 'r3')), /not itself/);
  assert.match(textOf(await registry.call('tools.call', { args: {} }, base, 'r4')), /needs the tool's name/);

  const http = rig({ ownTools: false, dynamicTools: true });
  assert.ok(!(await http.registry.call('tools.call', { name: 'files.write', args: {} }, http.base, 'r6')).isError, 'an engine without own tools may write files');
  const codex = rig({ ownTools: true, dynamicTools: true });
  assert.ok(!(await codex.registry.call('tools.call', { name: 'files.write', args: {} }, codex.base, 'r7')).isError, 'Codex runs files.write through tools.call');
});

test('Codex in browser mode finds shell.exec by name and by "secret env", and runs it with the value masked', BOUNDED, async () => {
  const { h, services, registry, base } = rig({ ownTools: true, dynamicTools: true });
  const host = { encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a), decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8') };
  const vault = new SecretVault({ db: h.db, host, clock: h.clock });
  services.secrets = vault as unknown as RuntimeServices['secrets'];
  const spawned: Array<NodeJS.ProcessEnv | undefined> = [];
  // "print NAME" writes that env value – what a command could show.
  const shell: ShellSpawn = (command, options) => {
    spawned.push(options.env);
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr: null, kill: () => true });
    setImmediate(() => { stdout.emit('data', Buffer.from(`value ${String(options.env?.[command.slice(6)] ?? '')}\n`)); child.emit('close', 0); });
    return child as unknown as ReturnType<ShellSpawn>;
  };
  registry.register(fileTools({ shell }).find((entry) => entry.name === 'shell.exec')!);
  for (const entry of secretTools) registry.register(entry);
  const browser = { ...base, mode: 'browser' };

  assert.match(textOf(await registry.call('tools.find', { query: 'shell.exec' }, browser, 's1')), /^shell\.exec – Runs a shell command on this PC or a linked PC, with stored secrets/);
  const asked = textOf(await registry.call('tools.find', { query: 'run command with secret env', limit: 1 }, browser, 's2')).split('\n');
  assert.match(asked[1], /^- shell\.exec \(in my list\): /, asked.join('\n'));
  assert.match(asked[2], /^ {2}Arguments: \{"type":"object"/, 'the best hit carries its whole schema');
  assert.equal(asked.length, 3, 'limit 1: shell.exec alone');

  const key = await vault.save({ label: 'Mail password', kind: 'password', value: 'pw-imap-0042-secret' });
  const out = await registry.call('tools.call', { name: 'shell.exec', args: { command: 'print P', env: { P: `secret://${key.id}` } } }, browser, 's3');
  assert.ok(!out.isError, textOf(out));
  assert.equal(spawned.at(-1)?.P, 'pw-imap-0042-secret', 'the command gets the value');
  assert.ok(!textOf(out).includes('pw-imap-0042-secret') && textOf(out).includes(`value secret://${key.id}`), 'what comes back has it masked');
});

test('learned from use: a non-core target that succeeded waits for the next promotion; failed and core targets are not noted; bounded', BOUNDED, async () => {
  const { h, registry, base, services } = rig();
  const chat = h.chat.id;
  assert.ok((await registry.call('tools.call', { name: 'notes.jot', args: { text: '' } }, base, 'l0')).isError, 'invalid arguments');
  assert.equal(promoteLearned(services, 'ag_tom'), false, 'a failed call takes no learned slot');
  await registry.call('tools.call', { name: 'notes.jot', args: { text: 'x' } }, base, 'l1');
  await registry.call('tools.call', { name: 'chat.read', args: {} }, base, 'l2');
  assert.deepEqual(learnedTools(h.db, 'ag_tom'), [], 'nothing joins mid-session');
  const offer = () => registry.offerFor(base.agent, services.modes.get('general'), { ownTools: true, via: 'native' }, learnedTools(h.db, 'ag_tom')).map((spec) => spec.name);
  const before = offer();
  assert.ok(!before.includes('notes.jot'));
  assert.equal(promoteLearned(services, 'ag_tom'), true);
  assert.deepEqual(learnedTools(h.db, 'ag_tom'), ['notes.jot'], 'chat.read is core: not noted');
  assert.deepEqual(offer(), [...before, 'notes.jot'].sort(), 'it joins the offer from the next fresh session on');
  assert.equal(promoteLearned(services, 'ag_tom'), false, 'nothing new');
  assert.deepEqual(learnedTools(h.db, 'ag_other'), [], 'per agent');

  for (let index = 0; index < MAX_LEARNED + 3; index++) noteLearned(services, 'ag_tom', `x.tool${index}`);
  promoteLearned(services, 'ag_tom');
  const kept = learnedTools(h.db, 'ag_tom');
  assert.equal(kept.length, MAX_LEARNED);
  assert.equal(kept.at(-1), `x.tool${MAX_LEARNED + 2}`, 'the newest kept');
});

test('tools.find: best fit first, direct tools marked, full schema for a name, families when nothing fits; every tool that can work here', BOUNDED, async () => {
  const { registry, base } = rig();
  const remind = textOf(await registry.call('tools.find', { query: 'remind me tomorrow to call the bank' }, base, 'f1'));
  const lines = remind.split('\n');
  assert.equal(lines[1], '- tasks.remind (in my list): Private reminder: at that time you get a turn with your own note (no chat post).');
  assert.match(lines[2], /^ {2}Arguments: \{"type":"object","properties":\{"at":/, 'one find is enough: the best hit with its whole schema');
  assert.ok(lines.slice(3).every((line) => line.includes(' Arguments: ')), 'every other hit with its arguments');
  assert.ok(!remind.includes('computer.click'));

  const post = textOf(await registry.call('tools.find', { query: 'post a message' }, base, 'f2'));
  assert.match(post, /- chat.read \(in my list\): Post a message/);

  const exact = textOf(await registry.call('tools.find', { query: 'notes__jot' }, base, 'f3'));
  assert.match(exact, /^notes\.jot – Write a short jot/);
  assert.match(exact, /\nArguments: \{"type":"object"/);
  assert.equal(exact.split('"required"').length, 2, 'the arguments once');
  assert.match(exact, /tools\.call \{"name": "notes\.jot"/);

  const none = textOf(await registry.call('tools.find', { query: 'zzz qqq' }, base, 'f4'));
  assert.match(none, /^Nothing fits "zzz qqq"\. I can use these here: .*notes\.jot/);
  assert.ok(none.includes('computer.click'), 'every mode reaches the device tools');
  assert.ok(!none.includes('phone.say'), 'never a tool that cannot work here');
  assert.match(textOf(await registry.call('tools.find', { query: 'phone.say' }, base, 'f5')), /^phone\.say needs a linked phone/, 'its name says why');

  // B-049 F8: the one-line purpose is the first sentence – an "e.g." / "i.e." inside it does not cut it short.
  assert.equal(purpose('Hand the task on (e.g. to a writer) or switch modes. Then wait.'), 'Hand the task on (e.g. to a writer) or switch modes.');
  assert.equal(purpose('Change one setting, i.e. a path from settings.get. More.'), 'Change one setting, i.e. a path from settings.get.');
  assert.equal(purpose('Read a file. More.'), 'Read a file.');
});

test('names and arguments: wire and hub names, arguments beside the name, the compact argument line', () => {
  assert.equal(normalizeName('ui__help'), 'ui.help');
  assert.equal(normalizeName('mcp__workforce__browser__save_secret'), 'browser.save_secret');
  assert.deepEqual(callTarget({ name: 'notes.jot', text: 'hi' }), { name: 'notes.jot', args: { text: 'hi' } });
  assert.deepEqual(callTarget({ name: 'notes.jot', args: '{"text":"hi"}' }), { name: 'notes.jot', args: { text: 'hi' } });
  assert.ok('error' in callTarget({ name: 'notes.jot', args: { text: 'a' }, extra: 1 }));
  assert.deepEqual(calledTool('tools.call', { name: 'human.ask', args: { title: 'x' } }), { name: 'human.ask', args: { title: 'x' } });
  assert.deepEqual(calledTool('chat.send', { body: 'x' }), { name: 'chat.send', args: { body: 'x' } });
  assert.equal(compactArgs({ type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, kinds: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }, required: ['query'] }),
    'query*: string, limit: integer 1–20, kinds: (a|b)[]');
});
