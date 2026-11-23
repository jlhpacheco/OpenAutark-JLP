// Owns: real SQLite mail-origin persistence and identity isolation. Never: network or live accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { MailWaker, mailOrigin } from '../../../src/runtime/apps/mail-wake.ts';
import type { Connector } from '../../../src/runtime/apps/types.ts';
import type { MailWakeDeps } from '../../../src/runtime/apps/mail-wake.ts';

const connector = { id: 'office', name: 'Office', transport: 'mail', mail: { address: 'test@example.invalid', agent: 'ag_a' } } as Connector;
const clock = new ManualClock(100_000);
function open(path = ':memory:') {
  const db = new Db(path); migrate(db);
  return { db, wakes: new WakeQueueImpl({ db, clock }) };
}
function waker(wakes: WakeQueueImpl) {
  return new MailWaker({ connected: () => connector,
    services: { wakes, clock, org: { list: () => [{ id: 'ag_a', name: 'Tester' }] } } } as unknown as MailWakeDeps);
}
test('debounced notice survives a real close/reopen with UID identity and no execution scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-origin-')); const path = join(dir, 'queue.db');
  let db: Db | undefined;
  try {
    let state = open(path); db = state.db;
    const source = waker(state.wakes);
    source.notice('office', { count: 1, messageIds: ['INBOX/12/7'] });
    state.wakes.done(state.wakes.claim('ag_a').map(w => w.id));
    source.notice('office', { count: 1, messageIds: ['INBOX/12/8'] });
    source.close();
    assert.equal(state.wakes.list('ag_a')[0].dueAt, 160_000);
    db.close(); db = undefined;
    state = open(path); db = state.db;
    const [stored] = state.wakes.list('ag_a');
    assert.deepEqual(stored.origin?.mailProvenance, { appId: 'office', messageIds: ['INBOX/12/8'] });
    assert.equal(stored.origin?.mailScope, undefined);
    assert.equal(state.wakes.claim('ag_a').length, 0);
    const [claimed] = state.wakes.claim('ag_a', 160_000);
    state.wakes.release([claimed.id], 170_000);
    assert.deepEqual(state.wakes.list('ag_a')[0].origin, stored.origin);
    state.wakes.claim('ag_a', 170_000);
    assert.equal(state.wakes.reconcile(), 1);
    assert.deepEqual(state.wakes.list('ag_a')[0].origin, stored.origin);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('same explicit key cannot mix privileges, UIDVALIDITY or missing identities', () => {
  const { db, wakes } = open();
  try {
    for (const id of ['INBOX/12/7', 'INBOX/13/7', 'INBOX/12/8', '']) {
      wakes.wake({ agentId: 'ag_a', reason: 'event', coalesceKey: 'same', origin: mailOrigin(connector, id ? [id] : []) });
    }
    wakes.wake({ agentId: 'ag_a', reason: 'manual', coalesceKey: 'same' });
    wakes.wake({ agentId: 'ag_a', reason: 'event', coalesceKey: 'same', origin: mailOrigin(connector, ['INBOX/12/7']) });
    assert.equal(wakes.pending(), 5);
    const claimed = wakes.claim('ag_a');
    for (const w of claimed) wakes.release([w.id]);
    assert.equal(wakes.pending(), 5);
  } finally { db.close(); }
});
test('legacy or corrupt mail origins retain an untrusted marker, never a scope', () => {
  const { db, wakes } = open();
  try {
    wakes.wake({ agentId: 'ag_a', reason: 'event', origin: { source: 'app:office', label: 'New mail in test@example.invalid' } });
    let [w] = wakes.list('ag_a');
    assert.deepEqual(w.origin?.mailProvenance, { appId: 'office', messageIds: [] });
    db.run('UPDATE wakes SET mail_origin = ?', ['not json']);
    [w] = wakes.claim('ag_a');
    assert.equal(w.origin?.mailProvenance?.messageIds.length, 0);
    assert.equal(w.origin?.mailScope, undefined);
    wakes.release([w.id]);
    assert.equal(wakes.list('ag_a')[0].origin?.mailProvenance?.messageIds.length, 0);
  } finally { db.close(); }
});
test('malformed runtime refs lose authority rather than acquiring a partial identity set', () => {
  assert.deepEqual(mailOrigin(connector, ['INBOX/12/7', 'INBOX/0/9']).mailProvenance?.messageIds, []);
  assert.equal(mailOrigin(connector).mailScope, undefined);
});
