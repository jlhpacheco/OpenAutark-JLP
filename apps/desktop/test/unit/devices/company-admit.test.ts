// Admit through the company (devices/company-admit.ts, Eine-ID 22.11.2026): the params check (the new PC as proven, a
// non-empty plain name, nothing else), the company's side answers members' PCs only, the member's side turns a company PC
// that is away or older into one plain line, passes the company's refusal on, and takes only the employer PC it is linked
// to as the answer. The whole flow between three PCs: test/unit/remote/eine-id.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitMarks, admitThrough, employerOf, readAdmit, serveAdmit, unreachable, ADMIT_METHOD, type AdmitMesh } from '../../../src/runtime/devices/company-admit.ts';
import { b64url, fingerprintOf, fromB64url, generateEd25519, rawPublic } from '../../../src/runtime/devices/keys.ts';
import type { PeerInfo } from '../../../src/runtime/devices/pair-proof.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import { memoryDb } from './fakes.ts';

const pub = () => b64url(rawPublic(generateEd25519().publicKey));
const info = (id: string, key = pub()): PeerInfo => ({ id, name: 'Nora PC', role: 'home', pub: key, addresses: [] });
const device = (id: string, key: string, extra: Partial<Device>): Device =>
  ({ id, name: 'Office', kind: 'pc', role: 'home', fingerprint: fingerprintOf(fromB64url(key)), addresses: [], caps: {}, status: 'online', self: false, ...extra });
const code = (name: string, text?: RegExp) => (error: unknown) => error instanceof WorkforceError && error.code === name && (!text || text.test(error.message));

test('readAdmit: the new PC as proven and a plain non-empty name; nothing else', () => {
  const nora = info('dev_nora00000001');
  assert.deepEqual(readAdmit({ info: nora, person: { name: '  Nora\u0000 Berg ' } }), { info: nora, name: 'Nora Berg' });
  assert.throws(() => readAdmit({ info: nora, person: { name: '\u0000 ' } }), code('bad_request'), 'an empty name makes no person');
  assert.throws(() => readAdmit({ info: nora, person: { name: 'Nora', role: 'ceo' } }), code('bad_request'), 'only a name');
  assert.throws(() => readAdmit({ info: { ...nora, id: 'x' }, person: { name: 'Nora' } }), code('bad_request'), 'a PC as its request proved it');
  assert.throws(() => readAdmit({ info: nora, person: { name: 'Nora' }, personId: 'per_x' }), code('bad_request'));
});

test('serveAdmit answers a member\'s PC only, with this PC\'s identity once the new one is stored', async () => {
  const handlers = new Map<string, { handler: PeerHandler; kinds?: readonly string[] }>();
  const key = pub();
  const devices = [device('dev_seat00000001', key, { personId: 'per_momo' }), device('dev_mine00000001', pub(), {})];
  const me = info('dev_office000001');
  const admitted: Array<[string, string]> = [];
  serveAdmit({ register: (method, handler, kinds) => { handlers.set(method, { handler, kinds }); }, list: () => devices }, (pc, name) => { admitted.push([pc.id, name]); return me; });
  const entry = handlers.get(ADMIT_METHOD)!;
  assert.deepEqual(entry.kinds, ['employee'], 'the mesh offers it to members\' PCs only');
  const params = { info: info('dev_nora00000001'), person: { name: 'Nora' } };
  assert.deepEqual(await entry.handler(params, 'dev_seat00000001', new AbortController().signal), { employer: me });
  assert.deepEqual(admitted, [['dev_nora00000001', 'Nora']]);
  await assert.rejects(entry.handler(params, 'dev_mine00000001', new AbortController().signal) as Promise<unknown>, code('forbidden'), 'one of my own PCs makes no member through it');
  await assert.rejects(entry.handler(params, 'dev_gone00000001', new AbortController().signal) as Promise<unknown>, code('forbidden'));
  assert.equal(admitted.length, 1);
});

test('admitThrough: the company PC\'s answer as linked; away or older → one plain line; its refusal as it said', async () => {
  const officeKey = pub();
  const office = device('dev_office000001', officeKey, { joinedAs: 'employee', status: 'online' });
  const nora = info('dev_nora00000001');
  const mesh = (answer: () => unknown): Pick<AdmitMesh, 'call'> => ({ call: async () => answer() });
  const self = { ...info('dev_office000001', officeKey), name: 'Office' };
  assert.deepEqual(await admitThrough(mesh(() => ({ employer: self })), office, nora, 'Nora'), self);
  await assert.rejects(admitThrough(mesh(() => { throw new WorkforceError('unavailable', 'The linked device is offline.'); }), office, nora, 'Nora'), code('unavailable', /^Office is not reachable – it adds the new member\.$/));
  await assert.rejects(admitThrough(mesh(() => { throw new WorkforceError('timeout', 'late'); }), office, nora, 'Nora'), code('unavailable', /not reachable/));
  await assert.rejects(admitThrough(mesh(() => { throw new WorkforceError('not_found', 'Unknown device method company.admit.'); }), office, nora, 'Nora'), code('unavailable', /^Update Autark on Office/));
  await assert.rejects(admitThrough(mesh(() => { throw new WorkforceError('conflict', 'Nora PC is linked here already.'); }), office, nora, 'Nora'), code('conflict', /linked here already/));
  await assert.rejects(admitThrough(mesh(() => ({ employer: info('dev_office000001') })), office, nora, 'Nora'), code('forbidden'), 'another key than the linked company PC\'s');
  assert.equal(unreachable({ name: '' }), 'The company\'s PC is not reachable – it adds the new member.');
});

test('employerOf: the company PC this PC joined as a member\'s, never a revoked one or one of my own', () => {
  const office = device('dev_office000001', pub(), { joinedAs: 'employee' });
  assert.equal(employerOf([device('dev_mine00000001', pub(), {}), office])?.id, office.id);
  assert.equal(employerOf([{ ...office, status: 'revoked' }]), undefined);
  assert.equal(employerOf([{ ...office, self: true }]), undefined);
  // Review M3: an online employer link first (Accept's check and the call ask the same one), else any.
  const away = device('dev_officeaway01', pub(), { joinedAs: 'employee', status: 'offline' });
  assert.equal(employerOf([away, office])?.id, office.id);
  assert.equal(employerOf([away, { ...office, status: 'connecting' }])?.id, away.id);
});

test('review M2: admitMarks keeps the keys stored through an admit', () => {
  const marks = admitMarks(memoryDb());
  assert.equal(marks.has('a'.repeat(64)), false);
  marks.add('a'.repeat(64));
  assert.equal(marks.has('a'.repeat(64)), true);
  assert.equal(marks.has('b'.repeat(64)), false);
});
