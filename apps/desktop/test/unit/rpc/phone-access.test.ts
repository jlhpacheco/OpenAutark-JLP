// B-078 ("alles vom Handy"): accounts.* for the owner's phone on a secure transport (the app's loopback tunnel) – a
// sign-in it starts opens its page as a tab in the PC's own pane – and the phone-use handlers (phoneUse.attach /
// phoneUse.reply only for the device itself, its PCs list, phone.pairLink for the owner and – B-084 – the owner's phone on
// a secure transport, never plain LAN); phoneUse.request reaches only the device it names (rpc/scopes.ts).
// B-091: a Codex/Claude Code sign-in the phone starts is "away" (finished on the phone, nothing opens on the PC) and
// accounts.loginCode hands the Claude page's code on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable, allowedScope, secureScope } from '../../../src/runtime/rpc/table.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import { myPcs, register as registerPhoneUse } from '../../../src/runtime/rpc/handlers/phone-use.ts';
import { mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { FULL_ACCESS } from '../../../src/runtime/pwa/tokens.ts';
import { phonePairLink, remoteIdOfPairText } from '../../../src/shared/api/methods-phone.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { memoryDb, recordingBus } from '../devices/fakes.ts';

const OWNER: ClientScope = { kind: 'owner', person: true }; // FX1: the person
/** This PC's key fingerprint; its own Remote ID differs from the person code remote.state shows. */
const PC_FP = 'c'.repeat(64);
const OWN_ID = remoteIdOf(PC_FP);
const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone0000001', capabilities: [...FULL_ACCESS], secure: true };
const LAN: ClientScope = { ...PHONE, secure: false };

function setup(accounts: Record<string, unknown> = {}) {
  const table = new HandlerTable();
  registerProviders(table);
  registerPhoneUse(table);
  const db = memoryDb();
  // the phone app's own row: a paired phone with its key (rendezvous pairing)
  new DevicesRepo(db).upsert({ id: 'dev_phone0000001', name: 'Pixel', kind: 'phone', role: 'client', fingerprint: 'fphone', publicKey: 'B'.repeat(43), addresses: [], caps: {}, status: 'online', self: false });
  const { bus, events } = recordingBus();
  const opened: unknown[] = [];
  const services = {
    db, bus, log: { warn() {}, info() {}, debug() {}, error() {} },
    host: { sideBrowser: async (call: unknown) => { opened.push(call); return { ok: true, tab: 'web-1' }; } },
    accounts: {
      list: () => [], login: async () => ({ started: true, url: 'https://auth.openai.com/oauth/authorize?x=1' }),
      add: async () => ({ id: 'acc_1', signInUrl: 'https://claude.ai/oauth/authorize' }),
      ...accounts,
    },
  } as never;
  // remote.state's self: my person code (the root PC's ID) and this PC's own key
  const extras = { remote: { state: () => ({ self: { remoteId: '482913071', fingerprint: PC_FP } }) } } as never;
  const aborts: AbortController[] = [];
  async function call(method: string, params: unknown, scope: ClientScope): Promise<any> {
    const entry = table.get(method);
    if (!entry) throw new WorkforceError('not_found', method);
    if (!allowedScope(entry.scope, scope)) throw new WorkforceError('forbidden', 'Not allowed');
    const abort = new AbortController();
    aborts.push(abort);
    const ctx: HandlerContext = { scope, services, extras, topics: new Set(), signal: abort.signal, secure: secureScope(scope) };
    return entry.handler(params as never, ctx);
  }
  return { call, events, opened, db, aborts };
}

const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code);

test('accounts.* reach the owner\'s phone on a secure transport, never a plain LAN browser', async () => {
  const { call } = setup();
  assert.deepEqual(await call('accounts.list', undefined, PHONE), []);
  await rejects(call('accounts.list', undefined, LAN), 'forbidden');
  await rejects(call('accounts.login', { id: 'acc_1' }, LAN), 'forbidden');
  assert.ok(FULL_ACCESS.includes('permissions'), 'a paired phone holds permissions (secure transport only)');
});

