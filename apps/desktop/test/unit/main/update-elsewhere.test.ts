// Sicher-Runde 19.11.2026 (D2, E4/E5): the Update pressed on another own PC (src/main/updates-wiring.ts updateNow,
// updateFromElsewhere) answers what the updater said after its fresh check – 'available' (it goes on), 'current' (nothing
// newer in the official feed) – and only after the answer, ANSWER_FIRST_MS later, downloads and installs; the install's
// drain says goodbye to my other PCs ('update') before the runtime stops. The host op app.update hands the answer on.
// Owns: these assertions only. Never: electron, network or a real install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_FIRST_MS, DesktopUpdates, updateFromElsewhere } from '../../../src/main/updates-wiring.ts';
import { HostServices, type HostServicesDeps } from '../../../src/main/host-services.ts';
import { desktopDeps, fakeUpdater, settle } from './update-fakes.ts';

function remote(version: string | null) {
  const { updater, calls } = fakeUpdater({ version });
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const h = desktopDeps({ updater, autoDownload: () => false, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  h.deps.runtime.bye = async (reason) => { h.order.push(`bye:${reason}`); };
  return { ...h, calls, timers, updates: new DesktopUpdates(h.deps) };
}

test('updateNow: the verdict after the check first; the download and install only after the answer', async () => {
  const h = remote('0.3.8');
  const answer = await h.updates.updateNow();
  assert.equal(answer.status, 'available');
  assert.equal(answer.availableVersion, '0.3.8');
  await settle();
  assert.deepEqual(h.order, [], 'nothing drains before the answer is out');
  const later = h.timers.find((timer) => timer.ms === ANSWER_FIRST_MS);
  assert.ok(later, 'the install waits for the answer to travel');
  later.fn();
  await settle();
  assert.equal(h.calls.download, 1);
  assert.deepEqual(h.order.slice(0, 4), ['drafts', 'pause:0.3.8', 'bye:update', 'stop'], 'the goodbye goes out before the runtime stops');
  h.updates.dispose();
});

test('updateNow: nothing newer in the official feed says so and installs nothing', async () => {
  const h = remote(null);
  const answer = await updateFromElsewhere(h.updates, () => undefined);
  assert.deepEqual({ status: answer.status, version: answer.version }, { status: 'current', version: '0.2.0' });
  for (const timer of h.timers.filter((entry) => entry.ms === ANSWER_FIRST_MS)) timer.fn();
  await settle();
  assert.equal(h.calls.download, 0);
  assert.deepEqual(h.order, []);
  await assert.rejects(updateFromElsewhere(null, () => undefined), (error: { code?: string }) => error.code === 'unavailable');
  h.updates.dispose();
});

test('host op app.update hands the updater\'s answer back; no wiring refuses', async () => {
  const host = new HostServices({ update: async () => ({ ok: true, status: 'current', version: '0.3.5' }) } as unknown as HostServicesDeps);
  assert.deepEqual(await host.handle({ id: 1, type: 'host', op: 'app.update', args: {} }), { ok: true, status: 'current', version: '0.3.5' });
  const bare = new HostServices({} as unknown as HostServicesDeps);
  await assert.rejects(bare.handle({ id: 2, type: 'host', op: 'app.update', args: {} }), (error: { code?: string }) => error.code === 'unavailable');
});
