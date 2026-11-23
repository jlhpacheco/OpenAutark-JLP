// Who is the person (Sicher-Runde FX1 19.11.2026, C1/H1/H2): the person token is owner scope marked `person`, the
// launch token of runtime.json plain owner; an agent's wf (or a runtime.json token) never reaches the person's own methods;
// every other changing method passes the switch of its kind (rpc-map.ts) – an agent's through the gate, a session
// without an agent's name only when it is open; an answer to a security request opens a switch only with 'settings'.
// Owns: these assertions. Never: the decisions themselves (policy.test.ts) or the approval flow (approvals.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import WebSocket from 'ws';
import { agent, harness } from '../chat/harness.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { securityDefaults } from '../../../src/shared/model/security-settings.ts';
import { securityOf } from '../../../src/shared/model/system.ts';
import { withCaller } from '../../../src/runtime/rpc/caller.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { answerAs, isPersonScope } from '../../../src/runtime/security/rpc-guard.ts';
import { methodNeed } from '../../../src/runtime/security/rpc-map.ts';
import type { GateRequest } from '../../../src/runtime/security/service.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { fixture, LAUNCH_TOKEN, PERSON_TOKEN, closeCode, nextMessage, openSocket } from '../http/fixture.ts';

const AGENT: ClientScope = { kind: 'owner', agentId: 'ag_tom' };
const PLAIN: ClientScope = { kind: 'owner' };
const WINDOW: ClientScope = { kind: 'owner', person: true };
const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_1', capabilities: ['todo', 'settings'], secure: true };
const TODO_PHONE: ClientScope = { kind: 'device', deviceId: 'dev_2', capabilities: ['todo'], secure: true };

/** A table with stand-in handlers and a security service that records what it is asked. */
function rig(verdict: 'open' | 'ask' | 'closed' = 'ask') {
  const gated: GateRequest[] = [];
  const checked: string[] = [];
  const ran: string[] = [];
  const services = {
    settings: { get: () => ({ profile: { name: 'Mia' } }) },
    security: {
      check: (req: { capability: string }) => { checked.push(req.capability); return verdict; },
      gate: async (req: GateRequest) => { gated.push(req); return verdict === 'open' ? { ok: true } : { ok: false, text: `closed: ${req.capability}` }; },
    },
  } as unknown as RuntimeServices;
  const table = new HandlerTable();
  const methods = ['pwa.link', 'secrets.export', 'system.restore', 'people.invite', 'remote.connect', 'security.answer', 'settings.update',
    'chats.list', 'messages.send', 'agents.update', 'agents.create', 'files.writePath', 'files.readPath', 'secrets.save', 'secrets.list', 'companies.tool', 'privacy.purgeProviderHistory'];
  for (const method of methods) table.add(method as never, (() => { ran.push(method); return { ok: true }; }) as never, 'owner');
  const call = (method: string, params: unknown, scope: ClientScope) => Promise.resolve(table.get(method)!.handler(params as never, {
    scope, services, extras: {} as HandlerContext['extras'], topics: new Set(), signal: new AbortController().signal,
  }));
  return { call, gated, checked, ran };
}

test('the person token is owner scope marked person; runtime.json\'s launch token is plain owner; an agent never rides the person token', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const hello = async (token: string, extra: Record<string, unknown> = {}) => {
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
      ws.send(JSON.stringify({ protocol: 1, token, client: 'cli', ...extra }));
      return ws;
    };
    const person = await hello(PERSON_TOKEN);
    person.send(JSON.stringify({ id: 1, method: 'session.info' }));
    await nextMessage(person);
    const launch = await hello(LAUNCH_TOKEN);
    launch.send(JSON.stringify({ id: 1, method: 'session.info' }));
    await nextMessage(launch);
    assert.deepEqual(f.rpc.attached.map((entry) => entry.scope), [{ kind: 'owner', person: true }, { kind: 'owner' }]);
    const agentOnPerson: WebSocket = await hello(PERSON_TOKEN, { agent: 'ag_tom' });
    assert.equal(await closeCode(agentOnPerson), 4400, 'an agent\'s name is never the person');
    person.close();
    launch.close();
  } finally { await f.close(); }
});

test('isPersonScope: the marked owner sessions and the phone; never an agent or the launch token', () => {
  assert.equal(isPersonScope(WINDOW), true);
  assert.equal(isPersonScope(PHONE), true);
  assert.equal(isPersonScope(PLAIN), false);
  assert.equal(isPersonScope(AGENT), false);
  assert.equal(isPersonScope({ kind: 'owner', person: true, agentId: 'ag_tom' }), false);
  assert.equal(isPersonScope({ kind: 'peer', deviceId: 'pc' }), false);
});