test('a sign-in started on the phone opens its page as a tab in the PC\'s own pane; the owner\'s window opens it itself', async () => {
  const { call, opened } = setup();
  const started = await call('accounts.login', { id: 'acc_1' }, PHONE);
  assert.equal(started.url, 'https://auth.openai.com/oauth/authorize?x=1', 'the phone still gets the page');
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { action: 'open', url: started.url, newTab: true, show: true, space: 'global', agent: { id: 'human', name: 'Sign-in' } });
  await call('accounts.add', { provider: 'claude' }, PHONE);
  assert.equal((opened[1] as { url: string }).url, 'https://claude.ai/oauth/authorize', 'an add with a sign-in page too');
  await call('accounts.login', { id: 'acc_1' }, OWNER);
  assert.equal(opened.length, 2, 'the owner\'s window opens the page itself');
});

test('B-091: the phone\'s Codex/Claude Code sign-in is away – finished on the phone, nothing opens on the PC; the code goes to accounts.loginCode', async () => {
  const asked: unknown[][] = [];
  const codes: unknown[][] = [];
  const DEVICE_URL = 'https://auth.openai.com/codex/device';
  const { call, opened } = setup({
    login: async (...args: unknown[]) => { asked.push(['login', ...args]); return { started: true, url: DEVICE_URL, code: 'FR4A-CONBK' }; },
    add: async (...args: unknown[]) => { asked.push(['add', ...args]); return { id: 'acc_2', signInUrl: 'https://claude.com/cai/oauth/authorize?x=1', paste: true }; },
    loginCode: async (...args: unknown[]) => { codes.push(args); return { ok: true }; },
  });
  assert.deepEqual(await call('accounts.login', { id: 'acc_1' }, PHONE), { started: true, url: DEVICE_URL, code: 'FR4A-CONBK' });
  assert.equal((await call('accounts.add', { provider: 'claude' }, PHONE)).paste, true);
  assert.deepEqual(opened, [], 'nothing opens in the PC\'s pane');
  await call('accounts.login', { id: 'acc_1' }, OWNER);
  await call('accounts.add', { provider: 'claude' }, OWNER);
  assert.deepEqual(asked, [
    ['login', 'acc_1', { page: true, away: true }], ['add', { provider: 'claude', label: undefined, apiKey: undefined, baseUrl: undefined }, { away: true }],
    ['login', 'acc_1', { page: true, away: false }], ['add', { provider: 'claude', label: undefined, apiKey: undefined, baseUrl: undefined }, { away: false }],
  ], 'the PC window signs in at the PC');

  assert.deepEqual(await call('accounts.loginCode', { id: 'acc_2', code: ' abc#def ' }, PHONE), { ok: true });
  assert.deepEqual(codes, [['acc_2', ' abc#def ']]);
  await rejects(call('accounts.loginCode', { id: 'acc_2', code: 'abc' }, LAN), 'forbidden');
  for (const params of [{ id: 'acc_2', code: '' }, { id: 'acc_2', code: 'a\nb' }, { id: 'acc_2', code: 'a\u0007b' }, { id: 'acc_2', code: 'x'.repeat(4097) }, { id: 'acc_2', code: 'a', extra: 1 }]) {
    await rejects(call('accounts.loginCode', params, PHONE), 'bad_request');
  }
  assert.equal(codes.length, 1);
});

