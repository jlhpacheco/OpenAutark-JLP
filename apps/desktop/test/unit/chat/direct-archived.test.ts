// 25.11.2026 (Konrad): an archived agent takes the owner's default 1:1 with it out of the list, a restored agent brings the
// same chat back, and the start archives the 1:1 of an agent that was archived before (runtime/chat/direct.ts
// keepOwnerDirects). Only that one chat: a group chat with the agent and the 1:1 of two agents stay as they are; the
// history stays (archived, not deleted).
// Owns: these assertions. Never: the default 1:1 of active agents (direct-owner.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { harness, tick } from './harness.ts';
import { findDirect, findOrCreateDirect, keepOwnerDirects } from '../../../src/runtime/chat/direct.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');

function setup() {
  const h = harness();
  const org = new Org({ db: h.db, bus: h.bus, clock: h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  (h.services as { org: unknown }).org = org;
  return { ...h, org, services: h.services as RuntimeServices };
}

const listed = (h: ReturnType<typeof setup>) => h.chats.list().map((chat) => chat.id);
const everything = (h: ReturnType<typeof setup>) => h.chats.list({ includeHidden: true }).map((chat) => chat.id);

test('archiving an agent archives its default 1:1 only – listed with includeHidden, messages kept; restoring brings the same chat back', async () => {
  const h = setup();
  const off = keepOwnerDirects(h.services);
  const manager = h.org.ensureSeed()!;
  const mira = h.org.create({ name: 'Mira', createdBy: HUMAN_ID });
  const tom = h.org.create({ name: 'Tom', createdBy: HUMAN_ID });
  await tick();
  const direct = findDirect(h.services, HUMAN_ID, mira.id)!;
  const other = findDirect(h.services, HUMAN_ID, tom.id)!;
  assert.ok(direct && other);
  h.chats.send({ conversationId: direct, body: 'Earlier history', authorId: HUMAN_ID, authorKind: 'human' });
  const group = h.chats.create({ title: 'Launch', agentIds: [mira.id, tom.id], createdBy: HUMAN_ID }).id;
  const pair = findOrCreateDirect(h.services, tom.id, mira.id); // two agents: their own 1:1
  assert.ok(listed(h).includes(direct));

  h.org.archive(mira.id, { successorId: manager.id });
  await tick();
  assert.ok(!listed(h).includes(direct), 'the default 1:1 left the list');
  assert.ok(everything(h).includes(direct), 'and stays reachable under archived');
  assert.ok(h.chats.messages(direct).some((m) => m.body === 'Earlier history'), 'its history stays');
  for (const id of [group, pair, other]) assert.equal(h.chats.get(id)?.archivedAt, undefined, 'no other chat is touched');
  assert.ok(listed(h).includes(group) && listed(h).includes(other));
  assert.ok(h.events.some((e) => e.event === 'conversation.upserted' && (e.data as { id: string }).id === direct), 'the windows hear of it');

  h.org.restore(mira.id);
  await tick();
  assert.equal(findDirect(h.services, HUMAN_ID, mira.id), direct, 'the same chat, not a new one');
  assert.ok(listed(h).includes(direct), 'back in the list');
  assert.equal(h.chats.get(direct)?.archivedAt, undefined);
  assert.ok(h.chats.messages(direct).some((m) => m.body === 'Earlier history'));
  assert.equal(h.chats.list({ includeHidden: true }).filter((c) => c.settings.direct && c.id !== pair).length, 3, 'manager, Mira and Tom – one 1:1 each');
  off();
});

test('start-up backfill archives the default 1:1 of an agent archived before; a second start changes nothing', async () => {
  const h = setup();
  const manager = h.org.ensureSeed()!;
  const mira = h.org.create({ name: 'Mira', createdBy: HUMAN_ID });
  const tom = h.org.create({ name: 'Tom', createdBy: HUMAN_ID });
  const miraDirect = findOrCreateDirect(h.services, HUMAN_ID, mira.id); // no keepOwnerDirects running: the old data of before this fix
  const tomDirect = findOrCreateDirect(h.services, HUMAN_ID, tom.id);
  findOrCreateDirect(h.services, HUMAN_ID, manager.id);
  h.org.archive(mira.id, { successorId: manager.id });
  assert.ok(listed(h).includes(miraDirect), 'visible before the fix runs');

  const off = keepOwnerDirects(h.services);
  assert.ok(!listed(h).includes(miraDirect));
  assert.ok(everything(h).includes(miraDirect));
  assert.ok(listed(h).includes(tomDirect));
  const archivedAt = h.chats.get(miraDirect)!.archivedAt;
  assert.ok(archivedAt !== undefined);
  off();

  h.clock.advance(5000);
  const before = h.events.length;
  keepOwnerDirects(h.services)();
  assert.equal(h.chats.get(miraDirect)!.archivedAt, archivedAt, 'untouched');
  assert.deepEqual(h.events.slice(before).filter((e) => e.event === 'conversation.upserted'), [], 'no event, no change');
  assert.equal(everything(h).length, 3, 'nothing made');
});
