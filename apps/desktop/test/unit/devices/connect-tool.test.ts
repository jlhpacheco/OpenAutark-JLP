// Linking PCs from an agent (devices/connect-tool.ts, list-tool.ts): devices.connect exists where connecting PCs is
// wired and asks through the same remote.connect as Settings › Devices – Eine-ID 22.11.2026: with no role, the PC asked
// decides from the ID (the person's own ID: one of their devices, a company's ID: a new member; the other PC's person still
// compares the code and accepts), and its description says so in my own words and what a link hands over; its refusal
// reaches the agent as is; devices.list adds this PC's Remote ID and the meeting server in one word ('error' still
// retries, so it is 'connecting' with the reason) – and names both, and devices.connect, in its description only there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceTools } from '../../../src/runtime/devices/tools.ts';
import type { DeviceLink } from '../../../src/runtime/devices/connect-tool.ts';
import type { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { BrowserService } from '../../../src/runtime/browser/service.ts';
import type { AdbPhone } from '../../../src/runtime/phone/adb.ts';
import type { RelayState } from '../../../src/shared/model/relay.ts';
import type { RemoteOutgoing } from '../../../src/shared/model/remote.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const stubs = { computer: { activity: {} } as unknown as ComputerService, browser: {} as BrowserService, phone: {} as AdbPhone };

function rig(relay: RelayState = { status: 'connected', peersOnline: 0, relayed: [] }) {
  const asked: Array<Record<string, unknown>> = [];
  let refuse: Error | undefined;
  let answer: RemoteOutgoing = { id: 'ro_1', role: 'employee', company: 'Dojo', deviceId: 'dev_tower', name: 'Tower', remoteId: '123456782', fingerprint: 'f'.repeat(64), code: '4821', status: 'waiting', expiresAt: 1 };
  const link: DeviceLink = {
    remote: {
      ids: () => ({ companyId: '482913071', myId: '123456782' }),
      connect: async (input) => {
        asked.push({ ...input });
        if (refuse) throw refuse;
        return answer;
      },
    },
    meeting: { state: () => relay },
  };
  const tools = new Map(deviceTools({ ...stubs, link }).map((tool) => [tool.name, tool]));
  const self = { id: 'dev_self', name: 'Laptop', kind: 'pc', role: 'home', fingerprint: 'a', addresses: [], caps: {}, status: 'online', self: true };
  const ctx = {
    agent: { id: 'ag_1', name: 'Mira' }, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: { devices: { self: () => self, list: () => [self], online: () => true, call: async () => undefined } },
  } as unknown as ToolContext;
  return { tools, asked, ctx, refuse: (error: Error) => { refuse = error; }, answer: (next: RemoteOutgoing) => { answer = next; } };
}

test('devices.connect only where connecting is wired; no role – the ID decides; it says what happens next', async () => {
  assert.equal(deviceTools(stubs).some((tool) => tool.name === 'devices.connect'), false, 'not without the connect flow');
  const { tools, asked, ctx } = rig();
  const tool = tools.get('devices.connect')!;
  assert.ok(tool, 'listed with the device tools');
  assert.equal(tool.remote, undefined, 'it runs on this PC');
  assert.equal(tool.requires, undefined, 'offered in every mode that lists it');
  const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(schema.required, ['target']);
  assert.deepEqual(Object.keys(schema.properties), ['target'], 'no role to pick');
  assert.ok(tool.description.length < 650);
  // In my own words, no permission language: what the ID decides and what a link hands over.
  assert.match(tool.description, /^Asks another PC to link with this one, by an ID or address\. The ID I type decides:/);
  assert.match(tool.description, /a person's own ID would make it one of their devices – a full mirror of company, secrets, settings and phones, with commands on both – which the person here says yes to in Settings › Devices first/);
  assert.match(tool.description, /a company's ID makes this PC a new member of that company/);
  assert.doesNotMatch(tool.description, /\byou may\b|\ballowed\b|\bonly if\b|\bask before\b/i);
  const out = await tool.run({ target: '123 456 782' }, ctx);
  assert.deepEqual(asked, [{ target: '123 456 782' }], 'the same remote.connect, without a role');
  const result = out.structured as Record<string, string>;
  assert.deepEqual([result.code, result.status, result.role, result.company], ['4821', 'waiting', 'employee', 'Dojo'], 'the role the other PC decided');
  assert.match(result.next, /Tower shows the code 4821 as well; the person there accepts/);
  assert.deepEqual(tool.describe?.({ target: '123 456 782' }, ctx), { summary: 'Ask PC 123 456 782 to link', resource: '123 456 782', reversible: true, external: true });
});

test('review H1: an answer that would make this PC one of someone\'s devices comes back as "confirm" – the tool never says yes', async () => {
  const { tools, ctx, answer } = rig();
  answer({ id: 'ro_2', role: 'ceo', person: 'Momo', deviceId: 'dev_tower', name: 'Tower', remoteId: '123456782', fingerprint: 'f'.repeat(64), code: '', status: 'confirm', expiresAt: 1 });
  const result = (await tools.get('devices.connect')!.run({ target: '123456782' }, ctx)).structured as Record<string, string>;
  assert.deepEqual([result.status, result.role, result.person, 'code' in result], ['confirm', 'ceo', 'Momo', false]);
  assert.match(result.next, /^This PC would become one of Momo's devices – everything here shared with them\. The person here says yes in Settings › Devices \(or cancels\); then Tower shows a code\.$/);
  // DeviceLink.remote is Pick<RemoteService, 'ids' | 'connect'>: the tool has no way to say yes.
});

test('devices.connect passes the refusal through: the agent reads why', async () => {
  const { tools, ctx, refuse } = rig();
  refuse(new WorkforceError('not_found', 'No PC with this Remote ID is online. Open Autark on that PC – Settings › Devices shows its Remote ID.'));
  await assert.rejects(tools.get('devices.connect')!.run({ target: '123456782' }, ctx), (error: unknown) => error instanceof WorkforceError && /Settings › Devices shows its Remote ID/.test(error.message));
});

test('devices.list: the company ID, my own ID and the meeting server in one word, with the hint to devices.connect', async () => {
  const read = async (relay: RelayState) => {
    const { tools, ctx } = rig(relay);
    return (await tools.get('devices.list')!.run({}, ctx)).structured as Record<string, unknown>;
  };
  const connected = await read({ status: 'connected', peersOnline: 1, relayed: [] });
  assert.equal(connected.companyId, '482913071');
  assert.equal(connected.myId, '123456782', 'the company ID and my own ID, not the device ID');
  assert.equal(connected.meetingServer, 'connected');
  assert.equal('meetingServerError' in connected, false);
  assert.equal((await read({ status: 'off', peersOnline: 0, relayed: [] })).meetingServer, 'off');
  const failing = await read({ status: 'error', error: 'The meeting server is not reachable (ECONNREFUSED)', peersOnline: 0, relayed: [] });
  assert.deepEqual([failing.meetingServer, failing.meetingServerError], ['connecting', 'The meeting server is not reachable (ECONNREFUSED)']);
  assert.equal((await read({ status: 'connecting', peersOnline: 0, relayed: [] })).meetingServer, 'connecting');
  const { tools } = rig();
  assert.match(tools.get('devices.list')!.description, /The company's ID, my own ID and the meeting server come with it; a new PC types one of the two IDs to link \(devices\.connect\)\./);
  assert.ok(tools.get('devices.list')!.description.length < 500);
  const plain = new Map(deviceTools(stubs).map((tool) => [tool.name, tool]));
  const { ctx } = rig();
  assert.equal('companyId' in ((await plain.get('devices.list')!.run({}, ctx)).structured as object), false, 'without the connect flow: nothing claimed');
  assert.doesNotMatch(plain.get('devices.list')!.description, /devices\.connect|Remote ID|meeting server/, 'and its description points at nothing missing');
});
