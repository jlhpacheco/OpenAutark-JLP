// 0.3.19, the persistent mark of a native session (engines/managed-path.ts, engines/managed-session.ts, migration 114): the
// restart simulation – a new engine instance (a restarted runtime: empty process memory) over the same database trusts a
// ref only when its mark is 'ready', from this PC, under a verified masker and CLI version, and the transcript is exactly
// as measured. Every other case is cold: a transcript that grew or changed, a pending mark, an unknown masker or CLI
// version, no mark, another PC's mark, a known path outside the Codex home, a deleted file, a late seal of an older write.
// Owns: these assertions only. Never: a real transcript or key – every file is a synthetic one in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagedPathStore, MASKER_VERSION, measure, verifiedCli } from '../../../src/runtime/engines/managed-path.ts';
import { ManagedSessions } from '../../../src/runtime/engines/managed-session.ts';
import { codexRollout } from '../../../src/runtime/engines/codex/rollout.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { VERIFIED_CODEX, codexHome, managedStore } from './managed-fixture.ts';

const account = { id: 'acc_test', provider: 'codex' } as Account;
const key = (ref: string, engine = 'codex') => ({ engine, account: account.id, ref });
type Row = { state: string; transcript: string | null; transcript_bytes: number | null; masker_version: number; cli_version: string | null; catalog_epoch: number; device_id: string };
const rowOf = (db: ReturnType<typeof managedStore>['db'], ref: string, engine = 'codex') => db.get<Row>('SELECT * FROM managed_paths WHERE engine = ? AND account_id = ? AND session_ref = ?', [engine, account.id, ref]);

/** One runtime's Codex trust over a shared store; a new call is a restarted runtime (a new engine object, empty memory). */
function runtime(store: ManagedPathStore, home: string) {
  return new ManagedSessions({ engine: { id: 'codex' }, store, locate: (_account, ref, known) => codexRollout(home, ref, known), settleMs: 10 });
}

test('migration 114: the mark table and the catalog epoch, raised by a new secret and a changed value only', () => {
  const { db } = managedStore();
  const epoch = () => db.get<{ n: number }>('SELECT n FROM catalog_epoch')!.n;
  assert.equal(epoch(), 0);
  db.run("INSERT INTO secrets (id, label, kind, cipher, created_at) VALUES ('sec_1', 'Fixture', 'password', ?, 1)", [Buffer.from('cipher-a')]);
  assert.equal(epoch(), 1, 'a new secret');
  db.run("UPDATE secrets SET label = 'Renamed' WHERE id = 'sec_1'");
  assert.equal(epoch(), 1, 'a new label is no new value');
  db.run("UPDATE secrets SET cipher = ? WHERE id = 'sec_1'", [Buffer.from('cipher-a')]);
  assert.equal(epoch(), 1, 'the same value written again');
  db.run("UPDATE secrets SET cipher = ? WHERE id = 'sec_1'", [Buffer.from('cipher-b')]);
  assert.equal(epoch(), 2, 'a changed value');
  const columns = db.all<{ name: string }>('PRAGMA table_info(managed_paths)').map((column) => column.name);
  assert.deepEqual(columns, ['engine', 'account_id', 'session_ref', 'device_id', 'state', 'masker_version', 'cli_version', 'transcript', 'transcript_bytes', 'tail_sha256', 'catalog_epoch', 'updated_at']);
});

test('the verified CLI versions: Claude Code from 2.1.303 (an allowlist of tools), Codex only as checked', () => {
  for (const cli of ['2.1.303', '2.1.304 (Claude Code)', '2.2.0', '3.0.0']) assert.equal(verifiedCli('claude', cli), true, cli);
  for (const cli of ['2.1.302', '2.0.999', '1.9.0', 'unknown', '', undefined, null]) assert.equal(verifiedCli('claude', cli), false, String(cli));
  assert.equal(verifiedCli('codex', VERIFIED_CODEX), true);
  for (const cli of ['0.171.0-alpha.13', '0.171.0']) assert.equal(verifiedCli('codex', cli), true, cli); // live control 45290886874
  for (const cli of ['0.167.0', '0.168.0', '0.167.0-alpha.3.3', '0.171.1', '0.171.0-alpha.14', '0.171.0-alpha.13.2', '0.172.0', '0.173.0-alpha.4', undefined]) assert.equal(verifiedCli('codex', cli), false, String(cli));
  assert.equal(verifiedCli('acp', '1.0.0'), false, 'another engine has no mark');
});

test('restart: a sealed mark is warm in a new runtime; a grown, a rewritten, a deleted transcript is cold', async () => {
  const home = codexHome(['thr_a', 'thr_b', 'thr_c']);
  const { db, store } = managedStore();
  try {
    const first = runtime(store, home.dir);
    for (const ref of ['thr_a', 'thr_b', 'thr_c']) { first.opened(account, ref); void first.sealed(account, ref, VERIFIED_CODEX); }
    await first.settled();
    const row = rowOf(db, 'thr_a')!;
    assert.deepEqual([row.state, row.transcript, row.transcript_bytes, row.masker_version, row.cli_version, row.device_id], ['ready', home.file('thr_a'), statSync(home.file('thr_a')).size, MASKER_VERSION, VERIFIED_CODEX, 'dev_self']);

    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_a'), true, 'warm after a restart');
    home.append('thr_a', '{"type":"response_item","payload":{"note":"written by someone else"}}');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_a'), false, 'grown since the seal');

    const text = readFileSync(home.file('thr_b'), 'utf8');
    writeFileSync(home.file('thr_b'), text.replace('session_meta', 'session_mexa'));
    assert.equal(statSync(home.file('thr_b')).size, rowOf(db, 'thr_b')!.transcript_bytes, 'same size');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_b'), false, 'same size, other tail');

    unlinkSync(home.file('thr_c'));
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_c'), false, 'no transcript');
  } finally { home.cleanup(); }
});

