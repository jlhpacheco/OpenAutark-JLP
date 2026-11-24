// Eine-ID 22.11.2026 in the connect flow (remote/requests.ts, join.ts, service.ts, devices/company-admit.ts): the PC asked
// decides the role from the ID typed (an older requester asking 'ceo' with another ID hears to update; an older target that
// answers no role makes a new member); the new member's name from either side (remoteName, MAC'd; Accept takes the
// proposal); the IDs show only once this is a company, and the state goes out again when its first run finishes; my own
// request accepted finishes it; a new member accepted on a member's PC is admitted by the company's PC – the new PC links
// that PC, the member's PC stores nothing, the company's PC away refuses Accept with a plain line, a forged employer fails.
// Fest 22.11.2026: my request accepted as a new member hands on the name I joined with (setUpDone keeps it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url } from '../../../src/runtime/devices/keys.ts';
import { chainIn } from '../../../src/runtime/remote/code.ts';
import { newEphemeral } from '../../../src/runtime/remote/sas.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { NewPerson } from '../../../src/shared/model/remote.ts';
import { Lan, connectYes, linkedIds, settle, treesOf, type Pc } from './rig.ts';

const code = (name: string, text?: RegExp) => (error: unknown) => error instanceof WorkforceError && error.code === name && (!text || text.test(error.message));
const remote1 = (from: Pc, extra: Record<string, unknown>) =>
  ({ kind: 'remote1', v: 1, device: from.mesh.selfInfo(), eph: b64url(newEphemeral().pub), ...extra });

test('the PC asked decides from the ID: my ID → my device, its own ID or an address → a new member; an older "ceo" ask with another ID is refused', async () => {
  const lan = new Lan();
  const office = await lan.add('Office', 'http://10.0.0.1:47812', { deps: { companyName: () => 'Dojo' } });
  const { me } = treesOf(office);
  const pcs = await Promise.all([2, 3, 4, 5, 6].map((n) => lan.add(`PC ${n}`, `http://10.0.0.${n}:47812`)));
  const ask = async (n: number, extra: Record<string, unknown>) => office.remote.handle(remote1(pcs[n], extra), { address: `10.0.1.${n}` }) as Promise<Record<string, unknown>>;

  const mine = await ask(0, { role: 'employee', target: { remoteId: me.code() } });
  assert.deepEqual([mine.ok, mine.role, mine.company], [true, 'ceo', 'Dojo'], 'my ID: one of my devices, whatever the requester asked');
  assert.ok((mine.chain as { links: unknown[] }).links.length >= 1, 'with the me chain that proves my ID');
  const own = await ask(1, { role: 'employee', target: { remoteId: office.remote.remoteId() } });
  assert.deepEqual([own.ok, own.role, own.chain], [true, 'employee', undefined], 'its own device ID: a new member (the ID needs no chain)');
  const older = await ask(3, { role: 'ceo', target: { remoteId: office.remote.remoteId() } });
  assert.equal(older.ok, false);
  assert.match(JSON.stringify(older), /Update Autark on the other PC/, 'an older PC never becomes a full mirror by another ID');
  const stranger = await ask(4, { role: 'employee', target: { remoteId: '123456782' } });
  assert.match(JSON.stringify(stranger), /not the PC that was asked for/, 'an ID that is not this PC\'s');
  const byAddress = await ask(2, { role: 'employee' });
  assert.deepEqual([byAddress.ok, byAddress.role], [true, 'employee'], 'no ID (an address): a new member');

  const second = await lan.add('Second', 'http://10.0.0.9:47812');
  const olderMine = await second.remote.handle(remote1(pcs[3], { role: 'ceo', target: { remoteId: treesOf(second).me.code() } }), { address: '10.0.1.9' }) as Record<string, unknown>;
  assert.deepEqual([olderMine.ok, olderMine.role], [true, 'ceo'], 'an older PC that typed my ID is one of my devices');
});

test('an older PC that answers no role makes a new member: remote1 asks "employee" for it', async () => {
  const lan = new Lan();
  const office = await lan.add('Office', 'http://10.0.0.1:47812');
  const anna = await lan.add('Anna laptop', 'http://10.0.0.2:47812');
  anna.edit = (kind, reply) => { if (kind === 'remote1') { const { role: _role, company: _company, ...rest } = reply; return rest; } return reply; };
  const out = await anna.remote.connect({ target: office.remote.remoteId() });
  assert.equal(out.role, 'employee');
  assert.equal(out.company, undefined);
  assert.equal(anna.bodies.find((body) => body.kind === 'remote1')?.role, 'employee');
  office.remote.decide(office.remote.state().incoming[0].id, true, 'per_anna');
  await settle();
  assert.equal(anna.repo.get(office.identity.deviceId)?.joinedAs, 'employee', 'never a full mirror by accident');
});

