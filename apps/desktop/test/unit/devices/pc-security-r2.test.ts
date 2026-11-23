// Umzug 21.11.2026, PCSEC round 2 (review R2): H1 – the file-tab path methods ('files.path') pass this PC's otherPcs
// for every caller but the person, like tools.call and files.put; H2 – an approval to-do answered on another of the
// person's PCs reaches the PC that holds the request (its client id apr:<id> travels; the answer goes there over
// 'security.answer'; the holder applies it and wakes the agent; with linked PCs but none online it says so; no holder:
// dropped); L6 – a refusal that travels back names the receiving PC.
// Owns: these assertions only. Never: a real network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent, harness } from '../chat/harness.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { relayAnswer, serveAnswer } from '../../../src/runtime/security/answer-relay.ts';
import { RemotePaths } from '../../../src/runtime/devices/sync/paths.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { readRow, TABLE } from '../../../src/runtime/devices/sync/tables.ts';
import { TaskRepo } from '../../../src/runtime/tasks/repo.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const root = path.resolve('pcsec-r2-root');
const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id === 'dev_a' ? 'Tower' : 'Laptop', kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
} as DeviceRecord);

/** One PC: settings, Security (short wait), Tom in its org, the other PC linked as the CEO's. */
function pc(id: 'dev_a' | 'dev_b', security: Partial<SecuritySettings> = {}) {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  settings.update({ profile: { name: 'Mia' }, security: { ...securityDefaults('secure'), ...security } } as never);
  const services = h.services as RuntimeServices;
  services.settings = settings;
  services.paths = { data: path.join(root, id, 'data'), workspace: path.join(root, id, 'Workforce'), resources: path.join(root, 'res'), temp: path.join(root, id, 'tmp') } as RuntimeServices['paths'];
  h.org.add(agent('ag_tom', 'Tom'));
  const repo = new DevicesRepo(h.db);
  repo.upsert(record(id, { self: true }));
  const other = id === 'dev_a' ? 'dev_b' : 'dev_a';
  repo.upsert(record(other));
  const sec = new Security({ services: () => services, waitMs: 20 });
  services.security = sec;
  const net = { up: true, to: undefined as RuntimeServices | undefined };
  services.devices = {
    self: () => ({ ...record(id), self: true }), list: () => repo.list(),
    online: () => net.up, call: async (_to: string, _method: string, params: unknown) => serveAnswer(net.to!, params, id),
  } as unknown as RuntimeServices['devices'];
  return { ...h, services, settings, sec, net };
}

test('H1: a file-tab request from another PC passes otherPcs – no refuses, ask asks, the person passes', async () => {
  const a = pc('dev_a', { otherPcs: 'no' });
  const paths = new RemotePaths(a.services, {} as never, { read: async () => ({ text: 'x' }), write: async () => ({}), list: async () => ({ entries: [] }) });
  const file = path.join(root, 'dev_a', 'Workforce', 'note.md');
  for (const by of [{ agentId: 'ag_far', agentName: 'Lena' }, {}]) {
    await assert.rejects(paths.serve({ op: 'read', path: file, by }, 'dev_b'), /Tower takes no calls from agents on other PCs/);
  }
  await assert.rejects(paths.serve({ op: 'root', by: { agentId: 'ag_far' } }, 'dev_b'), /Tower takes no calls/, 'root too');
  assert.deepEqual(await paths.serve({ op: 'read', path: file, by: { person: true } }, 'dev_b'), { text: 'x' }, 'the person\'s own request');
  a.settings.update({ security: { otherPcs: 'ask' } } as never);
  await assert.rejects(paths.serve({ op: 'write', path: file, by: { agentId: 'ag_far', agentName: 'Lena' } }, 'dev_b'), /Calls from agents on other PCs is closed on Tower, so the app asked Mia/);
  const [request] = a.sec.requests();
  assert.equal(request.capability, 'otherPcs');
  assert.equal(request.summary, `From Laptop: Change ${file}`);
  assert.equal(request.agentName, 'Lena (Laptop)');
});

test('H2: an approval to-do keeps its client id apr:<id> between PCs; every other client id stays home', () => {
  const a = pc('dev_a');
  const repo = new TaskRepo(a.db);
  const base = { kind: 'task', title: 't', notes: '', status: 'open', assigneeKind: 'human', priority: 1, ledger: {}, sort: 0, rev: 1, createdAt: 1, updatedAt: 1 };
  repo.insert({ ...base, id: 'tk_apr', createdBy: SYSTEM_ID } as never, 'apr:apr_1');
  repo.insert({ ...base, id: 'tk_own', createdBy: 'human' } as never, 'cl_1');
  repo.insert({ ...base, id: 'tk_fake', createdBy: 'ag_tom' } as never, 'apr:apr_2');
  const out = (id: string) => readRow(a.services, TABLE.get('tasks')!, id, 'dev_a');
  assert.equal(out('tk_apr')!.client_id, 'apr:apr_1');
  assert.equal('client_id' in out('tk_own')!, false);
  assert.equal('client_id' in out('tk_fake')!, false, 'only the app\'s own request to-do');
});

test('H2: asked on Tower, answered on Laptop – Tower applies it, the agent is woken, the to-do closes there', async () => {
  const a = pc('dev_a');
  const b = pc('dev_b');
  b.net.to = a.services;
  const result = await a.sec.gate({ agentId: 'ag_tom', capability: 'commands', summary: 'Run: npm install', fingerprint: 'fp_1' });
  assert.match((result as { text: string }).text, /closed on Tower, so the app asked Mia/, 'L6: the PC by its name');
  const [request] = a.sec.requests();
  const [todo] = a.tasks.todos(10);
  // The to-do as it arrived on Laptop (rows.ts): same id, its client id along.
  const row = readRow(a.services, TABLE.get('tasks')!, todo.id, 'dev_a')!;
  TABLE.get('tasks')!.write!(row, { s: b.services } as never, false);
  const view = b.tasks.answer({ taskId: todo.id, answer: { choice: 'once' }, by: 'human' });
  assert.equal(view?.status, 'open', 'Laptop leaves it to Tower');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(a.sec.requests().length, 0, 'Tower applied the answer');
  assert.equal(a.tasks.get(todo.id)?.status, 'done', 'and closed its to-do (that travels back)');
  const [wake] = a.wakeRows();
  assert.equal(wake.agent_id, 'ag_tom');
  assert.match(wake.note ?? '', /Mia answered my request "Run: npm install": Allow once/);
  assert.equal(request.capability, 'commands');
});

test('H2: Tower offline – the answer is refused and the to-do stays; no PC holds it – dropped; only a CEO PC answers', async () => {
  const a = pc('dev_a');
  const b = pc('dev_b');
  b.net.to = a.services;
  b.net.up = false;
  assert.equal(relayAnswer(b.services, 'apr_x', 'once', () => assert.fail('not gone')), 'offline');
  b.net.up = true;
  let gone = false;
  assert.equal(relayAnswer(b.services, 'apr_unknown', 'once', () => { gone = true; }), 'sent');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gone, true, 'nobody holds it');
  new DevicesRepo(a.db).upsert(record('dev_b', { personId: 'pe_anna' }));
  await assert.rejects(serveAnswer(a.services, { id: 'apr_1', answer: 'once' }, 'dev_b'), /only from the person's own PCs/);
});
