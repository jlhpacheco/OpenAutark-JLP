// The ping keepalive (http/keepalive.ts, B-077/B-080): a ping every 15 s; a socket is ended only after a minute without
// any frame (onSilent hears it first); any frame counts as life, not only the pong; a tick that comes late because this
// process stalled pings again and ends nobody; the interval is armed only while sockets exist. Fake sockets and a
// manual clock – no timers run. Fest round 22.11.2026: a socket marked with page() (a page's, http/ws.ts) also gets BEAT
// with every ping – a page cannot see pings (ui/lib/rpc.ts waits for a frame); every other socket gets pings only. G: its
// ping → pong times are round trips to its device (devices/link-quality.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BEAT, KEEPALIVE_MS, Keepalive } from '../../../src/runtime/http/keepalive.ts';
import { linkQuality } from '../../../src/runtime/devices/link-quality.ts';

class FakeWs extends EventEmitter {
  pings = 0;
  ended = false;
  readonly sent: string[] = [];
  ping(): void { this.pings++; }
  send(text: string): void { this.sent.push(text); }
  terminate(): void { this.ended = true; this.emit('close'); }
}

test('a page socket gets the beat with every ping, from the round after it was marked; a peer socket never', () => {
  let now = 0;
  const keepalive = new Keepalive(KEEPALIVE_MS, () => now);
  const page = new FakeWs();
  const peer = new FakeWs();
  keepalive.add(page as never);
  keepalive.add(peer as never);
  try {
    now += KEEPALIVE_MS; keepalive.tick();
    assert.deepEqual(page.sent, [], 'before its Hello was accepted: pings only');
    keepalive.page(page as never);
    keepalive.page(new FakeWs() as never); // a socket the keepalive does not hold: nothing happens
    for (let round = 0; round < 3; round++) { now += KEEPALIVE_MS; keepalive.tick(); page.emit('pong'); peer.emit('pong'); }
    assert.deepEqual(page.sent, [BEAT, BEAT, BEAT]);
    assert.equal(page.pings, 4);
    assert.deepEqual(peer.sent, [], 'the peer protocol gets no text frame');
    assert.equal(peer.pings, 4);
    const frame: unknown = JSON.parse(BEAT);
    assert.ok(typeof frame === 'object' && frame !== null && !('id' in frame) && !('event' in frame), 'neither an answer nor an event: every client passes over it');
  } finally {
    keepalive.stop();
  }
});

test('G: a page\'s ping → pong is one round trip to its device (no new traffic); a socket without a device notes none', () => {
  let now = 100_000;
  const keepalive = new Keepalive(KEEPALIVE_MS, () => now);
  const phone = new FakeWs();
  const anonymous = new FakeWs();
  keepalive.add(phone as never);
  keepalive.add(anonymous as never);
  keepalive.page(phone as never, 'dev_keepalive_phone');
  keepalive.page(anonymous as never);
  try {
    for (const ms of [80, 95, 85]) {
      now += KEEPALIVE_MS; keepalive.tick();
      now += ms; phone.emit('pong'); anonymous.emit('pong');
    }
    phone.emit('pong'); // a pong without a ping of ours counts nothing
    assert.equal(linkQuality('dev_keepalive_phone', now)?.rttMs, 85, 'the median of 80, 95, 85');
    assert.equal(phone.sent.length, 3, 'and the beat went with every ping');
  } finally {
    keepalive.stop();
  }
});

test('B-080: a socket silent for 45 s stays; past a minute without any frame it is cut, onSilent hearing it first', () => {
  let now = 0;
  const heard: Array<{ ws: unknown; ms: number }> = [];
  const keepalive = new Keepalive(KEEPALIVE_MS, () => now, (ws, ms) => heard.push({ ws, ms }));
  const silent = new FakeWs();
  const pongs = new FakeWs();
  const talks = new FakeWs();
  for (const ws of [silent, pongs, talks]) keepalive.add(ws as never);
  try {
    for (let round = 0; round < 3; round++) { now += KEEPALIVE_MS; keepalive.tick(); pongs.emit('pong'); }
    talks.emit('message', Buffer.from('frame')); // a pong stuck behind a big frame: the frame itself proves life
    assert.equal(now, 45_000);
    assert.deepEqual([silent.ended, silent.pings], [false, 3], '45 s of silence: a low-RAM PC may just have stalled');
    now += KEEPALIVE_MS; keepalive.tick();
    assert.equal(silent.ended, false, 'exactly a minute: still kept');
    now = 61_000; keepalive.tick();
    assert.equal(silent.ended, true, 'past a minute without any frame');
    assert.deepEqual(heard, [{ ws: silent, ms: 61_000 }]);
    assert.equal(pongs.ended, false);
    assert.equal(talks.ended, false);
    assert.equal(keepalive.all().length, 2);
  } finally {
    keepalive.stop();
  }
});

test('a late tick (this process stalled) pings again and ends nobody; the next on-time tick does', () => {
  let now = 0;
  const keepalive = new Keepalive(KEEPALIVE_MS, () => now);
  const ws = new FakeWs();
  keepalive.add(ws as never);
  try {
    now += KEEPALIVE_MS; keepalive.tick();
    now += KEEPALIVE_MS * 4; keepalive.tick(); // 60 s late: its answers may sit unread in this process
    assert.equal(ws.ended, false, 'a late tick never ends a socket');
    assert.equal(ws.pings, 2);
    now += KEEPALIVE_MS; keepalive.tick();
    assert.equal(ws.ended, true, 'still no frame after an on-time round');
  } finally {
    keepalive.stop();
  }
});

test('a ping every 15 s; a dead link is noticed within about 60–75 s on either end', () => {
  assert.equal(KEEPALIVE_MS, 15_000);
  assert.equal(new Keepalive().silentMs, 60_000);
});