test('the new member\'s name: proposed at connect, changed while waiting, MAC\'d; Accept without a name takes it', async () => {
  const lan = new Lan();
  const made: NewPerson[] = [];
  const office = await lan.add('Office', 'http://10.0.0.1:47812', { deps: { createPerson: (input) => { made.push(input); return 'per_anna'; } } });
  const anna = await lan.add('Anna laptop', 'http://10.0.0.2:47812');
  const out = await anna.remote.connect({ target: office.remote.remoteId(), name: '  Anna\u0000 ' });
  assert.equal(out.myName, 'Anna');
  assert.equal(office.remote.state().incoming[0].proposedName, 'Anna', 'the other side shows it, plain');
  await anna.remote.rename('Anna Berg');
  assert.equal(anna.remote.state().outgoing?.myName, 'Anna Berg');
  assert.equal(office.remote.state().incoming[0].proposedName, 'Anna Berg');
  assert.equal(office.states.at(-1)?.incoming[0]?.proposedName, 'Anna Berg', 'remote.updated tells the window at once');
  const session = anna.bodies.find((body) => body.kind === 'remoteName')?.session;
  const forged = await office.remote.handle({ kind: 'remoteName', session, name: 'Mallory', mac: 'AAAA' }, { address: '10.0.0.9' });
  assert.equal(forged.ok, false, 'only the requester\'s session key names it');
  assert.equal(office.remote.state().incoming[0].proposedName, 'Anna Berg');

  office.remote.decide(office.remote.state().incoming[0].id, true);
  await settle();
  assert.deepEqual(made, [{ name: 'Anna Berg' }], 'one side named her: enough');
  assert.equal(office.repo.get(anna.identity.deviceId)?.personId, 'per_anna');
  await assert.rejects(anna.remote.rename('Ann'), code('not_found'), 'no request waits any more');
});

test('my device takes no name: none is sent', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  treesOf(laptop);
  const out = await tower.remote.connect({ target: laptop.remote.state().self.myId!, name: 'Tower person' });
  assert.equal(out.role, 'ceo');
  assert.equal(out.myName, undefined);
  assert.equal(tower.sent.includes('remoteName'), false);
  await assert.rejects(tower.remote.rename('X'), code('not_found'));
});

test('the IDs show once this is a company; its first run finishing sends the state again; my accepted request finishes it', async () => {
  const lan = new Lan();
  let ready = false;
  const finished: string[] = [];
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812', { deps: { setUp: () => ready, setUpDone: () => { finished.push('laptop'); } } });
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812', { deps: { setUpDone: () => { finished.push('tower'); } } });
  treesOf(laptop);
  const self = () => laptop.remote.state().self;
  assert.deepEqual([self().companyId, self().myId], [undefined, undefined], 'no company yet: no IDs');
  assert.match(self().remoteId, /^\d{9}$/, 'its own device ID stays');
  const before = laptop.states.length;
  laptop.remote.refresh();
  assert.equal(laptop.states.length, before, 'nothing changed, nothing sent');
  ready = true;
  laptop.remote.refresh(); // settings.updated: the first run is done
  assert.equal(laptop.states.length, before + 1, 'the state goes out again');
  assert.equal(laptop.states.at(-1)?.self.companyId, laptop.remote.remoteId());
  assert.match(laptop.states.at(-1)?.self.myId ?? '', /^\d{9}$/);

  await connectYes(tower, { target: self().myId! });
  laptop.remote.decide(laptop.remote.state().incoming[0].id, true);
  await settle();
  assert.deepEqual(finished, ['tower'], 'the requester\'s first run is done once its request is linked; the accepting side was set up already');
});

test('Fest: my request accepted as a new member hands on the name I typed while it waited; as one of my devices, none', async () => {
  const lan = new Lan();
  const names: Array<string | undefined> = [];
  const heard = (name?: string) => { names.push(name); };
  const office = await lan.add('Office', 'http://10.0.0.1:47812', { deps: { createPerson: () => 'per_anna' } });
  const anna = await lan.add('Anna laptop', 'http://10.0.0.2:47812', { deps: { setUpDone: heard } });
  await anna.remote.connect({ target: office.remote.remoteId() }); // a company still joining has no profile name to send
  await anna.remote.rename('Anna Berg');
  office.remote.decide(office.remote.state().incoming[0].id, true);
  await settle();
  assert.deepEqual(names, ['Anna Berg'], 'the seat keeps it as its person\'s name (devices/connect.ts finishFirstRun)');

  const laptop = await lan.add('Laptop', 'http://10.0.0.3:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.4:47812', { deps: { setUpDone: heard } });
  treesOf(laptop);
  await connectYes(tower, { target: laptop.remote.state().self.myId!, name: 'Tower person' });
  laptop.remote.decide(laptop.remote.state().incoming[0].id, true);
  await settle();
  assert.deepEqual(names, ['Anna Berg', undefined]);
});

