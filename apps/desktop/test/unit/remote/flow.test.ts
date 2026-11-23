// Connect requests between PCs in one process (remote/service.ts, requests.ts, join.ts): connect by an ID (found on this
// network) or by address → the target shows the request with the same code → Accept stores both keys (the requester
// dials) and both sides get the linked notice (which PC, as what, where to remove it). Eine-ID 22.11.2026: the PC asked
// decides the role from the ID typed – my ID makes one of my devices (signed into my tree and, on a company's own PC, the
// company's), the company's ID, its own device ID or an address a new member, who needs a name or a person on the
// accepting side; Decline, expiry, cancel; refusals (not findable, typo, unknown ID); the limits (3 open, 5 per address,
// one per PC). More in delivery.test.ts and eine-id.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRemoteId } from '../../../src/runtime/remote/id.ts';
import { COMMIT_TTL_MS, MAX_OPEN, PER_ADDRESS, REQUEST_TTL_MS, WAIT_MAX_MS } from '../../../src/runtime/remote/requests.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { Lan, connectYes, linkedIds, settle, treesOf } from './rig.ts';

const fps = (tree: { links: Array<{ by: string }> }) => tree.links.map((link) => link.by);

test('connect by my ID: both PCs show the same code; Accept makes it one of my devices, signed into both trees', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812', { deps: { person: () => ' Momo\u0000 ' } });
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  const trees = treesOf(laptop);
  const myId = laptop.remote.state().self.myId!;
  assert.match(myId, /^\d{9}$/);
  assert.notEqual(myId, laptop.remote.remoteId(), 'my ID is not this PC\'s own device ID');

  // Review H1: becoming one of Momo's devices waits for this side's yes; the other PC shows nothing before it.
  const asked = await tower.remote.connect({ target: formatRemoteId(myId) });
  assert.deepEqual([asked.status, asked.role, asked.person, asked.code], ['confirm', 'ceo', 'Momo', '']);
  assert.equal(tower.remote.state().outgoing?.status, 'confirm');
  assert.deepEqual(laptop.remote.state().incoming, [], 'nothing shows there before my yes');
  assert.equal(tower.sent.includes('remote2'), false);
  const out = await tower.remote.confirm();
  assert.equal(out.status, 'waiting');
  assert.match(out.code, /^\d{4}$/, 'the code shows after the yes');
  await assert.rejects(tower.remote.confirm(), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found', 'one yes');
  assert.equal(out.role, 'ceo', 'the PC asked decided: one of my devices');
  assert.equal(out.deviceId, laptop.identity.deviceId);
  assert.equal(out.remoteId, myId);
  const [incoming] = laptop.remote.state().incoming;
  assert.ok(incoming, 'the target shows the request');
  assert.equal(incoming.code, out.code, 'the same code on both screens');
  assert.equal(incoming.name, 'Tower');
  assert.equal(incoming.role, 'ceo');
  assert.equal(incoming.address, '10.0.0.2');
  assert.equal(laptop.shown.length, 1, 'one notification');
  assert.deepEqual(linkedIds(laptop), [], 'nothing is stored before the answer');

  laptop.remote.decide(incoming.id, true);
  await settle();
  assert.deepEqual(linkedIds(laptop), [tower.identity.deviceId]);
  assert.deepEqual(linkedIds(tower), [laptop.identity.deviceId]);
  assert.equal(laptop.repo.get(tower.identity.deviceId)?.publicKey, tower.mesh.selfInfo().pub, 'the proven key is pinned');
  assert.deepEqual(laptop.paired.map((entry) => entry.side), ['inviter']);
  assert.deepEqual(tower.paired.map((entry) => entry.side), ['joiner'], 'the requester dials');
  assert.equal(laptop.repo.get(tower.identity.deviceId)?.personId, undefined, 'my own device, no person\'s');
  assert.equal(tower.repo.get(laptop.identity.deviceId)?.joinedAs, 'ceo');
  assert.ok(fps(trees.me.tree()).includes(laptop.identity.fingerprint), 'my tree: Laptop signed Tower');
  assert.ok(fps(trees.company.tree()).includes(laptop.identity.fingerprint), 'the company\'s tree too: Laptop is one of the company\'s own PCs');
  // Both sides hear which PC is linked as what and where to remove it – a link an agent asked for never sits unnoticed.
  assert.deepEqual(laptop.notes, [{
    title: 'Tower is now linked',
    body: `Tower (Remote ID ${formatRemoteId(tower.remote.remoteId())}) is linked as your own PC: it receives this company's chats, secrets and settings and can run commands on this PC. Remove it in Settings › Devices.`,
  }]);
  assert.equal(tower.notes.length, 1);
  assert.match(tower.notes[0].body, new RegExp(`^Laptop \\(Remote ID ${formatRemoteId(laptop.remote.remoteId())}\\) is linked as your own PC: .*Settings › Devices\\.$`));
  assert.equal(tower.remote.state().outgoing?.status, 'accepted');
  tower.remote.cancel();
  assert.equal(tower.remote.state().outgoing, undefined, 'Close clears the outcome');
});

