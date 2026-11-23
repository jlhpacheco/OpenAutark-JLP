// The texts of Settings › Devices (ui/settings/connect-text.ts): grouped Remote IDs, the line under
// "Connect" for each state of this PC's request (with the code while it waits), the Remote ID hint
// with the meeting server or "only this network", a device row's hint (an employee's PC names its
// person), and when the first run's Connect card ends the first run (ui/onboarding/first-run-model.ts); F09 the PCs on
// this network grouped by PC with their companies, F17 a request waiting on another of my PCs. Eine-ID 22.11.2026: the
// Company ID / My ID hints, the line by the role the PC asked answered, "Your name" while waiting as a new member, a
// request's words by its role, a nearby row's Connect by its company's ID.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awayText, connectLine, deviceHint, groupDigits, incomingText, nearbyGroups, nearbyHint, nearbyTarget, remoteIdHint, typedTarget, waitsAsMember,
  COMPANY_ID_BASE, CONNECT_HINT, MY_ID_HINT, UPDATE_BACK_MS,
} from '../../../src/ui/settings/connect-text.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import type { NearbyPc, RemoteOutgoing } from '../../../src/shared/model/remote.ts';

const out = (status: RemoteOutgoing['status'], role: RemoteOutgoing['role'] | null = 'ceo', company?: string): RemoteOutgoing => ({
  id: 'ro_1', ...(role ? { role } : {}), ...(company ? { company } : {}), deviceId: 'dev_x', name: 'Tower', remoteId: '123456782', fingerprint: 'f'.repeat(64), code: '4821', status, expiresAt: 1,
});

test('Remote IDs in groups of three; a typed address stays as typed', () => {
  assert.equal(groupDigits('482913071'), '482 913 071');
  assert.equal(typedTarget('4829130'), '482 913 0');
  assert.equal(typedTarget('203.0.113.5'), '203.0.113.5');
});

test('Eine-ID: the line under Connect says what the ID typed makes of this PC – a new member, one of my devices, or not yet answered', () => {
  assert.deepEqual(connectLine(undefined, null), { text: CONNECT_HINT });
  assert.equal(CONNECT_HINT, 'PCs nearby are listed above; others by ID or address');
  assert.deepEqual(connectLine(out('waiting', 'employee', 'Dojo'), null), { text: 'Joining Dojo as a new member', code: '4821', action: 'cancel' });
  assert.deepEqual(connectLine(out('waiting', 'employee'), null).text, 'Joining Tower as a new member', 'no company named (an older PC): the PC asked');
  assert.deepEqual(connectLine(out('waiting', 'ceo'), null), { text: 'Adding to your devices', code: '4821', action: 'cancel' });
  assert.deepEqual(connectLine(out('waiting', null), null), { text: 'Asking Tower', code: '4821', action: 'cancel' }, 'the role comes with the answer');
  assert.deepEqual(connectLine(out('accepted', 'employee', 'Dojo'), null), { text: 'Joined Dojo as a new member', tone: 'ok', action: 'close' });
  assert.deepEqual(connectLine(out('accepted', 'ceo'), null), { text: 'Tower is one of your devices now', tone: 'ok', action: 'close' });
  assert.equal(connectLine(out('declined'), null).action, 'close');
  assert.deepEqual(connectLine(out('waiting'), 'No Autark PC answered at that address.'), { text: 'No Autark PC answered at that address.', tone: 'error' });
});

test('review H1: one of another person\'s devices only with this side\'s yes – the line asks first, no code before the yes', () => {
  assert.deepEqual(connectLine({ ...out('confirm', 'ceo'), person: 'Kim' }, null), { text: 'Add this PC to Kim\'s devices? Everything here is shared with them.', action: 'cancel' });
  assert.equal(connectLine(out('confirm', 'ceo'), null).text, 'Add this PC to Tower\'s devices? Everything here is shared with them.', 'no person named: the PC asked');
  assert.equal(connectLine(out('confirm', 'ceo'), null).code, undefined);
  assert.equal(waitsAsMember(out('confirm', 'ceo')), false);
});

