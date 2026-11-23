// End-to-end (Umzug 21.11.2026, the real mesh): two headless runtimes on this machine, linked as the CEO's PCs over
// loopback (test profiles: no meeting server, no LAN listener), demo engine. What the unit tests could only fake with
// sync-net.ts, here over the real RpcPeer:
// 1. Mirror – an agent's record (context_items) written on A shows on B with the same ids, kinds, states and orders.
// 2. Move – agents.update {patch: {deviceId: B}} on A (the app's "Works on"): B stores its own id as none; the next message
//    runs the agent's turn on B only (a run row on B, none new on A), and only after A answered the hand-over (its leave
//    logged done); B's record goes on after A's last ids, and that turn reads the move line.
// 0. Homes (part 2) – each agent makes itself at home on both PCs with one call (agents.update {homes}); the row travels,
//    and B then holds "settled" for an idle agent whose rows it has (kv sync.settled).
// 3. Takeover – A's process gone, a message to the agent on B: after TAKEOVER_MS (120 s, no knob – the test waits) B
//    writes itself as the agent's PC and runs the turn; the turn reads the takeover line. Part 2, in the same two minutes:
//    Jonas is in the middle of a turn on A when A goes ([[hang:…]]) – B does not take him: his row still names A, no run
//    of his on B, his wake waits there, one log line says why.
// 4. Merge – B gone, A back alone (it still holds the old agents row) and runs a turn of its own; then B back: the
//    agents row settles on one writer, the other PC's rows written while apart sit at the writer's end with fresh ids and
//    `pc` = the PC that wrote them, nothing lost (row counts of both sides), both mirrors equal (ids, kinds, states, orders;
//    `pc` is each PC's own "who wrote it"), and the agent reads "While … I also worked on …" and, when the writer took it
//    over, "<PC> is reachable again" beside it. Jonas's wake that waited on B goes to A the normal way and is answered
//    there.
// The databases are read read-only (node:sqlite, <data>/workforce.db) where no RPC shows the record. Both profiles live
// in one temp folder that is removed at the end, also on failure.
// Run: npm run build && node --test test/e2e/runtime-move.test.mjs   (about 8–12 minutes: two waits of 2 minutes)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRuntime, connectYes } from './lib/runtime-client.mjs';

const A_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.2,127.0.0.3' };
const B_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.3,127.0.0.2' };
/** devices/sync/takeover.ts TAKEOVER_MS. */
const TAKEOVER_MS = 120_000;

