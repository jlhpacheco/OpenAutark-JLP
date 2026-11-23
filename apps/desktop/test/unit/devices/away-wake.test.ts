// Sicher-Runde 19.11.2026 (D2): honest states and waking a PC whose app is closed.
// - device.bye (src/runtime/devices/away.ts, mesh.ts): a goodbye before a deliberate stop is Device.away on the other PC –
//   kept while the link is down, gone once it is back;
// - the wake (wake.ts, wake-sign.ts, sleeper.ts): a PC announces its wake key, its helper's file pins only my own PCs, and
//   a Wake from a linked own PC reaches the helper through a played meeting server, is checked (signer, freshness, once)
//   and starts the app; anything else is refused, and 4009 ends the helper.
// Owns: these assertions only. Never: network, Electron, real timers for the helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { awayOf, BYE_METHOD, sayBye, storedAway } from '../../../src/runtime/devices/away.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { b64url, fromB64url, generateEd25519, rawPublic, signEd25519, verifyEd25519, fingerprintOf } from '../../../src/runtime/devices/keys.ts';
import { PAIR_INFO, helloText, openJson, sealJson, toBox } from '../../../src/runtime/devices/rendezvous/seal.ts';
import { Sleeper, type SleeperSocket } from '../../../src/runtime/devices/sleeper.ts';
import { sendWake, wakeFileFor, wakeKey, writeWakeFile, type Waker } from '../../../src/runtime/devices/wake.ts';
import { checkWake, parseWakeFile, signWake, WAKE_FILE, WAKE_FRESH_MS, wakeFpOf, type WakeFile } from '../../../src/runtime/devices/wake-sign.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { idOf, linkedPair, settle, statusOf } from './mesh-nodes.ts';

const awayOn = (node: Awaited<ReturnType<typeof linkedPair>>['a'], other: Awaited<ReturnType<typeof linkedPair>>['a']) =>
  node.mesh.list().find((device) => device.id === idOf(other))?.away;

test('device.bye: the other PC keeps why this one went, with its own clock, until the link is back', async () => {
  const { low, high } = await linkedPair();
  high.clock.advance(5_000);
  await low.mesh.bye('quit');
  assert.deepEqual(awayOn(high, low), { reason: 'quit', at: high.clock.now() });
  (await high.mesh.connect(idOf(low))).channel.close(); // the app ends: its link closes
  await settle();
  assert.equal(statusOf(high, low), 'offline');
  assert.equal(awayOn(high, low)?.reason, 'quit', 'kept while the PC is away');
  low.timers.fire(); // the smaller id dials again: the app is back
  await settle();
  assert.equal(statusOf(high, low), 'online');
  assert.equal(awayOn(high, low), undefined, 'gone once the link is back');
});

test('device.bye: an employee\'s PC says goodbye too; a bad reason changes nothing', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'pe_1' });
  await b.mesh.bye('update');
  assert.equal(awayOn(a, b)?.reason, 'update');
  assert.equal(awayOf({ reason: 'gone' }, 1), undefined);
  assert.equal(storedAway({ reason: 'quit', at: 'x' }), undefined);
  assert.deepEqual(storedAway({ reason: 'session-end', at: 7 }), { reason: 'session-end', at: 7 });
  const calls: string[] = [];
  await sayBye([{ call: async (method) => { calls.push(method); throw new Error('closed'); } }], 'quit'); // a failure is no error
  assert.deepEqual(calls, [BYE_METHOD]);
});

test('the wake key: made once, announced in the caps at start, sent to linked PCs', async () => {
  const { a, b } = await linkedPair();
  const key = wakeKey(a.db);
  assert.deepEqual(wakeKey(a.db), key, 'the same key every time');
  a.mesh.start();
  await settle();
  assert.equal(a.mesh.self().caps.wakeKey, key.pub);
  assert.equal(b.mesh.list().find((device) => device.id === idOf(a))?.caps.wakeKey, key.pub);
});

