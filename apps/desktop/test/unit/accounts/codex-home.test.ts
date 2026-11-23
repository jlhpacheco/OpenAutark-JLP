// Every Codex account runs in a home of its own (accounts/cli-homes.ts, login-file.ts): a login found in the default home
// (~/.codex) is copied into <accounts>/codex/<id> – never the other way, and nothing in the default home is written; when
// the copy is signed out while the default home holds a newer login of the same person, the copy takes it again – never
// after the person signed out here.
// Owns: these assertions. Never touches a real home (temp folders only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeLogin } from '../../../src/runtime/accounts/login-file.ts';
import { harness } from './harness.ts';

const auth = (refresh: string, at: string, account = 'acct_A') => JSON.stringify({ tokens: { refresh_token: refresh, account_id: account }, last_refresh: at });

function folders() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-own-'));
  const user = path.join(root, 'user');
  const codex = path.join(user, '.codex');
  mkdirSync(codex, { recursive: true });
  return { root, user, codex, accounts: path.join(root, 'accounts'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('takeLogin: a newer refreshable login of the same person is copied; older, foreign, emptied or the same folder never; the source is only read', () => {
  const f = folders();
  try {
    const own = path.join(f.root, 'own');
    writeFileSync(path.join(f.codex, 'auth.json'), auth('r1', '2026-11-10T00:00:00Z'));
    writeFileSync(path.join(f.codex, 'config.toml'), 'notify = ["x"]\n');
    const before = statSync(path.join(f.codex, 'auth.json')).mtimeMs;
    assert.equal(takeLogin('codex', ['auth.json'], f.codex, own), true, 'no login there yet');
    assert.equal(readFileSync(path.join(own, 'auth.json'), 'utf8'), auth('r1', '2026-11-10T00:00:00Z'));
    assert.deepEqual(readdirSync(own), ['auth.json'], 'only the login file – no config.toml, AGENTS.md or skills');
    assert.equal(takeLogin('codex', ['auth.json'], f.codex, own), false, 'not newer');

    writeFileSync(path.join(own, 'auth.json'), auth('r2', '2026-11-12T00:00:00Z'));
    assert.equal(takeLogin('codex', ['auth.json'], f.codex, own), false, 'the copy here is newer');

    writeFileSync(path.join(f.codex, 'auth.json'), auth('r3', '2026-11-13T00:00:00Z', 'acct_B'));
    assert.equal(takeLogin('codex', ['auth.json'], f.codex, own), false, 'another person\'s login');

    writeFileSync(path.join(f.codex, 'auth.json'), JSON.stringify({ tokens: {} }));
    assert.equal(takeLogin('codex', ['auth.json'], f.codex, own), false, 'an emptied login');
    assert.equal(takeLogin('codex', ['auth.json'], own, own), false);
    assert.equal(takeLogin('codex', ['auth.json'], path.join(f.root, 'missing'), own), false);
    assert.ok(statSync(path.join(f.codex, 'auth.json')).mtimeMs >= before);
    assert.deepEqual(readdirSync(f.codex).sort(), ['auth.json', 'config.toml'], 'nothing is written into the default home');
  } finally {
    f.done();
  }
});

test('a Codex login found in the default home runs on a copy in a home of its own; the default home stays as it is', async () => {
  const f = folders();
  try {
    writeFileSync(path.join(f.codex, 'auth.json'), auth('r1', '2026-11-10T00:00:00Z'));
    const h = harness({ accounts: f.accounts, homeDir: f.user });
    await h.service.detect();
    await h.service.useFound('codex:default'); // 17.11.2026: found, then used after the person's "Use"
    await h.settle();
    const codex = h.service.list().find((account) => account.provider === 'codex')!;
    assert.equal(codex.home, path.join(f.accounts, 'codex', codex.id));
    assert.equal(codex.detected, true);
    assert.equal(readFileSync(path.join(codex.home!, 'auth.json'), 'utf8'), auth('r1', '2026-11-10T00:00:00Z'));
    assert.deepEqual(readdirSync(f.codex), ['auth.json']);
  } finally {
    f.done();
  }
});

test('a signed-out copy takes the default home\'s newer login before it counts as signed out – never after the person signed out here', async () => {
  const f = folders();
  try {
    writeFileSync(path.join(f.codex, 'auth.json'), auth('r1', '2026-11-10T00:00:00Z'));
    const h = harness({ accounts: f.accounts, homeDir: f.user });
    await h.service.detect();
    await h.service.useFound('codex:default'); // 17.11.2026: found, then used after the person's "Use"
    await h.settle();
    const codex = h.service.list().find((account) => account.provider === 'codex')!;

    // The person's own Codex refreshed: the copy here fails, the default home holds the newer login.
    writeFileSync(path.join(f.codex, 'auth.json'), auth('r2', '2026-11-12T00:00:00Z'));
    assert.equal(h.service.markUnavailable(codex.id, 'needs_login'), false, 'taken again, not signed out');
    assert.equal(h.service.markUnavailable(codex.id, 'needs_login'), false, 'a second turn of the same server failing at once is stale too');
    assert.equal(readFileSync(path.join(codex.home!, 'auth.json'), 'utf8'), auth('r2', '2026-11-12T00:00:00Z'));
    assert.equal(h.service.get(codex.id)!.state, 'ok');
    await h.settle();
    assert.equal(h.service.get(codex.id)!.state, 'ok', 'the queued check reads the newer login');

    // A check that finds the copy signed out takes the newer one and checks again.
    writeFileSync(path.join(f.codex, 'auth.json'), auth('r3', '2026-11-13T00:00:00Z'));
    h.answers.set(codex.id, { state: 'needs_login' });
    const checks = h.checks.length;
    await h.service.check(codex.id);
    await h.settle();
    assert.equal(h.checks.length, checks + 2, 'checked again after the newer login was taken');
    assert.equal(readFileSync(path.join(codex.home!, 'auth.json'), 'utf8'), auth('r3', '2026-11-13T00:00:00Z'));

    // Signed out here by the person: no login comes back from the default home.
    h.answers.delete(codex.id);
    await h.service.logout(codex.id);
    writeFileSync(path.join(f.codex, 'auth.json'), auth('r4', '2026-11-14T00:00:00Z'));
    h.answers.set(codex.id, { state: 'needs_login' });
    await h.service.check(codex.id);
    assert.equal(readFileSync(path.join(codex.home!, 'auth.json'), 'utf8'), auth('r3', '2026-11-13T00:00:00Z'), 'not taken');
  } finally {
    f.done();
  }
});
