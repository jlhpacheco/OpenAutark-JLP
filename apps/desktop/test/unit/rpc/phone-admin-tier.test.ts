// B-084 (D6) "Settings on the phone = the PC's": the device administration methods (remote.*, remote.relay, devices.*,
// phone.pairLink, people.invite/closeInvite, voice.pullLocal) are open to the owner's phone on a secure transport
// ('settings' + secure: its app tunnel, HTTPS or the tailnet) and to nobody else – a plain LAN browser gets 'insecure',
// a person of the organisation and a device without 'settings' get 'scope'; the UI's note on LAN says HTTPS; the device
// events reach only a secure 'settings' device; an invite opened on the phone is the same person-scoped invite as on the PC.
// Owns: these assertions only. Never: the DOM, the transport or the people service itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { allowedScope, scopeDenial, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { mayReceive, maySubscribe } from '../../../src/runtime/rpc/scopes.ts';
import { FULL_ACCESS } from '../../../src/runtime/pwa/tokens.ts';
import type { MethodName } from '../../../src/shared/api/methods.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { HTTPS_NOTE, PC_NOTE, blockedNote, can, session } from '../../../src/ui/lib/session.ts';
import { ANDROID_APP_NOTIFY, pushHint } from '../../../src/ui/settings/connect-text.ts';

const ADMIN = ['remote.state', 'remote.decide', 'remote.connect', 'remote.nearby', 'remote.cancel', 'remote.relay',
  'devices.list', 'devices.rename', 'devices.revoke', 'phone.pairLink', 'people.invite', 'people.closeInvite', 'voice.pullLocal'] as const;
const EVENTS = ['remote.updated', 'relay.updated', 'device.upserted', 'device.removed'] as const;

const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone0000001', capabilities: [...FULL_ACCESS], secure: true };
const LAN: ClientScope = { ...PHONE, secure: false };
const NO_SETTINGS: ClientScope = { ...PHONE, capabilities: FULL_ACCESS.filter((capability) => capability !== 'settings') };
const PERSON = { kind: 'person', personId: 'per_anna000000', deviceId: 'dev_anna00000001', tokenId: 'tok_1' } as unknown as ClientScope;

const table = createHandlerTable();

test('the device administration methods: settings on a secure transport, like accounts.*', () => {
  for (const method of ADMIN) {
    const rule = table.get(method)!.scope;
    // F13: people.invite/closeInvite also have a CEO person variant – the owner's rule is its base, its HTTPS ceiling holds for a CEO too.
    const ceoVariant = typeof rule === 'object' && 'person' in rule;
    assert.deepEqual(ceoVariant ? rule.base : rule, { capability: 'settings', secure: true }, method);
    if (ceoVariant) {
      assert.equal(scopeDenial(rule, { ...PERSON, role: 'ceo', secure: false } as ClientScope), 'insecure', `${method}: a CEO never over plain LAN http`);
      assert.equal(scopeDenial(rule, { ...PERSON, role: 'ceo', secure: true } as ClientScope), undefined, `${method}: a CEO on HTTPS`);
    }
    assert.ok(allowedScope(rule, { kind: 'owner' }), `${method}: the owner`);
    assert.ok(allowedScope(rule, PHONE), `${method}: my phone on its tunnel`);
    assert.equal(scopeDenial(rule, LAN), 'insecure', `${method}: never over plain LAN http`);
    assert.equal(scopeDenial(rule, PERSON), 'scope', `${method}: never a person of the organisation`);
    assert.equal(scopeDenial(rule, NO_SETTINGS), 'scope', `${method}: needs settings`);
  }
  assert.equal(table.get('pwa.enable')!.scope, 'owner', 'phone access itself stays on the PC');
});

test('session.info and the UI gates: the phone sees the rows, a LAN browser the HTTPS note', () => {
  try {
    session.value = sessionInfo(table, PHONE);
    for (const method of ADMIN) assert.ok(can(method as MethodName), method);
    session.value = sessionInfo(table, LAN);
    for (const method of ADMIN) {
      assert.equal(can(method as MethodName), false, method);
      assert.equal(blockedNote(method as MethodName), HTTPS_NOTE, method);
    }
    session.value = sessionInfo(table, NO_SETTINGS);
    assert.equal(blockedNote('remote.state'), PC_NOTE);
  } finally {
    session.value = null;
  }
});

test('the device events reach only a secure settings device (and the owner)', () => {
  for (const event of EVENTS) {
    assert.ok(maySubscribe(PHONE, 'system'));
    assert.ok(mayReceive(PHONE, 'system', event), event);
    assert.ok(mayReceive({ kind: 'owner' }, 'system', event), event);
    assert.ok(!mayReceive(LAN, 'system', event), `${event}: LAN`);
    assert.ok(!mayReceive(NO_SETTINGS, 'system', event), `${event}: no settings`);
    assert.ok(!mayReceive({ ...PHONE, secure: undefined } as unknown as ClientScope, 'system', event), `${event}: no secure flag fails closed`);
  }
  assert.ok(!mayReceive(PHONE, 'system', 'pwa.updated'), 'phone access state stays with the owner');
});

test('the Notifications row inside the Android app says the app shows them, whatever the web push status', () => {
  for (const status of ['unsupported', 'off', undefined] as const) assert.equal(pushHint(status, { person: false, chat: true, androidApp: true }), ANDROID_APP_NOTIFY);
  assert.match(pushHint('unsupported', { person: false, chat: true }) ?? '', /cannot show notifications/, 'a plain browser keeps its line');
});

test('people.invite from my phone is the same person-scoped invite as on the PC', async () => {
  const calls: Array<{ op: string; id: string }> = [];
  const invite = { personId: 'per_anna000000', url: 'https://pc.example/#join=t1', qrDataUrl: 'data:image/png;base64,AA', code: '123456', codeExpiresAt: 1, expiresAt: 2, reachable: true };
  const people = {
    get: () => ({ id: 'per_anna000000' }),
    invite: async (id: string) => { calls.push({ op: 'invite', id }); return invite; },
    closeInvite: (id: string) => { calls.push({ op: 'close', id }); },
  };
  const run = async (method: 'people.invite' | 'people.closeInvite', scope: ClientScope) => {
    const entry = table.get(method)!;
    if (!allowedScope(entry.scope, scope)) throw new Error('forbidden');
    const ctx = { scope, services: { people }, extras: {}, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) } as unknown as HandlerContext;
    return entry.handler({ id: 'per_anna000000' } as never, ctx);
  };
  const fromPc = await run('people.invite', { kind: 'owner', person: true });
  const fromPhone = await run('people.invite', PHONE);
  assert.deepEqual(fromPhone, fromPc, 'the handler does not depend on the caller');
  assert.deepEqual(await run('people.closeInvite', PHONE), { ok: true });
  assert.deepEqual(calls, [{ op: 'invite', id: 'per_anna000000' }, { op: 'invite', id: 'per_anna000000' }, { op: 'close', id: 'per_anna000000' }]);
  await assert.rejects(run('people.invite', LAN), /forbidden/);
  await assert.rejects(run('people.invite', PERSON), /forbidden/);
});
