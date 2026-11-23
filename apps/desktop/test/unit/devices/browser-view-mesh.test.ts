// 21.11.2026 (owner: "ich kann den Browser von einem Agent … nicht anschauen und kann nicht da reingehen"): an agent's
// own browser runs on the PC the agent runs on. A view on another of the person's PCs sends browser.pull / pullPart /
// input / navigate / takeover there (src/runtime/rpc/handlers/browser.ts browserHandlers → devices/browser-view.ts):
// with the caller as `via`, frames capped to 1 MiB parts on the link, the real window never across; an agent running
// here is served here. Pane between people (same day): every link reaches the mesh methods and each call is checked
// against what is shared (pane/shares.ts reach, key agent:<id>) – a CEO PC reaches every agent's browser, another PC
// only one shared with its person (the company's PC with `for`), and a PC that is no link here is reached through the
// company's PC (pane/relay.ts callPc).
// Owns: these assertions only. Never: a real link, browser or Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import { BROWSER_METHODS, forwardBrowser, forwardedCaller, registerBrowserView } from '../../../src/runtime/devices/browser-view.ts';
import { browserHandlers } from '../../../src/runtime/rpc/handlers/browser.ts';
import { addShare, removeShare } from '../../../src/runtime/pane/shares.ts';
import { relayHandler } from '../../../src/runtime/pane/relay.ts';
import { SIDE_PART_BYTES } from '../../../src/shared/model/side-view.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { record } from './sync-net.ts';
import { memoryDb } from './fakes.ts';

const code = (error: unknown) => (error as { code?: string }).code;

function rig() {
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  repo.upsert(record('dev_self', { self: true, name: 'office-pc' }));
  repo.upsert(record('dev_ceo'));
  repo.upsert(record('dev_emp', { personId: 'per_1' }));
  repo.upsert(record('dev_boss', { joinedAs: 'employee' }));
  const sent: Array<{ device: string; method: string; params: Record<string, unknown> }> = [];
  const agents: Record<string, { id: string; deviceId?: string }> = { ag_far: { id: 'ag_far', deviceId: 'dev_ceo' }, ag_here: { id: 'ag_here' } };
  const services = {
    db, bus: { on: () => () => undefined },
    org: { get: (id: string) => agents[id] },
    devices: {
      self: () => ({ id: 'dev_self', name: 'office-pc' }),
      call: async (device: string, method: string, params: Record<string, unknown>) => {
        sent.push({ device, method, params });
        if (method === 'browser.pull') return { state: { agentId: 'ag_far', open: true, tabs: [], live: true, at: 7 } };
        return method === 'browser.pullPart' ? { data: 'part' } : { ok: true };
      },
    },
  } as unknown as RuntimeServices;
  const handlers = new Map<string, PeerHandler>();
  const kinds = new Map<string, readonly string[] | undefined>();
  registerBrowserView({ register: (method, handler, linkKinds) => { handlers.set(method, handler); kinds.set(method, linkKinds); } }, () => services);
  const share = (key: string, people: string[]) => addShare({ db, clock: { now: () => 1 } } as never, key, people);
  const mesh = (method: string, params: unknown, from: string) => handlers.get(method)!(params, from, new AbortController().signal);
  const ctx = (scope: Record<string, unknown>) => ({ services, scope, signal: new AbortController().signal }) as unknown as HandlerContext;
  const rpc = async (method: keyof typeof browserHandlers, params: unknown, scope: Record<string, unknown> = { kind: 'owner' }) => browserHandlers[method](params, ctx(scope));
  return { db, handlers, kinds, mesh, rpc, sent, share };
}

