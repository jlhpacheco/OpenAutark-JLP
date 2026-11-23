// Review R1 22.11.2026 in the connect flow (remote/join.ts, requests.ts): H1 – an answer that would make this PC one of
// someone's devices stops at 'confirm' (whose: `person`) before remote2; Cancel ends it there and tells the other PC; no
// yes in time ends it; a target that would do so without saying 'ceo' never gets that far. M4 – several PCs found for an
// ID are asked in order until one answers. L8 – remote2 failing names the other cause: two versions, update both.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_MS } from '../../../src/runtime/remote/join.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { Lan, linkedIds, settle, treesOf } from './rig.ts';

test('H1: Cancel at "confirm" ends it here and tells the other PC; no yes in time ends it too', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  const myId = treesOf(laptop).me.code();

  assert.equal((await tower.remote.connect({ target: myId })).status, 'confirm');
  tower.remote.cancel();
  await settle();
  assert.equal(tower.remote.state().outgoing, undefined);
  assert.equal(tower.sent.at(-1), 'remoteCancel', 'the other PC hears it');
  await assert.rejects(tower.remote.confirm(), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');

  assert.equal((await tower.remote.connect({ target: myId })).status, 'confirm');
  tower.timers.fire(CONFIRM_MS);
  await settle();
  assert.deepEqual([tower.remote.state().outgoing?.status, tower.remote.state().outgoing?.reason], ['expired', 'Nobody said yes in time.']);
  assert.equal(tower.sent.at(-1), 'remoteCancel');
  assert.ok(CONFIRM_MS < 60_000, 'within the other PC\'s time for remote2');
  assert.deepEqual([laptop.remote.state().incoming, linkedIds(laptop), linkedIds(tower)], [[], [], []], 'nothing showed, nothing linked');
});

test('L8: a target that decided "ceo" but answers no role (two versions) fails at remote2 and says to update both', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  const myId = treesOf(laptop).me.code();
  tower.edit = (kind, reply) => { if (kind === 'remote1') { const { role: _role, ...rest } = reply; return rest; } return reply; };
  await assert.rejects(tower.remote.connect({ target: myId }), (error: unknown) => error instanceof WorkforceError && /could not prove its identity – or one of the two PCs runs an older Autark: update both\./.test(error.message));
  assert.deepEqual([laptop.remote.state().incoming, linkedIds(tower)], [[], []], 'never a full mirror without the yes');
});

test('M4: several PCs found for the company\'s ID are asked in order until one answers', async () => {
  const lan = new Lan();
  const office = await lan.add('Office', 'http://10.0.0.1:47812');
  const second = await lan.add('Second', 'http://10.0.0.2:47812');
  const ot = treesOf(office);
  const st = treesOf(second);
  ot.company.sign(second.mesh.selfInfo().pub);
  st.company.take(ot.company.tree(), office.mesh.selfInfo().pub); // the company's second PC (the roster brings it)
  const companyId = office.remote.remoteId();
  office.address = 'http://10.0.0.99:47812'; // its LAN answer names an address nobody listens on any more
  const nora = await lan.add('Nora PC', 'http://10.0.0.3:47812');
  const out = await nora.remote.connect({ target: companyId });
  assert.equal(out.deviceId, second.identity.deviceId, 'the next PC found answered');
  assert.equal(nora.bodies.filter((body) => body.kind === 'remote1').length, 2, 'the first one was asked first');
  assert.equal(second.remote.state().incoming.length, 1);
});
