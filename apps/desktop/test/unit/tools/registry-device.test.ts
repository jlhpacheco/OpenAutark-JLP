// Choosing the PC a tool runs on (MP5): remote tools get the optional `device` argument (MCP
// tools/list shows it for remote tools only); the registry resolves it against devices.list,
// strips it, forwards the call to that PC and names the PC in the summary; unknown, revoked,
// ambiguous and non-PC devices are clear errors; agents.update sets the PC an agent works on.
// B-080: files.read and files.list are remote tools (forwarded like shell.exec, run there by runRemoteTool), a call from
// a linked PC reads by the same path rule (an absolute path anywhere on that PC), and devices.list pings before it answers
// (each ping waits at most PROBE_MS); without device, a home this PC does not forward to leaves the call on this PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { fileTools } from '../../../src/runtime/tools/builtin/files.ts';
import { sendFile } from '../../../src/runtime/devices/send-file.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { DEVICE_PROPERTY, type ToolContext, type ToolDef } from '../../../src/runtime/tools/types.ts';
import { deviceTools, runRemoteTool } from '../../../src/runtime/devices/tools.ts';
import { PROBE_MS } from '../../../src/runtime/devices/mesh.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { toMcpTool } from '../../../src/runtime/mcp/convert.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { BrowserService } from '../../../src/runtime/browser/service.ts';
import type { AdbPhone } from '../../../src/runtime/phone/adb.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import { agent } from '../chat/harness.ts';
import { ctxFor, setup } from './helpers.ts';

const pc = (id: string, name: string, extra: Partial<Device> = {}): Device => ({
  id, name, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: { computerUse: true }, status: 'online', self: false, ...extra,
});

const DEVICES: Device[] = [
  pc('dev_self', 'Laptop', { self: true }),
  pc('dev_tower', 'Tower', { lastSeenAt: Date.UTC(2026, 9, 20, 8, 0, 0) }),
  pc('dev_old', 'Attic', { status: 'revoked' }),
  { ...pc('dev_phone', 'Pixel'), kind: 'phone', role: 'client', caps: {} },
  pc('dev_pending', 'Studio', { status: 'pairing' }),
  pc('dev_twin1', 'Twin', { status: 'offline' }),
  pc('dev_twin2', 'Twin', { status: 'offline' }),
];

/** A devices row as DevicesRepo reads it (only `allow` carries joinedAs). */
const ROW = { name: 'Tower', kind: 'pc', role: 'home', fingerprint: 'fp_dev_tower', public_key: '', addresses: '[]', caps: '{}', status: 'online', self: 0, paired_at: null, last_seen_at: null, revoked_at: null, allow: '{}' };

const MODE = { key: 'computer', name: 'Computer', workspace: 'computer', tools: ['computer.*', 'browser.*', 'phone.*', 'devices.*', 'agents.*', 'screen.*'] } as unknown as ModeInfo;

interface Forwarded { deviceId: string; method: string; params: { name: string; args: Record<string, unknown> } }

/** `pinged`: the PCs devices.list pinged (only Tower answers); `waits`: how long each ping may wait for its answer. */
function fakeDevices(forwarded: Forwarded[], pinged: string[] = [], waits: Array<number | undefined> = []): RuntimeServices['devices'] {
  return {
    self: () => DEVICES[0],
    list: () => DEVICES,
    online: (id: string) => id === 'dev_self' || id === 'dev_tower',
    call: async (deviceId: string, method: string, params: unknown, _signal?: AbortSignal, timeoutMs?: number) => {
      if (method === 'ping') {
        pinged.push(deviceId);
        waits.push(timeoutMs);
        if (deviceId !== 'dev_tower') throw new WorkforceError('unavailable', 'not reachable', { details: { deviceId, reachable: false } });
        return { ok: true };
      }
      forwarded.push({ deviceId, method, params: params as Forwarded['params'] });
      return { content: [{ type: 'text', text: `ran on ${deviceId}` }] };
    },
  };
}

/** A remote tool that records local runs (where it ran and what it saw). */
function recorder(runs: Array<{ args: Record<string, unknown>; deviceId?: string }>): ToolDef {
  return {
    name: 'screen.peek', description: 'Peek at the screen', category: 'read', remote: true,
    inputSchema: { type: 'object', properties: { x: { type: 'integer' } }, additionalProperties: false },
    describe: () => ({ summary: 'Peek at the screen', reversible: true, external: false }),
    run: async (args, ctx) => { runs.push({ args, deviceId: ctx.deviceId }); return { content: [{ type: 'text', text: 'peeked here' }] }; },
  };
}

