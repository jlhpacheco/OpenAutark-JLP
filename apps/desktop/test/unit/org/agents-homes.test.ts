// 0.3.20 (Konrad #830): a new agent (agents.create tool and RPC) starts at home on all of the person's own PCs.
// Umzug part 2, 21.11.2026 – Agent.homes (migration 113): the PCs an agent is at home on. Absent by default (column
// '[]'); an edit stores the list of PC ids, each once, and [] clears it (org/patch.ts, store/agents.ts). agents.update
// {homes} takes names or ids of the person's own PCs, stores their ids with the PC the agent runs on, answers with the
// names, and says which name is none of those PCs; a move leaves the list as it is.
// Owns: these assertions only. Never: the network, real timers or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerOrg } from '../../../src/runtime/rpc/handlers/org.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';
import { link, makePc, Net, record } from '../devices/sync-net.ts';
import { liveHomes } from '../../../src/runtime/devices/sync/home.ts';

test('homes: absent by default (column []), a list stored as JSON and read back, each PC once, cleared again by []', () => {
  const db = memoryDb();
  const org = new Org({ db, bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') });
  const manager = org.ensureSeed()!;
  const column = () => db.get<{ homes: string }>('SELECT homes FROM agents WHERE id = ?', [manager.id])?.homes;
  assert.equal(manager.homes, undefined);
  assert.equal(column(), '[]');
  assert.deepEqual(org.update(manager.id, { homes: ['dev_a', 'dev_b', 'dev_a'] }).homes, ['dev_a', 'dev_b']);
  assert.equal(column(), '["dev_a","dev_b"]');
  assert.deepEqual(org.get(manager.id)?.homes, ['dev_a', 'dev_b']);
  assert.deepEqual(org.update(manager.id, { role: 'Chief of staff' }).homes, ['dev_a', 'dev_b'], 'another edit keeps it');
  assert.equal(org.update(manager.id, { homes: [] }).homes, undefined);
  assert.equal(column(), '[]');
  assert.throws(() => org.update(manager.id, { homes: 'dev_a' as never }), /homes is a list of PCs/);
  assert.equal(org.update(manager.id, { homes: Array.from({ length: 21 }, (_, n) => `dev_${n}`) }).homes?.length, 21, 'review L4: 20 named PCs and the one it runs on');
  assert.throws(() => org.update(manager.id, { homes: Array.from({ length: 33 }, (_, n) => `dev_${n}`) }), /homes takes at most 32 PCs/);
});

/** This PC "Tower" with the linked own PC "Notebook", an employee's PC "Guest" and the real org. */
function rig() {
  const net = new Net();
  const tower = makePc(net, 'dev_t');
  const notebook = makePc(net, 'dev_n');
  const guest = makePc(net, 'dev_g');
  link(tower, notebook);
  link(tower, guest, 'person_g');
  tower.repo.upsert(record('dev_t', { self: true, name: 'Tower' }));
  tower.repo.upsert({ ...tower.repo.get('dev_n')!, name: 'Notebook' });
  tower.repo.upsert({ ...tower.repo.get('dev_g')!, name: 'Guest' });
  const org = new Org({ db: tower.h.db, bus: tower.h.bus, clock: tower.h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  tower.h.services.org = org;
  const manager = org.ensureSeed()!;
  const update = agentTools.find((tool) => tool.name === 'agents.update')!;
  const ctx = () => ({ agent: org.get(manager.id)!, services: tower.h.services, runId: 'run_h', mode: 'manager', signal: new AbortController().signal, status: () => {} }) as unknown as ToolContext;
  return { org, manager, update, ctx };
}

test('agents.update {homes}: names of my own PCs become their ids, with the PC I run on; the answer names them; [] clears', async () => {
  const { org, manager, update, ctx } = rig();
  assert.equal(update.describe!({ homes: ['notebook'] } as never, ctx()).summary, `Update agent ${manager.name}: at home on Notebook`);
  assert.equal(update.describe!({ homes: [] } as never, ctx()).summary, `Update agent ${manager.name}: waits for its own PC`);

  const out = await update.run({ homes: ['notebook'] } as never, ctx());
  assert.equal(out.isError, undefined);
  assert.deepEqual((out.structured as { homes?: string[] }).homes, ['Tower', 'Notebook']);
  assert.deepEqual(org.get(manager.id)?.homes, ['dev_t', 'dev_n'], 'ids, the PC I run on counted in');

  await update.run({ homes: ['Tower', 'dev_n', 'this'] } as never, ctx());
  assert.deepEqual(org.get(manager.id)?.homes, ['dev_t', 'dev_n'], 'each PC once, by name, id or "this"');

  const cleared = await update.run({ homes: [] } as never, ctx());
  assert.deepEqual((cleared.structured as { homes?: string[] }).homes, []);
  assert.equal(org.get(manager.id)?.homes, undefined);
});

test('agents.update {homes}: a PC that is not one of the person\'s own, or no PC at all, changes nothing and says so', async () => {
  const { org, manager, update, ctx } = rig();
  const guest = await update.run({ homes: ['Notebook', 'Guest'] } as never, ctx());
  assert.equal(guest.isError, true);
  assert.equal((guest.content[0] as { text: string }).text, 'I am at home on the person\'s own PCs; Guest is not one of them.');
  const unknown = await update.run({ homes: ['Attic'] } as never, ctx());
  assert.equal(unknown.isError, true);
  assert.match((unknown.content[0] as { text: string }).text, /^No linked PC is called "Attic"\./);
  assert.equal(org.get(manager.id)?.homes, undefined);
});

test('agents.update {device, homes} in one call: at home on the PC I move to and the ones I name; a later move keeps the list', async () => {
  const { org, manager, update, ctx } = rig();
  await update.run({ agentId: manager.id, device: 'Notebook', homes: ['Tower'] } as never, { ...ctx(), agent: { ...ctx().agent, id: 'ag_other' } } as ToolContext);
  assert.equal(org.get(manager.id)?.deviceId, 'dev_n');
  assert.deepEqual(org.get(manager.id)?.homes, ['dev_n', 'dev_t']);
  org.update(manager.id, { deviceId: undefined });
  assert.deepEqual(org.get(manager.id)?.homes, ['dev_n', 'dev_t'], 'the set of homes stays the same');
});

// 0.3.20 (Konrad #830): a NEW agent is at home on all of the person's own PCs – hired by an agent (agents.create) or by the
// person in the app (agents.create RPC); the employee's PC "Guest" is none of them; agents that exist keep what they have.
test('agents.create: a hire is at home on this PC and the linked own PC, not on an employee\'s PC; the existing agent keeps its homes', async () => {
  const { org, manager, ctx } = rig();
  const create = agentOrgTools.find((tool) => tool.name === 'agents.create')!;
  const out = await create.run({ name: 'Mara', role: 'Research' } as never, ctx());
  assert.equal(out.isError, undefined, JSON.stringify(out.content));
  const mara = org.get((out.structured as { agentId: string }).agentId)!;
  assert.deepEqual(mara.homes, ['dev_t', 'dev_n'], 'this PC first, then the own PC – Guest is no own PC');
  assert.equal(mara.deviceId, undefined, 'it still runs here (no deviceId)');
  assert.equal(org.get(manager.id)?.homes, undefined, 'the agent that existed keeps what it has: no migration');

  const moved = await create.run({ name: 'Nico', role: 'Research', device: 'Notebook' } as never, ctx());
  assert.equal(moved.isError, undefined, JSON.stringify(moved.content));
  const nico = org.get((moved.structured as { agentId: string }).agentId)!;
  assert.equal(nico.deviceId, 'dev_n');
  assert.deepEqual(nico.homes, ['dev_n', 'dev_t'], 'the PC it was given to first, the others behind it');

  const team = await create.run({ agents: [{ name: 'Olga', role: 'Writer' }, { name: 'Paul', role: 'Editor' }] } as never, ctx());
  assert.equal(team.isError, undefined, JSON.stringify(team.content));
  for (const name of ['Olga', 'Paul']) assert.deepEqual(org.list().find((agent) => agent.name === name)?.homes, ['dev_t', 'dev_n'], `${name} of a team hire too`);
});

test('agents.update {device}: moving an agent to another PC does not write homes for it – only a new agent starts with them', async () => {
  const { org, manager, update, ctx } = rig();
  await update.run({ device: 'Notebook' } as never, ctx());
  assert.equal(org.get(manager.id)?.deviceId, 'dev_n');
  assert.equal(org.get(manager.id)?.homes, undefined, 'the existing agent\'s homes come with 0.3.21 (ledger)');
});

test('agents.create with no other own PC linked: homes stay empty (the agent waits for its PC as before)', async () => {
  const net = new Net();
  const solo = makePc(net, 'dev_s');
  const guest = makePc(net, 'dev_g');
  link(solo, guest, 'person_g');
  solo.repo.upsert(record('dev_s', { self: true, name: 'Solo' }));
  const org = new Org({ db: solo.h.db, bus: solo.h.bus, clock: solo.h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  solo.h.services.org = org;
  const manager = org.ensureSeed()!;
  const create = agentOrgTools.find((tool) => tool.name === 'agents.create')!;
  const ctx = { agent: org.get(manager.id)!, services: solo.h.services, runId: 'run_s', mode: 'manager', signal: new AbortController().signal, status: () => {} } as unknown as ToolContext;
  const out = await create.run({ name: 'Rita', role: 'Research' } as never, ctx);
  assert.equal(out.isError, undefined, JSON.stringify(out.content));
  assert.equal(org.get((out.structured as { agentId: string }).agentId)?.homes, undefined);
});

test('the app\'s hire (agents.create RPC) puts the person\'s new agent at home on their own PCs too', async () => {
  const { org, manager, ctx } = rig();
  const table = new HandlerTable();
  registerOrg(table);
  const entry = table.get('agents.create')!;
  const handlerCtx = { scope: { kind: 'owner' }, services: ctx().services, extras: {}, topics: new Set(), signal: new AbortController().signal, secure: true } as unknown as HandlerContext;
  const made = await entry.handler({ name: 'Quinn', role: 'Research' } as never, handlerCtx) as { id: string };
  assert.deepEqual(org.get(made.id)?.homes, ['dev_t', 'dev_n']);
  assert.equal(org.get(manager.id)?.homes, undefined);
});

test('review L3: a PC that was removed is not named any more, and goes from the list at the next move', async () => {
  const { org, manager, update, ctx } = rig();
  const services = ctx().services;
  org.update(manager.id, { homes: ['dev_t', 'dev_n', 'dev_g'] }); // dev_g: linked here, not one of the person's own PCs
  const out = await update.run({ role: 'Lead' } as never, ctx());
  assert.equal((out.structured as { homes?: string[] }).homes, undefined, 'only an answer to homes names them');
  assert.deepEqual(liveHomes(services.db, org.get(manager.id)!.homes!), ['dev_t', 'dev_n']);
  assert.deepEqual(liveHomes(services.db, ['dev_t', 'dev_unknown']), ['dev_t', 'dev_unknown'], 'a PC this one never linked stays: another of my PCs knows it');
});