test("every link reaches the five mesh methods; a browser shared with nobody answers only the CEO's own PCs, and from one of them the call reaches this PC's browser view", async () => {
  const r = rig();
  assert.deepEqual([...r.handlers.keys()].sort(), [...BROWSER_METHODS].sort());
  for (const method of BROWSER_METHODS) assert.deepEqual(r.kinds.get(method), ['ceo', 'employer', 'employee'], method);
  const calls: Array<[string, Record<string, unknown>]> = [
    ['browser.pull', { agentId: 'ag_here' }], ['browser.pullPart', { agentId: 'ag_here', at: 1, index: 1 }],
    ['browser.input', { agentId: 'ag_here', tab: 't1', input: { kind: 'text', text: 'x' } }],
    ['browser.navigate', { agentId: 'ag_here', action: 'reload' }], ['browser.takeover', { agentId: 'ag_here', on: true }],
  ];
  for (const from of ['dev_emp', 'dev_boss', 'dev_unknown', 'dev_self']) {
    for (const [method, params] of calls) await assert.rejects(r.mesh(method, params, from), (error: unknown) => code(error) === 'forbidden', `${method} from ${from}`);
  }
  // no live view runs in this rig: getting as far as the view proves the link check let it through
  for (const [method, params] of calls.slice(2)) await assert.rejects(r.mesh(method, params, 'dev_ceo'), (error: unknown) => code(error) === 'unavailable', method);
  await assert.rejects(r.mesh('browser.navigate', { agentId: 'ag_here', window: 'show' }, 'dev_ceo'), (error: unknown) => code(error) === 'bad_request', 'the real window never across');
  await assert.rejects(r.mesh('browser.input', { agentId: 'ag_here', tab: 't1', input: { kind: 'eval', text: 'x' } }, 'dev_ceo'), (error: unknown) => code(error) === 'bad_request');
});

test('a view of an agent on another PC goes there with its caller; one here stays here', async () => {
  const r = rig();
  const pulled = await r.rpc('browser.pull', { agentId: 'ag_far', maxBytes: 4 * 1024 * 1024 }) as { state: { at: number } };
  assert.equal(pulled.state.at, 7);
  assert.deepEqual(r.sent[0], { device: 'dev_ceo', method: 'browser.pull', params: { agentId: 'ag_far', maxBytes: SIDE_PART_BYTES, via: 'owner' } });
  assert.deepEqual(await r.rpc('browser.pullPart', { agentId: 'ag_far', at: 7, index: 1 }, { kind: 'device', deviceId: 'dev_phone' }), { data: 'part' });
  assert.equal(r.sent[1]!.params.via, 'dev_phone', 'the phone keeps its own slot there');
  await r.rpc('browser.input', { agentId: 'ag_far', tab: 't2', input: { kind: 'text', text: 'hello' } });
  await r.rpc('browser.takeover', { agentId: 'ag_far', on: true });
  await r.rpc('browser.navigate', { agentId: 'ag_far', url: 'https://example.com/' });
  assert.deepEqual(r.sent.slice(2).map((call) => [call.method, call.params]), [
    ['browser.input', { agentId: 'ag_far', tab: 't2', input: { kind: 'text', text: 'hello' }, via: 'owner' }],
    ['browser.takeover', { agentId: 'ag_far', on: true, via: 'owner' }],
    ['browser.navigate', { agentId: 'ag_far', url: 'https://example.com/', via: 'owner' }],
  ]);
  await assert.rejects(r.rpc('browser.navigate', { agentId: 'ag_far', window: 'show' }), /The window shows on the PC the agent runs on/);
  await assert.rejects(r.rpc('browser.takeover', { agentId: 'ag_here', on: true }), (error: unknown) => code(error) === 'unavailable', "an agent here: this PC's own view");
  assert.equal(r.sent.length, 5);
});

test('the caller key here keeps the linked PC apart and the owner there recognisable', async () => {
  assert.equal(forwardedCaller('dev_ceo', {}), 'dev_ceo/owner');
  assert.equal(forwardedCaller('dev_ceo', { via: 'dev_phone' }), 'dev_ceo/dev_phone');
  assert.throws(() => forwardedCaller('dev_ceo', { via: '../x y' }), /via must be a caller id/);
  const calls: unknown[] = [];
  await forwardBrowser({ db: rig().db, devices: { call: async (...args: unknown[]) => { calls.push(args.slice(0, 3)); } } } as never, 'dev_ceo', 'browser.pull', { agentId: 'ag_far' }, 'owner');
  assert.deepEqual(calls, [['dev_ceo', 'browser.pull', { agentId: 'ag_far', maxBytes: 1024 * 1024, via: 'owner' }]]);
});