test('phoneUse.attach: only the device itself; it is reachable until its socket closes; the answer lists my PCs only', async () => {
  const { call, events, db, aborts } = setup();
  const repo = new DevicesRepo(db);
  const pc = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ id, name: id, kind: 'pc', role: 'home', fingerprint: `f${id}`, publicKey: 'A'.repeat(43), addresses: [], caps: {}, status: 'online', self: false, ...extra });
  repo.upsert(pc('dev_self0000001', { self: true }));
  repo.upsert(pc('dev_mine0000001'));
  repo.upsert(pc('dev_employee001', { personId: 'per_1' }));
  repo.upsert(pc('dev_employer001', { joinedAs: 'employee' }));
  repo.upsert(pc('dev_gone0000001', { revokedAt: 1, status: 'revoked' }));
  await rejects(call('phoneUse.attach', {}, OWNER), 'forbidden');
  const attached = await call('phoneUse.attach', { model: 'Pixel 8', screen: { width: 1080, height: 2400 }, ready: true }, PHONE);
  assert.deepEqual(attached.pcs.map((entry: { deviceId: string }) => entry.deviceId), ['dev_self0000001', 'dev_mine0000001']);
  assert.deepEqual(myPcs({ db }).length, 2);
  assert.deepEqual(events.at(-1), { event: 'phoneUse.attached', data: { deviceId: 'dev_phone0000001', on: true, model: 'Pixel 8', screen: { width: 1080, height: 2400 }, ready: true } });
  aborts.at(-1)!.abort();
  assert.deepEqual(events.at(-1), { event: 'phoneUse.attached', data: { deviceId: 'dev_phone0000001', on: false } });
  await rejects(call('phoneUse.attach', { screen: { width: -1, height: 2 } }, PHONE), 'bad_request');
  await rejects(call('phoneUse.attach', {}, LAN), 'forbidden'); // plain LAN http never carries typed secrets
  repo.upsert({ id: 'dev_browser0001', name: 'Old browser', kind: 'browser', role: 'client', fingerprint: 'fb', addresses: [], caps: {}, status: 'online', self: false });
  await rejects(call('phoneUse.attach', {}, { ...PHONE, deviceId: 'dev_browser0001' }), 'forbidden'); // a QR-paired browser is no phone
  await rejects(call('phoneUse.reply', { id: 'pu_9', result: {} }, LAN), 'forbidden');
});

test('phone.pcs (the iPhone web app): my PCs for the phone itself, without claiming phone use', async () => {
  const { call, events, db } = setup();
  const repo = new DevicesRepo(db);
  repo.upsert({ id: 'dev_self0000001', name: 'Desk', kind: 'pc', role: 'home', fingerprint: 'fself', publicKey: 'A'.repeat(43), addresses: [], caps: {}, status: 'online', self: true });
  repo.upsert({ id: 'dev_employer001', name: 'Boss', kind: 'pc', role: 'home', fingerprint: 'fboss', publicKey: 'C'.repeat(43), addresses: [], caps: {}, status: 'online', self: false, joinedAs: 'employee' });
  const before = events.length;
  const listed = await call('phone.pcs', undefined, PHONE);
  assert.deepEqual(listed.pcs, [{ deviceId: 'dev_self0000001', name: 'Desk', fingerprint: 'fself', publicKey: 'A'.repeat(43) }]);
  assert.equal(events.length, before, 'no phoneUse.attached: phone use stays unreachable');
  await rejects(call('phone.pcs', undefined, OWNER), 'forbidden');
  await rejects(call('phone.pcs', undefined, LAN), 'forbidden');
  await rejects(call('phone.pcs', { extra: 1 }, PHONE), 'bad_request');
});