test('the helper\'s file: only my own linked PCs are pinned; none or no meeting server – no file', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'pe_1' }); // Tower is an employee's PC on Laptop
  const key = wakeKey(a.db);
  assert.equal(wakeFileFor({ relay: 'wss://meet.example', key, devices: new DevicesRepo(a.db).list() }), undefined, 'an employee\'s PC does not wake mine');
  const own = wakeFileFor({ relay: 'wss://meet.example', key, devices: new DevicesRepo(b.db).list() });
  assert.deepEqual(own?.pins, [{ fp: a.identity.fingerprint, pub: b64url(a.identity.publicKey) }]);
  assert.equal(wakeFileFor({ relay: undefined, key, devices: new DevicesRepo(b.db).list() }), undefined);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wake-'));
  try {
    assert.equal(writeWakeFile(dir, own), true);
    assert.deepEqual(parseWakeFile(readFileSync(path.join(dir, WAKE_FILE), 'utf8')), own);
    assert.equal(writeWakeFile(dir, undefined), false);
    assert.equal(existsSync(path.join(dir, WAKE_FILE)), false, 'removed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(parseWakeFile('{"v":1,"relay":"wss://x","key":{"pub":"a","pkcs8":"b"},"pins":[]}'), undefined);
});

test('checkWake: the pinned signer, this session, fresh and once', () => {
  const signer = generateEd25519();
  const pub = b64url(rawPublic(signer.publicKey));
  const fp = fingerprintOf(rawPublic(signer.publicKey));
  const pins = [{ fp, pub }];
  const session = { wakeFp: 'f'.repeat(64), box: b64url(randomBytes(32)) };
  const sign = (data: Uint8Array) => signEd25519(signer.privateKey, data);
  const body = signWake(sign, session.wakeFp, session.box, 1_000_000, b64url(randomBytes(18)));
  const seen = new Set<string>();
  assert.equal(checkWake(body, 'e'.repeat(64), pins, session, 1_000_000, seen), false, 'from a key that is not pinned');
  assert.equal(checkWake(body, fp, pins, { ...session, box: b64url(randomBytes(32)) }, 1_000_000, seen), false, 'another session');
  assert.equal(checkWake(body, fp, pins, session, 1_000_000 + WAKE_FRESH_MS + 1, seen), false, 'too old');
  assert.equal(checkWake({ ...body, at: body.at + 1 }, fp, pins, session, 1_000_000, seen), false, 'the time is signed');
  assert.equal(checkWake(body, fp, pins, session, 1_000_000, seen), true);
  assert.equal(checkWake(body, fp, pins, session, 1_000_000, seen), false, 'once');
});