test('an agent\'s wf and a runtime.json token are refused the person\'s own methods in every mode; the window and the phone pass', async () => {
  const r = rig('open'); // even with every switch open (Trust AI mode)
  for (const scope of [AGENT, PLAIN]) {
    for (const [method, params] of [['pwa.link', {}], ['secrets.export', { dir: 'C:\\x' }], ['system.restore', { path: 'C:\\b' }], ['people.invite', { id: 'p1' }],
      ['remote.connect', { target: '123' }], ['security.answer', { id: 'a', answer: 'once' }], ['settings.update', { security: { mode: 'trust' } }]] as const) {
      await assert.rejects(r.call(method, params, scope), /Mia|person/, `${method} for ${JSON.stringify(scope)}`);
    }
  }
  assert.deepEqual(r.ran, []);
  await r.call('pwa.link', {}, WINDOW);
  await r.call('settings.update', { security: { mode: 'trust' } }, PHONE);
  assert.deepEqual(r.ran, ['pwa.link', 'settings.update']);
  assert.equal(r.gated.length, 0, 'the person is never gated');
});

test('Trust AI mode stays open: an agent\'s wf exports as before; the security setup, its answers and the links that mint a person session stay the person\'s', async () => {
  const trust = rigWithMode('trust');
  await trust.call('secrets.export', { dir: 'C:\\x' }, AGENT);
  assert.deepEqual(trust.ran, ['secrets.export']);
  for (const [method, params] of [['security.answer', { id: 'a', answer: 'once' }], ['settings.update', { security: { mode: 'secure' } }], ['pwa.link', {}], ['people.invite', { id: 'p1' }]] as const) {
    await assert.rejects(trust.call(method, params, AGENT), /Mia|person/);
  }
  const secure = rigWithMode('secure');
  await assert.rejects(secure.call('pwa.link', {}, AGENT), /Mia|person/);
});

/** The rig with a security service that names its mode. */
function rigWithMode(mode: 'trust' | 'secure') {
  const ran: string[] = [];
  const services = {
    settings: { get: () => ({ profile: { name: 'Mia' } }) },
    security: { current: () => ({ mode }), check: () => 'open', gate: async () => ({ ok: true }) },
  } as unknown as RuntimeServices;
  const table = new HandlerTable();
  for (const method of ['pwa.link', 'secrets.export', 'people.invite', 'security.answer', 'settings.update']) table.add(method as never, (() => { ran.push(method); return { ok: true }; }) as never, 'owner');
  const call = (method: string, params: unknown, scope: ClientScope) => Promise.resolve(table.get(method)!.handler(params as never, {
    scope, services, extras: {} as HandlerContext['extras'], topics: new Set(), signal: new AbortController().signal,
  }));
  return { call, ran };
}

test('Secure mode: an agent\'s changing wf calls pass the switch of their kind; reads and its own work stay open', async () => {
  const r = rig('ask');
  await r.call('chats.list', {}, AGENT);
  await r.call('messages.send', { conversationId: 'c', text: 'hi' }, AGENT);
  await r.call('secrets.list', {}, AGENT);
  await r.call('agents.update', { id: 'ag_tom', instructions: 'mine' }, AGENT);
  assert.deepEqual(r.ran, ['chats.list', 'messages.send', 'secrets.list', 'agents.update']);
  assert.equal(r.gated.length, 0);
  await assert.rejects(r.call('settings.update', { voice: {} }, AGENT), /closed: setup/);
  await assert.rejects(r.call('agents.update', { id: 'ag_ida' }, AGENT), /closed: setup/, 'another agent\'s instructions');
  await assert.rejects(r.call('agents.create', { name: 'X' }, AGENT), /closed: team/);
  await assert.rejects(r.call('files.writePath', { path: 'C:\\Users\\m\\x.txt', text: 'x' }, AGENT), /closed: write/);
  await assert.rejects(r.call('files.readPath', { path: 'C:\\Users\\m\\x.txt' }, AGENT), /closed: read/);
  await assert.rejects(r.call('secrets.save', { label: 'x' }, AGENT), /closed: accounts/);
  await assert.rejects(r.call('privacy.purgeProviderHistory', {}, AGENT), /closed: setup/, 'a method nobody named: setup');
  assert.deepEqual(r.gated.map((g) => [g.capability, g.agentId, g.path ?? '']), [
    ['setup', 'ag_tom', ''], ['setup', 'ag_tom', ''], ['team', 'ag_tom', ''], ['write', 'ag_tom', 'C:\\Users\\m\\x.txt'], ['read', 'ag_tom', 'C:\\Users\\m\\x.txt'], ['accounts', 'ag_tom', ''], ['setup', 'ag_tom', ''],
  ]);
  assert.equal(r.ran.length, 4, 'nothing closed ran');
});

