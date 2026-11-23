// One login, one plan (21.11.2026, accounts/twins.ts + service.ts): two plan rows of one provider and one e-mail whose homes
// name no different logins merge into one on this PC – the shared row before one kept on this PC, then the older, on the
// home with the newest login; the twin's removal carries `twinOf`, so the row sync sends no removal to the linked PCs.
// Two workspaces of one e-mail, other providers and API keys stay apart. Fake homes in a temp folder, no real CLI or login.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Account } from '../../../src/shared/model/providers.ts';
import { twinMerges, type HomeLogin } from '../../../src/runtime/accounts/twins.ts';
import { harness, row } from './harness.ts';

const plan = (id: string, patch: Partial<Account> = {}): Account => row(id, { provider: 'codex', auth: 'cli', email: 'social@example.com', home: `/h/${id}`, ...patch });

test('twins: same provider and e-mail (any case) are one login – the shared, older row stays on the home with the newest login', () => {
  const held = new Map<string, HomeLogin>([['old', { at: 10 }], ['new', { at: 20 }], ['kept', { at: 30 }]]);
  const read = (account: Account) => held.get(account.id) ?? { at: 0 };
  const old = plan('old', { createdAt: 1 });
  const fresh = plan('new', { createdAt: 2, email: 'Social@Example.com' });
  const merges = twinMerges([fresh, old, plan('claude', { provider: 'claude' }), plan('key', { auth: 'api_key' })], read);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].keep.id, 'old', 'the older row stays');
  assert.deepEqual(merges[0].drop.map((a) => a.id), ['new']);
  assert.equal(merges[0].home, '/h/new', 'it runs on the home with the newest login');

  const onlyHere = plan('kept', { createdAt: 0, thisPcOnly: true });
  assert.equal(twinMerges([onlyHere, old], read)[0].keep.id, 'old', 'a shared row before one kept on this PC, also when that one is older');
  assert.equal(twinMerges([onlyHere, old], read)[0].home, '/h/kept');
});

test('twins: two workspaces of one e-mail, or one plan alone, are no twins', () => {
  const who = (account: Account): HomeLogin => ({ who: account.id === 'a' ? 'ws-1' : 'ws-2', at: 1 });
  assert.deepEqual(twinMerges([plan('a'), plan('b')], who), []);
  assert.deepEqual(twinMerges([plan('a'), plan('b', { email: 'other@example.com' })], () => ({ at: 1 })), []);
  assert.equal(twinMerges([plan('a'), plan('b')], (account) => (account.id === 'a' ? { who: 'ws-1', at: 1 } : { at: 1 })).length, 1, 'a home that does not say whose: one login');
});

test('the service merges twins when an account changes: one row stays, the twin goes on this PC only (twinOf)', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'twins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logins = path.join(root, 'logins');
  const h = harness({ accounts: logins, homeDir: path.join(root, 'user') });
  const home = (id: string, expiresAt: number) => {
    const dir = path.join(logins, 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: `r-${id}`, expiresAt, scopes: [], subscriptionType: 'max' } }));
    return dir;
  };
  const synced = row('acc_w', { provider: 'claude', auth: 'cli', email: 'social@example.com', home: home('acc_w', 1_000), createdAt: 1 });
  const signedInHere = row('acc_l', { provider: 'claude', auth: 'cli', email: 'social@example.com', home: home('acc_l', 2_000), createdAt: 5 });
  h.repo.save(synced);
  h.repo.save(signedInHere);
  const removed: unknown[] = [];
  h.bus.on('account.removed', (event) => removed.push(event));
  h.bus.emit('account.upserted', signedInHere);
  assert.deepEqual(h.service.list().filter((a) => a.provider === 'claude').map((a) => a.id), ['acc_w'], 'one plan for the login');
  assert.equal(h.service.get('acc_w')?.home, signedInHere.home, 'it runs on the home with the newer login');
  assert.deepEqual(removed, [{ id: 'acc_l', twinOf: 'acc_w' }], 'the twin goes here only');
});
