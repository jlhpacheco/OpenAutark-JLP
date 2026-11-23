// F17 (owner 15.11.2026): a connect request waiting on one of my PCs is acceptable on my other PCs too
// (remote/mirror.ts): the holder sends its list to its 'ceo' links only (never an employee's or employer's PC), the other
// PC shows it with `via`, its Accept is decided on the holder (the first answer wins, a later one is refused calmly), a
// link that goes or a request whose time is up leaves no row, and a new person (F13) accepted there is made once, on the
// holder. readDecide is the one params check of remote.decide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDecide } from '../../../src/runtime/remote/mirror.ts';
import { REQUEST_TTL_MS } from '../../../src/runtime/remote/requests.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { NewPerson } from '../../../src/shared/model/remote.ts';
import { Lan, connectYes, linkedIds, settle, treesOf, type Pc } from './rig.ts';

const ANNA = 'per_anna000000001';
const code = (name: string) => (error: unknown) => error instanceof WorkforceError && error.code === name;

/** My server and notebook (one person's own PCs, linked and up) and a PC that asks the server. */
async function office() {
  const lan = new Lan();
  const made: NewPerson[] = [];
  const joined: string[] = [];
  const server = await lan.add('Server', 'http://10.0.0.1:47812', {
    deps: {
      createPerson: (input) => { made.push(input); return ANNA; },
      knows: (personId) => personId === ANNA,
      joined: (personId) => { joined.push(personId); },
    },
  });
  const notebook = await lan.add('Notebook', 'http://10.0.0.2:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.3:47812');
  await lan.link(server, notebook);
  lan.up(server, notebook);
  return { lan, server, notebook, tower, made, joined };
}

const mirrored = (pc: Pc) => pc.remote.state().incoming.filter((row) => row.via);

test('a request on my server shows on my notebook with the same code; Accept there links the requester on the server', async () => {
  const { server, notebook, tower } = await office();
  treesOf(server);
  const out = await connectYes(tower, { target: server.remote.state().self.myId! }); // my ID: one of my devices, after my yes
  await settle();
  const [held] = server.remote.state().incoming;
  assert.equal(held.via, undefined, 'the holder shows its own row');
  const [row] = notebook.remote.state().incoming;
  assert.ok(row, 'the notebook shows the request');
  assert.deepEqual(row.via, { deviceId: server.identity.deviceId, name: 'Server' });
  assert.equal(row.id, held.id);
  assert.equal(row.code, out.code, 'the same code: it belongs to the request, not to a screen');
  assert.ok(notebook.states.at(-1)?.incoming.some((entry) => entry.id === row.id), 'remote.updated tells the window and the phones');

  await notebook.remote.decide(row.id, true);
  await settle();
  assert.deepEqual(linkedIds(server).sort(), [notebook.identity.deviceId, tower.identity.deviceId].sort(), 'the server stored the requester');
  assert.equal(tower.remote.state().outgoing?.status, 'accepted');
  assert.deepEqual(server.remote.state().incoming, []);
  assert.deepEqual(notebook.remote.state().incoming, [], 'the row left the notebook too');
  assert.throws(() => notebook.remote.decide(row.id, true), code('not_found'), 'a second answer hears it is no longer open');
});

test('the first answer wins: a later Accept on the other PC is refused calmly and its row goes', async () => {
  const { server, notebook, tower } = await office();
  await tower.remote.connect({ target: server.remote.remoteId() });
  await settle();
  const [row] = notebook.remote.state().incoming;
  notebook.handlers.delete('remote.requests'); // the server's next list does not arrive here
  server.remote.decide(row.id, false);
  assert.equal(notebook.remote.state().incoming.length, 1, 'the notebook still shows the stale row');
  await assert.rejects(Promise.resolve(notebook.remote.decide(row.id, true)), (error: unknown) => code('not_found')(error) && /answered or has ended/.test((error as Error).message));
  assert.deepEqual(notebook.remote.state().incoming, [], 'the refused row leaves at once');
  await settle();
  assert.equal(tower.remote.state().outgoing?.status, 'declined', 'the first answer stands');
});