test("21.11.2026: an agent's browser shared with a person reaches their PC, and the company's PC calling for them", async () => {
  const r = rig();
  const takeover = (from: string, extra: Record<string, unknown> = {}) => r.mesh('browser.takeover', { agentId: 'ag_here', on: true, ...extra }, from);
  const passed = (error: unknown) => code(error) === 'unavailable'; // no live view in this rig: the share let it through
  await assert.rejects(takeover('dev_emp'), (error: unknown) => code(error) === 'forbidden', 'not shared yet');
  r.share('agent:ag_here', ['per_1']);
  await assert.rejects(takeover('dev_emp'), passed, 'per_1\'s own PC');
  await assert.rejects(r.mesh('browser.takeover', { agentId: 'ag_other', on: true }, 'dev_emp'), (error: unknown) => code(error) === 'forbidden', 'another agent is not theirs');
  await assert.rejects(takeover('dev_boss'), (error: unknown) => code(error) === 'forbidden', 'the company\'s PC for its CEO');
  await assert.rejects(takeover('dev_boss', { for: 'per_1' }), passed, 'the company\'s PC passing per_1 on');
  await assert.rejects(takeover('dev_boss', { for: 'per_2' }), (error: unknown) => code(error) === 'forbidden');
  await assert.rejects(takeover('dev_ceo'), passed, 'a CEO PC as before');
  assert.equal(forwardedCaller('dev_boss/per_1', {}), 'dev_boss/per_1/owner', 'their slot names the person, and the owner gap stays');
});

test("21.11.2026: from an employee's PC a colleague's PC is reached through the company's PC, which passes on the caller's person", async () => {
  const r = rig(); // this PC: dev_boss is the company it joined
  r.share('agent:ag_here', ['per_1']);
  const company = memoryDb();
  new DevicesRepo(company).upsert(record('dev_company', { self: true }));
  new DevicesRepo(company).upsert(record('dev_e1', { personId: 'per_1' }));
  new DevicesRepo(company).upsert(record('dev_self', { personId: 'per_9' }));
  const arrived: Array<{ method: string; params: Record<string, unknown>; from: string }> = [];
  const relay = relayHandler(() => ({ db: company, devices: { call: async (to: string, method: string, params: Record<string, unknown>) => {
    assert.equal(to, 'dev_self');
    arrived.push({ method, params, from: 'dev_boss' });
    return r.mesh(method, params, 'dev_boss');
  } } }) as never);
  const e1 = memoryDb();
  new DevicesRepo(e1).upsert(record('dev_e1', { self: true }));
  new DevicesRepo(e1).upsert(record('dev_company', { joinedAs: 'employee' }));
  const viaCompany = { db: e1, devices: { call: async (device: string, method: string, params: Record<string, unknown>) => {
    assert.deepEqual([device, method], ['dev_company', 'pane.relay']);
    return relay(params, 'dev_e1', new AbortController().signal);
  } } };
  await assert.rejects(forwardBrowser(viaCompany as never, 'dev_self', 'browser.takeover', { agentId: 'ag_here', on: true }, 'owner'), (error: unknown) => code(error) === 'unavailable', 'shared with per_1: it reached the browser view there');
  assert.deepEqual(arrived, [{ method: 'browser.takeover', params: { agentId: 'ag_here', on: true, via: 'owner', for: 'per_1' }, from: 'dev_boss' }]);
  removeShare({ db: r.db, clock: { now: () => 2 } } as never, 'agent:ag_here');
  await assert.rejects(forwardBrowser(viaCompany as never, 'dev_self', 'browser.takeover', { agentId: 'ag_here', on: true }, 'owner'), (error: unknown) => code(error) === 'forbidden', 'shared no more');
});
