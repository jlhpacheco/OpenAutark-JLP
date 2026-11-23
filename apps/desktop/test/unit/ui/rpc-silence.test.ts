// One silence rule for every socket (lib/rpc.ts, Fest round 22.11.2026): the PC sends a page's socket a frame at least every
// 15 s (its beat, runtime/http/keepalive.ts), so an open socket that hears nothing for SILENT_MS (shared/api/protocol.ts, a
// minute) is replaced at once and the new socket reloads everything (rpc.open); every frame starts the wait over, the beat
// itself is passed over like any frame that is neither an answer nor an event; a socket that closed leaves no wait behind.
// Follow-up G + review: while a call waits for its answer the wait stretches to five silent minutes – a large answer on a
// slow link arrives as one frame after minutes, and a cut under it would reload, ask again and cut again – but a call that
// never answers (a page that always has one out on a dead socket) still ends it; a return to the page probes sooner.
// The probe itself: rpc-alive.test.ts; the desktop port has no wait (rpc-alive-desktop.test.ts).
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT_MS } from '../../../src/shared/api/protocol.ts';

interface Frame { id?: number; method?: string }

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Frame[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Frame); }
  close() { this.closed = true; }
  beat() { this.onmessage?.({ data: '{}' }); }
  answer(method: string, result: unknown) {
    const request = this.sent.find((frame) => frame.method === method);
    this.onmessage?.({ data: JSON.stringify({ id: request?.id, result }) });
  }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1];
let instance = 0;

