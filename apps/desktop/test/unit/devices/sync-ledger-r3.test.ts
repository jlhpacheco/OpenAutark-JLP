// Round 3 (review R1, Umzug 21.11.2026) of the record sync (devices/sync/ledger*.ts): a new writer's marks on rows the old
// writer wrote reach it, and an equal row is not written again (H2); a PC that missed rows of an agent before I ran it
// gets its whole record once I became its writer (H4); the person's Forget reaches my other PCs, at once or at their
// link-up (H5); a copied run takes its final status and is never my cut-off turn (M1); a branch that arrives during a
// turn drops the sessions after that turn (M2); a hidden appended row is restored from the PC that wrote it (M3); one
// agent's refusal never holds back another's rows (M6); a row the writer rejected stays on the loser (L1); a lost last
// answer of a branch gives one note, not two (L2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { restoreFetched } from '../../../src/runtime/context/ledger/restore.ts';
import { unfinishedRuns } from '../../../src/runtime/context/recent-actions.ts';
import { becameWriter } from '../../../src/runtime/devices/sync/ledger.ts';
import { forgetOnMyPcs } from '../../../src/runtime/devices/sync/ledger-forget.ts';
import { fingerprint } from '../../../src/runtime/privacy/mentions.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { agent } from '../chat/harness.ts';
import { link, Net, settle } from './sync-net.ts';
import { homeOf, items, journal, ledgerCalls, ledgerPc, MARA, record, row, THREAD, type LedgerPc } from './sync-ledger-rig.ts';

const TOM = 'ag_tom';
const changedOf = (pc: LedgerPc, itemId: string) => pc.h.db.get<{ changed: number }>('SELECT changed FROM context_items WHERE item_id = ?', [itemId])?.changed;
const withLedger = (pc: LedgerPc) => { pc.h.services.ledger = new ContextLedgerService({ services: () => pc.h.services }); return pc; };
const sessions = (pc: LedgerPc) => pc.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM engine_sessions WHERE agent_id = ?', [MARA])?.n;

test('H2: after a move the new writer\'s marks on rows the old writer wrote reach it; a row it holds as it is gets no write', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  const first = row(a, 'message', { ref: 'msg:msg_1' });
  const second = row(a, 'assistant');
  await a.ledger.catchUp('dev_b');
  const before = changedOf(a, second.item_id);
  for (const pc of [a, b]) homeOf(pc, 'dev_b');
  becameWriter(b.h.services, MARA);
  b.h.db.run(`UPDATE context_items SET state = 'hidden', marked_by = 'subconscious' WHERE item_id = ?`, [first.item_id]);
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.equal(record(a)[0].state, 'hidden', 'B\'s mark reached A');
  assert.equal(changedOf(a, second.item_id), before, 'the equal row was not written again (no echo)');
});

test('H4: a PC that skipped rows of an agent before I ran it gets its whole record once I became its writer', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  const c = ledgerPc(net, 'dev_c', 'dev_a');
  link(a, b);
  link(b, c); // C never reaches A
  row(a, 'message', { ref: 'msg:msg_1' });
  row(a, 'assistant');
  await a.ledger.catchUp('dev_b');
  assert.equal(await b.ledger.catchUp('dev_c'), true);
  assert.equal(record(c).length, 0, 'not B\'s agent then: B\'s cursor for C went past her rows');
  for (const pc of [a, b, c]) homeOf(pc, 'dev_b');
  becameWriter(b.h.services, MARA);
  assert.equal(await b.ledger.catchUp('dev_c'), true);
  assert.deepEqual(record(c).map((item) => [item.item_id, item.pc]), [['m1', 'dev_b'], ['a1', 'dev_b']], 'her whole record');
  const calls = ledgerCalls(net, 'rows').length;
  assert.equal(await b.ledger.catchUp('dev_c'), true);
  assert.equal(ledgerCalls(net, 'rows').length, calls, 'owed once');
});

