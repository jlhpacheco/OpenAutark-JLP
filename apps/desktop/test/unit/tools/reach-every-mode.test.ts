// KI-Runde 17.11.2026 (package T): every tool is in reach from every mode, a linked phone is visible and usable.
// - an agent in mode manager reaches phone.say and browser.open through tools.call; phone.* waits for a linked phone,
//   and the refusal before it says why and is journaled;
// - a refused call journals only the keys its tool's schema declares, minus what the tool hides, and none of a tool that
//   hides arguments when its arguments were refused;
// - tools.find answers "phone read sms notifications" with a phone tool, names a meta tool by its own name, and says
//   why a phone question finds no phone tool;
// - "My environment now" names a linked phone, its phone use and the PC it hangs off; devices.list lists it;
// - the core set holds the tools every agent looked up by name; the More-tools list opens with the engine's own names.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, tool } from './helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { MORE_TOOLS_HEADER, cannotWork, howToCall, metaTools, moreToolsSection } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { BASE_CORE, NO_OWN_TOOLS_CORE, coreNames } from '../../../src/runtime/tools/core-sets.ts';
import { phoneTools } from '../../../src/runtime/phone/tools.ts';
import { devicesList } from '../../../src/runtime/devices/list-tool.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { offeredTools, phonesLine } from '../../../src/runtime/context/environment.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const BOUNDED = { timeout: 10_000 };
const textOf = (output: ToolOutput) => output.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function rig() {
  const h = setup();
  const services = h.services as RuntimeServices;
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  services.runs = runs as unknown as RuntimeServices['runs'];
  services.modes = new ModeLibrary({ resources: path.resolve('resources'), clock: h.clock }) as unknown as RuntimeServices['modes'];
  services.dispatcher = { activity: () => [] } as unknown as RuntimeServices['dispatcher'];
  services.engines = { get: () => ({ caps: {} }) } as unknown as RuntimeServices['engines'];
  services.devices = { self: () => ({ id: 'dev_self', name: 'Desk' }), list: () => [], call: async () => null } as unknown as RuntimeServices['devices'];
  const registry = new Registry({ services: () => services });
  services.tools = registry;
  for (const entry of metaTools) registry.register(entry);
  const asked: string[] = [];
  const driver = { say: async (_serial: unknown, text: string) => { asked.push(text); return { serial: 'dev_phone', answer: 'yes' }; } };
  for (const entry of phoneTools(driver as never)) registry.register(entry);
  registry.register(tool('browser.open', 'device', { description: 'Opens a page in my own browser.', requires: 'device', run: async () => ({ content: [{ type: 'text', text: 'opened' }] }) }));
  registry.register(tool('secrets.save', 'write_local', {
    description: 'Puts a password into the catalog.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
    run: async () => ({ content: [{ type: 'text', text: 'saved' }] }),
  }));
  registry.register(devicesList());
  runs.start({ id: 'run_1', agentId: 'ag_tom', conversationId: h.chat.id, trigger: 'message' });
  const base: Omit<ToolContext, 'services'> = { agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'manager', signal: new AbortController().signal, status: () => {} };
  const link = () => new DevicesRepo(h.db).upsert({
    id: 'dev_phone', name: 'samsung SM-S918B', kind: 'phone', role: 'client', fingerprint: 'fp', publicKey: 'key', addresses: [], caps: {}, status: 'online', self: false,
  });
  const items = (callId: string) => runs.items('run_1').filter((item) => (item.data as { callId?: string }).callId === callId).map((item) => [item.kind, item.name, (item.data as { ok?: boolean }).ok]);
  const journaled = (callId: string) => runs.items('run_1').filter((item) => item.kind === 'tool_call' && (item.data as { callId?: string }).callId === callId)
    .map((item) => ({ name: item.name, args: JSON.parse(String((item.data as { args?: unknown }).args)) as unknown })); // the journal keeps a JSON preview
  return { h, services, registry, base, link, asked, items, journaled };
}

test('mode manager reaches phone.say and browser.open through tools.call; phone.* waits for a linked phone and says why', BOUNDED, async () => {
  const { registry, base, link, asked, items } = rig();
  const opened = await registry.call('tools.call', { name: 'browser.open', args: {} }, base, 'c1');
  assert.ok(!opened.isError, textOf(opened));

  const before = await registry.call('tools.call', { name: 'phone.say', args: { text: 'Kurz dein Handy?', ask: true } }, base, 'c2');
  assert.ok(before.isError);
  assert.match(textOf(before), /^phone\.say needs a linked phone/);
  assert.deepEqual(items('c2'), [['tool_call', 'phone.say', undefined], ['tool_result', 'phone.say', false]], 'the refusal is journaled as a failed call');

  link();
  const said = await registry.call('tools.call', { name: 'phone.say', args: { text: 'Kurz dein Handy?', ask: true } }, base, 'c3');
  assert.ok(!said.isError, textOf(said));
  assert.match(textOf(said), /✓/);
  assert.deepEqual(asked, ['Kurz dein Handy?']);
});