test('Eine-ID: "Your name" shows only while this PC waits as a new member', () => {
  assert.equal(waitsAsMember(out('waiting', 'employee')), true);
  assert.equal(waitsAsMember(out('waiting', 'ceo')), false, 'one of my devices needs no name');
  assert.equal(waitsAsMember(out('waiting', null)), false, 'not answered yet (the name went with the request)');
  assert.equal(waitsAsMember(out('accepted', 'employee')), false);
  assert.equal(waitsAsMember(undefined), false);
});

test('the Remote ID hint: through the meeting server, or only this network', () => {
  const relay = (status: 'off' | 'connecting' | 'connected' | 'error') => ({ status, peersOnline: 0, relayed: [] });
  assert.equal(remoteIdHint(undefined, true), 'Type it on another PC to connect', 'not read yet: nothing claimed');
  assert.equal(remoteIdHint(relay('connected'), true), 'Type it on another PC to connect · meeting server connected');
  assert.equal(remoteIdHint(relay('off'), true), 'Type it on another PC to connect · only this network (meeting server off)');
  assert.match(remoteIdHint(relay('connecting'), true), /only this network for now \(meeting server connecting…\)$/);
  assert.match(remoteIdHint({ ...relay('error'), error: 'The meeting server is not reachable (ECONNREFUSED)' }, true), /only this network for now \(the meeting server is not reachable \(ECONNREFUSED\)\)$/);
  assert.match(remoteIdHint({ ...relay('error'), error: 'The meeting server refused this PC' }, true), /only this network for now \(the meeting server refused this PC\)$/, 'its own reason, not "not reachable"');
  assert.match(remoteIdHint(relay('error'), true), /only this network for now \(meeting server not reachable\)$/);
  assert.match(remoteIdHint(undefined, false), /devices\.findable/);
  assert.equal(remoteIdHint(relay('connected'), true, COMPANY_ID_BASE), 'New members type it · meeting server connected', 'Eine-ID: the Company ID row');
  assert.equal(MY_ID_HINT, 'Type it on another PC of yours to add it · phones scan the QR', 'the My ID row');
});

test('F09: PCs on this network grouped by PC – a PC\'s companies under it; same names elsewhere and older answers stay apart', () => {
  const pc = (name: string, digit: string, addresses: string[], company?: string): NearbyPc => ({
    deviceId: `dev_${digit.repeat(12)}`, name, remoteId: '123456782', fingerprint: digit.repeat(64), addresses, state: 'new', ...(company ? { company } : {}),
  });
  const first = pc('server', 'a', ['http://192.168.1.5:47812', 'http://100.64.0.5:47812'], 'Teydra Lab');
  const second = pc('server', 'b', ['http://192.168.1.5:63140'], 'Teydra Lab');
  const elsewhere = pc('server', 'c', ['http://192.168.1.9:47812'], 'Other firm');
  const old = pc('server', 'd', ['http://192.168.1.5:50000']);
  const notebook = pc('notebook', 'e', ['http://192.168.1.7:47812'], 'Teydra Lab');
  const groups = nearbyGroups([first, second, elsewhere, old, notebook]);
  assert.deepEqual(groups.map((group) => [group.name, group.pcs.map((entry) => entry.fingerprint[0])]), [
    ['server', ['a', 'b']], // one PC, two companies: they share an address host
    ['server', ['c']], // another PC of the same name on the same network never merges
    ['server', ['d']], // an older PC without a company stays one row
    ['notebook', ['e']],
  ]);
  assert.equal(nearbyHint(notebook, false), 'On this network · Teydra Lab · ID 123 456 782', 'a PC alone: its company in the hint');
  assert.equal(nearbyHint(old, false), 'On this network · ID 123 456 782');
  assert.equal(nearbyHint(first, true), 'ID 123 456 782', 'under its PC: the company is the label');
  const member = { ...notebook, companyId: '482913071' };
  assert.equal(nearbyHint(member, false), 'On this network · Teydra Lab · Company ID 482 913 071', 'Eine-ID: the company\'s ID, the one Connect asks with');
  assert.equal(nearbyTarget(member), '482913071', 'Connect on a row: a new member of that company');
  assert.equal(nearbyTarget(old), '123456782', 'an older PC: its own Remote ID');
  assert.deepEqual(nearbyGroups([]), []);
});