test('H5: Forget pressed on one PC clears the record copies on my other PC – at once, or at its link-up', async () => {
  const net = new Net();
  const a = withLedger(ledgerPc(net, 'dev_a', 'dev_a'));
  const b = withLedger(ledgerPc(net, 'dev_b', 'dev_a'));
  link(a, b);
  row(a, 'assistant', { title: 'Invoice INV-4711 is paid' });
  row(a, 'assistant', { title: 'Lena moves to Hamburg on Friday' });
  row(a, 'assistant', { title: 'Nothing to forget here' });
  await a.ledger.catchUp('dev_b');
  forgetOnMyPcs(a.h.services, fingerprint(['Invoice INV-4711']));
  await settle();
  assert.equal(record(b)[0].title, '[forgotten]', 'at once on the online PC');
  net.up = false;
  forgetOnMyPcs(a.h.services, fingerprint(['Lena moves to Hamburg on Friday']));
  await settle();
  assert.equal(record(b)[1].title, 'Lena moves to Hamburg on Friday', 'B is offline');
  net.up = true;
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(record(b).map((item) => item.title), ['[forgotten]', '[forgotten]', 'Nothing to forget here'], 'owed until its link-up');
  assert.equal(a.h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM kv WHERE ns = 'sync.ledger.forget'`)?.n, 0, 'nothing kept once it went');
});

test('M1: a copied run takes its final status; a copy is never my cut-off turn', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  for (const id of ['run_1', 'run_2']) a.h.db.run(`INSERT INTO runs (id, agent_id, conversation_id, trigger, status, started_at) VALUES (?, ?, 'ch_1', 'message', 'running', 1)`, [id, MARA]);
  journal(a, 'run_1', 'ri_1');
  journal(a, 'run_2', 'ri_2');
  const one = row(a, 'tool', { ref: 'item:ri_1', runId: 'run_1' });
  row(a, 'tool', { ref: 'item:ri_2', runId: 'run_2' });
  await a.ledger.catchUp('dev_b');
  const status = (id: string) => b.h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', [id])?.status;
  assert.equal(status('run_1'), 'unknown');
  a.h.db.run(`UPDATE runs SET status = 'done', ended_at = 2 WHERE id = 'run_1'`);
  a.h.db.run(`UPDATE context_items SET state = 'condensed', condensed = 'short' WHERE item_id = ?`, [one.item_id]);
  await a.ledger.catchUp('dev_b');
  assert.equal(status('run_1'), 'done', 'the source\'s final status');
  assert.equal(status('run_2'), 'unknown');
  for (const pc of [a, b]) homeOf(pc, 'dev_b');
  b.h.services.runs = new Journal({ db: b.h.db, bus: b.h.bus, clock: b.h.clock });
  assert.deepEqual(unfinishedRuns(b.h.services, { agentId: MARA, conversationId: 'ch_1' }), [], 'run_2 is A\'s, not a cut-off turn of mine');
});

test('M2: a branch that arrives while a turn of the agent runs drops its sessions after that turn, not before', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  row(a, 'message', { ref: 'msg:msg_a' });
  row(b, 'assistant', { title: 'B alone' });
  a.h.db.run(`INSERT INTO runs (id, agent_id, trigger, status, started_at) VALUES ('run_now', ?, 'message', 'running', 1)`, [MARA]);
  a.h.db.run(`INSERT INTO engine_sessions (agent_id, conversation_id, engine, session_ref, updated_at) VALUES (?, 'main', 'codex', 'th_1', 0)`, [MARA]);
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.equal(a.notes.length, 1, 'the branch is in');
  assert.equal(sessions(a), 1, 'the running turn keeps its session');
  a.h.db.run(`UPDATE runs SET status = 'done' WHERE id = 'run_now'`);
  a.h.bus.emit('run.upserted', { id: 'run_now', agentId: MARA, trigger: 'message', status: 'done' } as never);
  assert.equal(sessions(a), 0, 'dropped once it ended');
});

test('M3: a hidden appended row names the PC that wrote it; a restore brings its original from there', async () => {
  const net = new Net();
  const a = withLedger(ledgerPc(net, 'dev_a', 'dev_a'));
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  row(a, 'message', { ref: 'msg:msg_a' });
  journal(b, 'run_old', 'ri_old', 25);
  row(b, 'tool', { ref: 'item:ri_old', runId: 'run_old', state: 'hidden', title: 'old call', at: Date.UTC(2026, 9, 1) });
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  const appended = record(a).find((item) => item.title === 'old call')!;
  assert.deepEqual([appended.state, appended.pc], ['hidden', 'dev_b']);
  assert.ok(items(b).includes('ri_old'), 'the loser keeps the run item');
  const result = await restoreFetched(a.h.services, MARA, THREAD, { ids: [appended.item_id] });
  assert.match(result, new RegExp(`^Restored ${appended.item_id}`));
  assert.match(result, /x{25}/);
});

test('M6: one agent\'s refused rows wait; another agent\'s rows go on and arrive', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_b'); // B thinks Mara runs on B
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent(TOM, 'Tom', { deviceId: 'dev_a' }));
  row(b, 'message', { ref: 'msg:msg_b', title: 'B 1' });
  row(a, 'message', { ref: 'msg:msg_a', title: 'A 1' });
  row(a, 'assistant', { title: 'Tom 1', agentId: TOM });
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(record(b, THREAD, TOM).map((item) => item.title), ['Tom 1'], 'Tom\'s rows went');
  assert.deepEqual(record(b).map((item) => item.title), ['B 1'], 'Mara\'s waited');
  homeOf(b, 'dev_a'); // B learns from the agents row
  row(a, 'assistant', { title: 'Tom 2', agentId: TOM });
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(record(b, THREAD, TOM).map((item) => item.title), ['Tom 1', 'Tom 2']);
  assert.equal(await a.ledger.catchUp('dev_b'), true); // the appended branch goes with the next push
  assert.deepEqual(record(b).map((item) => item.title), ['A 1', 'B 1'], 'Mara\'s came, with B\'s own work as a branch on A');
  assert.deepEqual(record(a).map((item) => item.title), ['A 1', 'B 1']);
});

test('L1 + L2: a row the writer rejects stays on the loser; a lost last answer gives one note, not two', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  row(a, 'message', { ref: 'msg:msg_a' });
  for (let index = 0; index < 120; index++) {
    journal(b, `run_${index}`, `ri_${index}`, 40_000);
    row(b, 'tool', { ref: `item:ri_${index}`, runId: `run_${index}` });
  }
  b.h.db.run(`INSERT INTO context_items (agent_id, conversation_id, item_id, kind, "order", created_at, title) VALUES (?, 'main', 'z9', 'diagram', 500, 1, 'from a newer version')`, [MARA]);
  const handler = a.handlers.get('sync.ledger')!;
  let lost = false;
  a.handlers.set('sync.ledger', async (params, from) => {
    const answer = await handler(params, from);
    if (!lost && (params as { op?: string; last?: boolean }).op === 'branch' && (params as { last?: boolean }).last) { lost = true; throw new Error('answer lost'); }
    return answer;
  });
  await b.ledger.catchUp('dev_a');
  assert.ok(ledgerCalls(net, 'branch').length >= 3, 'a branch of several pages');
  assert.equal(a.notes.length, 1, 'noted at the last page');
  await b.ledger.catchUp('dev_a');
  assert.equal(a.notes.length, 1, 'the resent last page is no second branch');
  assert.match(a.notes[0].text, /: 120 items, /);
  assert.equal(record(a).length, 121);
  assert.deepEqual(record(b).map((item) => item.item_id), ['z9'], 'the rejected row stays; the taken ones went');
});