test('restart: pending, an unknown masker or CLI version, no mark, another PC\'s mark are cold', async () => {
  const home = codexHome(['thr_p', 'thr_m', 'thr_v', 'thr_d', 'thr_none']);
  const { db, store } = managedStore();
  try {
    const first = runtime(store, home.dir);
    first.opened(account, 'thr_p');
    assert.equal(rowOf(db, 'thr_p')!.state, 'pending');
    assert.equal(await first.trusted(account, 'thr_p'), true, 'the runtime that opened it trusts it while it runs');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_p'), false, 'a write that never ended (a crash mid-turn)');

    for (const ref of ['thr_m', 'thr_d']) { first.opened(account, ref); void first.sealed(account, ref, VERIFIED_CODEX); }
    first.opened(account, 'thr_v'); void first.sealed(account, 'thr_v', '0.168.0');
    await first.settled();
    db.run("UPDATE managed_paths SET masker_version = 99 WHERE session_ref = 'thr_m'");
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_m'), false, 'a masker version not on the verified list');
    assert.equal(rowOf(db, 'thr_v')!.state, 'ready');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_v'), false, 'a Codex version nobody checked the shell switches of');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_none'), false, 'a session this runtime never wrote');
    const other = new ManagedPathStore({ db, device: () => 'dev_other' });
    assert.equal(await runtime(other, home.dir).trusted(account, 'thr_d'), false, 'a restored copy of the database on another PC');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_d'), true, 'the same row on its own PC');
  } finally { home.cleanup(); }
});

test('the mark trusts only the transcript the engine resumes: a known path outside the Codex home or of another thread is cold', async () => {
  const home = codexHome(['thr_k']);
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'wf-elsewhere-'));
  const { db, store } = managedStore();
  try {
    const first = runtime(store, home.dir);
    first.opened(account, 'thr_k'); await first.sealed(account, 'thr_k', VERIFIED_CODEX);
    const outside = path.join(elsewhere, path.basename(home.file('thr_k')));
    writeFileSync(outside, readFileSync(home.file('thr_k')));
    db.run("UPDATE managed_paths SET transcript = ? WHERE session_ref = 'thr_k'", [outside]);
    assert.equal(await codexRollout(home.dir, 'thr_k', outside), undefined, 'a path outside the home is not taken');
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_k'), false);
    db.run("UPDATE managed_paths SET transcript = ? WHERE session_ref = 'thr_k'", [home.file('thr_k').replace('thr_k', 'thr_x')]);
    assert.equal(await runtime(store, home.dir).trusted(account, 'thr_k'), false, 'a path that bears another thread id');
    assert.equal(await codexRollout(home.dir, '../thr_k'), undefined, 'a thread id is never a path');
  } finally { home.cleanup(); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('a late seal of an older write is dropped: the session stays pending while a newer write runs', async () => {
  const home = codexHome(['thr_r']);
  const { db, store } = managedStore();
  try {
    const first = new ManagedSessions({ engine: { id: 'codex' }, store, locate: (_account, ref, known) => codexRollout(home.dir, ref, known), settleMs: 40 });
    first.opened(account, 'thr_r');
    const late = first.sealed(account, 'thr_r', VERIFIED_CODEX); // still measuring …
    first.opened(account, 'thr_r'); // … when the next turn of the session begins
    await late;
    assert.equal(rowOf(db, 'thr_r')!.state, 'pending');
    await first.sealed(account, 'thr_r', VERIFIED_CODEX);
    assert.equal(rowOf(db, 'thr_r')!.state, 'ready');
  } finally { home.cleanup(); }
});

test('forget removes the mark; old marks are pruned after 90 days; the catalog epoch is stored with each row', async () => {
  const home = codexHome(['thr_f', 'thr_old']);
  let now = 1_800_000_000_000;
  const { db, store } = managedStore('dev_self', () => now);
  try {
    db.run("INSERT INTO secrets (id, label, kind, cipher, created_at) VALUES ('sec_1', 'Fixture', 'password', ?, 1)", [Buffer.from('c')]);
    const first = runtime(store, home.dir);
    first.opened(account, 'thr_old'); await first.sealed(account, 'thr_old', VERIFIED_CODEX);
    now += 91 * 24 * 60 * 60 * 1000;
    first.opened(account, 'thr_f'); await first.sealed(account, 'thr_f', VERIFIED_CODEX);
    assert.equal(rowOf(db, 'thr_f')!.catalog_epoch, 1);
    first.forget(account, 'thr_f');
    assert.equal(rowOf(db, 'thr_f'), undefined);
    assert.equal(await first.trusted(account, 'thr_f'), false, 'neither memory nor mark');
    new ManagedPathStore({ db, now: () => now, device: () => 'dev_self' });
    assert.equal(rowOf(db, 'thr_old'), undefined, 'pruned');
  } finally { home.cleanup(); }
});

test('measure: the exact size and the tail hash; a missing file is undefined', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-measure-'));
  try {
    const file = path.join(dir, 'transcript.jsonl');
    writeFileSync(file, 'x'.repeat(70 * 1024));
    const first = await measure(file, 5);
    assert.equal(first?.bytes, 70 * 1024);
    writeFileSync(file, `y${'x'.repeat(70 * 1024 - 1)}`);
    assert.equal((await measure(file))?.tail, first?.tail, 'a change before the last 64 KiB keeps the tail …');
    assert.equal((await measure(file))?.bytes, first?.bytes, '… and the size: the mark is about appends, its seal is Autark\'s own write');
    assert.equal(await measure(path.join(dir, 'missing.jsonl')), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
