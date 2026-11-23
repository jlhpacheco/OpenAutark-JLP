// Feedback F25 (16.11.2026): Settings › Devices writes each PC's app version after its line – "0.3.6 – behind
// server 0.3.8" when another listed PC runs a newer one, else just the version; a phone, a browser or a PC that
// sends no version shows none (src/ui/settings/device-version.ts).
// Owns: these assertions only. Never: the row's markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Device } from '../../../src/shared/model/devices.ts';
import { answerText, rowAction, splitDevices, UPDATE_ALL_FROM, updateAllText, updateOffered, updateQueue, versionHint } from '../../../src/ui/settings/device-version.ts';

const pc = (id: string, version?: string, extra: Partial<Device> = {}): Device => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: version ? { version } : {}, status: 'online', self: false, ...extra,
});

test('a PC behind another names the newest one; the newest PC shows its version only', () => {
  const list = [pc('notebook', '0.3.6', { self: true }), pc('server', '0.3.8'), pc('office', '0.3.7')];
  assert.equal(versionHint(list[0], list), '0.3.6 – behind server 0.3.8');
  assert.equal(versionHint(list[2], list), '0.3.7 – behind server 0.3.8');
  assert.equal(versionHint(list[1], list), '0.3.8');
});

test('no version, a phone or a removed PC: nothing to say or compare', () => {
  const old = pc('old-pc');
  const phone: Device = { ...pc('phone', '0.3.9'), kind: 'phone', role: 'client' };
  const gone = pc('gone', '0.4.0', { status: 'revoked' });
  const me = pc('me', '0.3.8', { self: true });
  const list = [me, old, phone, gone];
  assert.equal(versionHint(old, list), '', 'an older PC sends none');
  assert.equal(versionHint(phone, list), '');
  assert.equal(versionHint(me, list), '0.3.8', 'a phone or a removed PC is no comparison');
});

// Feedback 1b136d01 (19.11.2026): a PC behind the others and online offers its Update on its row.
test('the Update button: only on a PC behind the others that is online', () => {
  const list = [pc('notebook', '0.3.6'), pc('server', '0.3.8', { self: true }), pc('office', '0.3.7', { status: 'offline' })];
  assert.equal(updateOffered(list[0], list), true);
  assert.equal(updateOffered(list[1], list), false, 'the newest needs none');
  assert.equal(updateOffered(list[2], list), false, 'an offline PC cannot be asked');
  assert.equal(updateOffered(pc('old-pc'), list), false, 'no version, no comparison');
});

// Sicher-Runde 19.11.2026 (D2): E3, the strip, "Update all", the row's one slot and the updater's answer in words.
test('E3: an employee\'s PC or my employer\'s gets no Update (that update is not mine to press)', () => {
  const list = [pc('me', '0.3.8', { self: true }), pc('staff', '0.3.6', { personId: 'pe_1' }), pc('boss', '0.3.6', { joinedAs: 'employee' }), pc('mine', '0.3.6', { joinedAs: 'ceo' })];
  assert.equal(updateOffered(list[1], list), false);
  assert.equal(updateOffered(list[2], list), false);
  assert.equal(updateOffered(list[3], list), true);
});

test('the strip: This PC on its own, the others PCs first then by name; removed and pairing ones not at all', () => {
  const phone: Device = { ...pc('phone'), kind: 'phone', role: 'client' };
  const { self, others } = splitDevices([pc('zeta'), phone, pc('me', undefined, { self: true }), pc('alpha'), pc('gone', undefined, { status: 'revoked' }), pc('new', undefined, { status: 'pairing' })]);
  assert.equal(self?.id, 'me');
  assert.deepEqual(others.map((device) => device.id), ['alpha', 'zeta', 'phone']);
  assert.equal(splitDevices([pc('alpha')]).self, undefined);
});

test('Update all: every offered PC, this PC last; shown from two on', () => {
  const list = [pc('me', '0.3.6', { self: true }), pc('a', '0.3.6'), pc('b', '0.3.9'), pc('c', '0.3.7'), pc('off', '0.3.6', { status: 'offline' })];
  const queue = updateQueue(list, (device) => updateOffered(device, list));
  assert.deepEqual(queue.map((device) => device.id), ['a', 'c', 'me']);
  assert.ok(queue.length >= UPDATE_ALL_FROM);
});

test('the row\'s one slot: Update, Wake for my own PC away with a wake key, else nothing', () => {
  const list = [pc('me', '0.3.8', { self: true }), pc('old', '0.3.6'), pc('closed', '0.3.8', { status: 'offline', caps: { version: '0.3.8', wakeKey: 'k' } })];
  assert.equal(rowAction(list[1], list), 'update');
  assert.equal(rowAction(list[2], list), 'wake');
  assert.equal(rowAction(pc('staff', undefined, { status: 'offline', personId: 'pe_1', caps: { wakeKey: 'k' } }), list), undefined, 'not an employee\'s PC');
  assert.equal(rowAction(pc('older', undefined, { status: 'offline' }), list), undefined, 'no wake key: an older app');
  assert.equal(rowAction(list[0], list), undefined);
  assert.equal(rowAction(list[0], list, true), 'update', 'this PC\'s own updater found one');
});

test('E4: what the updater answered, in words; several in one toast', () => {
  assert.equal(answerText('Server', { ok: true, status: 'current', version: '0.3.5' }).title, 'Server: already the newest official version (0.3.5)');
  assert.equal(answerText('Server', { ok: true, status: 'available', availableVersion: '0.3.8', automaticInstall: true }).title, 'Server is downloading 0.3.8');
  assert.match(answerText('Mac', { ok: true, status: 'available', availableVersion: '0.3.8', automaticInstall: false }).body ?? '', /by hand/);
  assert.deepEqual(answerText('Server', { ok: true, status: 'error', message: 'Smart App Control blocked the installer.' }), { title: 'Server could not update', body: 'Smart App Control blocked the installer.', tone: 'error' });
  assert.equal(answerText('Old', { ok: true }).title, 'Old got the update request');
  const all = updateAllText([
    { name: 'Laptop', answer: { ok: true, status: 'current', version: '0.3.5' } },
    { name: 'Server', answer: { ok: true, status: 'downloading', availableVersion: '0.3.8' } },
    { name: 'Office', error: 'Office is offline right now.' },
  ]);
  assert.equal(all.title, 'Updating 1 of 3 PCs');
  assert.equal(all.body, 'Laptop: already the newest (0.3.5) · Server: downloading 0.3.8 · Office: Office is offline right now.');
  assert.equal(all.tone, 'error');
  assert.equal(updateAllText([{ name: 'Office', error: 'offline' }]).title, 'Office could not update');
});
