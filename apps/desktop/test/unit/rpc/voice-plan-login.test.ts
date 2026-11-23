// STIMME 21.11.2026 (+ review): voice.planLogin (runtime/rpc/handlers/voice-plan.ts) hands the ChatGPT plan login only
// to the person's own paired Android phone, proven by its device key: the native link's signature of
// "autark-plan-login\n<deviceId>\n<at>" against the key of that device's phone record. Refused: the page's bearer token
// (same device token, no key), a desktop browser or iPhone web app device (no phone record with a key), a wrong key, an
// old or replayed `at`, an owner session (the window, an agent's wf), an employee, plain http. Only while dictation here
// goes to the plan (routing.stt auto/codex), with the language hint this PC would send; `fresh` asks Codex to refresh.
// The signature vector is the one apps/android test/phoneuse/PlanHearingTest.java signs with the same seed.
// Owns: these assertions. Never: a real login, Codex server, network or device key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROOF_WINDOW_MS, planProofText, register } from '../../../src/runtime/rpc/handlers/voice-plan.ts';
import { HandlerTable, scopeDenial, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { ResultOf } from '../../../src/shared/api/methods.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const table = new HandlerTable();
register(table);
const entry = table.get('voice.planLogin')!;
const NOW = 1_800_000_000_000;
const phone: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'], secure: true };
/** A test key (seed 32 × 7, no real device): its public key, and the signature PlanHearingTest.java computes too. */
const SEED = Buffer.alloc(32, 7);
const PUBLIC = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw';
const VECTOR = 'NHAmZpVGM9Iux17oMpmZVQhS8b6IzPZsrkIYi8qbOabNoAil2qgYaAbPepQM0xaOvJWGZBdlI9nJEHsyUQcjAg';
const keyOf = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const proofOf = (deviceId: string, at: number, seed = SEED) => sign(null, Buffer.from(planProofText(deviceId, at), 'utf8'), keyOf(seed)).toString('base64url');

/** Device rows by id: the paired phone with its key; a browser device without one. */
const ROWS: Record<string, object> = {
  dev_phone: { id: 'dev_phone', name: 'S23', kind: 'phone', role: 'client', fingerprint: 'f', public_key: PUBLIC, addresses: '[]', caps: '{}', status: 'online', self: 0, paired_at: 1, last_seen_at: 1, revoked_at: null },
  dev_browser: { id: 'dev_browser', name: 'iPhone', kind: 'phone', role: 'client', fingerprint: 'g', public_key: null, addresses: '[]', caps: '{}', status: 'online', self: 0, paired_at: 1, last_seen_at: 1, revoked_at: null },
};

let clock = NOW;
function rig(options: { stt?: string; signedIn?: boolean } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'plan-login-'));
  writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok-test', account_id: 'acct-test' } }));
  const refreshes: unknown[] = [];
  const logs: Array<{ msg: string; data: unknown }> = [];
  const account = { id: 'acc_c', provider: 'codex', auth: 'cli', plan: 'plus', home, state: 'ok', priority: 0, enabled: true };
  const services = {
    clock: { now: () => clock },
    db: { get: (_sql: string, params: unknown[]) => ROWS[String(params[0])] },
    log: { info: (msg: string, data: unknown) => logs.push({ msg, data }), debug: () => undefined, warn: () => undefined, error: () => undefined },
    settings: { get: () => ({ routing: options.stt ? { stt: options.stt } : {} }) },
    accounts: { list: () => (options.signedIn === false ? [] : [account]) },
    engines: { get: () => ({ realtime: async () => ({ hold: () => () => undefined, request: async (_m: string, params: unknown) => { refreshes.push(params); return {}; } }) }) },
  } as unknown as RuntimeServices;
  const call = async (params: Record<string, unknown>, scope: ClientScope = phone, secure = true) => await entry.handler(params as never, {
    scope, secure, services, extras: {} as HandlerContext['extras'], topics: new Set(), signal: new AbortController().signal,
  }) as ResultOf<'voice.planLogin'>;
  /** A call as the native link makes it: a fresh `at`, signed by the device key. */
  const proven = (params: Record<string, unknown> = {}, deviceId = 'dev_phone', seed = SEED) => { const at = ++clock; return { ...params, at, proof: proofOf(deviceId, at, seed) }; };
  return { call, proven, refreshes, logs, done: () => rmSync(home, { recursive: true, force: true }) };
}
const refused = (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden';

test('the signature both sides compute: the shared vector', () => {
  assert.equal(proofOf('dev_phone', NOW), VECTOR);
  assert.equal(planProofText('dev_phone', NOW), 'autark-plan-login\ndev_phone\n1800000000000');
});

test('my Android phone, proven by its device key, gets the login, its expiry and the language hint; nothing of it is logged', async () => {
  const before = process.env.AUTARK_SYSTEM_LANGUAGE;
  process.env.AUTARK_SYSTEM_LANGUAGE = 'de-DE';
  const t = rig();
  try {
    const login = await t.call(t.proven({ language: 'de' }));
    assert.equal(login.token, 'tok-test');
    assert.equal(login.accountId, 'acct-test');
    assert.equal(login.expiresAt, clock + 10 * 60_000, 'a token without exp: ten minutes');
    assert.equal(login.language, 'de');
    assert.equal((await t.call(t.proven({ language: 'en-US' }))).language, undefined, 'English on a German PC: the endpoint detects it, as transcribe.ts');
    assert.deepEqual(t.refreshes, []);
    assert.doesNotMatch(JSON.stringify(t.logs), /tok-test|acct-test/);
    await t.call(t.proven({ fresh: true }));
    assert.deepEqual(t.refreshes, [{ refreshToken: true }], 'fresh: Codex refreshes first');
  } finally {
    t.done();
    if (before === undefined) delete process.env.AUTARK_SYSTEM_LANGUAGE; else process.env.AUTARK_SYSTEM_LANGUAGE = before;
  }
});

test('the page\'s bearer token, a browser or iPhone device, another key, an old or replayed proof: refused', async () => {
  const t = rig();
  try {
    await assert.rejects(t.call({ at: ++clock, proof: 'x'.repeat(86) }), refused, 'the page: same device token, no key');
    await assert.rejects(t.call(t.proven({}, 'dev_phone', Buffer.alloc(32, 9))), refused, 'another key');
    await assert.rejects(t.call(t.proven({}, 'dev_browser'), { ...phone, deviceId: 'dev_browser' }), refused, 'a device without a phone key (browser, iPhone web app)');
    const once = t.proven();
    await t.call(once);
    await assert.rejects(t.call(once), refused, 'a proof counts once');
    const old = clock - PROOF_WINDOW_MS - 1;
    await assert.rejects(t.call({ at: old, proof: proofOf('dev_phone', old) }), refused, 'outside the window');
    await assert.rejects(t.call(t.proven(), { kind: 'owner', person: true }), refused, 'the window');
    await assert.rejects(t.call(t.proven(), { kind: 'owner', agentId: 'agent_1' }), refused, 'an agent\'s wf');
    await assert.rejects(t.call(t.proven(), { ...phone, secure: false }, false), refused, 'plain http');
    await assert.rejects(t.call(t.proven(), { ...phone, capabilities: ['todo'] }), refused, 'a to-do-only token');
    await assert.rejects(t.call({}), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request', 'no proof at all');
  } finally { t.done(); }
  assert.equal(scopeDenial(entry.scope, phone), undefined);
  assert.notEqual(scopeDenial(entry.scope, { kind: 'person', personId: 'p', deviceId: 'd', tokenId: 't', role: 'ceo', secure: true }), undefined, 'an employee never');
  assert.notEqual(scopeDenial(entry.scope, { kind: 'external', memberId: 'm', conversationId: 'c', tokenId: 't' }), undefined);
});

test('dictation here goes to another choice, or no plan login: the phone keeps the PC\'s way (unavailable)', async () => {
  const local = rig({ stt: 'local' });
  try { await assert.rejects(local.call(local.proven()), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable'); } finally { local.done(); }
  const none = rig({ signedIn: false });
  try { await assert.rejects(none.call(none.proven()), /No ChatGPT plan login/); } finally { none.done(); }
  const bad = rig();
  try {
    const badRequest = (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request';
    await assert.rejects(bad.call(bad.proven({ language: 'de; DROP' })), badRequest);
    await assert.rejects(bad.call(bad.proven({ fresh: 'yes' })), badRequest);
    await assert.rejects(bad.call(bad.proven({ token: 'x' })), badRequest);
  } finally { bad.done(); }
});
