// B-084 person code at the meeting server (protocol.ts chainCode, relay.ts index/find): a device whose chain proves the
// code is found under it as well as under its own Remote ID (hello or a later update), the found entry carries the
// chain, a chain signed by a stranger or ending at another key is ignored (its own ID still works), an update without
// the chain takes it out of the code again. Eine-ID 22.11.2026: two chains (company ID, my ID) beside the old single one.
// The format is the one of .local/b084/notes/W4-format.md.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainCode, chainCodes } from '../src/protocol.ts';
import { createRelay, remoteIdOf } from '../src/relay.ts';
import { connect, device } from './clients.ts';

type Device = ReturnType<typeof device>;
const link = (by: Device, member: Device) => ({ pub: member.pub, sig: by.sign(`wf-code-v1|${member.fp}`) });
const pubs = (frame: Record<string, any>) => (frame.entries as Array<{ pub: string }>).map((entry) => entry.pub).sort();

test('the W4-format vector: the server proves the same code as the desktop app and Android', () => {
  const chain = {
    root: 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w',
    links: [
      { pub: 'gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q', sig: 'O576_zzndF29qmqcm5jrRZgKhpXtem-hmw7IQPyEEaL4-DG0nR0wIotGJY_rAKg7c6dxYryLPqFfi8gDud6-Bw' },
      { pub: '7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E', sig: 'i5ka_Tv1qlsFzO1H8awBRr1o0e7BNN-UaRNst_2pmNZOuHmiSDfsbecjHzrRgYExfT9WNGrEyEbsL5aIwYLdBw' },
    ],
  };
  assert.equal(chainCode(chain, 'b62e867fa2f33afe62d5d6b1642e1621d543307846b2a57b897e710919b76709')?.code, '133687038');
  assert.equal(chainCode(chain, '6a3803d5f059902a1c6dafbc9ba4729212f7caac08634cc3ae76b27529f03827'), undefined, 'the chain ends at another key');
  assert.equal(chainCode({ ...chain, links: Array(9).fill(chain.links[0]) }, 'b62e867fa2f33afe62d5d6b1642e1621d543307846b2a57b897e710919b76709'), undefined, 'at most 8 links');
});

