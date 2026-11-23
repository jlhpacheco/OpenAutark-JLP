// "Only me" hides nothing (owner 20.11.2026: "Only me" means the person does it themselves, it is no privacy – "wieso
// soll Only Me keine anderen PCs erreichen?"): a person reads an "Only me" task by the same rules as any other – through
// the chat it was handed over in, as its maker, as a CEO – in code and in SQL alike, and it syncs to a colleague's PC
// like its neighbour (people/access.ts mayReadTask, readsTask, readableTasksSql; devices/sync/tables.ts); an employee's own
// "Only me" to-do travels to her company like her other own to-dos (devices/sync/employee.ts).
// Owns: these assertions only. Never: a real mesh or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { readsTask } from '../../../src/runtime/people/access.ts';
import { agent } from '../chat/harness.ts';
import { link, makePc, Net, settle } from '../devices/sync-net.ts';
import { peopleRig } from './rig.ts';

test('a person reads an "Only me" task by the same rules as any other – through its chat, as its maker, in SQL alike', async (t) => {
  const r = peopleRig();
  t.after(r.cleanup);
  const anna = (await r.join('Anna')).person.id;
  const ben = (await r.join('Ben')).person.id;
  const room = r.chats.create({ agentIds: ['ag_research'], people: [anna], createdBy: HUMAN_ID });
  const plain = r.tasks.create({ conversationId: room.id, title: 'Draft the offer', assigneeKind: 'agent', assigneeId: 'ag_research', createdBy: HUMAN_ID });
  const own = r.tasks.create({ conversationId: room.id, title: 'Sign the offer', assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  const quest = r.tasks.create({ conversationId: room.id, kind: 'quest', title: 'Health', assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  const inside = r.tasks.create({ conversationId: room.id, title: 'Find a clinic', parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_research', createdBy: HUMAN_ID });
  const fromAnna = r.tasks.create({ title: 'Read my notes', assigneeKind: 'human', assigneeId: ben, createdBy: anna, private: true });
  const reads = (person: string, id: string) => readsTask(r.db, person, r.tasks.get(id)!);
  for (const id of [plain.id, own.id, quest.id, inside.id, fromAnna.id]) assert.equal(reads(anna, id), true, id);
  assert.equal(reads(ben, fromAnna.id), true);
  assert.equal(reads(ben, own.id), false, 'not his chat: the usual rule, not "Only me"');
  const made = new Set([plain, own, quest, inside, fromAnna].map((task) => task.id)); // the rig's own join to-dos left out
  const listed = (person: string) => r.tasks.list({ readableByPerson: person, includeSteps: true, limit: 200 }).map((task) => task.id).filter((id) => made.has(id));
  assert.deepEqual(listed(anna).sort(), [...made].sort(), 'the SQL rule is the same');
});

test('an "Only me" task syncs to a colleague\'s PC through the chat it was handed over in, like its neighbour', async () => {
  const LENA = 'per_lena000001';
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  a.h.org.add(agent('ag_x', 'Xena'));
  const room = a.h.chats.create({ agentIds: ['ag_x'], people: [LENA], createdBy: HUMAN_ID });
  const plain = a.h.tasks.create({ conversationId: room.id, title: 'Draft the offer', assigneeKind: 'agent', assigneeId: 'ag_x', createdBy: HUMAN_ID });
  const own = a.h.tasks.create({ conversationId: room.id, title: 'Sign the offer', assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  await settle();
  assert.ok(e.h.tasks.get(plain.id));
  assert.equal(e.h.tasks.get(own.id)?.private, true, 'it reaches her PC, marked "Only me"');
  a.h.tasks.update(own.id, { title: 'Sign the offer today' }, HUMAN_ID);
  await settle();
  assert.equal(e.h.tasks.get(own.id)?.title, 'Sign the offer today', 'and its changes follow');
});

test('an employee\'s own "Only me" to-do reaches her company like her other own to-dos, and its "done" follows', async () => {
  const LENA = 'per_lena000001';
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const own = e.h.tasks.create({ title: 'Renew my passport', assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  await settle();
  const there = a.h.tasks.get(own.id);
  assert.deepEqual([there?.assigneeKind, there?.assigneeId, there?.private], ['human', LENA, true], 'hers there, marked "Only me"');
  e.h.tasks.finish(own.id, { status: 'done', summary: 'Renewed' }, HUMAN_ID);
  await settle();
  assert.equal(a.h.tasks.get(own.id)?.status, 'done', 'her "done" follows');
});