test('Eine-ID: a request says what the PC becomes – a new member of this company or one of my devices; F17 names the PC it waits on', () => {
  const via = { deviceId: 'dev_server', name: 'server' };
  assert.deepEqual(incomingText({ role: 'employee', name: 'Tower', code: '1234' }, 'Dojo'), { label: 'Tower wants to join Dojo as a new member', hint: 'Accept only if Tower shows the code 1234' });
  assert.equal(incomingText({ role: 'employee', name: 'Tower', code: '1234' }, '  ').label, 'Tower wants to join as a new member', 'no company name yet');
  assert.equal(incomingText({ role: 'ceo', name: 'Tower', code: '1234' }, 'Dojo').label, 'Tower wants to be one of your devices');
  assert.deepEqual(incomingText({ role: 'phone', name: 'Galaxy', code: '5359', via }), { label: 'Phone Galaxy asks server to connect', hint: 'Accept only if the phone shows the code 5359' });
  assert.equal(incomingText({ role: 'ceo', name: 'Tower', code: '1234', via }).label, 'Tower wants to be one of your devices · on server');
  assert.equal(incomingText({ role: 'employee', name: 'Tower', code: '1234', via }, 'Dojo').label, 'Tower wants to join Dojo as a new member · on server');
});


test('device hints: this PC, a phone, the CEO\'s PC and an employee\'s PC', () => {
  const base: Device = { id: 'dev_a', name: 'Tower', kind: 'pc', role: 'home', fingerprint: 'f', addresses: [], caps: {}, status: 'online', self: false };
  const time = () => '14:02';
  assert.equal(deviceHint({ ...base, self: true }, () => undefined, time), 'This PC');
  assert.equal(deviceHint({ ...base, kind: 'phone', lastSeenAt: 1 }, () => undefined, time), 'Phone · Last used 14:02');
  assert.equal(deviceHint(base, () => undefined, time), 'PC · Online');
  assert.equal(deviceHint({ ...base, personId: 'per_anna', status: 'offline', lastSeenAt: 1 }, (id) => (id === 'per_anna' ? 'Anna' : undefined), time), 'PC · Employee · Anna · Not reachable · Last seen 14:02');
});

// Sicher-Runde 19.11.2026: a PC that said goodbye (device.bye) reads what it is doing, not "Not reachable".
test('device hints after a goodbye: app closed, updating (and not back), signed out; online again: the plain line', () => {
  const base: Device = { id: 'dev_a', name: 'Tower', kind: 'pc', role: 'home', fingerprint: 'f', addresses: [], caps: {}, status: 'offline', self: false, lastSeenAt: 1 };
  const time = () => '14:02';
  const at = 1_000_000;
  assert.equal(deviceHint({ ...base, away: { reason: 'quit', at } }, () => undefined, time, at + 60_000), 'PC · App closed · 14:02');
  assert.equal(deviceHint({ ...base, away: { reason: 'update', at } }, () => undefined, time, at + 60_000), 'PC · Updating… · since 14:02');
  assert.equal(deviceHint({ ...base, away: { reason: 'update', at } }, () => undefined, time, at + UPDATE_BACK_MS), 'PC · Not back after its update · 14:02');
  assert.equal(deviceHint({ ...base, away: { reason: 'session-end', at } }, () => undefined, time, at), 'PC · Signed out or shut down · 14:02');
  assert.equal(deviceHint({ ...base, status: 'online', away: { reason: 'quit', at } }, () => undefined, time, at), 'PC · Online');
  assert.equal(awayText({ status: 'offline' }, time), '');
});
