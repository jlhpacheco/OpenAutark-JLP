// B-091: every sign-out becomes the work – the account check itself (background or not) that finds a working Codex or
// Claude Code plan ('ok' | 'cooling') signed out reports it to the attached relogin service like a turn would
// (failure.ts reportSignedOut). The person's own sign-out, a new or never-signed-in account, an API key, a switched-off
// account and a sign-out already known create nothing; without a relogin service nothing breaks.
// Owns: these assertions only. Never: a real CLI (account harness).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachRelogin } from '../../../src/runtime/accounts/failure.ts';
import { humanNotes } from '../../../src/runtime/accounts/relogin.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { harness, row } from './harness.ts';

const OUT = { state: 'needs_login' as const, message: 'Not logged in' };

function rig() {
  const h = harness();
  const reported: Account[] = [];
  const detach = attachRelogin(h.service, { signedOut: (account: Account) => { reported.push(account); } } as never);
  return { ...h, reported, detach };
}

test('a working plan the check finds signed out becomes the sign-in work, once', async () => {
  const h = rig();
  h.repo.save(row('acc_codex', { provider: 'codex', auth: 'cli', state: 'ok', detected: true }));
  h.repo.save(row('acc_claude', { provider: 'claude', auth: 'cli', state: 'cooling', coolingUntil: 10_000_000, detected: true }));
  h.answers.set('acc_codex', OUT);
  h.answers.set('acc_claude', OUT);
  assert.equal((await h.service.check('acc_codex', true)).state, 'needs_login', 'the monitor\'s background check');
  await h.service.check('acc_claude');
  assert.deepEqual(h.reported.map((account) => [account.id, account.state]), [['acc_codex', 'needs_login'], ['acc_claude', 'needs_login']]);
  await h.service.check('acc_codex', true);
  assert.equal(h.reported.length, 2, 'a sign-out already known: nothing new');
  await h.service.dispose();
});

test('nothing for the person\'s own sign-out, new or never-signed-in plans, API keys, switched-off accounts; no service → no error', async () => {
  const h = rig();
  h.repo.save(row('acc_mine', { provider: 'codex', auth: 'cli', state: 'ok', detected: true }));
  await h.service.logout('acc_mine');
  h.answers.set('acc_mine', OUT);
  await h.service.check('acc_mine');
  h.repo.save(row('acc_new', { provider: 'claude', auth: 'cli', state: 'unknown' }));
  h.repo.save(row('acc_never', { provider: 'claude', auth: 'cli', state: 'needs_login' }));
  h.repo.save(row('acc_key', { provider: 'openai', auth: 'api_key', state: 'ok' })); // no key in the vault → needs_login
  h.repo.save(row('acc_off', { provider: 'codex', auth: 'cli', state: 'ok', enabled: false }));
  for (const id of ['acc_new', 'acc_never', 'acc_off']) h.answers.set(id, OUT);
  for (const id of ['acc_new', 'acc_never', 'acc_key', 'acc_off']) await h.service.check(id);
  assert.equal(h.service.get('acc_key')!.state, 'needs_login');
  assert.deepEqual(h.reported, []);

  h.detach();
  h.repo.save(row('acc_lost', { provider: 'codex', auth: 'cli', state: 'ok', detected: true }));
  h.answers.set('acc_lost', OUT);
  assert.equal((await h.service.check('acc_lost')).state, 'needs_login', 'no relogin service: the state alone shows it');
  assert.deepEqual(h.reported, []);
  await h.service.dispose();
});

test('a check that meets the person\'s own sign-out while its CLI still runs creates nothing', async () => {
  const h = rig();
  h.repo.save(row('acc_mine', { provider: 'codex', auth: 'cli', state: 'ok', detected: true }));
  let done = false;
  const out = h.service.logout('acc_mine').then(() => { done = true; });
  h.answers.set('acc_mine', OUT); // the CLI already deleted the login
  await h.service.check('acc_mine', true);
  assert.equal(done, false, 'the check ended inside the sign-out');
  await out;
  assert.deepEqual(h.reported, []);
  await h.service.dispose();
});

test('the person\'s to-do says the phone works too', () => {
  const notes = humanNotes(row('acc_x', { provider: 'codex', auth: 'cli', label: 'Codex' }), 'no_account');
  assert.match(notes, /Sign in again in Settings › Models – from your phone too; it takes a minute\. This to-do closes itself once the account works again\.$/);
});

test('0.3.19: a runtime that is stopping (quit, update install) records no sign-out and reports none', async () => {
  const h = rig();
  h.repo.save(row('acc_claude', { provider: 'claude', auth: 'cli', state: 'ok', detected: true }));
  await h.service.dispose();
  assert.equal(h.service.markUnavailable('acc_claude', 'needs_login'), false);
  assert.equal(h.repo.get('acc_claude')!.state, 'ok');
  assert.deepEqual(h.reported, []);
});
