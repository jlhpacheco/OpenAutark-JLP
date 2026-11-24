// 0.3.19 (task_0c6aet8h, claude/status.ts STATUS_REUSE_MS): the monitor reads every Claude plan each minute while any agent
// works, and each read started `auth status` and the probe – two cold starts of the CLI, the runtime's most frequent process
// starts on teydra-server. A background check now starts only the probe while the last `auth status` said signed in less
// than STATUS_REUSE_MS ago and the probe reads limits through that sign-in; anything else asks `auth status` as before.
// With real stand-in processes (fake-claude-login.mjs) and the real supervisor; time is a test clock.
// Owns: these assertions only. Never: a real Claude Code binary, a real home or sign-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { ClaudeStatus, STATUS_REUSE_MS } from '../../../src/runtime/engines/claude/status.ts';
import type { Executable } from '../../../src/runtime/accounts/executables.ts';
import { account } from './fakes.ts';

const FAKE = fileURLToPath(new URL('./fake-claude-login.mjs', import.meta.url));
const EXE: Executable = { command: process.execPath, prefixArgs: [FAKE], path: FAKE };

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-status-reuse-'));
  const supervisor = new Supervisor({ killTree: () => Promise.resolve() });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), FAKE_DIR: dir, FAKE_SAVE_MS: '50' };
  let now = Date.now();
  const status = new ClaudeStatus({ supervisor, tempDir: dir, env, now: () => now, timeoutMs: 30_000, graceMs: 30_000 });
  const acc = account({ id: 'acc_a', provider: 'claude', label: 'Claude', home: path.join(dir, 'home-a') });
  const file = path.join(dir, 'log.jsonl');
  const started = (kind: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; event: string }) : [])
    .filter((entry) => entry.kind === kind && entry.event === 'start').length;
  const signIn = (state: { loggedIn?: boolean; email?: string; limits?: boolean; plan?: string }) => writeFileSync(path.join(dir, 'sign-in.json'), JSON.stringify(state));
  const later = (ms: number) => { now += ms; };
  const check = (background: boolean) => status.check(EXE, acc, { background });
  const done = async () => { await supervisor.killAll(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* closing */ } };
  return { started, signIn, later, check, done };
}

test('a background check within STATUS_REUSE_MS of a signed-in auth status starts only the probe', async () => {
  const h = harness();
  try {
    h.signIn({ email: 'a@example.test', limits: true });
    const first = await h.check(true); // nothing known yet: auth status and the probe, as before
    assert.equal(first.state, 'ok');
    assert.deepEqual([h.started('status'), h.started('probe')], [1, 1]);
    for (let minute = 1; minute <= 9; minute++) {
      h.later(61_000); // the probe's own cache (one minute) has run out, as at the monitor's working cadence
      const next = await h.check(true);
      assert.equal(next.state, 'ok');
      assert.equal(next.email, 'a@example.test', 'the e-mail of the known sign-in');
      assert.equal(next.plan, 'max');
      assert.ok(next.limits?.windows.length, 'the limits of this minute');
    }
    assert.deepEqual([h.started('status'), h.started('probe')], [1, 10], 'ten readings, one auth status');
    h.later(STATUS_REUSE_MS); // the known status is too old: auth status again
    await h.check(true);
    assert.deepEqual([h.started('status'), h.started('probe')], [2, 11]);
  } finally { await h.done(); }
});

test('a check the person or a sign-in asks for (not background) always asks auth status', async () => {
  const h = harness();
  try {
    h.signIn({ email: 'a@example.test', limits: true });
    await h.check(true);
    h.later(61_000);
    await h.check(false);
    assert.equal(h.started('status'), 2);
  } finally { await h.done(); }
});

test('a probe without limits asks auth status, which tells the sign-out – the probe is not run twice', async () => {
  const h = harness();
  try {
    h.signIn({ email: 'a@example.test', limits: true });
    await h.check(true);
    h.signIn({ loggedIn: false });
    h.later(61_000);
    const out = await h.check(true);
    assert.equal(out.state, 'needs_login');
    assert.deepEqual([h.started('status'), h.started('probe')], [2, 2], 'one probe, then auth status – no second probe');
    h.signIn({ email: 'a@example.test', limits: true });
    h.later(61_000);
    await h.check(true); // nothing signed in is known any more: auth status first
    assert.equal(h.started('status'), 3);
  } finally { await h.done(); }
});

test('a probe that reads another plan, or none (Free), asks auth status – the switch shows at the next reading (Noah 24.11.)', async () => {
  const h = harness();
  try {
    h.signIn({ email: 'a@example.test', limits: true });
    await h.check(true);
    h.signIn({ email: 'a@example.test', limits: true, plan: 'pro' });
    h.later(61_000);
    const pro = await h.check(true);
    assert.equal(pro.plan, 'pro');
    assert.deepEqual([h.started('status'), h.started('probe')], [2, 2], 'another plan: auth status');
    h.later(61_000);
    await h.check(true); // the known sign-in is now Pro: only the probe
    assert.deepEqual([h.started('status'), h.started('probe')], [2, 3]);
    h.signIn({ email: 'a@example.test', limits: true, plan: 'free' });
    h.later(61_000);
    const free = await h.check(true);
    assert.equal(free.state, 'error', 'Free cannot run agents (B-051 L5), also found by a background reading');
    assert.deepEqual([h.started('status'), h.started('probe')], [3, 4]);
  } finally { await h.done(); }
});

test('a probe that reads another e-mail asks auth status (another login in the same home)', async () => {
  const h = harness();
  try {
    h.signIn({ email: 'a@example.test', limits: true });
    await h.check(true);
    h.signIn({ email: 'b@example.test', limits: true });
    h.later(61_000);
    const other = await h.check(true);
    assert.equal(other.email, 'b@example.test');
    assert.deepEqual([h.started('status'), h.started('probe')], [2, 2]);
  } finally { await h.done(); }
});