test('an employee\'s PC and an employer\'s PC never get the list nor decide here', async () => {
  const lan = new Lan();
  const server = await lan.add('Server', 'http://10.0.0.1:47812');
  const staff = await lan.add('Anna PC', 'http://10.0.0.4:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.3:47812');
  await lan.link(server, staff, { personId: ANNA }); // staff joined the server as Anna, an employee
  lan.up(server, staff);
  await tower.remote.connect({ target: server.remote.remoteId() });
  await settle();
  assert.equal(server.remote.state().incoming.length, 1);
  assert.deepEqual(staff.remote.state().incoming, [], 'the employee\'s PC shows nothing');
  assert.deepEqual(server.calls.filter((call) => call.startsWith('remote.requests')), [], 'nothing was sent to it');
  const id = server.remote.state().incoming[0].id;
  await assert.rejects(lan.call(staff, server.identity.deviceId, 'remote.decide', { id, accept: true }), code('forbidden'), 'its decide is refused by the link kind');
  assert.equal(server.remote.state().incoming.length, 1, 'the request still waits');

  // A request on the employee's PC never goes to its employer either.
  const other = await lan.add('Other', 'http://10.0.0.5:47812');
  await other.remote.connect({ target: staff.remote.remoteId() });
  await settle();
  assert.equal(staff.remote.state().incoming.length, 1);
  assert.deepEqual(staff.calls.filter((call) => call.startsWith('remote.requests')), []);
  assert.deepEqual(mirrored(server), []);
});

test('a link that goes takes its rows; when it comes back the list comes again; a request\'s time ends on any clock', async () => {
  const { lan, server, notebook, tower } = await office();
  notebook.clock.advance(60 * 60_000); // the notebook's clock is an hour ahead: the holder's time left counts
  await tower.remote.connect({ target: server.remote.remoteId() });
  await settle();
  assert.equal(mirrored(notebook).length, 1, 'shown although the clocks differ');
  lan.down(server, notebook);
  assert.deepEqual(notebook.remote.state().incoming, [], 'link gone: row gone');
  lan.up(server, notebook);
  await settle();
  assert.equal(mirrored(notebook).length, 1, 'the link-up brought the list again');
  notebook.clock.advance(REQUEST_TTL_MS + 1);
  assert.deepEqual(notebook.remote.state().incoming, [], 'its time is up: the row is gone without any message');
});

test('F13: a new person accepted on my notebook is made once, on the server, when the PC links', async () => {
  const { server, notebook, tower, made, joined } = await office();
  await tower.remote.connect({ target: server.remote.remoteId(), name: 'Anna B' }); // its own device ID: a new member
  await settle();
  const [row] = mirrored(notebook);
  assert.equal(row.role, 'employee');
  assert.equal(row.proposedName, 'Anna B', 'Eine-ID: the name she proposed shows on my notebook too');
  await notebook.remote.decide(row.id, true, undefined, { name: 'Anna', title: 'Design' });
  await settle();
  assert.deepEqual(made, [{ name: 'Anna', title: 'Design' }], 'made once, on the PC that holds the request');
  assert.equal(server.repo.get(tower.identity.deviceId)?.personId, ANNA, 'the PC is hers');
  assert.deepEqual(joined, [ANNA], 'and she is in now');
  assert.deepEqual(server.admitted, [ANNA], 'the personal manager hears once');
  assert.equal(tower.remote.state().outgoing?.status, 'accepted');
  assert.deepEqual(notebook.paired, [{ id: server.identity.deviceId, side: 'joiner' }], 'nothing was linked on the notebook');
});

test('readDecide: a request id, accept, either a known person or a new one with a name', () => {
  const knows = (id: string) => id === ANNA;
  const id = 'rr_0123456789abcdef';
  assert.deepEqual(readDecide({ id, accept: true }, knows), { id, accept: true });
  assert.deepEqual(readDecide({ id, accept: true, personId: ANNA }, knows), { id, accept: true, personId: ANNA });
  assert.deepEqual(readDecide({ id, accept: true, newPerson: { name: ' Anna ', title: ' Design ', managerId: 'ag_x' } }, knows), { id, accept: true, newPerson: { name: 'Anna', title: 'Design', managerId: 'ag_x' } });
  assert.deepEqual(readDecide({ id, accept: true, newPerson: { name: 'Anna', title: '' } }, knows), { id, accept: true, newPerson: { name: 'Anna' } });
  assert.deepEqual(readDecide({ id, accept: true, newPerson: { name: 'Anna', role: 'ceo' } }, knows), { id, accept: true, newPerson: { name: 'Anna', role: 'ceo' } }, 'F13: a second CEO');
  for (const params of [
    { id: 'rr_x', accept: true },
    { id, accept: 'yes' },
    { id, accept: true, personId: 'per_nobody' },
    { id, accept: true, personId: ANNA, newPerson: { name: 'Anna' } },
    { id, accept: true, newPerson: { name: '  ' } },
    { id, accept: true, newPerson: { name: 'Anna', role: 'owner' } },
    { id, accept: true, newPerson: { name: 'Anna', scopes: { spaces: 'all' } } },
    { id, accept: true, extra: 1 },
  ]) assert.throws(() => readDecide(params, knows), code('bad_request'), JSON.stringify(params));
});
