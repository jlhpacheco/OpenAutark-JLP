// How good this PC's connection to each device is now (src/runtime/devices/link-quality.ts, Fest round 22.11.2026 G): the
// round trip is the median of the last five samples, a stall of one sample does not move it, `slow` from 300 ms, nothing
// older than five minutes counts; a linked PC's clock offset comes NTP-style from the mesh ping with the smallest round
// trip; pingLink notes a sample only when the link was up before the ping (a dial would count); devices.list shows the
// figures for PCs and phones without the sample time.
// Owns: these assertions only. Never: a real network, socket or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_STALE_MS, SLOW_LINK_MS } from '../../../src/shared/model/devices.ts';
import { linkQuality, noteClock, noteRoundTrip, pingLink, withLink } from '../../../src/runtime/devices/link-quality.ts';
import { devicesList } from '../../../src/runtime/devices/list-tool.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

test('the round trip is the median of the last five samples; one stall does not move it; slow from 300 ms', () => {
  for (const [i, ms] of [40, 42, 2_000, 45, 41].entries()) noteRoundTrip('dev_phone_a', ms, 1_000 + i);
  assert.deepEqual(linkQuality('dev_phone_a', 1_010), { rttMs: 42, at: 1_004 }, 'the 2 s stall of one ping is not the connection');
  for (const [i, ms] of [400, 380, 420, 390, 410].entries()) noteRoundTrip('dev_phone_a', ms, 2_000 + i);
  assert.deepEqual(linkQuality('dev_phone_a', 2_010), { rttMs: 400, slow: true, at: 2_004 }, 'only the last five count');
  assert.equal(SLOW_LINK_MS, 300);
  noteRoundTrip('dev_phone_b', 299, 0);
  assert.equal(linkQuality('dev_phone_b', 1)?.slow, undefined);
  noteRoundTrip('dev_phone_b', -5, 1);
  noteRoundTrip('dev_phone_b', Number.NaN, 1);
  assert.equal(linkQuality('dev_phone_b', 1)?.rttMs, 299, 'nonsense samples are dropped');
});

test('nothing older than five minutes counts; an unmeasured device has no figure', () => {
  noteRoundTrip('dev_phone_c', 50, 0);
  assert.equal(linkQuality('dev_phone_c', LINK_STALE_MS)?.rttMs, 50);
  assert.equal(linkQuality('dev_phone_c', LINK_STALE_MS + 1), undefined);
  assert.equal(linkQuality('dev_never', 0), undefined);
  assert.deepEqual(withLink({ id: 'dev_never', name: 'X' }, 0), { id: 'dev_never', name: 'X' }, 'no link field while unmeasured');
  assert.deepEqual(withLink({ id: 'dev_phone_c' }, 10), { id: 'dev_phone_c', link: { rttMs: 50, at: 0 } });
});

test('the clock offset: at − (sent + received) / 2 from the sample with the smallest round trip', () => {
  // The other PC runs 2 s ahead. A slow sample (400 ms, its answer late on the way back) would read 1.8 s.
  noteClock('dev_pc_a', 10_000, 12_000 + 0, 10_400); // midpoint 10 200 → offset 1 800
  noteClock('dev_pc_a', 20_000, 22_000 + 20, 20_040); // midpoint 20 020 → offset 2 000, round trip 40 ms
  noteClock('dev_pc_a', 30_000, 'not a number', 30_100); // an answer without `at`: a round trip, no offset sample
  const quality = linkQuality('dev_pc_a', 30_100)!;
  assert.equal(quality.offsetMs, 2_000);
  assert.equal(quality.rttMs, 100, 'median of 400, 40, 100');
});

test('pingLink: a sample only when the link was up before the ping; it answers what the ping answered', async () => {
  let now = 5_000;
  let up = true;
  const devices = {
    online: () => up,
    call: async (_id: string, method: string) => { assert.equal(method, 'ping'); now += 60; return { ok: true, at: now - 30 + 1_000 }; },
  };
  const answer = await pingLink(devices, 'dev_pc_b', { now: () => now });
  assert.deepEqual(answer, { ok: true, at: 6_030 });
  assert.deepEqual(linkQuality('dev_pc_b', now), { rttMs: 60, offsetMs: 1_000, at: 5_060 });
  up = false; // the call has to dial first: its time is no round trip
  await pingLink(devices, 'dev_pc_c', { now: () => now });
  assert.equal(linkQuality('dev_pc_c', now), undefined);
});

test('devices.list gives the AI each online PC\'s connection (round trip, slow, clock offset), without the sample time', async () => {
  const pc = (id: string, name: string, self = false) => ({ id, name, kind: 'pc', role: 'home', fingerprint: id, addresses: [], caps: {}, status: 'online', ...(self ? { self: true } : {}) });
  const devices = [pc('dev_self_l', 'Server', true), pc('dev_pc_far', 'Notebook')];
  const ctx = {
    agent: { id: 'ag_1', name: 'Mira' }, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: {
      devices: { self: () => devices[0], list: () => devices, online: () => true, call: async () => ({ ok: true, at: Date.now() }) },
      dispatcher: { activity: () => [] },
    },
  } as unknown as ToolContext;
  const out = (await devicesList().run({}, ctx)).structured as { devices: Array<{ name: string; link?: Record<string, unknown> }> };
  const by = new Map(out.devices.map((device) => [device.name, device]));
  const link = by.get('Notebook')!.link!;
  assert.equal(typeof link.rttMs, 'number');
  assert.equal(typeof link.offsetMs, 'number');
  assert.equal('at' in link, false);
  assert.equal(by.get('Server')!.link, undefined, 'this PC: no connection to itself');
  assert.match(devicesList().description, /link \(round trip, slow, clock offset\)/);
});