test('a member is found under the code with its chain; a forged chain is ignored; an update moves it in and out', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  t.after(() => relay.close());
  const root = device();
  const member = device();
  const stranger = device();
  const code = remoteIdOf(root.fp);
  const chain = { root: root.pub, links: [link(root, member)] };

  const cr = await connect(relay.port, { me: root, findable: true });
  await cr.next('ready');
  const cm = await connect(relay.port, { me: member, findable: true });
  await cm.next('ready');
  const asker = await connect(relay.port);
  await asker.next('ready');

  asker.send({ t: 'find', ref: 1, id: code });
  assert.deepEqual(pubs(await asker.next('found')), [root.pub], 'without its chain the member is not under the code');

  cm.send({ t: 'update', peers: [], findable: true, chain });
  await new Promise((resolve) => setTimeout(resolve, 60));
  asker.send({ t: 'find', ref: 2, id: code });
  const found = await asker.next('found');
  assert.deepEqual(pubs(found), [root.pub, member.pub].sort());
  assert.deepEqual(found.entries.find((entry: { pub: string }) => entry.pub === member.pub).chain, chain, 'the finder checks the chain itself');
  assert.equal(found.entries.find((entry: { pub: string }) => entry.pub === root.pub).chain, undefined, 'the root answers with its own ID');
  asker.send({ t: 'find', ref: 3, id: remoteIdOf(member.fp) });
  assert.deepEqual(pubs(await asker.next('found')), [member.pub], 'and under its own ID as before');

  cm.send({ t: 'update', peers: [], findable: true, chain: { root: root.pub, links: [link(stranger, member)] } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  asker.send({ t: 'find', ref: 4, id: code });
  assert.deepEqual(pubs(await asker.next('found')), [root.pub], 'a link signed by a stranger is ignored');

  cm.send({ t: 'update', peers: [], findable: true, chain });
  cm.send({ t: 'update', peers: [], findable: false, chain });
  await new Promise((resolve) => setTimeout(resolve, 60));
  asker.send({ t: 'find', ref: 5, id: code });
  assert.deepEqual(pubs(await asker.next('found')), [root.pub], 'not findable: under no ID');
  cm.ws.close();
  cr.ws.close();
  asker.ws.close();
});

test('Eine-ID: two chains (company ID and my ID) – found under each with the chain that proves it; the old `chain` still works', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  t.after(() => relay.close());
  const company = device();
  const meRoot = device();
  const member = device();
  const old = device();
  const companyChain = { root: company.pub, links: [link(company, member)] };
  const meChain = { root: meRoot.pub, links: [link(meRoot, member)] };

  const cm = await connect(relay.port, { me: member, findable: true });
  await cm.next('ready');
  const co = await connect(relay.port, { me: old, findable: true });
  await co.next('ready');
  const asker = await connect(relay.port);
  await asker.next('ready');

  cm.send({ t: 'update', peers: [], findable: true, chains: [companyChain, meChain, { root: company.pub, links: [] }], chain: companyChain });
  co.send({ t: 'update', peers: [], findable: true, chain: { root: company.pub, links: [link(company, old)] } });
  await new Promise((resolve) => setTimeout(resolve, 60));

  asker.send({ t: 'find', ref: 1, id: remoteIdOf(company.fp) });
  const byCompany = await asker.next('found');
  assert.deepEqual(pubs(byCompany), [member.pub, old.pub].sort(), 'a client before 22.11. (one `chain`) is found as before');
  assert.deepEqual(byCompany.entries.find((entry: { pub: string }) => entry.pub === member.pub).chain, companyChain, 'the company chain proves the company ID');
  asker.send({ t: 'find', ref: 2, id: remoteIdOf(meRoot.fp) });
  const byMe = await asker.next('found');
  assert.deepEqual(pubs(byMe), [member.pub], 'found under my ID');
  assert.deepEqual(byMe.entries[0].chain, meChain, 'with the chain that proves my ID');
  asker.send({ t: 'find', ref: 3, id: remoteIdOf(member.fp) });
  const own = await asker.next('found');
  assert.deepEqual(pubs(own), [member.pub], 'and under its own Remote ID');
  assert.equal(own.entries[0].chain, undefined, 'there it needs no chain');

  cm.send({ t: 'update', peers: [], findable: true, chains: [meChain] });
  await new Promise((resolve) => setTimeout(resolve, 60));
  asker.send({ t: 'find', ref: 4, id: remoteIdOf(company.fp) });
  assert.deepEqual(pubs(await asker.next('found')), [old.pub], '`chains` without the company chain takes it out of the company ID');
  cm.ws.close();
  co.ws.close();
  asker.ws.close();
});

test('chainCodes: at most two chains, invalid ones skipped, one entry per code, `chain` only without `chains`', () => {
  const root = device();
  const other = device();
  const member = device();
  const a = { root: root.pub, links: [link(root, member)] };
  const b = { root: other.pub, links: [link(other, member)] };
  assert.deepEqual(chainCodes({ chains: [a, a, b] }, member.fp).map((entry) => entry.code), [remoteIdOf(root.fp)], 'two slots: the duplicate fills the second');
  assert.deepEqual(chainCodes({ chains: [a, b] }, member.fp).map((entry) => entry.code), [remoteIdOf(root.fp), remoteIdOf(other.fp)]);
  assert.deepEqual(chainCodes({ chains: [{ root: root.pub, links: [link(other, member)] }, b] }, member.fp).map((entry) => entry.code), [remoteIdOf(other.fp)], 'a forged one is skipped');
  assert.deepEqual(chainCodes({ chains: [b], chain: a }, member.fp).map((entry) => entry.code), [remoteIdOf(other.fp)], '`chains` wins over `chain`');
  assert.deepEqual(chainCodes({ chain: a }, member.fp).map((entry) => entry.code), [remoteIdOf(root.fp)]);
  assert.deepEqual(chainCodes({}, member.fp), []);
});