const deviceDefs = () => deviceTools({ computer: {} as ComputerService, browser: {} as BrowserService, phone: {} as AdbPhone });

function rig() {
  const forwarded: Forwarded[] = [];
  const pinged: string[] = [];
  const waits: Array<number | undefined> = [];
  const items: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const runs: Array<{ args: Record<string, unknown>; deviceId?: string }> = [];
  const services = {
    devices: fakeDevices(forwarded, pinged, waits),
    modes: { get: () => MODE },
    runs: { item: (_runId: string, item: { kind: string; data?: Record<string, unknown> }) => { items.push(item); return { id: `ri_${items.length}` }; }, updateItem: () => undefined },
    db: { get: () => undefined },
    secrets: { redact: (text: string) => text },
    files: { put: async () => ({ id: 'file_1' }) },
    org: { list: () => [], get: () => undefined },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  const defs = [...deviceDefs(), recorder(runs), ...agentTools];
  for (const tool of defs) registry.register(tool);
  const mira = agent('ag_1', 'Mira', { mode: 'computer' });
  const base = (extra: Partial<ToolContext> = {}) => ({ agent: mira, runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status: () => {}, ...extra });
  /** The summaries the journal kept, in call order. */
  const summaries = () => items.filter((item) => item.kind === 'tool_call').map((item) => String(item.data?.summary));
  return { registry, services, defs, forwarded, pinged, waits, summaries, items, runs, mira, base };
}

const textOf = (out: { content: Array<{ type: string; text?: string }> }) => out.content.map((part) => part.text ?? '').join('\n');
const props = (schema: Record<string, unknown>) => (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

test('MCP tools/list: remote tools get the optional device argument, other tools do not', () => {
  const { registry, defs, mira } = rig();
  const listed = registry.specsFor(mira, MODE, { ownTools: true, via: 'mcp' }).map(toMcpTool);
  const remote = listed.filter((tool) => registry.get(tool.title)?.remote);
  assert.ok(remote.length >= 20, 'computer.*, browser.* and phone.* are offered');
  for (const tool of listed) {
    const device = props(tool.inputSchema).device;
    if (registry.get(tool.title)?.remote) {
      assert.deepEqual(device, DEVICE_PROPERTY, tool.title);
      assert.ok(!((tool.inputSchema.required as string[] | undefined) ?? []).includes('device'), `${tool.title}: device is optional`);
    } else if (tool.title === 'agents.update') {
      assert.match(String(device?.description), /^The PC it works on: on one of the person's own PCs its turns run there too/, 'agents.update keeps its own device field');
    } else {
      assert.equal(device, undefined, `${tool.title} runs here and takes no device`);
    }
  }
  const windows = listed.find((tool) => tool.title === 'computer.windows')!;
  assert.equal(windows.inputSchema.additionalProperties, false, 'the schema stays strict');
  assert.equal(props(defs.find((tool) => tool.name === 'computer.windows')!.inputSchema).device, undefined, 'the definition itself is not changed');
  assert.match(registry.get('devices.list')!.description, /Tools with a device argument run on any of the PCs/);
  assert.throws(() => registry.register({ ...recorder([]), name: 'screen.own', inputSchema: { type: 'object', properties: { device: { type: 'string' } } } }), /must not define its own "device"/);
});

test('device names a linked PC: the call is forwarded there without the argument and the summary names the PC', async () => {
  const { registry, forwarded, summaries, items, base } = rig();
  const out = await registry.call('computer.windows', { device: ' tower ' }, base(), 'call_1');
  assert.equal(out.isError, undefined);
  assert.equal(textOf(out), 'ran on dev_tower');
  assert.deepEqual(forwarded.map((call) => [call.deviceId, call.method, call.params.name, call.params.args]), [['dev_tower', 'tools.call', 'computer.windows', {}]]);
  assert.deepEqual(summaries(), ['List open windows on Tower']);
  const journaled = items.find((item) => item.kind === 'tool_call')!;
  assert.equal(journaled.data?.device, 'Tower');
  assert.equal(String(journaled.data?.args).includes('device'), false);

  await registry.call('browser.open', { url: 'https://example.com/a', device: 'dev_tower' }, base(), 'call_2');
  assert.deepEqual(forwarded[1].params.args, { url: 'https://example.com/a' }, 'a device id works too');
  assert.equal(summaries()[1], 'Open https://example.com/a on Tower');
});

test("'this' or the own name runs here even when the agent works on another PC; no device uses the agent's PC", async () => {
  const { registry, forwarded, summaries, runs, base } = rig();
  const onTower = base({ deviceId: 'dev_tower' });
  assert.equal(textOf(await registry.call('screen.peek', { device: 'this', x: 1 }, onTower, 'call_1')), 'peeked here');
  assert.equal(textOf(await registry.call('screen.peek', { device: 'Laptop', x: 2 }, onTower, 'call_2')), 'peeked here');
  assert.deepEqual(runs, [{ args: { x: 1 }, deviceId: 'dev_self' }, { args: { x: 2 }, deviceId: 'dev_self' }]);
  assert.deepEqual(summaries(), ['Peek at the screen', 'Peek at the screen']);

  const out = await registry.call('screen.peek', { x: 3 }, onTower, 'call_3');
  assert.equal(textOf(out), 'ran on dev_tower');
  assert.deepEqual(forwarded.map((call) => [call.deviceId, call.params.args]), [['dev_tower', { x: 3 }]]);
  assert.equal(summaries()[2], 'Peek at the screen on Tower');
});

test('unknown, revoked, ambiguous and non-PC devices are clear errors and nothing runs', async () => {
  const { registry, forwarded, summaries, runs, base } = rig();
  const fails = async (args: Record<string, unknown>, pattern: RegExp, ctx = base(), tool = 'computer.windows') => {
    const out = await registry.call(tool, args, ctx, `call_${Math.random()}`);
    assert.equal(out.isError, true, JSON.stringify(args));
    assert.match(textOf(out), pattern);
  };
  await fails({ device: 'Kitchen' }, /^No linked PC is called "Kitchen"\. Linked PCs: Laptop, Tower, Studio, Twin, Twin\. devices\.list shows their names and ids/);
  await fails({ device: 'attic' }, /^Attic was removed, so it cannot run tools any more\./);
  await fails({ device: 'dev_old' }, /^Attic was removed/);
  await fails({ device: 'Pixel' }, /^"Pixel" is a phone, not a PC/);
  await fails({ device: 'Twin' }, /^Several linked PCs are called "Twin"\. Pass the device id/);
  await fails({ device: '' }, /device: too short/);
  await fails({ device: 'Tower' }, /^devices\.list always runs on this PC, so it takes no "device"\.$/, base(), 'devices.list');
  assert.deepEqual([forwarded.length, summaries().length, runs.length], [0, 7, 0], 'nothing forwarded or run; each refusal journaled as a failed call (KI-Runde 17.11.2026)');
  const twin = await registry.call('computer.windows', { device: 'dev_twin2' }, base(), 'call_twin');
  assert.equal(textOf(twin), 'ran on dev_twin2', 'the id picks one of two PCs with the same name');
});

test('B-080: without device, a home this PC does not forward to – removed, half-paired, unknown, or a PC this PC joined as an employee – leaves the call here', async () => {
  const { registry, services, forwarded, summaries, runs, base } = rig();
  const joined = new Set(['dev_tower']);
  (services as { db: unknown }).db = { get: (_sql: string, params: string[]) => (joined.has(params[0]) ? { ...ROW, id: params[0], allow: '{"joinedAs":"employee"}' } : undefined) };
  for (const home of ['dev_old', 'dev_pending', 'dev_gone', 'dev_tower']) {
    const out = await registry.call('screen.peek', { x: 1 }, base({ deviceId: home }), `call_${home}`);
    assert.equal(textOf(out), 'peeked here', home);
  }
  assert.deepEqual(runs.map((run) => run.deviceId), ['dev_self', 'dev_self', 'dev_self', 'dev_self'], 'it ran on this PC, as this PC');
  assert.deepEqual([forwarded.length, summaries()], [0, ['Peek at the screen', 'Peek at the screen', 'Peek at the screen', 'Peek at the screen']]);
  joined.clear(); // Tower is one of my own PCs again: its calls go there
  assert.equal(textOf(await registry.call('screen.peek', { x: 2 }, base({ deviceId: 'dev_tower' }), 'call_own')), 'ran on dev_tower');
});

test('devices.list names this PC, the PC the agent works on and the linked PCs (no role, phones or revoked PCs); online = answered a ping just now', async () => {
  const { registry, base, mira, pinged, waits } = rig();
  const out = await registry.call('devices.list', {}, base({ agent: { ...mira, deviceId: 'dev_tower' } }), 'call_1');
  assert.deepEqual(pinged.sort(), ['dev_pending', 'dev_tower', 'dev_twin1', 'dev_twin2'], 'every linked PC once, never this PC, a phone or a removed PC');
  assert.deepEqual(waits, [PROBE_MS, PROBE_MS, PROBE_MS, PROBE_MS], "B-080: each ping waits at most the mesh's probe time, not the 120 s RPC default");
  const listed = out.structured as { youAreOn: string; homeDevice?: string; note?: string; devices: Array<Record<string, unknown>> };
  assert.equal(listed.youAreOn, 'Laptop');
  assert.equal(listed.homeDevice, 'Tower');
  assert.match(listed.note ?? '', /run on Tower/);
  assert.deepEqual(listed.devices.map((device) => device.name), ['Laptop', 'Tower', 'Studio', 'Twin', 'Twin']);
  for (const device of listed.devices) assert.equal('role' in device || 'kind' in device, false);
  assert.deepEqual(listed.devices[0], { id: 'dev_self', name: 'Laptop', thisPc: true, online: true, caps: { computerUse: true } });
  const { link: towerLink, ...tower } = listed.devices[1];
  assert.deepEqual(tower, { id: 'dev_tower', name: 'Tower', online: true, caps: { computerUse: true }, lastSeen: '2026-10-20T08:00:00.000Z' });
  assert.equal(typeof (towerLink as { rttMs?: unknown }).rttMs, 'number', 'G: its ping was timed – the connection now (devices/link-quality.ts)');
  assert.equal(listed.devices[2].status, 'pairing');
  assert.deepEqual([listed.devices[3].online, listed.devices[3].status], [false, 'offline'], 'no answer: not online');
  const plain = (await registry.call('devices.list', {}, base(), 'call_2')).structured as { homeDevice?: string };
  assert.equal(plain.homeDevice, undefined, 'no home device while the agent works on this PC');
});

test('a call received from a linked PC never travels on: runRemoteTool drops a device argument', async () => {
  const runs: Array<{ args: Record<string, unknown>; deviceId?: string }> = [];
  const registry = new Registry({ services: () => services });
  const services = {
    tools: registry,
    // The person on Tower allowed agents from Laptop to use it (MP4).
    devices: { ...fakeDevices([]), self: () => ({ ...DEVICES[1], self: true }), list: () => DEVICES.map((device) => (device.id === 'dev_self' ? { ...device, allow: { control: true } } : device)) },
    settings: { get: () => ({ permissions: { grants: {} } }) },
    secrets: { redact: (text: string) => text },
    org: { get: () => undefined },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as RuntimeServices;
  registry.register(recorder(runs));
  const out = await runRemoteTool(services, { name: 'screen.peek', args: { device: 'Laptop', x: 4 }, agentId: 'ag_1', runId: 'run_1' }, 'dev_self', new AbortController().signal);
  assert.equal(textOf(out), 'peeked here');
  assert.deepEqual(runs, [{ args: { x: 4 }, deviceId: 'dev_tower' }]);
});

test('B-080: files.read and files.list with device go to that PC as tools.call, without the device argument', async () => {
  const { registry, services, forwarded, summaries, base } = rig();
  Object.assign(services, { modes: { get: () => ({ ...MODE, tools: [...(MODE.tools ?? []), 'files.*'] }) }, paths: { workspace: os.tmpdir() } });
  for (const tool of fileTools()) registry.register(tool);
  assert.deepEqual(props(registry.get('files.read')!.inputSchema).device, DEVICE_PROPERTY, 'the shared device argument of remote tools');
  const log = 'C:/Users/ann/AppData/Roaming/Autark/logs/runtime.log';
  assert.equal(textOf(await registry.call('files.read', { path: log, device: 'Tower' }, base(), 'call_1')), 'ran on dev_tower');
  assert.equal(textOf(await registry.call('files.list', { path: 'C:/Users/ann/Downloads', device: 'tower' }, base(), 'call_2')), 'ran on dev_tower');
  assert.deepEqual(forwarded.map((call) => [call.deviceId, call.method, call.params.name, call.params.args]), [
    ['dev_tower', 'tools.call', 'files.read', { path: log }],
    ['dev_tower', 'tools.call', 'files.list', { path: 'C:/Users/ann/Downloads' }],
  ]);
  assert.deepEqual(summaries(), [`Read ${log} on Tower`, 'List C:/Users/ann/Downloads on Tower']);
});

test('B-080: on the PC that receives it, files.read, files.list and devices.send_file read an absolute path anywhere there', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-remote-read-'));
  try {
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'Downloads', 'note.txt');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, 'from the notebook');
    const forwarded: Forwarded[] = [];
    const registry = new Registry({ services: () => services });
    const services = {
      tools: registry, paths: { workspace },
      // This is Tower: the call comes from Laptop.
      devices: { ...fakeDevices(forwarded), self: () => ({ ...DEVICES[1], self: true }), list: () => DEVICES.map((device) => ({ ...device, self: device.id === 'dev_tower' })) },
      secrets: { redact: (text: string) => text },
      org: { get: () => undefined },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as RuntimeServices;
    for (const tool of [...fileTools(), sendFile]) registry.register(tool);
    const call = (name: string, args: Record<string, unknown>) => runRemoteTool(services, { name, args, agentId: 'ag_1', runId: 'run_1' }, 'dev_self', new AbortController().signal);
    assert.equal(textOf(await call('files.read', { path: outside })), 'from the notebook', 'read, not refused – and outside the workspace');
    assert.equal(textOf(await call('files.list', { path: path.dirname(outside) })), 'file note.txt');
    const sent = await call('devices.send_file', { to: 'Laptop', path: outside });
    assert.equal(sent.isError, undefined, textOf(sent));
    assert.deepEqual(forwarded.map((item) => [item.deviceId, item.method]), [['dev_self', 'files.put'], ['dev_self', 'files.put']], 'Umzug 21.11.: begin, then the piece');
    const begin = (forwarded[0].params as unknown as { begin: { name: string; folder: boolean; from: string; agentId: string } }).begin;
    assert.deepEqual([begin.name, begin.folder, begin.agentId], ['note.txt', false, 'ag_1']);
    const piece = forwarded[1].params as unknown as { dataBase64: string; last: boolean };
    assert.deepEqual([Buffer.from(piece.dataBase64, 'base64').toString(), piece.last], ['from the notebook', true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agents.update sets the PC an agent works on (any agent); its next device call runs there', async () => {
  const h = setup();
  const forwarded: Forwarded[] = [];
  const services = h.services as RuntimeServices;
  services.devices = fakeDevices(forwarded);
  const registry = new Registry({ services: () => services });
  for (const tool of [...deviceDefs(), ...agentTools]) registry.register(tool);
  const update = registry.get('agents.update')!;

  assert.equal(update.describe!({ device: 'tower' }, ctxFor(h)).summary, 'Update agent Tom: works on Tower', 'the approval names the agent');
  const moved = await update.run({ device: 'tower' }, ctxFor(h));
  assert.deepEqual(moved.structured, { ok: true, agentId: 'ag_tom', worksOn: 'Tower' });
  assert.equal(h.org.require('ag_tom').deviceId, 'dev_tower');

  // As turn-attempt does: the agent's PC becomes ctx.deviceId of its calls.
  const ran = await registry.call('computer.windows', {}, ctxFor(h, { agent: h.org.require('ag_tom'), deviceId: h.org.require('ag_tom').deviceId }), 'call_1');
  assert.equal(textOf(ran), 'ran on dev_tower');

  const refused = await update.run({ device: 'Attic' }, ctxFor(h));
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Attic was removed/);
  assert.equal(h.org.require('ag_tom').deviceId, 'dev_tower', 'unchanged after an error');

  const back = await update.run({ device: 'this' }, ctxFor(h));
  assert.deepEqual(back.structured, { ok: true, agentId: 'ag_tom', worksOn: 'Laptop' });
  assert.equal(h.org.require('ag_tom').deviceId, undefined, 'this PC is the default (no deviceId)');

  h.org.add(agent('ag_ann', 'Ann'));
  const other = await update.run({ agentId: 'ag_ann', device: 'Tower' }, ctxFor(h));
  assert.equal(other.isError, undefined, textOf(other));
  assert.equal(h.org.require('ag_ann').deviceId, 'dev_tower', 'any agent may move another');
});
