// Two records of one agent that drifted apart (devices/sync/ledger-branch.ts): both PCs went on with Mara while they
// could not reach each other, the agents row names A as her PC. B's own rows go to A as a branch – whether B pushes
// first or A's rows reach B first – and A appends them after its own last row with fresh ids, tells her once and drops
// her native sessions; B's copies are replaced by A's mirror. An agent with no rows at all on the writer takes the
// other PC's rows as they are (a PC that ran her before this version).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, Net } from './sync-net.ts';
import { homeOf, items, journal, ledgerCalls, ledgerPc, MARA, record, row, type LedgerPc } from './sync-ledger-rig.ts';

const ids = (pc: LedgerPc) => record(pc).map((item) => item.item_id);
const titles = (pc: LedgerPc) => record(pc).map((item) => item.title);

/** A and B share Mara's first two rows, then each writes two more while the link is down (B as her PC meanwhile). */
async function split() {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  row(a, 'message', { ref: 'msg:msg_1', title: 'shared 1' });
  row(a, 'assistant', { title: 'shared 2' });
  await a.ledger.catchUp('dev_b');
  net.up = false;
  homeOf(b, 'dev_b'); // B took her over
  journal(b, 'run_b', 'ri_b');
  row(b, 'tool', { ref: 'item:ri_b', runId: 'run_b', title: 'B 1' });
  row(b, 'assistant', { title: 'B 2' });
  row(a, 'reasoning', { title: 'A 1' });
  row(a, 'assistant', { title: 'A 2' });
  a.h.db.run(`INSERT INTO engine_sessions (agent_id, conversation_id, engine, session_ref, updated_at) VALUES (?, 'main', 'codex', 'th_1', 0)`, [MARA]);
  homeOf(b, 'dev_a'); // the agents row decided: A
  net.up = true;
  return { net, a, b };
}

const merged = ['shared 1', 'shared 2', 'A 1', 'A 2', 'B 1', 'B 2'];

test('the loser pushes first: its rows go as a branch, the writer appends them with fresh ids and tells her once', async () => {
  const { net, a, b } = await split();
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.equal(ledgerCalls(net, 'branch').length, 1);
  assert.deepEqual(titles(a), merged, 'after A\'s own last row, no interleaving');
  assert.deepEqual(ids(a), ['m1', 'a1', 'r2', 'a3', 't4', 'a5'], 'fresh ids from A\'s counters; A\'s own rows keep theirs');
  assert.deepEqual(record(a).map((item) => item.pc), [null, null, null, null, 'dev_b', 'dev_b'], 'appended rows name the PC that wrote them (and holds their originals)');
  assert.ok(items(a).includes('ri_b'), 'the original came along');
  assert.equal(a.notes.length, 1);
  assert.match(a.notes[0].text, /^While dev_b could not reach dev_a \(\d\d:\d\d–\d\d:\d\d\) I also worked on dev_b: 2 items, t4–a5 in my record\.$/);
  assert.equal(a.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM engine_sessions')?.n, 0, 'her next turn rebuilds with them');
  assert.deepEqual(titles(b), ['shared 1', 'shared 2'], 'B\'s own copies went');

  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(titles(b), merged, 'B mirrors the writer\'s record');
  assert.deepEqual(ids(b), ids(a));
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.equal(ledgerCalls(net, 'branch').length, 1, 'no second branch');
  assert.equal(a.notes.length, 1, 'told once');
});

test('the writer pushes first: the conflict sends the loser\'s branch, then its copies are replaced by the writer\'s rows', async () => {
  const { net, a, b } = await split();
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.equal(ledgerCalls(net, 'branch').length, 1, 'B handed its rows over inside the conflict');
  assert.deepEqual(titles(a), merged);
  assert.deepEqual(titles(b), ['shared 1', 'shared 2', 'A 1', 'A 2'], 'B took the writer\'s rows in place of its own');
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(titles(b), merged, 'the appended rows follow');
  assert.deepEqual(ids(b), ids(a));
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.equal(ledgerCalls(net, 'branch').length, 1);
  assert.equal(a.notes.length, 1);
});

test('the writer refuses rows of an agent that runs on it; they wait as owed rows and go as a branch once the sender learns', async () => {
  const { a, b } = await split();
  homeOf(b, 'dev_b'); // B still thinks it is her PC
  assert.equal(await b.ledger.catchUp('dev_a'), true, 'the push goes on; that agent is refused');
  assert.deepEqual(titles(a), ['shared 1', 'shared 2', 'A 1', 'A 2'], 'A\'s record unchanged');
  homeOf(b, 'dev_a'); // the agents row arrives
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.deepEqual(titles(a), merged, 'then the branch');
});

test('an agent with no rows on the writer takes the other PC\'s rows as they are', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  row(b, 'message', { ref: 'msg:msg_1', title: 'old 1' }); // B ran her before this version
  row(b, 'assistant', { title: 'old 2' });
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.deepEqual(ids(a), ['m1', 'a1'], 'ids kept');
  assert.deepEqual(record(a).map((item) => item.pc), ['dev_b', 'dev_b'], 'A\'s record now; B wrote them and holds their originals');
  assert.equal(a.notes.length, 0, 'no branch to tell');
  assert.deepEqual(record(b).map((item) => [item.item_id, item.pc]), [['m1', 'dev_a'], ['a1', 'dev_a']], 'B keeps them as the writer\'s');
  row(a, 'reasoning', { title: 'new' });
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(titles(b), ['old 1', 'old 2', 'new']);
});

test('Round 2: one branch with both kinds – my rows from before this PC\'s record sync started are appended hidden, the later ones as they are', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a'); // its record sync started at its clock: 17 Oct 2026, 09:00 UTC
  link(a, b);
  row(a, 'message', { ref: 'msg:msg_a', title: 'A 1' });
  row(a, 'assistant', { title: 'A 2' });
  const before = Date.UTC(2026, 9, 1, 9, 0, 0);
  row(b, 'message', { ref: 'msg:msg_old', title: 'old 1', at: before });
  row(b, 'assistant', { title: 'old 2', at: before + 1000 });
  row(b, 'tool', { title: 'B 1' });
  row(b, 'assistant', { title: 'B 2' });
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.deepEqual(ledgerCalls(net, 'branch').length, 1, 'one branch');
  assert.deepEqual(record(a).map((item) => [item.title, item.item_id, item.state]), [
    ['A 1', 'm1', 'keep'], ['A 2', 'a1', 'keep'], ['old 1', 'm2', 'hidden'], ['old 2', 'a2', 'hidden'], ['B 1', 't3', 'keep'], ['B 2', 'a4', 'keep'],
  ]);
  assert.equal(a.notes.length, 1, 'one line, both parts');
  assert.match(a.notes[0].text, /^While dev_b could not reach dev_a \(\d\d:\d\d–\d\d:\d\d\) I also worked on dev_b: 2 items, t3–a4 in my record\. My older record from dev_b \(before \d{1,2} Oct\) is in my record now, hidden – 2 items, m2–a2; context\.restore brings any back\.$/);
  assert.deepEqual(titles(b), [], 'B\'s copies went; the writer\'s mirror brings them');
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(record(b).map((item) => [item.title, item.state]), record(a).map((item) => [item.title, item.state]));
});
