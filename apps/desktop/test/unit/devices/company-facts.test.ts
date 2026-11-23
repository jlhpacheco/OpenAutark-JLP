// Owner 21.11.2026 (devices/company-facts.ts): an employee's PC names its company after the firm (never "company-2"),
// shows the company's one Remote ID and how the person is named there; a company PC answers only its employees' PCs. Also
// the profile menu's role line (roleLine). Eine-ID 22.11.2026: the answer's chain makes the employee's PC answer for the
// Company ID until it leaves. Fest 22.11.2026: no fallback name is stored (an older company PC leaves the name empty), a
// stored PC name heals with the next answer, the person's name fills an empty profile.name, and the facts come again in
// the link's rhythm while it stays up.
// Owns: these assertions only. Never: a real mesh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { harness } from '../chat/harness.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { cleanFacts, companyCode, employerFacts, employerPeople, FACTS_METHOD, startCompanyFacts } from '../../../src/runtime/devices/company-facts.ts';
import { fingerprintOf, rawPublic } from '../../../src/runtime/devices/keys.ts';
import { belongs, codeFor, openCodes, type CodeKey } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { roleLine } from '../../../src/shared/model/companies.ts';
import { record } from './sync-net.ts';

const LENA = 'per_lena000001';
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 2)); };

type Handler = (params: unknown, from: string, signal: AbortSignal) => Promise<unknown>;
interface Peer { repo: DevicesRepo; handlers: Map<string, { handler: Handler; kinds: readonly string[] }> }

function pc(id: string, key?: CodeKey) {
  const h = harness();
  let profile: Record<string, unknown> = { name: '', company: '' };
  h.services.settings = {
    get: () => ({ profile: { ...profile } }),
    update: (patch: { profile?: Record<string, unknown> }) => { profile = { ...profile, ...patch.profile }; return { profile }; },
  } as never;
  const repo = new DevicesRepo(h.db);
  repo.upsert(record(id, { self: true }));
  const handlers = new Map<string, { handler: Handler; kinds: readonly string[] }>();
  const pub = key ? Buffer.from(key.publicKey) : randomBytes(32);
  if (key) openCodes(h.db, key, () => h.clock.now());
  const peers = new Map<string, Peer>();
  const mesh = {
    register: (method: string, handler: Handler, kinds: readonly string[] = ['ceo', 'employer']) => { handlers.set(method, { handler, kinds }); },
    call: async (peer: string, method: string, params: unknown) => {
      const target = peers.get(peer);
      const entry = target?.handlers.get(method);
      if (!target || !entry) throw new Error('unknown method');
      const link = target.repo.get(id);
      const kind = link?.personId ? 'employee' : link?.joinedAs === 'employee' ? 'employer' : 'ceo';
      if (!entry.kinds.includes(kind)) throw new Error('not for this link');
      return entry.handler(JSON.parse(JSON.stringify(params)), id, new AbortController().signal);
    },
    selfInfo: () => ({ id, name: id, pub: pub.toString('base64url'), addresses: [] }),
  };
  let changed = 0;
  return { id, h, repo, handlers, peers, mesh, pub, changed: () => changed, start: () => startCompanyFacts(h.services, mesh as never, () => { changed += 1; }) };
}

function company(options: { oldCompany?: boolean; keys?: [CodeKey, CodeKey] } = {}) {
  const a = pc('dev_a', options.keys?.[0]);
  const e = pc('dev_e', options.keys?.[1]);
  a.peers.set(e.id, e);
  e.peers.set(a.id, a);
  a.repo.upsert(record(e.id, { personId: LENA, ...(options.keys ? { publicKey: e.pub.toString('base64url'), fingerprint: fingerprintOf(e.pub) } : {}) }));
  a.h.services.settings.update({ profile: { name: 'Momo', company: 'MomosDojo GmbH' } });
  const staff = [
    { id: 'human', name: 'CEO', title: '', role: 'ceo', status: 'active' },
    { id: LENA, name: 'Lena', title: 'Designer', role: 'member', status: 'active' },
    { id: 'per_otto000001', name: 'Otto', title: 'Sales', role: 'member', status: 'active' },
    { id: 'per_gone000001', name: 'Gone', title: '', role: 'member', status: 'revoked' },
  ];
  (a.h.services as { people?: unknown }).people = { get: (personId: string) => staff.find((p) => p.id === personId), list: () => staff };
  if (!options.oldCompany) a.start();
  const offE = e.start();
  return { a, e, offE };
}

