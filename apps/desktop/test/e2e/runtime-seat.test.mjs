// End-to-end (owner 22.11.2026, Eine-ID: "eine Firmen-ID … jedes Mitglied … hat diese ID stehen und kann approven … pro
// User noch den Code … nur für einen selber … keine Sonderlogik"): four headless runtimes on this machine, nobody picks a
// role – the ID typed decides.
// A is the company (CEO Kim, "Dojo"). E is Momo's seat – on a real PC a second company folder, maybe beside A – that types
// the company ID and proposes her name; Kim accepts with that name. L is Momo's laptop: it types Momo's own ID (My ID)
// and becomes one of her devices; the company then knows it as Momo's PC, L names the company and gets her chat. N is a
// new PC that only reaches Momo's seat: it types the company ID, Momo accepts and names it "Lena", the company makes the
// person and N links the company's PC as Lena's.
// Run: npm run build && node --test test/e2e/runtime-seat.test.mjs (alone: the device e2e files share loopback addresses)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const A_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.2,127.0.0.3,127.0.0.4' };
const E_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.3,127.0.0.2,127.0.0.4' };
const L_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.4,127.0.0.2,127.0.0.3' };
const N_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.5,127.0.0.3' }; // N's LAN probe reaches only Momo's seat

async function until(read, ok, what, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const deviceOf = (runtime, id) => runtime.client.call('devices.list').then((list) => list.find((device) => device.id === id));
const incoming = (runtime) => runtime.client.call('remote.state').then((state) => state.incoming);

test('one company ID for every member, one own ID per person: the ID decides, any member accepts', { timeout: 360_000 }, async (t) => {
  const a = await startRuntime({ env: A_ENV });
  t.after(() => a.stop());
  const e = await startRuntime({ env: E_ENV, firstRun: true }); // Momo's new profile: no IDs until it joined
  t.after(() => e.stop());
  const peer = await until(() => a.client.call('system.info').then((info) => info.peer), (state) => state?.status === 'open', 'A to accept requests');
  if (!peer.addresses.length) { t.skip('this machine has no LAN or tailnet address for the peer listener'); return; }
  await a.client.call('settings.update', { profile: { company: 'Dojo', name: 'Kim' } });
  const aSelf = (await a.client.call('remote.state')).self;
  assert.notEqual(aSelf.companyId, aSelf.myId, 'the CEO has the company ID and an own ID');

  // E types the company ID and proposes her name; Kim accepts it as it came.
  const eBefore = (await e.client.call('remote.state')).self;
  assert.equal(eBefore.companyId ?? eBefore.myId, undefined, 'before its first run is done the folder is no company yet: no IDs');
  assert.equal(eBefore.findable, false, 'and nobody finds it');
  const eId = eBefore.deviceId;
  const out = await e.client.call('remote.connect', { target: aSelf.companyId, name: 'Momo' });
  assert.equal(out.role === undefined || out.role === 'employee', true);
  const [ask] = await until(() => incoming(a), (list) => list.length === 1, 'the seat\'s request on A');
  assert.equal(ask.role, 'employee', 'the company ID makes a new member');
  assert.equal(ask.proposedName, 'Momo');
  await a.client.call('remote.decide', { id: ask.id, accept: true, newPerson: { name: ask.proposedName } });
  await until(() => deviceOf(a, eId).then((device) => device?.status), (status) => status === 'online', 'A to list the seat online');
  const momo = (await a.client.call('people.list')).find((person) => person.name === 'Momo');
  assert.ok(momo, 'Momo is a person of the company');
  const eSelf = await until(() => e.client.call('remote.state').then((state) => state.self), (self) => self.companyId === aSelf.companyId, 'the seat to show the company ID');
  assert.notEqual(eSelf.myId, aSelf.companyId);
  assert.notEqual(eSelf.myId, aSelf.myId, 'Momo\'s own ID is hers');
  await until(() => e.client.call('settings.get').then((settings) => settings.profile.company), (name) => name === 'Dojo', 'the seat to name the company');

  // L types Momo's own ID: one of her devices; Kim is never asked.
  const l = await startRuntime({ env: L_ENV, firstRun: true }); // a 'join' start: its first run ends with the link
  t.after(() => l.stop());
  const lId = (await l.client.call('remote.state')).self.deviceId;
  const asked = await l.client.call('remote.connect', { target: eSelf.myId });
  assert.equal(asked.status, 'confirm', 'my own ID: the laptop says yes first (review H1)');
  assert.equal((await incoming(e)).length, 0, 'nothing reaches the seat before the yes');
  await l.client.call('remote.confirm');
  const [mine] = await until(() => incoming(e), (list) => list.length === 1, 'the laptop\'s request on the seat');
  assert.equal(mine.role, 'ceo', 'my own ID makes one of my devices');
  await e.client.call('remote.decide', { id: mine.id, accept: true });
  await until(() => deviceOf(e, lId).then((device) => device?.status), (status) => status === 'online', 'the seat to list the laptop online');
  assert.equal((await incoming(a)).length, 0, 'the CEO was never asked about the laptop');
  await until(() => deviceOf(a, lId), (device) => device?.personId === momo.id, 'A to know the laptop as Momo\'s PC', 90_000);
  await until(() => l.client.call('remote.state').then((state) => state.self), (self) => self.myId === eSelf.myId && self.companyId === aSelf.companyId, 'the laptop to show Momo\'s ID and the company ID', 90_000);
  const chat = await a.client.call('chats.create', { title: 'With Momo', agentIds: [], people: [momo.id] });
  await a.client.call('messages.send', { conversationId: chat.id, body: 'Hi Momo' });
  await until(() => l.client.call('messages.list', { conversationId: chat.id }).catch(() => []), (list) => list.some((message) => message.body === 'Hi Momo'), 'the CEO\'s line on the laptop', 90_000);

  // N reaches only Momo's seat with the company ID; Momo accepts and names the new member; the company makes the person.
  const n = await startRuntime({ env: N_ENV, firstRun: true });
  t.after(() => n.stop());
  const nId = (await n.client.call('remote.state')).self.deviceId;
  await n.client.call('remote.connect', { target: aSelf.companyId });
  const [join] = await until(() => incoming(e), (list) => list.length === 1, 'N\'s request on Momo\'s seat');
  assert.equal(join.role, 'employee');
  await e.client.call('remote.decide', { id: join.id, accept: true, newPerson: { name: 'Lena' } });
  const lena = await until(() => a.client.call('people.list').then((list) => list.find((person) => person.name === 'Lena')), Boolean, 'Lena on A');
  await until(() => deviceOf(a, nId), (device) => device?.personId === lena.id && device.status === 'online', 'A to hold N as Lena\'s PC', 90_000);
  assert.equal(await deviceOf(e, nId), undefined, 'Momo\'s seat stores nothing of N');
  await until(() => n.client.call('settings.get').then((settings) => settings.profile.company), (name) => name === 'Dojo', 'N to name the company', 90_000);
});