test('a refused call journals only declared keys, minus hidden ones, and nothing of a hiding tool whose arguments were refused', BOUNDED, async () => {
  const { registry, base, journaled } = rig();
  const shapes = [
    ['j1', { name: 'secrets.save', args: { name: 'bank', value: 'PlainPw-12345' }, why: 'x' }], // a key beside args: no target
    ['j2', { name: 'secret.save', args: { name: 'bank', value: 'PlainPw-67890' } }], // a name I do not have
  ] as const;
  for (const [callId, args] of shapes) {
    const out = await registry.call('tools.call', args, base, callId);
    assert.equal(out.isError, true, textOf(out));
    assert.deepEqual(journaled(callId).map((row) => row.args), [{}], `${callId}: ${JSON.stringify(journaled(callId))}`);
    assert.doesNotMatch(JSON.stringify(journaled(callId)), /PlainPw/);
  }
  // A tool that hides arguments journals none of them when its arguments were refused, whatever key carries the value.
  const refusedArgs = [
    ['j3', 'tools.call', { name: 'secrets.save', args: { name: 5, value: 'PlainPw-1' } }],
    ['j5', 'secrets.save', { name: 'bank', password: 'PlainPw-2' }],
    ['j6', 'tools.call', { name: 'secrets.save', args: { name: 'bank', secret: 'PlainPw-3' } }],
  ] as const;
  for (const [callId, name, args] of refusedArgs) {
    const out = await registry.call(name, args, base, callId);
    assert.equal(out.isError, true, textOf(out));
    assert.deepEqual(journaled(callId), [{ name: 'secrets.save', args: {} }], callId);
  }
  // Refused for another reason, a tool journals only the keys its schema declares, under its own HIDDEN_ARGS.
  const cannot = await registry.call('phone.say', { text: 'Hallo', pin: 'PlainPw-4' }, base, 'j7');
  assert.equal(cannot.isError, true, textOf(cannot));
  assert.deepEqual(journaled('j7'), [{ name: 'phone.say', args: { text: 'Hallo' } }]);

  const unknown = await registry.call('nope.nope', {}, base, 'j4');
  assert.equal(textOf(unknown), 'Unknown tool "nope.nope". tools.find lists what I can use here.');
});

test('one offer reads the linked phones once, however many phone tools are registered', BOUNDED, () => {
  const { h, services, registry } = rig();
  let reads = 0;
  const list = services.devices.list;
  services.devices = { ...services.devices, list: () => { reads += 1; return list(); } } as RuntimeServices['devices'];
  const specs = registry.specsFor(h.org.require('ag_tom'), services.modes.get('manager'));
  assert.ok(!specs.some((spec) => spec.name.startsWith('phone.')), 'no phone linked, none offered');
  assert.equal(reads, 1);
});

test('E.3: phone.* is offered where adb is installed on this PC or an app phone is linked; a cable alone moves nothing', BOUNDED, () => {
  const { h, services, registry, link } = rig();
  const phoneOffered = () => registry.specsFor(h.org.require('ag_tom'), services.modes.get('manager')).some((spec) => spec.name === 'phone.ui_tree');
  services.phones = { useOf: () => undefined, here: () => ({ app: [], adb: ['R5CT1234'] }), adbInstalled: () => false };
  assert.equal(phoneOffered(), false, 'a serial without adb here opens nothing');
  services.phones = { useOf: () => undefined, here: () => ({ app: [], adb: [] }), adbInstalled: () => true };
  assert.equal(phoneOffered(), true, 'adb installed, no phone on the cable: phone.* is offered and says itself that none is there');
  services.phones = { useOf: () => undefined, here: () => ({ app: [], adb: ['R5CT1234'] }), adbInstalled: () => true };
  assert.equal(phoneOffered(), true, 'plugging a phone in changes nothing in the offer');
  services.phones = { useOf: () => undefined, here: () => ({ app: [], adb: [] }), adbInstalled: () => false };
  link();
  assert.equal(phoneOffered(), true, 'a linked app phone, wherever it is');
});

test('why a tool cannot work here names the reason the registry judged by', () => {
  assert.match(cannotWork('phone.say'), /^phone\.say needs a linked phone/);
  assert.match(cannotWork('phone.say'), /needs a linked phone or adb on this PC.*adb is set up by an agent in computer mode \(skill phone-adb\)/, 'the ADB way names where it is set up');
  assert.equal(cannotWork('calls.join', { modes: ['computer', 'browser'] }), 'calls.join works in mode computer or browser.');
  assert.equal(cannotWork('files.read'), 'files.read cannot work here right now.');
});