/** A helper on a played meeting server: hello, ready, and the requests the waker sends as sealed 'pair' frames. */
function playedHelper(file: WakeFile, now: () => number) {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket: SleeperSocket = {
    on: ((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }) as SleeperSocket['on'],
    send: (data) => { sent.push(JSON.parse(data) as Record<string, unknown>); },
    close: () => undefined,
    terminate: () => undefined,
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const started: number[] = [];
  let exited = 0;
  const sleeper = new Sleeper({
    file, socket: () => socket, startApp: () => started.push(now()), exit: () => { exited++; }, now,
    timers: { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined },
  });
  sleeper.start();
  const frame = (value: Record<string, unknown>) => listeners.get('message')!(Buffer.from(JSON.stringify(value)), false);
  frame({ t: 'challenge', n: 'n1' });
  const hello = sent.shift()!;
  frame({ t: 'ready', fp: wakeFpOf(file.key.pub), online: [] });
  /** What the meeting server's 'pair' carries from `from` – sealed to the helper's box – and the opened reply. */
  const request = (from: string, body: unknown): unknown => {
    const { e, cipher } = toBox(hello.box as string, PAIR_INFO);
    frame({ t: 'pair', ref: 9, from, src: '0123456789abcdef', e, c: sealJson(cipher, body) });
    const reply = sent.shift()!;
    return openJson(cipher, reply.c);
  };
  return { hello, request, started, exited: () => exited, timers, close: (code: number) => listeners.get('close')!(code) };
}

test('Wake from a linked own PC: found under the helper\'s key, checked, the app starts and the helper ends', async () => {
  const { a, b } = await linkedPair();
  a.mesh.start(); // Laptop announces its wake key; Tower hears it
  await settle();
  const file = wakeFileFor({ relay: 'wss://meet.example', key: wakeKey(a.db), devices: new DevicesRepo(a.db).list() })!;
  const helper = playedHelper(file, () => b.clock.now());
  assert.equal(helper.hello.findable, true);
  assert.deepEqual(helper.hello.peers, [], 'pins nobody at the meeting server');
  assert.ok(verifyEd25519(fromB64url(file.key.pub), Buffer.from(helloText('n1'), 'utf8'), fromB64url(helper.hello.sig as string)), 'registered under the helper key');
  const waker: Waker = {
    find: async () => [{ fp: wakeFpOf(file.key.pub), pub: file.key.pub, box: helper.hello.box as string }],
    request: async (_fp, _box, body) => helper.request(b.identity.fingerprint, body),
  };
  b.mesh.setWaker(waker);
  await b.mesh.wake(idOf(a));
  assert.equal(helper.started.length, 1, 'the app starts');
  assert.equal(helper.exited(), 0, 'the answer goes out first');
  helper.timers.find((timer) => timer.ms === 1_000)!.fn();
  assert.equal(helper.exited(), 1);
});

test('the helper refuses a stranger, a stale or replayed wake; 4009 ends it; another close reconnects', async () => {
  const { a, b } = await linkedPair();
  const file = wakeFileFor({ relay: 'wss://meet.example', key: wakeKey(a.db), devices: new DevicesRepo(a.db).list() })!;
  let now = 5_000_000;
  const helper = playedHelper(file, () => now);
  const box = helper.hello.box as string;
  const fp = wakeFpOf(file.key.pub);
  const stranger = generateEd25519();
  const strangerBody = signWake((data) => signEd25519(stranger.privateKey, data), fp, box, now, b64url(randomBytes(18)));
  assert.deepEqual((helper.request(fingerprintOf(rawPublic(stranger.publicKey)), strangerBody) as { ok: boolean }).ok, false);
  const body = signWake((data) => b.identity.sign(data), fp, box, now - WAKE_FRESH_MS - 1, b64url(randomBytes(18)));
  assert.equal((helper.request(b.identity.fingerprint, body) as { ok: boolean }).ok, false, 'stale');
  assert.deepEqual(helper.started, []);
  const fresh = signWake((data) => b.identity.sign(data), fp, box, now, b64url(randomBytes(18)));
  assert.equal((helper.request(b.identity.fingerprint, fresh) as { ok: boolean }).ok, true);
  now += 10;
  assert.equal((helper.request(b.identity.fingerprint, fresh) as { ok: boolean }).ok, false, 'a replay after the wake is refused');
  assert.equal(helper.started.length, 1);

  const other = playedHelper(file, () => now);
  other.close(1006);
  const retry = other.timers.find((timer) => timer.ms === 1_000);
  assert.ok(retry, 'a lost connection reconnects after its backoff');
  retry.fn(); // the new connection
  other.close(4009);
  assert.equal(other.exited(), 1, 'another helper holds the key now');
});

test('sendWake: only my own linked PC with a wake key, through a meeting server, found there', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'pe_1' });
  const unavailable = (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable';
  const notFound = (error: unknown) => error instanceof WorkforceError && error.code === 'not_found';
  const sign = (data: Uint8Array) => a.identity.sign(data);
  const repo = new DevicesRepo(a.db);
  await assert.rejects(sendWake(undefined, repo.get(idOf(b)), sign, 1), notFound, 'an employee\'s PC');
  await assert.rejects(sendWake(undefined, repo.get('dev_nobody'), sign, 1), notFound);
  const own = await linkedPair();
  const record = new DevicesRepo(own.b.db).get(idOf(own.a))!;
  await assert.rejects(sendWake(undefined, record, sign, 1), (error: unknown) => unavailable(error) && /cannot be woken yet/.test((error as Error).message));
  const withKey = { ...record, caps: { wakeKey: wakeKey(own.a.db).pub } };
  await assert.rejects(sendWake(undefined, withKey, sign, 1), (error: unknown) => unavailable(error) && /meeting server/.test((error as Error).message));
  const nobody: Waker = { find: async () => [], request: async () => ({ ok: true }) };
  await assert.rejects(sendWake(nobody, withKey, sign, 1), (error: unknown) => unavailable(error) && /not waiting/.test((error as Error).message));
  const refusing: Waker = { find: async () => [{ fp: wakeFpOf(withKey.caps.wakeKey), pub: withKey.caps.wakeKey, box: b64url(randomBytes(32)) }], request: async () => ({ ok: false }) };
  await assert.rejects(sendWake(refusing, withKey, sign, 1), (error: unknown) => unavailable(error) && /did not take/.test((error as Error).message));
});