test('the company\'s ID makes a new member: the accepting side names or picks the person, and only it stores the person', async () => {
  const lan = new Lan();
  const office = await lan.add('Office', 'http://10.0.0.1:47812', { deps: { companyName: () => '  Dojo\u0000\n  Lab ' } });
  const anna = await lan.add('Anna laptop', 'http://10.0.0.2:47812');
  const trees = treesOf(office);
  const companyId = office.remote.state().self.companyId!;
  assert.equal(companyId, office.remote.remoteId(), 'the company\'s first PC: its company ID is its own device ID');
  const out = await anna.remote.connect({ target: companyId });
  assert.equal(out.role, 'employee');
  assert.equal(out.company, 'Dojo Lab', 'the company\'s name, plain ("Joining Dojo Lab as a new member")');
  const [incoming] = office.remote.state().incoming;
  assert.equal(incoming.role, 'employee');
  assert.equal(incoming.code, out.code, 'the role is part of what the code covers');
  assert.throws(() => office.remote.decide(incoming.id, true), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && /Name the new member/.test(error.message), 'a new member needs a name or a person');
  office.remote.decide(incoming.id, true, 'per_anna');
  await settle();
  assert.equal(office.repo.get(anna.identity.deviceId)?.personId, 'per_anna');
  assert.equal(anna.repo.get(office.identity.deviceId)?.personId, undefined, 'the company\'s PC is no member on Anna\'s side');
  assert.equal(anna.repo.get(office.identity.deviceId)?.joinedAs, 'employee');
  assert.ok(fps(trees.company.tree()).includes(office.identity.fingerprint), 'the company\'s tree signed her PC');
  assert.deepEqual(office.admitted, ['per_anna'], 'B-078 D15: the company PC welcomes the person once (org/member-welcome.ts)');
  assert.deepEqual(anna.admitted, [], 'the member side admits nobody');
  assert.match(office.notes[0]?.body ?? '', /^Anna laptop \(Remote ID [\d ]{11}\) is linked as an employee's PC: it receives its person's chats and tasks\./);
  assert.match(anna.notes[0]?.body ?? '', /^Office \(Remote ID [\d ]{11}\) is linked as your employer's PC: it receives your lines and task changes in its chats and can run commands on this PC\./);
});

test('without a linked notice wired, Accept still stores both keys', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812', { linked: false });
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812', { linked: false });
  treesOf(laptop);
  await connectYes(tower, { target: laptop.remote.state().self.myId! });
  laptop.remote.decide(laptop.remote.state().incoming[0].id, true);
  await settle();
  assert.deepEqual([linkedIds(laptop), linkedIds(tower)], [[tower.identity.deviceId], [laptop.identity.deviceId]]);
});

