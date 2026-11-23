// Owner 21.11.2026 ("natürlich sieht man alle anderen Agenten … das ist doch völliger Blödsinn"): every agent of the
// company reaches an employee's PC – without its setup, with the person's own personal manager as theirs, once also over
// a link that already has a cursor; the seat's untouched first-run Manager retires; a chat the person starts there with
// a company agent goes to the company and the line is delivered there; an employer's agent never runs on the person's PC.
// Owns: these assertions only. Never: a real mesh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { fromEmployer } from '../../../src/runtime/devices/sync/employee.ts';
import { homeElsewhere } from '../../../src/runtime/devices/sync/home.ts';
import { link, makePc, Net, settle } from './sync-net.ts';

const LENA = 'per_lena000001';

function company() {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const now = a.h.clock.now();
  const mira = agent('ag_mira', 'Mira', { instructions: 'Private setup of the company.', createdAt: now - 20_000, deviceId: 'dev_a' });
  const leo = agent('ag_leo', 'Leo', { createdAt: now - 20_000, managerId: LENA });
  for (const one of [mira, leo]) { new AgentRepo(a.h.db).save(one); a.h.org.add(one); }
  return { net, a, e, now };
}

const row = (pc: ReturnType<typeof makePc>, id: string) => pc.h.db.get<{ name: string; instructions: string; device_id: string | null; person_manager_id: string | null }>(
  'SELECT name, instructions, device_id, person_manager_id FROM agents WHERE id = ?', [id]);

test('every company agent reaches the employee\'s PC without its setup; their personal manager is theirs there', async () => {
  const { a, e } = company();
  link(a, e, LENA);
  assert.ok(await a.sync.catchUp('dev_e', undefined));
  await settle();
  assert.equal(row(e, 'ag_mira')?.name, 'Mira');
  assert.equal(row(e, 'ag_mira')?.instructions, '', 'its setup stays on the company\'s PCs');
  assert.equal(row(e, 'ag_mira')?.device_id, 'dev_a', 'it runs on the company PC');
  assert.equal(row(e, 'ag_leo')?.person_manager_id, 'human', 'Lena\'s personal manager is hers there');
  assert.equal(fromEmployer(e.h.db, 'ag_mira'), true);
});

test('a link that already has a cursor gets every agent once', async () => {
  const { a, e } = company();
  link(a, e, LENA);
  assert.ok(await a.sync.catchUp('dev_e', a.h.clock.now())); // nothing changed since: before 21.11. no agent went
  await settle();
  assert.equal(row(e, 'ag_mira')?.name, 'Mira', 'owed once');
  e.h.db.run('DELETE FROM agents WHERE id = ?', ['ag_mira']);
  assert.ok(await a.sync.catchUp('dev_e', a.h.clock.now()));
  await settle();
  assert.equal(row(e, 'ag_mira'), undefined, 'only once');
});

test('the seat\'s untouched first-run Manager retires once the company\'s agents arrive', async () => {
  const { a, e, now } = company();
  const seed = agent('ag_seed', 'Manager', { template: 'manager', createdAt: now - 5_000 });
  new AgentRepo(e.h.db).save(seed);
  e.h.org.add(seed);
  const archived: string[] = [];
  Object.assign(e.h.org, { archive: (id: string) => { archived.push(id); e.h.db.run('UPDATE agents SET archived_at = ? WHERE id = ?', [now, id]); } });
  link(a, e, LENA);
  assert.ok(await a.sync.catchUp('dev_e', undefined));
  await settle();
  assert.deepEqual(archived, ['ag_seed'], 'the company\'s manager is hers');
});

test('a company agent never runs on her PC; a chat she starts there with one goes to the company and her line is delivered there', async () => {
  const { a, e } = company();
  link(a, e, LENA);
  assert.ok(await a.sync.catchUp('dev_e', undefined));
  await settle();
  e.h.org.add(agent('ag_mira', 'Mira', { deviceId: 'dev_a' }));
  assert.equal(homeElsewhere(e.h.services, 'ag_mira'), 'dev_a', 'never here');

  const delivered: string[] = [];
  const onMessage = a.h.services.delivery.onMessage.bind(a.h.services.delivery);
  a.h.services.delivery.onMessage = (message) => { delivered.push(message.body); return onMessage(message); };
  const chat = e.h.chats.create({ agentIds: ['ag_mira'], createdBy: 'human' });
  await settle();
  e.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Hallo Mira' });
  await settle();
  const there = a.h.chats.get(chat.id);
  assert.ok(there, 'the chat reached the company');
  assert.deepEqual(a.h.db.all<{ member_id: string }>('SELECT member_id FROM members WHERE conversation_id = ? ORDER BY member_id', [chat.id]).map((m) => m.member_id), ['ag_mira', LENA]);
  assert.deepEqual(delivered, ['Hallo Mira'], 'delivered like a line from her phone');
});

test('a chat with one of her own agents stays on her PC', async () => {
  const { a, e } = company();
  link(a, e, LENA);
  const own = agent('ag_own', 'Own');
  new AgentRepo(e.h.db).save(own);
  e.h.org.add(own);
  const chat = e.h.chats.create({ agentIds: ['ag_own'], createdBy: 'human' });
  await settle();
  assert.equal(a.h.chats.get(chat.id), undefined);
});
