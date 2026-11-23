// Who an agent's home PCs are and when they share (devices/sync/share.ts, the link-up step in service.ts): only my own
// linked PCs among the one the agent runs on and its `homes`, only when this PC is one of them; an archived agent and
// an employee's PC take no part; a row change opens or closes a mirror; the link-up shares after the logins and before
// the wakes; a catch-up in rhythm sends no project list (the folder is looked at whole only at link-up); a leave carries
// the project changes still waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homePeers, shareNow } from '../../../src/runtime/devices/sync/share.ts';
import { linkUps, type LinkUpParts } from '../../../src/runtime/devices/sync/service.ts';
import { agent } from '../chat/harness.ts';
import { silentLog } from './fakes.ts';
import { MARA, calm, sharePc, until } from './share-rig.ts';
import { Net, link, record } from './sync-net.ts';

test('my home PCs are the one I run on and my homes – seen only from one of them, own linked PCs only', async () => {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', ['B', 'C', 'P', 'gone'], false);
  const b = await sharePc(net, 'B', 'A', ['B', 'C', 'P', 'gone'], false);
  const d = await sharePc(net, 'D', 'A', ['B', 'C'], false);
  const c = await sharePc(net, 'C', 'A', ['B', 'C'], false);
  link(a, b); link(a, c); link(b, c); link(a, d); link(b, d);
  a.repo.upsert(record('P', { personId: 'p_1' })); // an employee's PC is never a home
  assert.deepEqual(homePeers(a.h.services, MARA), ['B', 'C']);
  assert.deepEqual(homePeers(b.h.services, MARA), ['A', 'C'], 'the PC it runs on counts');
  assert.deepEqual(homePeers(d.h.services, MARA), [], 'a PC that is no home shares nothing');
  assert.deepEqual(homePeers(a.h.services, 'ag_none'), []);
  a.h.org.add(agent(MARA, 'Mara', { homes: ['B'] })); // no device: it runs here
  assert.deepEqual(homePeers(a.h.services, MARA), ['B']);
  a.h.org.add(agent(MARA, 'Mara', { deviceId: 'A' }));
  assert.deepEqual(homePeers(a.h.services, MARA), [], 'at home on one PC');
  a.h.org.add(agent(MARA, 'Mara', { deviceId: 'A', homes: ['B'], archivedAt: 5 }));
  assert.deepEqual(homePeers(a.h.services, MARA), []);
});

test('setting my homes starts the mirror, clearing them ends it; a leave carries what still waited', async () => {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', []);
  const b = await sharePc(net, 'B', 'A', []);
  link(a, b);
  const offA = a.share.attach();
  const offB = b.share.attach();
  await a.write('a.txt', 'one');
  await calm();
  assert.equal(await b.read('a.txt'), undefined, 'no homes: nothing travels');
  for (const pc of [a, b]) { pc.h.org.add(agent(MARA, 'Mara', { deviceId: 'A', homes: ['B'] })); pc.h.bus.emit('agent.upserted', pc.h.org.get(MARA)!); }
  await until(async () => (await b.read('a.txt')) === 'one', 'the project on B after agents.update homes');
  await calm();
  await a.write('a.txt', 'two, right before I leave');
  await a.changed(); // nothing reported yet …
  await a.write('late.txt', 'x');
  a.report('a.txt', 'late.txt'); // … the watch has it, the look still waits
  await shareNow(a.h.services, MARA);
  await until(async () => (await b.read('a.txt')) === 'two, right before I leave' && (await b.read('late.txt')) === 'x', 'the waiting changes on B');
  for (const pc of [a, b]) { pc.h.org.add(agent(MARA, 'Mara', { deviceId: 'A' })); pc.h.bus.emit('agent.upserted', pc.h.org.get(MARA)!); }
  await calm();
  await a.write('after.txt', 'stays on A');
  await a.changed('after.txt');
  await calm();
  assert.equal(await b.read('after.txt'), undefined);
  offA(); offB();
});

test('22.11.2026: a catch-up in rhythm looks at no project folder – the whole lists go at link-up', async () => {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', ['B']);
  const b = await sharePc(net, 'B', 'A', ['B']);
  link(a, b);
  await a.write('a.txt', 'one');
  const lists = () => net.calls.filter((call) => call.from === 'A' && (call.params as { op?: unknown }).op === 'have').length;
  await a.share.catchUp('B', true);
  await calm();
  assert.equal(lists(), 0, 'in rhythm: no walk of the folder, no list');
  await a.share.catchUp('B');
  await until(async () => (await b.read('a.txt')) === 'one', 'the project on B after the link-up');
  assert.ok(lists() > 0);
});

test('a link-up shares after the logins and before the wakes', async () => {
  const order: string[] = [];
  const step = (name: string) => async () => { order.push(name); return true; };
  const parts: LinkUpParts = {
    tabs: { catchUp: step('tabs') }, rows: { catchUp: step('rows'), resume: () => { order.push('wakes'); } }, ledger: { catchUp: async () => { order.push('ledger'); } },
    secrets: { catchUp: step('secrets') }, logins: { catchUp: async () => { order.push('logins'); } }, share: { catchUp: async () => { order.push('share'); } }, files: { catchUp: step('files') },
  } as unknown as LinkUpParts;
  const run = linkUps({ clock: { now: () => 1 }, log: silentLog } as never, { pair: () => '', cursor: () => undefined, setCursor: () => {} }, parts, () => true);
  run('B');
  await until(() => order.includes('files'));
  assert.deepEqual(order, ['tabs', 'rows', 'ledger', 'secrets', 'logins', 'share', 'wakes', 'files']);
});