test('tools.find: a phone tool for sms, a meta tool by its own name, and why a phone question finds none', BOUNDED, async () => {
  const { registry, base, link } = rig();
  const noPhone = textOf(await registry.call('tools.find', { query: 'sms code' }, base, 'f0'));
  assert.match(noPhone, /phone\.\* needs a linked phone/, noPhone);
  link();
  const found = textOf(await registry.call('tools.find', { query: 'phone read sms notifications' }, base, 'f1')).split('\n');
  assert.match(found[1], /^- phone\./, found.join('\n'));
  for (const query of ['authenticator code', 'sms code']) {
    const first = textOf(await registry.call('tools.find', { query }, base, `f-${query}`)).split('\n')[1];
    assert.match(first, /^- phone\.(key|ui_tree)\b/, `${query}: ${first}`); // the reading tools, not the ADB setup ones
  }
  for (const name of ['tools.call', 'tools.find']) {
    const answer = textOf(await registry.call('tools.find', { query: name }, base, `m-${name}`));
    assert.match(answer, new RegExp(`^${name.replace('.', '\\.')} – `), answer);
    assert.match(answer, /It is in my list: I call it directly\./);
  }
});

test('"My environment now" names the linked phone, its phone use and the PC it hangs off; devices.list lists it', BOUNDED, async () => {
  const { h, services, link } = rig();
  const manager = services.modes.get('manager');
  const offered = () => offeredTools(services, h.org.require('ag_tom'), manager);
  const line = () => phonesLine(services, offered());
  assert.equal(line(), '', 'no phone, no line');
  link();
  services.phones = { useOf: () => 'on', here: () => ({ app: ['dev_phone'], adb: [] }) };
  assert.match(line(), /^Linked phones: samsung SM-S918B \(the person's, Autark app, phone use on\) – phone\.\* works on a phone whose phone use is on \(an ADB phone always\); phone\.say with ask: true asks/);
  services.phones = { useOf: () => undefined, here: () => ({ app: [], adb: [] }) };
  assert.match(line(), /not connected right now/);

  // The phone's app is attached to my other PC: the line names that PC and how a call reaches it.
  services.devices = { ...services.devices, list: () => [{ id: 'dev_pc2', name: 'Laptop', kind: 'pc', status: 'online', self: false, caps: { appPhones: ['dev_phone'] } }] } as unknown as RuntimeServices['devices'];
  assert.match(line(), /samsung SM-S918B \(the person's, Autark app, on Laptop\).*one on another PC with device: that PC/);
  // An offline PC's last caps say nothing: its app phone is away, its ADB phone no longer counts.
  const devicesBefore = services.devices;
  services.devices = { ...services.devices, list: () => [{ id: 'dev_pc2', name: 'Laptop', kind: 'pc', status: 'offline', self: false, caps: { appPhones: ['dev_phone'], adbPhones: ['R9OLD'] } }] } as unknown as RuntimeServices['devices'];
  assert.doesNotMatch(line(), /on Laptop|R9OLD/);
  services.devices = devicesBefore;

  // An ADB phone attached here is named with where it hangs.
  services.phones = { useOf: () => undefined, here: () => ({ app: [], adb: ['R5CT1234'] }) };
  assert.match(line(), /R5CT1234 \(over ADB on this PC\)/);
  assert.ok(offered().has('phone.ui_tree'));

  const ctx = { agent: h.org.require('ag_tom'), runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => {} } as ToolContext;
  const listed = (await devicesList().run({}, ctx)).structured as { phones?: Array<{ name: string; via: string; pc?: string }> };
  assert.deepEqual(listed.phones?.map((phone) => [phone.name, phone.via, phone.pc]), [['samsung SM-S918B', 'Autark app', 'Laptop'], ['R5CT1234', 'ADB', 'Desk']]);
});

test('the core set holds the tools every agent looked up by name; the More-tools list opens with how a name is called', () => {
  for (const name of ['tasks.list', 'shell.exec', 'tasks.remind', 'memory.write', 'agents.split', 'agents.split_tell']) {
    assert.ok(Object.hasOwn(BASE_CORE, name), name);
    assert.ok(coreNames({ key: 'writing', tools: ['files.*'] }).has(name), `${name} in writing mode`);
  }
  assert.ok(!Object.hasOwn(NO_OWN_TOOLS_CORE, 'shell.exec'), 'once, in the base core');
  const one = [{ name: 'web.fetch', description: 'Reads a page.', inputSchema: {} }];
  const hub = moreToolsSection(one, new Set(['tools.call']), 'claude');
  assert.equal(hub.split('\n').slice(0, 2).join('\n'), `${MORE_TOOLS_HEADER}\n${howToCall('claude')}`);
  // The engine's own name for a tool, so a name from the list is never called as it is written here: Claude Code
  // knows ours under mcp__workforce__, every other engine by the wire name alone.
  assert.match(howToCall('claude'), /mcp__workforce__web__fetch\b.*mcp__workforce__tools__call/);
  for (const engine of ['codex', 'acp', 'anthropic', undefined]) {
    assert.match(howToCall(engine), /is web__fetch\b.*[^_]tools__call/, String(engine));
    assert.doesNotMatch(howToCall(engine), /mcp__workforce__/, String(engine));
  }
  assert.doesNotMatch(MORE_TOOLS_HEADER, /tools\.call/, 'the call line says it once');
});
