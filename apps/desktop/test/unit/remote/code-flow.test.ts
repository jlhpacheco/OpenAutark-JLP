// The two IDs in the connect flow (remote/service.ts, requests.ts, join.ts, find.ts with remote/code.ts; Eine-ID
// 22.11.2026): a PC accepted as one of my devices gets my signature in my tree and in the company's; a request by my ID
// reaches my other PC while the first one is gone, its `me` chain proves the ID and it joins as one of my devices; a
// request by the company's ID reaches the company's other PC, its company chain proves it and it joins as a new member;
// a device whose chain ends elsewhere is never asked.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belongs } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { Lan, connectYes, linkedIds, settle, treesOf, type Pc } from './rig.ts';

async function accept(target: Pc, from: Pc, id: string): Promise<void> {
  await connectYes(from, { target: id });
  const [incoming] = target.remote.state().incoming;
  target.remote.decide(incoming.id, true);
  await settle();
}

/** Laptop and Tower: my two PCs, Tower accepted by my ID, both trees brought over as the roster does (sync-roster-code.test.ts). */
async function mine() {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  const lt = treesOf(laptop);
  const tt = treesOf(tower);
  const myId = lt.me.code();
  await accept(laptop, tower, myId);
  tt.me.take(lt.me.tree(), laptop.mesh.selfInfo().pub);
  tt.company.take(lt.company.tree(), laptop.mesh.selfInfo().pub);
  laptop.findable = false; // the laptop is away
  laptop.remote.refresh();
  laptop.hello = undefined;
  return { lan, laptop, tower, lt, tt, myId };
}

test('a request by my ID reaches my other PC while the first one is gone, and the me chain proves it', async () => {
  const { lan, laptop, tower, lt, tt, myId } = await mine();
  assert.deepEqual(linkedIds(laptop), [tower.identity.deviceId]);
  assert.ok(lt.me.tree().links.some((entry) => entry.by === laptop.identity.fingerprint), 'Laptop signed Tower into my tree');
  assert.equal(tower.remote.state().self.myId, myId, 'Tower shows the same ID');
  assert.ok(tower.states.some((state) => state.self.myId === myId), 'and tells Settings at once');

  const desk = await lan.add('Desk', 'http://10.0.0.3:47812');
  const out = await connectYes(desk, { target: myId });
  assert.equal(out.deviceId, tower.identity.deviceId, 'Tower answered for my ID');
  assert.equal(out.remoteId, myId);
  assert.equal(out.role, 'ceo', 'my ID: one of my devices');
  const [incoming] = tower.remote.state().incoming;
  tower.remote.decide(incoming.id, true);
  await settle();
  assert.deepEqual(linkedIds(desk), [tower.identity.deviceId]);
  const dt = treesOf(desk);
  dt.me.take(tt.me.tree(), tower.mesh.selfInfo().pub);
  assert.equal(dt.me.code(), myId, 'Desk joined the same ID through Tower');
  assert.equal(belongs(myId, desk.identity.fingerprint, dt.me.chain()), true);
});

test('a request by the company\'s ID reaches the company\'s other PC: its company chain proves it, and it is a new member', async () => {
  const { lan, laptop, tower, tt } = await mine();
  const companyId = remoteIdOf(laptop.identity.fingerprint);
  assert.equal(tower.remote.state().self.companyId, companyId, 'Tower shows the company\'s ID: the first PC\'s own');
  const desk = await lan.add('Desk', 'http://10.0.0.3:47812');
  const out = await desk.remote.connect({ target: companyId });
  assert.equal(out.deviceId, tower.identity.deviceId);
  assert.equal(out.role, 'employee', 'the company\'s ID: a new member');
  assert.equal(tower.remote.state().incoming[0]?.role, 'employee');
  assert.equal(belongs(companyId, tower.identity.fingerprint, tt.company.chain()), true, 'the chain Tower answers with proves the company\'s ID');
});

test('a device that carries someone else\'s chain is never asked for the ID', async () => {
  const { lan, tower, tt, myId } = await mine();
  tower.findable = false;
  tower.remote.refresh();
  tower.hello = undefined;

  const rogue = await lan.add('Rogue', 'http://10.0.0.9:47812');
  const own = rogue.hello!;
  rogue.hello = () => ({ ...own()!, me: tt.me.chain(), chain: tt.company.chain() }); // Tower's chains, the rogue's own key
  const desk = await lan.add('Desk', 'http://10.0.0.3:47812');
  await assert.rejects(desk.remote.connect({ target: myId }), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
  assert.equal(rogue.remote.state().incoming.length, 0, 'nothing reached the rogue');
});