test('a session without an agent\'s name has nobody to ask for: only what is open passes, nothing waits', async () => {
  const closed = rig('ask');
  await assert.rejects(closed.call('settings.update', { voice: {} }, PLAIN), /names no agent/);
  await closed.call('chats.list', {}, PLAIN);
  await closed.call('companies.tool', { name: 'files.read', agentId: 'ag_other_company' }, PLAIN); // another company's runtime: gated inside the tool runner
  assert.equal(closed.gated.length, 0);
  assert.deepEqual(closed.checked, ['setup']);
  const open = rig('open');
  await open.call('settings.update', { voice: {} }, PLAIN);
  assert.deepEqual(open.ran, ['settings.update']);
});

test('companies.tool: never from an agent\'s own wf; another company\'s runtime (no agent name) passes – gated inside', async () => {
  const services = { org: { get: (id: string) => (id === 'ag_tom' ? { id } : undefined) } };
  const table = new HandlerTable();
  table.add('companies.tool' as never, (() => 'ran') as never, 'owner');
  const call = (params: unknown, scope: ClientScope) => Promise.resolve(table.get('companies.tool')!.handler(params as never, { scope, services, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext));
  await assert.rejects(call({ name: 'files.read', agentId: 'ag_x' }, AGENT), /another company/);
  assert.equal(await call({ name: 'files.read', agentId: 'ag_tom' }, PLAIN), 'ran', 'a company made from an export has the same agent ids');
  assert.equal(await call({ name: 'files.read', agentId: 'ag_x' }, PLAIN), 'ran');
});

test('methodNeed: families, single methods and the paths', () => {
  assert.deepEqual(methodNeed('tasks.create', {}), { kind: 'open' });
  assert.deepEqual(methodNeed('skills.save', {}), { kind: 'switch', capability: 'setup' });
  assert.deepEqual(methodNeed('bridges.connectTelegram', {}), { kind: 'switch', capability: 'accounts' });
  assert.deepEqual(methodNeed('browser.navigate', {}), { kind: 'switch', capability: 'web' });
  assert.deepEqual(methodNeed('phoneUse.attach', {}), { kind: 'switch', capability: 'phone' });
  assert.deepEqual(methodNeed('files.writePath', { path: 'x', device: 'pc2' }), { kind: 'switch', capability: 'write', path: 'x' }, 'another PC\'s path keeps its path (REVIEW-2 3)');
  assert.deepEqual(methodNeed('companies.remove', {}, 'ag_tom'), { kind: 'switch', capability: 'setup' }, 'an agent\'s own wf');
  assert.deepEqual(methodNeed('companies.remove', {}), { kind: 'open' }, 'another company\'s main');
  assert.deepEqual(methodNeed('companies.export', {}), { kind: 'person' });
  assert.deepEqual(methodNeed('settings.update', { theme: {} }), { kind: 'switch', capability: 'setup' });
});

test('H1: an answer opens a switch only with the settings tier; a to-do-only phone\'s "Always" counts once; agents never answer', () => {
  assert.equal(answerAs(TODO_PHONE, 'setting'), 'once');
  assert.equal(answerAs(TODO_PHONE, 'place'), 'once');
  assert.equal(answerAs(TODO_PHONE, 'decline'), 'decline');
  assert.equal(answerAs(PHONE, 'place'), 'place');
  assert.equal(answerAs(WINDOW, 'setting'), 'setting');
  assert.equal(answerAs({ kind: 'person', personId: 'p', deviceId: 'd', tokenId: 't' }, 'setting'), 'once', 'a colleague');
  assert.equal(answerAs(undefined, 'setting'), 'setting', 'the runtime itself');
  assert.throws(() => answerAs(AGENT, 'once'), /answered by the person/);
  assert.throws(() => answerAs(PLAIN, 'decline'), /answered by the person/);
});

test('H1 through the to-do: a to-do-only phone answering "Always: …" lets the waiting step through once and opens no switch', async () => {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  settings.update({ profile: { name: 'Mia' }, security: securityDefaults('secure') } as never);
  const services = h.services as RuntimeServices;
  services.settings = settings;
  services.paths = { data: path.resolve('fx1-data'), workspace: path.resolve('fx1-ws'), resources: path.resolve('fx1-res'), temp: path.resolve('fx1-data', 'tmp') } as RuntimeServices['paths'];
  h.org.add(agent('ag_tom', 'Tom'));
  const sec = new Security({ services: () => services, waitMs: 5_000 });
  services.security = sec;
  const pending = sec.gate({ agentId: 'ag_tom', capability: 'commands', summary: 'Run: npm install', fingerprint: 'fp_h1' });
  const [todo] = h.tasks.todos(50);
  assert.equal(todo.createdBy, 'system', 'the app made it, not the asking agent');
  withCaller({ scope: TODO_PHONE }, () => h.tasks.answer({ taskId: todo.id, answer: { choice: 'setting' }, by: 'human' }));
  assert.deepEqual(await pending, { ok: true });
  assert.equal(securityOf(settings.get()).commands, 'ask', 'no switch opened');
  assert.throws(() => withCaller({ scope: PLAIN }, () => sec.answer('nope', 'once')), /./);
});
