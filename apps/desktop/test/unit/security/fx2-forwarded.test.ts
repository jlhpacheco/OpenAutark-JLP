// FX2 of the Sicher-Runde (19.11.2026), C2 and the helper guard: a call from a linked PC (devices/tools.ts runRemoteTool)
// and a call from another company (tools/builtin/companies.ts runCompanyTool) pass the receiving runtime's gate for the
// calling agent before the tool runs, and a refusal travels back as 'forbidden'; a forwarded call never runs as the
// person; the computer helper's guard fails closed.
// Owns: these assertions only. Never: a real linked PC, another company's runtime or a real helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { runRemoteTool } from '../../../src/runtime/devices/tools.ts';
import { runCompanyTool } from '../../../src/runtime/tools/builtin/companies.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { CLOSED_GUARD, withGuardConfig, type HelperClient } from '../../../src/runtime/computer/helper.ts';
import { securityDefaults } from '../../../src/shared/model/security-settings.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import { setup, WORKSPACE } from '../tools/helpers.ts';

function receiving(mode: 'secure' | 'trust' = 'secure') {
  const h = setup();
  h.settings.update({ profile: { name: 'Mia' }, security: securityDefaults(mode) } as never);
  const services = h.services as RuntimeServices;
  services.paths = { data: path.join(WORKSPACE, '..', 'fx2-data'), workspace: WORKSPACE, resources: path.join(WORKSPACE, '..', 'res'), temp: path.join(WORKSPACE, '..', 'fx2-data', 'tmp') } as RuntimeServices['paths'];
  services.security = new Security({ services: () => services, waitMs: 20 });
  services.devices = { self: () => ({ id: 'dev_self' }), list: () => [{ id: 'dev_tower', name: 'Tower' }] } as unknown as RuntimeServices['devices'];
  let ran = 0;
  const read: ToolDef = {
    name: 'files.read', category: 'read', remote: true, description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (args) => ({ summary: `Read ${String((args as { path: string }).path)}`, external: false }),
    run: async () => { ran++; return { content: [{ type: 'text', text: 'the text' }] }; },
  };
  services.tools = { get: (name: string) => (name === read.name ? read : undefined) } as unknown as RuntimeServices['tools'];
  return { ...h, services, ran: () => ran };
}

const outside = path.join(os.homedir(), 'fx2-elsewhere', 'taxes.pdf');
const inside = path.join(WORKSPACE, 'notes.md');
const signal = () => new AbortController().signal;

test('a linked PC\'s call passes this PC\'s gate for its agent: closed here → refused with my text, the tool never runs', async () => {
  const h = receiving();
  const call = (file: string, agentId = 'ag_far') => runRemoteTool(h.services, { name: 'files.read', args: { path: file }, agentId, agentName: 'Lena', runId: 'run_far', mode: 'general' }, 'dev_tower', signal());
  await assert.rejects(call(outside), (error: Error & { code?: string }) => error.code === 'forbidden' && /Reading files is closed on this PC, so the app asked Mia/.test(error.message));
  assert.equal(h.ran(), 0);
  const [request] = h.services.security.requests();
  assert.equal(request.agentId, 'ag_far');
  assert.equal(request.agentName, 'Lena (Tower)', 'the request names the calling agent and its PC');
  const open = await call(inside);
  assert.equal(open.isError, undefined);
  assert.equal(h.ran(), 1, 'an open call runs as before');
  await assert.rejects(call(inside, HUMAN_ID), /names that agent/, 'a forwarded call never runs as the person');
});

test('a linked PC\'s call runs as before in Trust AI mode', async () => {
  const h = receiving('trust');
  await runRemoteTool(h.services, { name: 'files.read', args: { path: outside }, agentId: 'ag_far', runId: 'run_far', mode: 'general' }, 'dev_tower', signal());
  assert.equal(h.ran(), 1);
});

test('another company\'s call passes this company\'s gate for its agent before the tool runs', async () => {
  const h = receiving();
  const call = (file: string) => runCompanyTool(h.services, { name: 'files.read', args: { path: file }, agentId: 'ag_other', agentName: 'Jonas', runId: 'run_b', from: 'Company B' }, signal());
  await assert.rejects(call(outside), (error: Error & { code?: string }) => error.code === 'forbidden' && /so the app asked Mia/.test(error.message));
  assert.equal(h.ran(), 0);
  assert.equal(h.services.security.requests()[0].agentName, 'Jonas (Company B)');
  await call(inside);
  assert.equal(h.ran(), 1);
});

// ---------------------------------------------------------------- the computer helper's guard fails closed

function fakeHelper(failConfig = false) {
  const sent: Array<[string, unknown]> = [];
  const inner: HelperClient = {
    call: async <T>(op: string, args?: Record<string, unknown>): Promise<T> => {
      if (op === 'config' && failConfig) throw new Error('config refused');
      sent.push([op, args]);
      return undefined as T;
    },
    running: () => true,
    dispose: async () => {},
  };
  return { inner, sent };
}

test('a guard that cannot be worked out closes input to every app', async () => {
  const { inner, sent } = fakeHelper();
  const helper = withGuardConfig(inner, () => { throw new Error('settings unreadable'); });
  await helper.call('click', {});
  assert.deepEqual(sent, [['config', CLOSED_GUARD], ['click', {}]], 'the helper refuses the click itself (apps: [])');
});

test('a config the helper refuses fails the call: nothing runs open', async () => {
  const { inner, sent } = fakeHelper(true);
  const helper = withGuardConfig(inner, () => ({ appPids: [7], apps: null }));
  await assert.rejects(helper.call('click', {}), /config refused/);
  assert.deepEqual(sent, []);
});