/** Counts the company PC's answers to 'company.facts'. */
function countAsks(a: ReturnType<typeof pc>): () => number {
  let asked = 0;
  const serve = a.handlers.get(FACTS_METHOD)!;
  a.handlers.set(FACTS_METHOD, { ...serve, handler: (...args) => { asked += 1; return serve.handler(...args); } });
  return () => asked;
}

/** The employer link comes up on the employee's PC (device.upserted 'online', as the mesh tells it). */
async function linkUp(e: ReturnType<typeof pc>, status: 'online' | 'revoked' = 'online') {
  const employer = record('dev_a', { name: 'MomosDojo', joinedAs: 'employee', status, fingerprint: 'f'.repeat(64), ...(status === 'revoked' ? { revokedAt: 5 } : {}) });
  e.repo.upsert(employer);
  e.h.services.bus.emit('device.upserted', employer as never);
  await settle();
}

test('the employee\'s PC names its company after the firm and shows the company\'s Remote ID and her name there', async () => {
  const { a, e } = company();
  assert.equal(e.h.services.settings.get().profile.company, '', 'nothing before the link');
  await linkUp(e);
  assert.equal(e.h.services.settings.get().profile.company, 'MomosDojo GmbH');
  assert.deepEqual(employerFacts(e.h.services)?.person, { name: 'Lena', title: 'Designer' });
  assert.equal(companyCode(e.h.services), remoteIdOf(fingerprintOf(a.pub)), 'the company PC\'s code, not this PC\'s own');
  assert.equal(e.changed(), 1, 'the Remote ID row hears it');
  assert.equal(companyCode(a.h.services), undefined, 'a company\'s own PC shows its own code');
});

test('the employee\'s PC names every colleague: the CEO as owner, the others by id, never her own row or a revoked one', async () => {
  const { e } = company();
  await linkUp(e);
  assert.deepEqual(employerFacts(e.h.services)?.people, [
    { id: 'owner', name: 'Momo', title: '', ceo: true },
    { id: 'per_otto000001', name: 'Otto', title: 'Sales' },
  ]);
  const shown = employerPeople(e.h.services);
  assert.deepEqual(shown.map((p) => [p.id, p.name, p.title, p.fromEmployer]), [['owner', 'Momo', 'CEO', true], ['per_otto000001', 'Otto', 'Sales', true]]);
});

test('a roster entry with a foreign id or no name is dropped', () => {
  assert.deepEqual(cleanFacts({ people: [{ id: 'owner', name: 'Momo' }, { id: 'human', name: 'X' }, { id: 'per_x', name: 'Y' }, { id: 'per_otto000001', name: ' ' }] }).people, [{ id: 'owner', name: 'Momo', title: '' }]);
});

test('a company PC answers only its employees\' PCs', async () => {
  const { a } = company();
  const own = pc('dev_b');
  own.peers.set(a.id, a);
  a.repo.upsert(record(own.id)); // my other PC: a 'ceo' link
  await assert.rejects(own.mesh.call(a.id, FACTS_METHOD, {}), /not for this link/);
});

test('Fest: an older company PC without the method – no name is stored for it (never the PC\'s name), its own ID for the code', async () => {
  const { e } = company({ oldCompany: true });
  await linkUp(e);
  assert.equal(e.h.services.settings.get().profile.company, '', 'no fallback stored');
  assert.equal(companyCode(e.h.services), remoteIdOf('f'.repeat(64)));
  assert.equal(e.changed(), 0, 'nothing heard');
});

test('Fest: a name an older version stored (the employer PC\'s name) heals with the next answer that names the company', async () => {
  const { e } = company();
  e.h.services.settings.update({ profile: { company: 'MomosDojo' } });
  await linkUp(e);
  assert.equal(e.h.services.settings.get().profile.company, 'MomosDojo GmbH');
});

test('Fest: the name the company knows the person by fills an empty profile.name; a name already there stays', async () => {
  const empty = company();
  await linkUp(empty.e);
  assert.equal(empty.e.h.services.settings.get().profile.name, 'Lena');
  const named = company();
  named.e.h.services.settings.update({ profile: { name: 'Lena Berg' } });
  await linkUp(named.e);
  assert.equal(named.e.h.services.settings.get().profile.name, 'Lena Berg', 'the name she typed while joining stays');
});