async function page(t: TestContext) {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'location', 'history', 'WebSocket'] as const;
  const saved = keys.map((key) => [key, globals[key]] as const);
  const windowListeners = new Map<string, () => void>();
  globals.window = { addEventListener: (type: string, fn: () => void) => { windowListeners.set(type, fn); } };
  globals.document = { visibilityState: 'visible', addEventListener: () => undefined };
  globals.location = { protocol: 'https:', host: 'phone.test', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => {
    mock.timers.reset();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?silence-${instance++}`, import.meta.url).href)) as RpcModule;
  const opened = async (supportsBeat = true) => { const socket = last(); socket.onopen!(); if (supportsBeat) socket.beat(); await flush(); return socket; };
  let reloads = 0;
  mod.rpc.onOpen(() => { reloads += 1; });
  mod.rpc.start();
  return { mod, rpc: mod.rpc, opened, reloads: () => reloads, fire: (type: string) => windowListeners.get(type)!() };
}

test('a minute without any frame and no call waiting: the socket is replaced at once, the new one reloads everything', async (t) => {
  const { rpc, opened, reloads } = await page(t);
  assert.equal(SILENT_MS, 60_000, 'four beats of the PC missed');
  const quiet = await opened();
  assert.equal(reloads(), 1);

  mock.timers.tick(59_999);
  assert.equal(FakeSocket.all.length, 1, 'still within the minute');
  assert.equal(quiet.closed, false);
  mock.timers.tick(1);
  assert.equal(quiet.closed, true, 'the silent socket is closed');
  assert.equal(quiet.onmessage, null, 'and a late frame from it is dropped');
  assert.equal(FakeSocket.all.length, 2, 'a new socket at once, no backoff wait');

  await opened();
  assert.equal(reloads(), 2, 'onOpen → store.loadAll and every view (lib/use-load.ts) load again');
  assert.equal(rpc.status.value, 'open');
});

test('the beat every 15 s keeps a quiet socket open for as long as it comes; the beat itself is passed over', async (t) => {
  const { rpc, opened } = await page(t);
  const socket = await opened();
  let heard = 0;
  rpc.on('update.state', () => { heard += 1; });

  for (let round = 0; round < 20; round++) { mock.timers.tick(15_000); socket.beat(); } // five minutes
  await flush();
  assert.equal(FakeSocket.all.length, 1, 'never replaced while the PC beats');
  assert.equal(socket.closed, false);
  assert.equal(heard, 0, 'a beat is no event');

  socket.onmessage!({ data: JSON.stringify({ event: 'update.state', data: {} }) });
  mock.timers.tick(59_999);
  assert.equal(FakeSocket.all.length, 1, 'any frame starts the wait over');
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, 2);
});

test('a slow link: while a call waits for its large answer, silence does not cut for up to five minutes; after the answer the minute counts again', async (t) => {
  const { rpc, opened, reloads } = await page(t);
  const socket = await opened();
  const big = rpc.call('files.read', { path: 'C:/big.mp4' } as never);
  let answered = false;
  void big.then(() => { answered = true; }, () => undefined);

  for (let minute = 0; minute < 4; minute++) mock.timers.tick(60_000); // minute by minute: each silent wait fires in its turn
  mock.timers.tick(59_999); // the answer is almost five minutes on its way: the beats queue behind it
  assert.equal(FakeSocket.all.length, 1, 'no cut under a waiting call – no reload loop on a slow link');
  assert.equal(socket.closed, false);
  assert.equal(reloads(), 1);

  socket.answer('files.read', { text: 'x'.repeat(1000) }); // the large frame arrived
  await flush();
  assert.equal(answered, true);
  mock.timers.tick(59_999);
  assert.equal(FakeSocket.all.length, 1);
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, 2, 'nothing waits any more: a minute of silence replaces it');
});

test('a call that never answers (a dead socket under a page that always has a call out): replaced after five silent minutes', async (t) => {
  const { rpc, opened } = await page(t);
  const socket = await opened();
  const stuck = rpc.call('devices.list');
  for (let minute = 0; minute < 4; minute++) mock.timers.tick(60_000); // minute by minute: each silent wait fires in its turn
  void rpc.call('files.read', { path: 'C:/a.txt' } as never).catch(() => undefined); // a file tab's next look: still no frame
  mock.timers.tick(60_000 - 1);
  assert.equal(FakeSocket.all.length, 1, 'a waiting call is given five silent minutes');
  mock.timers.tick(1);
  assert.equal(socket.closed, true, 'then the socket counts as dead');
  assert.equal(FakeSocket.all.length, 2);
  await assert.rejects(stuck, (error: { code?: string }) => error.code === 'unavailable');
});

test('a call stuck on a dead socket: a return to the page replaces it within 3 s, before the five minutes', async (t) => {
  const { rpc, opened, fire } = await page(t);
  const socket = await opened();
  const stuck = rpc.call('devices.list');
  mock.timers.tick(2 * 60_000);
  assert.equal(FakeSocket.all.length, 1);
  fire('pageshow'); // the person comes back to the page
  mock.timers.tick(3_000);
  assert.equal(socket.closed, true);
  assert.equal(FakeSocket.all.length, 2);
  await assert.rejects(stuck, (error: { code?: string }) => error.code === 'unavailable');
});

test('a socket that closed leaves no wait behind: the next socket keeps its own minute', async (t) => {
  const { opened } = await page(t);
  const first = await opened();
  mock.timers.tick(30_000);
  first.onclose!({ code: 1006 }); // the OS reported the drop: the usual backoff
  mock.timers.tick(500);
  assert.equal(FakeSocket.all.length, 2);
  const second = await opened();
  mock.timers.tick(30_000); // the first socket's minute is over now
  assert.equal(FakeSocket.all.length, 2, 'the closed socket\'s wait is gone');
  assert.equal(second.closed, false);
  mock.timers.tick(30_000);
  assert.equal(second.closed, true, 'the second one\'s own minute');
  assert.equal(FakeSocket.all.length, 3);
});


test('legacy PC without app beats remains connected; upgrade is learned independently for each socket', async (t) => {
  const { opened } = await page(t);
  const socket = await opened(false);
  for (let minute = 0; minute < 10; minute++) mock.timers.tick(SILENT_MS);
  assert.equal(socket.closed, false);
  assert.equal(FakeSocket.all.length, 1);
  socket.beat();
  mock.timers.tick(SILENT_MS);
  assert.equal(socket.closed, true);
  const legacy = await opened(false);
  for (let minute = 0; minute < 3; minute++) mock.timers.tick(SILENT_MS);
  assert.equal(legacy.closed, false);
});