test('phone.forget: the phone app removes its own row (Forget there), never another device\'s, never from plain LAN', async () => {
  const { call } = setup();
  const revoked: string[] = [];
  const table = new HandlerTable();
  registerPhoneUse(table);
  const db = memoryDb();
  new DevicesRepo(db).upsert({ id: 'dev_phone0000001', name: 'iPhone', kind: 'phone', role: 'client', fingerprint: 'fphone', publicKey: 'B'.repeat(43), addresses: [], caps: {}, status: 'online', self: false });
  const forget = (params: unknown, scope: ClientScope) => {
    const entry = table.get('phone.forget')!;
    if (!allowedScope(entry.scope, scope)) throw new WorkforceError('forbidden', 'Not allowed');
    const ctx = { scope, services: { db }, extras: { pwa: { revoke: async (id: string) => { revoked.push(id); } } }, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) } as unknown as HandlerContext;
    return Promise.resolve().then(() => entry.handler(params as never, ctx));
  };
  await rejects(forget(undefined, OWNER), 'forbidden');
  await rejects(forget(undefined, LAN), 'forbidden');
  await rejects(forget(undefined, { ...PHONE, deviceId: 'dev_other000001' }), 'forbidden');
  await rejects(forget({ deviceId: 'dev_other000001' }, PHONE), 'bad_request');
  assert.deepEqual(revoked, []);
  assert.deepEqual(await forget(undefined, PHONE), { ok: true });
  assert.deepEqual(revoked, ['dev_phone0000001'], 'exactly its own row');
  await rejects(call('phone.forget', undefined, OWNER), 'forbidden');
});

test('phoneUse.reply carries the sender; phoneUse.request reaches only the device it names', async () => {
  const { call, events } = setup();
  await call('phoneUse.reply', { id: 'pu_1', result: { ok: 1 } }, PHONE);
  assert.deepEqual(events.at(-1), { event: 'phoneUse.reply', data: { deviceId: 'dev_phone0000001', id: 'pu_1', result: { ok: 1 } } });
  await call('phoneUse.reply', { id: 'pu_2', error: { code: 'paused', message: 'The person paused phone use.' } }, PHONE);
  assert.deepEqual((events.at(-1)!.data as { error: unknown }).error, { code: 'paused', message: 'The person paused phone use.' });
  const request = { deviceId: 'dev_phone0000001', id: 'pu_3', op: 'type', args: { text: 'secret value' } };
  assert.equal(mayReceive(PHONE, 'system', 'phoneUse.request', request), true);
  assert.equal(mayReceive({ ...PHONE, deviceId: 'dev_other000001' }, 'system', 'phoneUse.request', request), false);
  assert.equal(mayReceive(OWNER, 'system', 'phoneUse.request', request), false, 'not even the owner\'s window');
  assert.equal(mayReceive(OWNER, 'system', 'phoneUse.reply', {}), false, 'bus only');
  assert.equal(mayReceive(PHONE, 'providers', 'account.upserted', {}), true, 'accounts on the secure phone');
  assert.equal(mayReceive(LAN, 'providers', 'account.upserted', {}), false);
});

test('phone.pairLink: the QR carries only the Remote ID; typed IDs and scanned links read the same', async () => {
  const { call } = setup();
  const link = await call('phone.pairLink', undefined, OWNER);
  // F17: this PC's own ID (from its key), not my person code – the phone's request comes to the PC showing the QR
  assert.notEqual(OWN_ID, '482913071');
  assert.equal(link.remoteId, OWN_ID);
  assert.equal(link.url, `https://openautark.com/pair/#${OWN_ID}`);
  assert.match(link.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal((await call('phone.pairLink', undefined, PHONE)).url, link.url, 'B-084: my phone shows the same QR for another phone');
  await rejects(call('phone.pairLink', undefined, LAN), 'forbidden');
  assert.equal(phonePairLink(`${OWN_ID.slice(0, 3)} ${OWN_ID.slice(3, 6)} ${OWN_ID.slice(6)}`), link.url);
  assert.equal(remoteIdOfPairText(link.url), OWN_ID);
  assert.equal(remoteIdOfPairText(' 482 913-071 '), '482913071');
  assert.equal(remoteIdOfPairText('https://metajarvis.teydralab.com/autark/pair#482913071'), '482913071', 'an older QR without the slash');
  assert.equal(remoteIdOfPairText('12345'), undefined);
});