test('Fest: each round of the link\'s catch-up rhythm (sync.round) asks again – a renamed company heals; an unchanged answer is quiet', async () => {
  const { a, e } = company();
  const asked = countAsks(a);
  const round = async (peer = 'dev_a') => { e.h.services.bus.emit('sync.round', { peer }); await settle(); };
  await linkUp(e);
  assert.equal(asked(), 1, 'at link-up');
  await round();
  assert.equal(asked(), 2, 'again in the rhythm');
  assert.equal(e.changed(), 1, 'the same answer again: the Remote ID row hears nothing new');
  a.h.services.settings.update({ profile: { company: 'Dojo AG' } });
  await round();
  assert.equal(e.h.services.settings.get().profile.company, 'Dojo AG');
  assert.equal(e.changed(), 2);
  await round('dev_other');
  assert.equal(asked(), 3, 'a round of another PC asks nothing');
  e.repo.upsert(record('dev_a', { name: 'MomosDojo', joinedAs: 'employee', status: 'offline', fingerprint: 'f'.repeat(64) }));
  await round();
  assert.equal(asked(), 3, 'an employer PC out of reach is not asked');
});

test('Fest: after the last employer link went, and after the off switch, a round asks nothing', async () => {
  const gone = company();
  const asked = countAsks(gone.a);
  await linkUp(gone.e);
  await linkUp(gone.e, 'revoked');
  gone.e.h.services.bus.emit('sync.round', { peer: 'dev_a' });
  await settle();
  assert.equal(asked(), 1, 'no employer link: nothing asked');
  const off = company();
  const askedOff = countAsks(off.a);
  await linkUp(off.e);
  off.offE();
  off.e.h.services.bus.emit('sync.round', { peer: 'dev_a' });
  await settle();
  assert.equal(askedOff(), 1, 'switched off: nothing asked');
});

test('an answer keeps only its known keys; a code needs 9 digits', () => {
  assert.deepEqual(cleanFacts({ company: ' X ', code: '12345', person: { name: 'Lena', title: 'Designer', extra: 1 }, other: 1 }), { company: 'X', person: { name: 'Lena', title: 'Designer' } });
  assert.deepEqual(cleanFacts({ code: '123456789', person: { title: 'no name' } }), { code: '123456789' });
  assert.deepEqual(cleanFacts(null), {});
});

test('the profile menu\'s line: CEO in one\'s own company, the firm\'s words in another', () => {
  assert.equal(roleLine({ role: 'owner' }), 'CEO');
  assert.equal(roleLine({ role: 'employee', title: 'Designer · Lena' }), 'Designer · Lena');
  assert.equal(roleLine({ role: 'employee' }), 'Employee');
  assert.equal(roleLine({}), '', 'a company that does not run names nothing');
});

const keyOf = (): CodeKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPublic(publicKey);
  return { publicKey: raw, fingerprint: fingerprintOf(raw), sign: (data) => sign(null, data, privateKey) };
};

test('Eine-ID: the company PC signs the employee\'s PC in and hands it its chain; that PC keeps it, and loses it when it leaves', async () => {
  const [ka, ke] = [keyOf(), keyOf()];
  const { e } = company({ keys: [ka, ke] });
  assert.equal(codeFor(ke.fingerprint)?.code(), remoteIdOf(ke.fingerprint), 'before: its own ID');
  await linkUp(e);
  const companyId = codeFor(ka.fingerprint)!.code();
  assert.equal(codeFor(ka.fingerprint)!.tree().links.some((link) => link.pub === e.pub.toString('base64url')), true, 'the company PC signed it in');
  assert.equal(codeFor(ke.fingerprint)!.code(), companyId, 'the employee\'s PC answers for the Company ID');
  assert.equal(belongs(companyId, ke.fingerprint, codeFor(ke.fingerprint)!.chain()), true);
  assert.equal(employerFacts(e.h.services)?.chain, undefined, 'the chain is not kept with the facts');
  assert.equal(companyCode(e.h.services), companyId);
  await linkUp(e, 'revoked');
  assert.equal(codeFor(ke.fingerprint)!.code(), remoteIdOf(ke.fingerprint), 'its last employer link went: its own company again');
});
