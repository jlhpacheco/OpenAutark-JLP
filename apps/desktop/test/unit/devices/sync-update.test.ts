// Feedback 1b136d01 (owner 19.11.2026: "per PC einfach updaten mit einem Klick, auch wenn man gerade nicht auf dem PC ist"):
// system.update presses a PC's own Update button (src/runtime/devices/sync/update.ts) – here through host.update, with
// `device` on a linked own PC over the mesh; an offline PC says so and nothing is sent, a PC that is no CEO link is neither
// asked nor obeyed, and a host without the app refuses.
// Owns: these assertions only. Never: network, Electron or a real update.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { answerOf, serveUpdate, UPDATE_METHOD, updateOn } from '../../../src/runtime/devices/sync/update.ts';
import { link, makePc, Net, type Pc } from './sync-net.ts';

const code = (wanted: string) => (error: unknown) => error instanceof WorkforceError && error.code === wanted;

function withUpdate(pc: Pc): string[] {
  const pressed: string[] = [];
  (pc.h.services as { host: { update?: () => Promise<void> } }).host.update = async () => { pressed.push(pc.id); };
  pc.handlers.set(UPDATE_METHOD, (_params, from) => serveUpdate(pc.h.services, from));
  return pressed;
}

test('system.update: here, or on a linked own PC over the mesh', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const onA = withUpdate(a);
  const onB = withUpdate(b);
  assert.deepEqual(await updateOn(b.h.services, undefined), { ok: true });
  assert.deepEqual(await updateOn(b.h.services, b.id), { ok: true }, "this PC's own id stays here");
  assert.deepEqual(onB, ['dev_b', 'dev_b']);
  assert.deepEqual(await updateOn(b.h.services, a.id), { ok: true });
  assert.deepEqual(onA, ['dev_a'], "A's own Update button");
  assert.ok(net.calls.some((call) => call.method === UPDATE_METHOD && call.to === a.id));
});

test('system.update: offline says so and sends nothing; no CEO link is neither asked nor obeyed; no app window refuses', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const onA = withUpdate(a);
  net.up = false;
  await assert.rejects(updateOn(b.h.services, a.id), (error: unknown) => code('unavailable')(error) && /dev_a is offline/.test((error as Error).message));
  assert.equal(net.calls.length, 0);
  await assert.rejects(updateOn(b.h.services, 'dev_nobody'), code('not_found'));

  const other = new Net();
  const boss = makePc(other, 'dev_boss');
  const staff = makePc(other, 'dev_staff');
  link(boss, staff, 'pe_1'); // an employee's PC
  const onStaff = withUpdate(staff);
  await assert.rejects(updateOn(boss.h.services, staff.id), code('not_found'), "an employee's PC is not asked");
  await assert.rejects(staff.handlers.get(UPDATE_METHOD)!({}, boss.id), code('forbidden'), 'and does not obey');
  assert.deepEqual([...onA, ...onStaff], []);

  (a.h.services as { host: { update?: unknown } }).host.update = undefined;
  await assert.rejects(updateOn(a.h.services, undefined), code('unavailable'));
});

// Sicher-Runde 19.11.2026 (E4): the answer is what that PC's updater said – over the mesh too; junk is dropped.
test('system.update answers the updater\'s verdict, here and from a linked own PC', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  (a.h.services as { host: { update?: () => Promise<unknown> } }).host.update = async () => ({ ok: true, status: 'current', version: '0.3.5', key: 'x', message: 7 });
  a.handlers.set(UPDATE_METHOD, (_params, from) => serveUpdate(a.h.services, from));
  assert.deepEqual(await updateOn(b.h.services, a.id), { ok: true, status: 'current', version: '0.3.5' });
  assert.deepEqual(answerOf({ ok: true, status: 'exploded', automaticInstall: false }), { ok: true, automaticInstall: false });
  assert.deepEqual(answerOf(undefined), { ok: true }, 'an older main answers nothing');
});