async function until(read, ok, what, timeoutMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    try { value = await read(); } catch (error) { value = { error: String(error?.message ?? error) }; }
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Read-only query of a running runtime's database. */
function query(dataDir, sql, ...args) {
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'), { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** The agent's record on that PC, in order. */
const recordOf = (dataDir, agentId) => query(dataDir,
  'SELECT conversation_id, item_id, kind, state, "order" AS ord, created_at, title, pc FROM context_items WHERE agent_id = ? ORDER BY conversation_id, "order"', agentId);
const keyOf = (row) => `${row.conversation_id}|${row.item_id}|${row.kind}|${row.state}|${row.ord}`;
const idOf = (row) => `${row.conversation_id}|${row.item_id}|${row.kind}`;
const sameItem = (row) => `${row.conversation_id}|${row.kind}|${row.created_at}|${row.title}`;
const keys = (rows) => rows.map(keyOf);
const equalRecords = (left, right) => left.length > 0 && JSON.stringify(keys(left)) === JSON.stringify(keys(right));
/** Runs this PC ran itself (a mirrored minimal runs row – ledger-wire.ts – has no engine). */
const localRuns = (dataDir, agentId) => query(dataDir, 'SELECT id, status, device_id, started_at FROM runs WHERE agent_id = ? AND engine IS NOT NULL ORDER BY started_at', agentId);
/** The runtime's log lines (<data>/logs/runtime.log, JSON lines) with message `msg` whose data names `agentId`. */
function logLines(dataDir, msg, agentId) {
  let text = '';
  try { text = readFileSync(path.join(dataDir, 'logs', 'runtime.log'), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => { try { const entry = JSON.parse(line); return entry.msg === msg && entry.data?.agentId === agentId ? [entry] : []; } catch { return []; } });
}
const counter = (row) => (row.kind === 'message' ? 'm' : 'x'); // store.ts: messages count apart, the other kinds share one counter
const highest = (rows) => {
  const out = { m: 0, x: 0, ord: 0 };
  for (const row of rows) { out[counter(row)] = Math.max(out[counter(row)], Number(row.item_id.slice(1))); out.ord = Math.max(out.ord, Number(row.ord)); }
  return out;
};

/** The line of an echoed turn input that matches `pattern` (the move line the turn read). */
const lineWith = (body, pattern) => body.split('\n').find((line) => pattern.test(line))?.trim().slice(0, 300);

const agentOn = async (runtime, agentId) => (await runtime.client.call('agents.list')).find((agent) => agent.id === agentId);
/** The PC the agent runs on as `runtime` sees it (no deviceId = that PC itself). */
const writerOn = async (runtime, selfId, agentId) => (await agentOn(runtime, agentId))?.deviceId ?? selfId;
const status = (runtime, deviceId) => runtime.client.call('devices.list').then((list) => list.find((device) => device.id === deviceId)?.status);
const repliesOn = (runtime, chatId, agentId, token) => runtime.client.call('messages.list', { conversationId: chatId })
  .then((list) => list.filter((message) => message.authorId === agentId && message.state === 'final' && message.kind === 'text' && message.body.includes(token)));
/** The agent's final answer that echoes `token`, as `runtime` lists it. */
const answerOn = (runtime, chatId, agentId, token, timeoutMs = 90_000) => until(() => repliesOn(runtime, chatId, agentId, token), (list) => list.length > 0, `the answer to "${token}"`, timeoutMs).then((list) => list[0]);
/** No turn of the agent running or queued on `runtime`. */
/** Whether that PC holds "settled" for the agent as `pc` announced it (devices/sync/ledger-settled.ts, kv sync.settled). */
const settledOn = (dataDir, pc, agentId) => query(dataDir, 'SELECT 1 AS hit FROM kv WHERE ns = ? AND key = ?', 'sync.settled', `${pc}/${agentId}`).length > 0;
const idle = (runtime, agentId) => until(() => runtime.client.call('agents.runs', { id: agentId, limit: 10 }),
  (runs) => Array.isArray(runs) && !runs.some((run) => run.status === 'running' || run.status === 'queued'), 'the agent idle', 60_000, 100);

test('an agent\'s record mirrors, moves, is taken over and merges between two linked runtimes (real mesh)', { timeout: 1_500_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workforce-move-'));
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');
  await mkdir(dirA);
  await mkdir(dirB);
  const live = { a: undefined, b: undefined };
  t.after(async () => {
    for (const name of ['a', 'b']) await live[name]?.stop().catch(() => undefined);
    // WORKFORCE_E2E_LOGS=<folder>: both runtimes' log folders are copied there before the profiles go.
    if (process.env.WORKFORCE_E2E_LOGS) {
      for (const [name, dir] of [['a', dirA], ['b', dirB]]) await cp(path.join(dir, 'logs'), path.join(process.env.WORKFORCE_E2E_LOGS, name), { recursive: true }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
  });
  const startA = async () => (live.a = await startRuntime({ dataDir: dirA, keepData: true, env: A_ENV }));
  const startB = async () => (live.b = await startRuntime({ dataDir: dirB, keepData: true, env: B_ENV }));
  const stop = async (name) => { const runtime = live[name]; live[name] = undefined; await runtime.stop(); };

  await startA();
  await startB();
  const peer = await until(() => live.a.client.call('system.info').then((info) => info.peer), (state) => state?.status === 'open', 'A to accept requests');
  if (!peer.addresses.length) { t.skip('this machine has no address for the peer listener'); return; }
  const aId = (await live.a.client.call('remote.state')).self.deviceId;
  const bId = (await live.b.client.call('remote.state')).self.deviceId;
  await connectYes(live.b.client, (await live.a.client.call('remote.state')).self.myId);
  const incoming = await until(() => live.a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the request on A');
  await live.a.client.call('remote.decide', { id: incoming[0].id, accept: true });
  await until(() => status(live.a, bId), (value) => value === 'online', 'A to list B online');
  await until(() => status(live.b, aId), (value) => value === 'online', 'B to list A online');
  t.diagnostic(`linked: A ${aId}, B ${bId} (B ${bId < aId ? '<' : '>'} A)`);

  const mara = await live.a.client.call('agents.create', { name: 'Mara', role: 'Writer' });
  const ida = await live.a.client.call('agents.create', { name: 'Ida', role: 'Analyst' });
  const chatM = await live.a.client.call('chats.create', { title: 'Move', agentIds: [mara.id] });
  const jonas = await live.a.client.call('agents.create', { name: 'Jonas', role: 'Builder' });
  const chatI = await live.a.client.call('chats.create', { title: 'Takeover', agentIds: [ida.id] });
  const chatJ = await live.a.client.call('chats.create', { title: 'Mid-turn', agentIds: [jonas.id] });
  const chats = new Map([[mara.id, chatM.id], [ida.id, chatI.id], [jonas.id, chatJ.id]]);
  for (const agent of [mara, ida, jonas]) await until(() => agentOn(live.b, agent.id), (row) => row?.deviceId === aId, `${agent.name} on B, working on A`);

  // ---- 0. Homes
  await t.test('0 homes: each agent makes itself at home on both PCs with one call; B then holds its settled record', async () => {
    for (const agent of [mara, ida, jonas]) {
      assert.equal(settledOn(dirB, aId, agent.id), false, `${agent.name} is at home on A only: nothing is announced`);
      await live.a.client.call('messages.send', { conversationId: chats.get(agent.id), body: `at home for ${agent.name} [[tool:agents.update {"homes":["${aId}","${bId}"]}]]` });
      await answerOn(live.a, chats.get(agent.id), agent.id, `at home for ${agent.name}`);
      await idle(live.a, agent.id);
      const row = await until(() => agentOn(live.b, agent.id), (value) => Array.isArray(value?.homes), `${agent.name}'s homes on B`);
      assert.deepEqual(row.homes, [aId, bId], 'the PC it runs on and the one it named, as ids');
    }
    const started = Date.now();
    for (const agent of [mara, ida, jonas]) await until(async () => settledOn(dirB, aId, agent.id), (value) => value === true, `B to hold ${agent.name}'s settled record`, 20_000, 100);
    t.diagnostic(`0: B holds all three settled ${Date.now() - started} ms after the last turn ended`);
  });

  // ---- 1. Mirror
  let maraOnA;
  await t.test('1 mirror: the record written on A is on B with the same ids, kinds, states and orders', async () => {
    for (const n of [1, 2, 3]) {
      await live.a.client.call('messages.send', { conversationId: chatM.id, body: `mirror turn ${n} for Mara` });
      await answerOn(live.a, chatM.id, mara.id, `mirror turn ${n} for Mara`);
      await idle(live.a, mara.id);
    }
    const started = Date.now();
    maraOnA = recordOf(dirA, mara.id);
    assert.ok(maraOnA.length >= 6, `three turns leave items on A (${maraOnA.length})`);
    assert.ok(maraOnA.every((row) => row.pc === null), 'A wrote them itself');
    const onB = await until(() => recordOf(dirB, mara.id), (rows) => equalRecords(rows, recordOf(dirA, mara.id)), 'B\'s mirror of Mara equal to A\'s record', 20_000);
    assert.ok(onB.every((row) => row.pc === aId), 'B keeps them as A\'s rows (pc = A)');
    maraOnA = recordOf(dirA, mara.id);
    t.diagnostic(`1: ${maraOnA.length} rows (${[...new Set(maraOnA.map((row) => row.kind))].join(', ')}); B equal ${Date.now() - started} ms after the last turn ended`);
  });

  // ---- 2. Move by RPC (agents.update patch.deviceId – the app's "Works on"; the tool goes through the same org.update)
  await t.test('2 move: after agents.update deviceId = B the next turn runs on B and continues A\'s ids', async () => {
    maraOnA ??= recordOf(dirA, mara.id);
    const before = highest(maraOnA);
    const runsA = localRuns(dirA, mara.id).map((run) => run.id);
    const runsB = localRuns(dirB, mara.id).map((run) => run.id);
    const started = Date.now();
    await live.a.client.call('agents.update', { id: mara.id, patch: { deviceId: bId } });
    // The message goes at once, while A's leave and B's arrival are still running – the hand-over has to hold it.
    await live.a.client.call('messages.send', { conversationId: chatM.id, body: 'first turn after the move' });
    // Round 3 (MOVE B): a row that names the receiving PC is stored there without a deviceId – "this PC", one spelling.
    await until(() => writerOn(live.b, bId, mara.id), (pc) => pc === bId, 'B to hold Mara\'s row (B\'s own: no deviceId)');
    assert.equal((await agentOn(live.b, mara.id)).deviceId, undefined, 'B stores its own id as none');
    assert.equal((await agentOn(live.a, mara.id)).deviceId, bId, 'A names B');
    t.diagnostic(`2: row on B after ${Date.now() - started} ms`);
    const answer = await answerOn(live.b, chatM.id, mara.id, 'first turn after the move');
    t.diagnostic(`2: answer written on B ${Date.now() - started} ms after the move`);
    await idle(live.b, mara.id);
    const newOnB = localRuns(dirB, mara.id).filter((run) => !runsB.includes(run.id));
    const newOnA = localRuns(dirA, mara.id).filter((run) => !runsA.includes(run.id));
    assert.equal(newOnB.length, 1, `one new run on B (${JSON.stringify(newOnB)})`);
    assert.equal(newOnA.length, 0, `no new run on A (${JSON.stringify(newOnA)})`);
    // The hand-over: A answers agents.handover once its leave is done (logged "agent moved away" after the flush); B's first
    // turn starts after that answer, and B never had to go on without it.
    const left = logLines(dirA, 'agent moved away', mara.id);
    assert.equal(left.length, 1, 'A left Mara once');
    const leftAt = Date.parse(left[0].t);
    assert.ok(Number(newOnB[0].started_at) >= leftAt, `B's turn started after A's leave was done (${Number(newOnB[0].started_at) - leftAt} ms after)`);
    assert.equal(logLines(dirB, 'agent moved here', mara.id).length, 1, 'B took Mara in once');
    assert.equal(logLines(dirB, 'hand-over not answered, going on with the record here', mara.id).length, 0, 'A answered the hand-over');
    t.diagnostic(`2: A's leave done ${leftAt - started} ms after the move, B's turn started ${Number(newOnB[0].started_at) - leftAt} ms after it`);
    assert.match(answer.body, /moved from/, 'the turn on B read the move line');
    t.diagnostic(`2: move line read: ${lineWith(answer.body, /moved from/)}`);
    const onB = recordOf(dirB, mara.id);
    assert.deepEqual(onB.slice(0, maraOnA.length).map(idOf), maraOnA.map(idOf), 'B\'s record starts with A\'s rows, ids kept');
    const added = onB.slice(maraOnA.length);
    assert.ok(added.length > 0, 'B wrote rows of its own');
    assert.ok(added.every((row) => row.pc === null), 'B wrote them itself');
    assert.ok(added.every((row) => Number(row.ord) > before.ord), 'after A\'s last order');
    const next = { ...before };
    for (const row of added) {
      next[counter(row)] += 1;
      assert.equal(Number(row.item_id.slice(1)), next[counter(row)], `${row.item_id} is the next id after A's (${counter(row)} ${next[counter(row)] - 1})`);
    }
    t.diagnostic(`2: B continued at ${added[0].item_id} (A ended at m${before.m} / x${before.x}); ${added.length} new rows`);
    await until(() => recordOf(dirA, mara.id), (rows) => equalRecords(rows, recordOf(dirB, mara.id)), 'A\'s mirror of Mara equal to B\'s record', 20_000);
  });

  // ---- 3. Takeover
  let idaShared; // Ida's record both PCs held when A went away
  let idaOnB; // B's record after its own turn
  let offlineAt;
  await t.test('3 takeover: A gone, a message on B – after 2 min B takes Ida and runs the turn', async () => {
    for (const n of [1, 2]) {
      await live.a.client.call('messages.send', { conversationId: chatI.id, body: `before the cut ${n} for Ida` });
      await answerOn(live.a, chatI.id, ida.id, `before the cut ${n} for Ida`);
      await idle(live.a, ida.id);
    }
    idaShared = await until(() => recordOf(dirB, ida.id), (rows) => equalRecords(rows, recordOf(dirA, ida.id)), 'B\'s mirror of Ida equal before the cut', 20_000);
    await until(() => live.b.client.call('messages.list', { conversationId: chatI.id }), (list) => Array.isArray(list) && list.some((message) => message.body?.includes('before the cut 2')), 'Ida\'s chat on B');
    await until(async () => settledOn(dirB, aId, ida.id), (value) => value === true, 'B to hold Ida\'s settled record', 20_000, 100);
    // Part 2: Jonas starts a turn on A that does not end; A says 'busy' to B before A goes.
    await until(async () => settledOn(dirB, aId, jonas.id), (value) => value === true, 'B to hold Jonas\'s settled record first', 20_000, 100);
    await live.a.client.call('messages.send', { conversationId: chatJ.id, body: 'a long job for Jonas [[hang:bash {"command":"render --all"}]]' });
    await until(async () => settledOn(dirB, aId, jonas.id), (value) => value === false, 'B to hear that Jonas is at work on A', 20_000, 50);
    assert.equal(settledOn(dirB, aId, ida.id), true, 'Ida stays settled');
    // The turn is inside its command when A goes (journaled, so A's restart verifies it instead of starting it again).
    await until(async () => query(dirA, `SELECT 1 AS hit FROM run_items i JOIN runs r ON r.id = i.run_id WHERE r.agent_id = ? AND i.kind = 'tool_call' AND i.name = 'bash'`, jonas.id), (rows) => rows.length > 0, 'the command of Jonas to start on A', 20_000, 50);
    // Round 2 (M1): B compares Ida's chats, tasks and files with what A named when the link goes; A names them 3 s after her last turn.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await stop('a');
    await until(() => status(live.b, aId), (value) => value !== 'online', 'B to see A offline');
    offlineAt = Date.now();
    const runsB = localRuns(dirB, ida.id).map((run) => run.id);
    await live.b.client.call('messages.send', { conversationId: chatI.id, body: 'while A is gone' });
    await live.b.client.call('messages.send', { conversationId: chatJ.id, body: 'Jonas while A is gone' });
    const wakesOnB = () => query(dirB, 'SELECT reason, due_at, claimed_at, attempts FROM wakes WHERE agent_id = ?', ida.id);
    t.diagnostic(`3: Ida's wakes on B after the message: ${JSON.stringify(await until(async () => wakesOnB(), (rows) => rows.length > 0, 'a wake on B', 5_000).catch(() => wakesOnB()))}`);
    // The takeover writes no deviceId (= this PC, the tool's convention), so B's own view of the row has none.
    await until(() => writerOn(live.b, bId, ida.id), (pc) => pc === bId, 'B to take Ida', TAKEOVER_MS + 120_000, 1_000)
      .catch((error) => { throw new Error(`${error.message} – wakes ${JSON.stringify(wakesOnB())}, A ${JSON.stringify(query(dirB, 'SELECT status, last_seen_at FROM devices WHERE id = ?', aId))}, now ${Date.now()}`); });
    const tookMs = Date.now() - offlineAt;
    t.diagnostic(`3: B took Ida ${tookMs} ms after A went offline`);
    assert.ok(tookMs >= TAKEOVER_MS - 2_000, `not before 2 minutes (${tookMs} ms)`);
    const answer = await answerOn(live.b, chatI.id, ida.id, 'while A is gone');
    t.diagnostic(`3: answer ${Date.now() - offlineAt} ms after A went offline`);
    await idle(live.b, ida.id);
    assert.match(answer.body, /has not been reachable since \d\d:\d\d; my record was complete here, so I go on on /, 'the turn read the takeover line');
    t.diagnostic(`3: move line read: ${lineWith(answer.body, /has not been reachable since/)}`);
    assert.equal(localRuns(dirB, ida.id).filter((run) => !runsB.includes(run.id)).length, 1, 'one run on B');
    idaOnB = recordOf(dirB, ida.id);
    assert.deepEqual(idaOnB.slice(0, idaShared.length).map(idOf), idaShared.map(idOf), 'B went on from the shared record');
    assert.ok(idaOnB.length > idaShared.length, 'B wrote rows of its own');
    // (The demo engine's fresh session on B runs the homes call of scenario 0 once more – the same two PCs, B first.)
    assert.deepEqual([...(await agentOn(live.b, ida.id)).homes].sort(), [aId, bId].sort(), 'the set of her homes stays the same');

    // Part 2: the link broke in the middle of Jonas's turn – B waits for A with him.
    const why = await until(async () => logLines(dirB, 'agent waits for its PC, its record was not complete here', jonas.id), (lines) => lines.length > 0, 'B to say that Jonas waits for his PC', 90_000, 1_000);
    assert.equal(why.length, 1, 'one line');
    assert.equal(await writerOn(live.b, bId, jonas.id), aId, 'Jonas\'s row still names A');
    assert.equal(logLines(dirB, 'agent taken over', jonas.id).length, 0, 'B did not take him');
    assert.equal(localRuns(dirB, jonas.id).length, 0, 'no run of his on B');
    const waits = query(dirB, 'SELECT reason FROM wakes WHERE agent_id = ?', jonas.id);
    assert.ok(waits.length > 0, 'his wake waits on B');
    assert.equal((await repliesOn(live.b, chatJ.id, jonas.id, 'Jonas while A is gone')).length, 0, 'no answer from B');
    t.diagnostic(`3: Jonas waits for A (${Date.now() - offlineAt} ms after A went offline; ${waits.length} wake(s) held on B)`);
  });

  // ---- 4. Merge
  await t.test('4 merge: both went on apart – one writer, the other side appended with fresh ids, equal mirrors', async () => {
    assert.ok(idaShared && idaOnB, 'scenario 3 left a record on B');
    await stop('b');
    await startA();
    assert.notEqual(await status(live.a, bId), 'online', 'B is down');
    assert.equal(await writerOn(live.a, aId, ida.id), aId, 'A still holds the row that names A');
    await live.a.client.call('messages.send', { conversationId: chatI.id, body: 'A alone again' });
    await answerOn(live.a, chatI.id, ida.id, 'A alone again');
    await idle(live.a, ida.id);
    const idaOnA = recordOf(dirA, ida.id);
    assert.deepEqual(idaOnA.slice(0, idaShared.length).map(idOf), idaShared.map(idOf), 'A went on from the shared record');
    const nA = idaOnA.length - idaShared.length;
    const nB = idaOnB.length - idaShared.length;
    assert.ok(nA > 0, 'A wrote rows of its own while apart');
    t.diagnostic(`4: shared ${idaShared.length}, B wrote ${nB}, A wrote ${nA} while apart`);

    const started = Date.now();
    await startB();
    await until(() => status(live.a, bId), (value) => value === 'online', 'A to list B online again', 120_000, 500);
    await until(() => status(live.b, aId), (value) => value === 'online', 'B to list A online again', 60_000, 500);
    t.diagnostic(`4: linked again ${Date.now() - started} ms after B's start`);
    const writer = await until(async () => [await writerOn(live.a, aId, ida.id), await writerOn(live.b, bId, ida.id)], ([x, y]) => x === y, 'one writer on both PCs', 60_000, 500).then(([x]) => x);
    const [writerDir, loserRows, writerRows, loserName] = writer === bId ? [dirB, idaOnA, idaOnB, 'A'] : [dirA, idaOnB, idaOnA, 'B'];
    t.diagnostic(`4: the writer is ${writer === bId ? 'B' : 'A'}`);
    const merged = await until(() => recordOf(writerDir, ida.id), (rows) => rows.length >= idaShared.length + nA + nB && equalRecords(rows, recordOf(writer === bId ? dirA : dirB, ida.id)),
      'the merged record, equal on both PCs', 240_000, 1_000);
    t.diagnostic(`4: merged and mirrored ${Date.now() - started} ms after B's start (${merged.length} rows)`);
    assert.equal(merged.length, idaShared.length + nA + nB, 'every row of both sides, none twice');
    assert.deepEqual(merged.slice(0, writerRows.length).map(idOf), writerRows.map(idOf), 'the writer\'s own rows first, ids kept');
    const appended = merged.slice(writerRows.length);
    const own = loserRows.slice(idaShared.length);
    assert.deepEqual(appended.map(sameItem), own.map(sameItem), `${loserName}'s rows from while apart appended in their order`);
    const top = highest(writerRows);
    assert.ok(appended.every((row) => Number(row.ord) > top.ord), 'after the writer\'s last order');
    assert.ok(appended.every((row) => Number(row.item_id.slice(1)) > top[counter(row)]), `fresh ids (${appended.map((row) => row.item_id).join(', ')})`);
    // LEDGER round 3 (M3): appended rows keep the PC that wrote them (a restore of a hidden one fetches its original there).
    const loserId = writer === bId ? aId : bId;
    assert.ok(appended.every((row) => row.pc === loserId), `the appended rows name ${loserName} as the PC that wrote them (${JSON.stringify(appended.map((row) => row.pc))})`);
    assert.ok(merged.slice(idaShared.length, writerRows.length).every((row) => row.pc === null), 'the writer\'s rows from while apart are its own');
    const onLoser = recordOf(writer === bId ? dirA : dirB, ida.id);
    assert.ok(onLoser.slice(writerRows.length).every((row) => row.pc === writer), `the loser's copies of its rows are now the writer's mirror (${JSON.stringify(onLoser.slice(writerRows.length).map((row) => row.pc))})`);
    assert.equal(logLines(writerDir, 'record branch appended', ida.id).length, 1, 'one branch appended');

    const writerRt = writer === bId ? live.b : live.a;
    await writerRt.client.call('messages.send', { conversationId: chatI.id, body: 'after the merge' });
    const answer = await answerOn(writerRt, chatI.id, ida.id, 'after the merge');
    await idle(writerRt, ida.id);
    assert.match(answer.body, /I also worked on/, 'the turn read the merge line');
    t.diagnostic(`4: move lines read: ${lineWith(answer.body, /I also worked on/)} | ${lineWith(answer.body, /is reachable again/)}`);
    // MOVE round 3 (A): lines of different kinds stand together – the writer that took Ida over also says its old PC is back.
    if (writer === bId) assert.match(answer.body, /is reachable again; I stay on/, 'the turn read the "back" line too');
    await until(() => recordOf(writer === bId ? dirA : dirB, ida.id), (rows) => equalRecords(rows, recordOf(writerDir, ida.id)), 'the mirrors equal after the next turn', 20_000);

    // Part 2: A is back – the wake that waited on B for Jonas went to A, the normal path (rows.ts hand-over at link-up).
    const wakesOf = (dir) => query(dir, 'SELECT reason, due_at, claimed_at, attempts, conversation_id FROM wakes WHERE agent_id = ?', jonas.id);
    await until(async () => wakesOf(dirB), (rows) => rows.length === 0, 'B to hand Jonas’s wake to A', 60_000, 500);
    await until(() => live.a.client.call('messages.list', { conversationId: chatJ.id }), (list) => Array.isArray(list) && list.some((message) => message.body === 'Jonas while A is gone'), 'the line written on B in Jonas’s chat on A');
    assert.equal(await writerOn(live.b, bId, jonas.id), aId, 'Jonas still runs on A');
    assert.equal(localRuns(dirB, jonas.id).length, 0, 'B never ran him');
    // A answers that line: the wake comes after its line (rows.ts: a PC that lacks rows gets them before any wake), so the
    // turn finds it behind Jonas's read mark – also when A's restart had already answered in this chat (build/READ.md).
    const reply = await answerOn(live.a, chatJ.id, jonas.id, 'Jonas while A is gone', 30_000);
    await idle(live.a, jonas.id);
    assert.equal((await repliesOn(live.a, chatJ.id, jonas.id, 'Jonas while A is gone')).length, 1, 'answered once');
    assert.deepEqual(wakesOf(dirA), [], 'and his wake on A is settled');
    t.diagnostic(`4: Jonas's wake went from B to A and A answered the line written on B (#${reply.seq}, his runs on A ${localRuns(dirA, jonas.id).length})`);
  });
});
