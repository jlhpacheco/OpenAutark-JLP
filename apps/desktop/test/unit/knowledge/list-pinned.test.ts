// KnowledgeStore: the paged list filters by pinned (store + RPC knowledge.list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/knowledge.ts';
import type { KnowledgeItem } from '../../../src/shared/model/knowledge.ts';

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  return { db, clock, store: new KnowledgeStore({ db, clock }) };
}

test('list filters by pinned in the store and over RPC knowledge.list', async () => {
  const { store, clock } = setup();
  for (let i = 0; i < 120; i++) {
    clock.advance(1);
    store.save({ scope: 'agent', scopeId: 'ag_a', kind: 'fact', title: `Fact ${i}`, body: `Body ${i}`, pinned: i === 3 || i === 7, createdBy: 'human' });
  }
  const pinned = (await store.list({ scope: 'agent', scopeId: 'ag_a', pinned: true, limit: 100 }));
  assert.deepEqual(pinned.map((item) => item.title), ['Fact 7', 'Fact 3'], 'older pinned items are found beyond the first 100 rows');
  assert.equal((await store.list({ scope: 'agent', scopeId: 'ag_a', pinned: false, limit: 500 })).length, 118);
  assert.equal((await store.list({ scope: 'agent', scopeId: 'ag_a', limit: 500 })).length, 120);

  const table = new HandlerTable();
  register(table);
  const ctx = { services: { knowledge: store } } as unknown as HandlerContext;
  const list = (params: Record<string, unknown>) => table.get('knowledge.list')!.handler(params as never, ctx) as Promise<{ items: KnowledgeItem[]; next?: string }>;
  const page = await list({ scope: 'agent', scopeId: 'ag_a', pinned: true, limit: 1 });
  assert.deepEqual([page.items.map((item) => item.title), page.next], [['Fact 7'], '1']);
  assert.deepEqual((await list({ pinned: true, cursor: '1' })).items.map((item) => item.title), ['Fact 3']);
  await assert.rejects(async () => list({ pinned: 'yes' }), /pinned/);
});