/** Office (the company), Seat (Momo's PC, a member's PC in the company's tree) and Nora's new PC asking Seat by the company's ID. */
async function company() {
  const lan = new Lan();
  const made: NewPerson[] = [];
  const office = await lan.add('Office', 'http://10.0.0.1:47812', { deps: { createPerson: (input) => { made.push(input); return 'per_nora'; }, knows: () => true } });
  const seat = await lan.add('Seat', 'http://10.0.0.2:47812', { deps: { knows: () => true } });
  await lan.link(office, seat, { personId: 'per_momo' });
  const ot = treesOf(office);
  const st = treesOf(seat);
  ot.company.sign(seat.mesh.selfInfo().pub);
  st.company.adoptChain(chainIn(ot.company.tree(), seat.identity.fingerprint)); // company.facts brings it (CODES)
  office.findable = false; // only Seat answers on this network
  office.remote.refresh();
  const nora = await lan.add('Nora PC', 'http://10.0.0.3:47812');
  const companyId = office.remote.remoteId();
  return { lan, office, seat, nora, ot, made, companyId };
}

test('a new member accepted on a member\'s PC is admitted by the company\'s PC; the new PC links that PC, the member\'s stores nothing', async () => {
  const { lan, office, seat, nora, ot, made, companyId } = await company();
  assert.equal(seat.remote.state().self.companyId, companyId, 'Seat shows the company\'s ID');
  assert.deepEqual([seat.remote.state().self.member, office.remote.state().self.member], [true, undefined], 'review L7: a member\'s PC says so');
  const out = await nora.remote.connect({ target: companyId, name: 'Nora' });
  assert.deepEqual([out.deviceId, out.role], [seat.identity.deviceId, 'employee'], 'Seat answered for the company\'s ID');
  const [incoming] = seat.remote.state().incoming;
  assert.equal(incoming.proposedName, 'Nora');

  assert.throws(() => seat.remote.decide(incoming.id, true), code('unavailable', /^Office is not reachable right now\. The new member is added on it – try again once it is on\.$/), 'the company\'s PC is away');
  assert.equal(seat.remote.state().incoming.length, 1, 'the request stays open');
  lan.up(office, seat);
  assert.throws(() => seat.remote.decide(incoming.id, true, 'per_momo'), code('bad_request', /Name the new member here/), 'a member\'s PC names, it does not pick');
  seat.remote.decide(incoming.id, true);
  for (let i = 0; i < 4; i++) await settle();

  assert.deepEqual(made, [{ name: 'Nora' }], 'the company made the person');
  assert.equal(office.repo.get(nora.identity.deviceId)?.personId, 'per_nora', 'and stored her PC as hers');
  assert.ok(ot.company.tree().links.some((link) => link.pub === nora.mesh.selfInfo().pub && link.by === office.identity.fingerprint), 'signed into the company\'s tree');
  assert.deepEqual(office.admitted, ['per_nora']);
  assert.equal(nora.repo.get(office.identity.deviceId)?.joinedAs, 'employee', 'Nora links the company\'s PC');
  assert.equal(nora.repo.get(seat.identity.deviceId), undefined, 'not the member\'s');
  assert.deepEqual(linkedIds(seat), [office.identity.deviceId], 'the member\'s PC stored nothing');
  assert.equal(nora.remote.state().outgoing?.status, 'accepted');
  assert.match(nora.notes[0]?.body ?? '', /^Office .* is linked as your employer's PC/);

  // Review M2: the same admit again (a member's PC that missed the answer) answers again, with no second person.
  assert.deepEqual(await lan.call(seat, office.identity.deviceId, 'company.admit', { info: nora.mesh.selfInfo(), person: { name: 'Nora' } }), { employer: office.mesh.selfInfo() });
  assert.deepEqual(made, [{ name: 'Nora' }]);
  await assert.rejects(lan.call(seat, office.identity.deviceId, 'company.admit', { info: seat.mesh.selfInfo(), person: { name: 'Momo' } }), code('conflict'), 'never a key linked here any other way');
  await assert.rejects(lan.call(office, seat.identity.deviceId, 'company.admit', { info: nora.mesh.selfInfo(), person: { name: 'X' } }), code('forbidden'), 'only a member\'s PC asks the company');
});

test('an employer answer that is not MAC\'d with the session key links nothing', async () => {
  const { lan, office, seat, nora, companyId } = await company();
  lan.up(office, seat);
  nora.edit = (kind, reply) => (kind === 'remote3' && reply.status === 'accepted' ? { ...reply, employerMac: 'forged' } : reply);
  await nora.remote.connect({ target: companyId, name: 'Nora' });
  seat.remote.decide(seat.remote.state().incoming[0].id, true);
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(nora.remote.state().outgoing?.status, 'failed');
  assert.match(nora.remote.state().outgoing?.reason ?? '', /company's PC/);
  assert.deepEqual(linkedIds(nora), []);
});