test('Eine-ID: found entries come shortest chain first (the company\'s own PCs before members\' PCs), still at most 4', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  t.after(() => relay.close());
  const root = device();
  const members = [device(), device(), device(), device()];
  const deep = device();
  const code = remoteIdOf(root.fp);
  const clients = [];
  // The deepest PC and the members register first, the root last – the order of registration does not decide.
  const cd = await connect(relay.port, { me: deep, findable: true });
  await cd.next('ready');
  cd.send({ t: 'update', peers: [], findable: true, chains: [{ root: root.pub, links: [link(root, members[0]), link(members[0], deep)] }] });
  clients.push(cd);
  for (const member of members) {
    const cm = await connect(relay.port, { me: member, findable: true });
    await cm.next('ready');
    cm.send({ t: 'update', peers: [], findable: true, chains: [{ root: root.pub, links: [link(root, member)] }] });
    clients.push(cm);
  }
  const cr = await connect(relay.port, { me: root, findable: true });
  await cr.next('ready');
  clients.push(cr);
  const asker = await connect(relay.port);
  await asker.next('ready');
  clients.push(asker);
  await new Promise((resolve) => setTimeout(resolve, 60));
  asker.send({ t: 'find', ref: 1, id: code });
  const found = await asker.next('found');
  const entries = found.entries as Array<{ pub: string; chain?: { links: unknown[] } }>;
  assert.equal(entries.length, 4, 'at most 4');
  assert.equal(entries[0].pub, root.pub, 'the root first');
  assert.deepEqual(entries.map((entry) => entry.chain?.links.length ?? 0), [0, 1, 1, 1], 'then the shortest chains');
  assert.ok(!entries.some((entry) => entry.pub === deep.pub), 'the deepest one is left out');
  for (const client of clients) client.ws.close();
});

test('0.3.20: PCs of the same chain depth take turns at the front of the answer; a shorter chain still comes first and at most 4 are listed', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { findsPerMinute: 100 } });
  t.after(() => relay.close());
  const root = device();
  const peers = [device(), device(), device()];
  const code = remoteIdOf(root.fp);
  const clients = [];
  for (const peer of peers) {
    const cp = await connect(relay.port, { me: peer, findable: true });
    await cp.next('ready');
    cp.send({ t: 'update', peers: [], findable: true, chains: [{ root: root.pub, links: [link(root, peer)] }] });
    clients.push(cp);
  }
  const asker = await connect(relay.port);
  await asker.next('ready');
  clients.push(asker);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const fronts: string[] = [];
  for (let ref = 1; ref <= 6; ref++) {
    asker.send({ t: 'find', ref, id: code });
    const entries = (await asker.next('found')).entries as Array<{ pub: string }>;
    assert.deepEqual(entries.map((entry) => entry.pub).sort(), peers.map((peer) => peer.pub).sort(), 'every online PC of the depth is listed');
    fronts.push(entries[0].pub);
  }
  assert.equal(new Set(fronts).size, 3, 'each of the three takes the front in turn: ' + fronts.length + ' answers, no PC always first');
  // The root comes online: it is on a shorter chain, so it leads every answer, the others still take turns behind it.
  const cr = await connect(relay.port, { me: root, findable: true });
  await cr.next('ready');
  clients.push(cr);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const seconds: string[] = [];
  for (let ref = 11; ref <= 16; ref++) {
    asker.send({ t: 'find', ref, id: code });
    const entries = (await asker.next('found')).entries as Array<{ pub: string }>;
    assert.equal(entries.length, 4);
    assert.equal(entries[0].pub, root.pub, 'a shorter chain still comes first');
    seconds.push(entries[1].pub);
  }
  assert.ok(new Set(seconds).size > 1, 'behind it the others take turns');
  // An offline PC is never listed: the answer is what is online now.
  for (const client of clients) client.ws.close();
});