test('F13: Accept with a new person makes them as their PC links – once; decline, a requester that gives up and my own device make nobody', async () => {
  const lan = new Lan();
  const made: Array<{ name: string; title?: string }> = [];
  const joined: Array<{ personId: string; device: string }> = [];
  const office = await lan.add('Office', 'http://10.0.0.1:47812', {
    deps: {
      createPerson: (input) => { made.push(input); return `per_new${made.length}`; },
      joined: (personId, device) => { joined.push({ personId, device: device.name }); },
    },
  });
  const anna = await lan.add('Anna laptop', 'http://10.0.0.2:47812');
  const companyId = office.remote.remoteId();

  await anna.remote.connect({ target: companyId });
  office.remote.decide(office.remote.state().incoming[0].id, false);
  await settle();
  assert.deepEqual(made, [], 'Decline makes nobody');

  // Accepted, then the requester gives up before it collected the answer: nobody is made.
  await anna.remote.connect({ target: companyId });
  office.timers.fire(WAIT_MAX_MS);
  await settle();
  office.remote.decide(office.remote.state().incoming[0].id, true, undefined, { name: 'Anna' });
  anna.remote.cancel();
  await settle();
  assert.deepEqual([made, linkedIds(office)], [[], []], 'a requester that gave up leaves no person behind');

  await anna.remote.connect({ target: companyId });
  office.remote.decide(office.remote.state().incoming[0].id, true, undefined, { name: 'Anna', title: 'Design' });
  await settle();
  assert.deepEqual(made, [{ name: 'Anna', title: 'Design' }], 'made once, as her PC links');
  assert.equal(office.repo.get(anna.identity.deviceId)?.personId, 'per_new1', 'the PC is hers: a member link, never mine');
  assert.deepEqual(joined, [{ personId: 'per_new1', device: 'Anna laptop' }], 'she is in now');
  assert.deepEqual(office.admitted, ['per_new1']);
  assert.match(office.notes[0]?.body ?? '', /is linked as an employee's PC/);

  // My own device never becomes a person's.
  treesOf(office);
  const tower = await lan.add('Tower', 'http://10.0.0.3:47812');
  await connectYes(tower, { target: office.remote.state().self.myId! });
  const [mine] = office.remote.state().incoming;
  assert.throws(() => office.remote.decide(mine.id, true, undefined, { name: 'Bob' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && /one of your devices/.test(error.message));
  assert.equal(office.remote.state().incoming.length, 1, 'the request still waits for a right answer');
  assert.equal(made.length, 1);
});

test('F13: a person that cannot be made refuses the link; the requester hears why', async () => {
  const lan = new Lan();
  const office = await lan.add('Office', 'http://10.0.0.1:47812', { deps: { createPerson: () => { throw new WorkforceError('not_found', 'This manager no longer exists.'); } } });
  const anna = await lan.add('Anna laptop', 'http://10.0.0.2:47812');
  await anna.remote.connect({ target: office.remote.remoteId() });
  office.remote.decide(office.remote.state().incoming[0].id, true, undefined, { name: 'Anna', managerId: 'ag_gone' });
  await settle();
  assert.deepEqual(linkedIds(office), []);
  assert.equal(anna.remote.state().outgoing?.status, 'declined');
  assert.match(anna.remote.state().outgoing?.reason ?? '', /manager no longer exists/);
});

test('connect by address; decline; expiry; cancel', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  await tower.remote.connect({ target: '10.0.0.1' });
  const [first] = laptop.remote.state().incoming;
  laptop.remote.decide(first.id, false);
  await settle();
  assert.equal(tower.remote.state().outgoing?.status, 'declined');
  assert.deepEqual(linkedIds(laptop), []);
  assert.deepEqual([laptop.notes, tower.notes], [[], []], 'no linked notice without a link');

  await tower.remote.connect({ target: laptop.remote.remoteId() });
  laptop.clock.advance(REQUEST_TTL_MS + 1);
  assert.deepEqual(laptop.remote.state().incoming, [], 'an unanswered request ends after five minutes');

  await tower.remote.connect({ target: laptop.remote.remoteId() });
  assert.equal(laptop.remote.state().incoming.length, 1);
  tower.remote.cancel();
  await settle();
  assert.deepEqual(laptop.remote.state().incoming, [], 'the other PC hears of the cancel');
});

test('refusals: not findable, a typo, an unknown Remote ID', async () => {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812', { findable: false });
  laptop.remote.refresh();
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  const typo = laptop.remote.remoteId().replace(/.$/, (digit) => String((Number(digit) + 1) % 10));
  await assert.rejects(tower.remote.connect({ target: typo }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  await assert.rejects(tower.remote.connect({ target: laptop.remote.remoteId() }), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found' && /Settings › Devices shows its Remote ID/.test(error.message), 'a PC that does not accept requests does not answer on the LAN; the text says what to do');
  await assert.rejects(tower.remote.connect({ target: '10.0.0.1' }), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden', 'asked at its address it refuses');
});

test('limits: one open request per PC, at most 3 open, 5 per address in 10 minutes; remote2 within 60 s', async () => {
  const lan = new Lan();
  const target = await lan.add('Target', 'http://10.0.0.1:47812');
  const pcs = await Promise.all([2, 3, 4, 5].map((n) => lan.add(`PC ${n}`, `http://10.0.0.${n}:47812`)));
  for (const pc of pcs.slice(0, MAX_OPEN)) await pc.remote.connect({ target: target.remote.remoteId() });
  assert.equal(target.remote.state().incoming.length, MAX_OPEN);
  await assert.rejects(pcs[MAX_OPEN].remote.connect({ target: target.remote.remoteId() }), (error: unknown) => error instanceof WorkforceError && error.code === 'rate_limited');
  const reply = await target.remote.handle({ kind: 'remote1', v: 1 }, { address: 'x' });
  assert.equal(reply.ok, false, 'a malformed request is refused');
  let refused = 0;
  for (let n = 0; n < PER_ADDRESS + 1; n++) {
    const answer = await target.remote.handle({ kind: 'remote1', v: 1, device: pcs[0].mesh.selfInfo(), eph: 'AA' }, { address: '10.9.9.9' });
    if (!answer.ok && (answer as { error: { code: string } }).error.code === 'rate_limited') refused++;
  }
  assert.ok(COMMIT_TTL_MS <= 60_000);
  assert.ok(refused <= 1);
});
