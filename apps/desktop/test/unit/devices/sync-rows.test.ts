// Row sync between linked PCs (devices/sync/rows.ts, tables.ts): two or three in-memory PCs (the chat harness each)
// on a fake mesh that passes JSON like the real channel. A chat reaches the other PC through its repositories (index,
// events, a seq of its own) and wakes the agent only on its home PC – through a CEO PC that knows that home; rows go
// on to other CEO PCs and never back; the later change wins after a link-up; a chat's notes travel; schedules fire where
// their owner runs; an employee's PC gets its person's part in her ids (no secret handles either way; a removal and a
// reassignment reach it) and sends back only her own lines and task changes, which the CEO's PC checks like a line
// from her phone and delivers (anything else is left out quietly); the first link-up's history
// wakes nobody; a joining PC retires its untouched first-run Manager; B-087: a waiting wake goes at its own PC's
// link-up, and a catch-up whose link goes sends no further page; taking over a SYSTEM.md that came before its row is an
// echo, so the row of the PC it came from still wins with its other fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { placeSchedules } from '../../../src/runtime/devices/sync/tables.ts';
import { getNotes, saveNotes } from '../../../src/runtime/notes/store.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const LENA = 'per_lena000001';

test('a chat and its message reach the linked PC through its repositories; the agent wakes on its home PC only', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_b' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  const sent = a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Pläne für morgen' });
  await settle();

  const there = b.h.chats.messages(chat.id);
  assert.deepEqual(there.map((message) => [message.id, message.body, message.seq]), [[sent.id, 'Pläne für morgen', 1]]);
  assert.equal(b.h.chats.search('Pläne').length, 1, 'the full-text index there has it');
  assert.ok(b.h.of('message.created').some((message) => message.id === sent.id), 'the event fired there');
  assert.deepEqual(b.h.chats.members(chat.id).map((member) => member.memberId).sort(), ['ag_mara', 'human']);
  assert.equal(b.h.chats.get(chat.id)?.title, a.h.chats.get(chat.id)?.title, 'the title the first message gave it');
  assert.equal(a.h.wakes.pending('ag_mara'), 0, 'A handed the wake its delivery made to her home');
  assert.deepEqual(b.h.wakeRows().map((wake) => [wake.agent_id, wake.reason, wake.conversation_id]), [['ag_mara', 'message', chat.id]], 'B wakes her once');
});

test('a wake for an agent at home on a PC this one does not know goes there through the CEO PC that knows it', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const c = makePc(net, 'dev_c');
  link(a, b);
  link(a, c); // B and C each joined A; they do not know each other
  for (const pc of [a, b, c]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_c' }));
  const chat = b.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  b.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Hello from B' });
  await settle();
  assert.deepEqual(c.h.chats.messages(chat.id).map((message) => message.body), ['Hello from B'], 'the message reached C through A');
  assert.deepEqual([a, b, c].map((pc) => pc.h.wakes.pending('ag_mara')), [0, 0, 1], 'she wakes once, on C');
});

test('a schedule fires where its owner runs: a home that moves takes it along, a removed PC hands the person\'s on', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const tom = agent('ag_tom', 'Tom', { deviceId: 'dev_a' });
  for (const pc of [a, b]) pc.h.org.add({ ...tom });
  const routine = a.h.scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'Standup', spec: { everyMs: 3_600_000 }, payload: {} });
  const tea = a.h.scheduler.create({ ownerId: 'human', kind: 'message', conversationId: 'ch_tea', title: 'Tea', spec: { everyMs: 3_600_000 }, payload: { body: 'Tea' } });
  await settle();
  const due = (pc: Pc, id: string) => pc.h.db.get<{ next_at: number | null }>('SELECT next_at FROM schedules WHERE id = ?', [id])?.next_at ?? null;
  assert.deepEqual([due(a, routine.id) !== null, due(b, routine.id) !== null], [true, false], 'Tom\'s routine fires on his home, A');
  assert.deepEqual([due(a, tea.id) !== null, due(b, tea.id) !== null], [true, false], 'the person\'s on the CEO PC with the smallest id');
  // F06 (16.11.2026): B keeps no due time in the row, yet shows the next run wherever it is read.
  assert.equal(b.h.scheduler.get(routine.id)?.nextAt, b.h.clock.now() + 3_600_000, 'B shows when it runs next');
  assert.deepEqual(b.h.scheduler.list({ ownerId: 'ag_tom' }).map((schedule) => schedule.nextAt), [b.h.clock.now() + 3_600_000]);
  assert.equal(due(b, routine.id), null, 'shown, never written to the row');

  for (const pc of [a, b]) { pc.h.org.add({ ...tom, deviceId: 'dev_b' }); pc.h.bus.emit('agent.upserted', pc.h.org.get('ag_tom')!); }
  assert.deepEqual([due(a, routine.id) !== null, due(b, routine.id) !== null], [false, true], 'his home moved to B: B fires it');

  b.repo.patch('dev_a', { status: 'revoked', revokedAt: b.h.clock.now() });
  placeSchedules(b.h.services);
  assert.notEqual(due(b, tea.id), null, 'A was removed: B fires the person\'s schedules');
});

test('a wake for an agent whose home PC is away waits here and goes at the link-up', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_b' }));
  net.up = false;
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'While you were away' });
  await settle();
  assert.equal(a.h.wakes.pending('ag_mara'), 1, 'it waits, unclaimed');
  net.up = true;
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  a.sync.resume();
  await settle();
  assert.equal(a.h.wakes.pending('ag_mara'), 0);
  assert.equal(b.h.wakes.pending('ag_mara'), 1, 'she answers on her PC');
});

test('B-087: a waiting wake goes at its own PC\'s link-up, not at another PC\'s', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const c = makePc(net, 'dev_c');
  link(a, b);
  link(a, c);
  for (const pc of [a, b, c]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_b' }));
  net.up = false;
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'While you were away' });
  await settle();
  net.up = true;
  a.sync.resume('dev_c'); // C's link-up reached its wakes while B's still sends the rows this wake names
  await settle();
  assert.equal(a.h.wakes.pending('ag_mara'), 1, 'it waits for B\'s own link-up');
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  a.sync.resume('dev_b');
  await settle();
  assert.deepEqual([a, b, c].map((pc) => pc.h.wakes.pending('ag_mara')), [0, 1, 0], 'she wakes on her PC');
  assert.deepEqual(b.h.chats.messages(chat.id).map((message) => message.body), ['While you were away'], 'with the line there');
});

test('B-087: a hand-over the link cut goes again at that PC\'s link-up; an agent held while its wakes were cancelled is held no more', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_b' }));
  const devices = a.h.services.devices as { call(peer: string, method: string, params: unknown): Promise<unknown> };
  const call = devices.call;
  const cut = () => { devices.call = async (peer, method, params) => { if ((params as { wakes?: unknown[] }).wakes?.length) { devices.call = call; throw new Error('The link dropped while the call ran.'); } return call(peer, method, params); }; };
  cut();
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'First' });
  await settle();
  assert.equal(a.h.wakes.pending('ag_mara'), 1, 'back here, held');
  a.sync.resume('dev_b'); // B's link-up reached its wakes
  await settle();
  assert.deepEqual([a, b].map((pc) => pc.h.wakes.pending('ag_mara')), [0, 1], 'the cut hand-over went');

  cut();
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Second' });
  await settle();
  a.h.wakes.cancel('ag_mara'); // its wake was withdrawn while it was held (a cancelled task)
  a.sync.resume('dev_b');
  await settle();
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Third' });
  await settle();
  assert.equal(a.h.wakes.pending('ag_mara'), 0, 'the next wake goes at once, not at the next link-up');
});

test('B-087: a catch-up whose link goes sends no further page – no dial for each; the next link-up owes the rest', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara'));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  for (let i = 0; i < 450; i++) a.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: `line ${i}` }); // three pages
  link(a, b);
  const devices = a.h.services.devices as { call(peer: string, method: string, params: unknown): Promise<unknown> };
  const call = devices.call;
  const sent: string[][] = [];
  devices.call = async (peer, method, params) => { // the link goes right after the first page of the 450 lines
    const tables = ((params as { items?: Array<{ t: string }> }).items ?? []).map((item) => item.t);
    sent.push(tables);
    const answer = await call(peer, method, params);
    if (tables.includes('messages')) net.up = false;
    return answer;
  };
  assert.equal(await a.sync.catchUp('dev_b', undefined), false, 'incomplete: the cursor stays');
  assert.equal(sent.filter((tables) => tables.includes('messages')).length, 1, 'no second page of the lines, so none dials');
  assert.ok(sent.at(-1)!.includes('messages'), 'and no call after it');
  devices.call = call;
  net.up = true;
  assert.ok(await a.sync.catchUp('dev_b', undefined), 'the next link-up');
  await settle();
  assert.equal(b.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [chat.id])?.n, 450);
});

test('a row goes on to the other CEO PCs once and never back; an event without a change sends nothing', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const c = makePc(net, 'dev_c');
  link(a, b);
  link(b, c); // A and C are not linked
  const chat = a.h.chats.create({ agentIds: [], createdBy: 'human', title: 'Plans' });
  await settle();
  assert.equal(c.h.chats.get(chat.id)?.title, 'Plans', 'C has it through B');
  assert.deepEqual(net.calls.map((call) => `${call.from}>${call.to}`), ['dev_a>dev_b', 'dev_b>dev_c'], 'nothing echoes back');

  const before = net.calls.length;
  a.h.chats.update(chat.id, { pinned: false }, 'human'); // the chat's event fires, nothing that travels changed
  await settle();
  assert.equal(net.calls.length, before);
});

test('last writer wins: two PCs change one task while apart and agree after the link-up', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const task = a.h.tasks.create({ title: 'Draft', createdBy: 'human' });
  await settle();
  assert.equal(b.h.tasks.get(task.id)?.title, 'Draft');

  net.up = false;
  const apart = a.h.clock.now();
  a.h.clock.set(apart + 60_000);
  a.h.tasks.update(task.id, { title: 'From A' }, 'human');
  b.h.clock.set(apart + 120_000);
  b.h.tasks.update(task.id, { title: 'From B' }, 'human');
  await settle();
  net.up = true;
  assert.ok(await a.sync.catchUp('dev_b', apart));
  assert.ok(await b.sync.catchUp('dev_a', apart));
  await settle();
  assert.equal(a.h.tasks.get(task.id)?.title, 'From B');
  assert.equal(b.h.tasks.get(task.id)?.title, 'From B');
  assert.equal(a.h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks_fts WHERE tasks_fts MATCH 'from'")?.n, 1, 'the task index follows');
});

test('a chat\'s shared notes travel with their chat, live and at a link-up', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const chat = a.h.chats.create({ agentIds: [], createdBy: 'human', title: 'Plans' });
  saveNotes(a.h.services, chat.id, '# Plans\n- before the link', 'human');
  link(a, b);
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  assert.equal(getNotes(b.h.services, chat.id).text, '# Plans\n- before the link');
  saveNotes(a.h.services, chat.id, '# Plans\n- live', 'human');
  await settle();
  assert.deepEqual([getNotes(b.h.services, chat.id).text, getNotes(b.h.services, chat.id).version], ['# Plans\n- live', 2]);
  assert.ok(b.h.of('notes.updated').some((event) => event.conversationId === chat.id), 'the event fired there');
});

test('an employee\'s PC gets its person\'s chats, their messages and tasks – nothing else – and keeps its own to itself', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const theirs = a.h.chats.create({ agentIds: [], people: [LENA], createdBy: 'human', title: 'With Lena' });
  const other = a.h.chats.create({ agentIds: [], createdBy: 'human', title: 'Board' });
  const joined = a.h.clock.now() + 60_000;
  a.h.db.run('UPDATE members SET joined_at = ? WHERE member_id = ?', [joined, LENA]); // she joined later
  a.h.chats.send({ conversationId: theirs.id, authorId: 'human', body: 'Before Lena joined' });
  a.h.clock.set(joined);
  a.h.chats.send({ conversationId: theirs.id, authorId: 'human', body: 'Hi Lena' });
  a.h.chats.send({ conversationId: other.id, authorId: 'human', body: 'Numbers' });
  const hers = a.h.tasks.create({ title: 'Call the client', assigneeKind: 'human', assigneeId: LENA, createdBy: 'human' });
  const board = a.h.tasks.create({ title: 'Plan Q1', createdBy: 'human' });
  await settle();
  assert.ok(e.h.chats.get(theirs.id));
  assert.equal(e.h.chats.get(other.id), undefined);
  assert.deepEqual(e.h.chats.messages(theirs.id).map((message) => message.body), ['Hi Lena']);
  assert.ok(e.h.tasks.get(hers.id));
  assert.equal(e.h.tasks.get(board.id), undefined);
  assert.equal(e.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM people')?.n, 0, 'no people, agents, accounts or secrets');

  const own = e.h.chats.create({ agentIds: [], createdBy: 'human', title: 'Her own' });
  e.h.chats.send({ conversationId: own.id, authorId: 'human', body: 'Private on her PC' });
  e.h.chats.update(theirs.id, { title: 'Renamed on her PC' }, 'human');
  await settle();
  assert.equal(net.calls.filter((call) => call.from === 'dev_e').length, 0, 'her own chats and a chat\'s settings stay on her PC');
});

test('an employee\'s PC speaks in her ids, and her lines and task changes go back – checked, delivered, never echoed', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  a.h.org.add(agent('ag_mara', 'Mara'));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], people: [LENA], createdBy: 'human', title: 'With Lena' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Hi Lena', silent: true, meta: { secrets: ['sec_owner_key'] } });
  const hers = a.h.tasks.create({ title: 'Call the client', assigneeKind: 'human', assigneeId: LENA, createdBy: 'human' });
  await settle();
  assert.equal(a.h.wakes.pending('ag_mara'), 0);
  assert.equal(e.h.chats.messages(chat.id)[0]?.meta.secrets, undefined, 'the owner\'s secret handles stay on the CEO\'s PC');
  const down = () => net.calls.filter((call) => call.from === 'dev_a' && call.to === 'dev_e').length;
  const sentDown = down();

  // Down: she is 'human' on her PC, the CEO is 'owner', her task is her own.
  assert.deepEqual(e.h.chats.members(chat.id).map((member) => member.memberId).sort(), ['ag_mara', 'human', 'owner']);
  assert.deepEqual(e.h.chats.messages(chat.id).map((message) => [message.body, message.authorId]), [['Hi Lena', 'owner']]);
  const there = e.h.tasks.get(hers.id)!;
  assert.deepEqual([there.assigneeKind, there.assigneeId, there.createdBy], ['human', undefined, 'owner']);

  // Back: her line arrives as hers and wakes the agent on the CEO's PC; her change of her task arrives too.
  const reply = e.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Called them', mentions: ['ag_mara'], meta: { secrets: ['sec_hers'] } });
  e.h.tasks.update(hers.id, { notes: 'Called at 10' }, 'human');
  await settle();
  const arrived = a.h.chats.message(reply.id)!;
  assert.deepEqual([arrived.body, arrived.authorId, arrived.authorKind, arrived.mentions], ['Called them', LENA, 'human', ['ag_mara']]);
  assert.equal(arrived.meta.secrets, undefined, 'no secret handles come in from her PC either');
  assert.equal(a.h.wakes.pending('ag_mara'), 1, 'delivered on the CEO\'s PC like a line from her phone');
  assert.equal(a.h.tasks.get(hers.id)?.notes, 'Called at 10');
  assert.equal(a.h.tasks.get(hers.id)?.assigneeId, LENA, 'still hers');
  assert.equal(down(), sentDown, 'nothing echoes back to her PC');

  // A line written while the CEO's PC was away goes at the next link-up.
  net.up = false;
  const away = e.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'While you were away' });
  await settle();
  assert.equal(a.h.chats.message(away.id), undefined);
  net.up = true;
  assert.ok(await e.sync.catchUp('dev_a', undefined));
  await settle();
  assert.equal(a.h.chats.message(away.id)?.authorId, LENA);
});

test('the CEO\'s PC takes from an employee\'s PC only her own lines and her tasks – the rest is left out quietly', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const theirs = a.h.chats.create({ agentIds: [], people: [LENA], createdBy: 'human', title: 'With Lena' });
  const board = a.h.chats.create({ agentIds: [], createdBy: 'human', title: 'Board' });
  const old = a.h.chats.create({ agentIds: [], people: [LENA], createdBy: 'human', title: 'Old project' });
  const ceo = a.h.chats.send({ conversationId: theirs.id, authorId: 'human', body: 'From the CEO' });
  const answer = a.h.chats.send({ conversationId: theirs.id, authorId: LENA, authorKind: 'human', kind: 'answer', body: 'Yes' });
  const plan = a.h.tasks.create({ title: 'Plan Q1', createdBy: 'human' });
  await settle();
  a.h.db.run('UPDATE conversations SET archived_at = 1 WHERE id = ?', [old.id]);
  const now = a.h.clock.now() + 60_000;
  const line = { ...a.h.db.get<Record<string, unknown>>('SELECT * FROM messages WHERE id = ?', [ceo.id])! };
  const as = (id: string, row: Record<string, unknown>) => ({ t: 'messages', id, at: now, row: { ...row, id } });
  const forged = [
    as('msg_forged_owner', { ...line, author_id: 'owner', body: 'Signed as the CEO' }), // the CEO in her ids
    as('msg_forged_board', { ...line, conversation_id: board.id, author_id: 'human', body: 'Into a chat she is not in' }),
    as(ceo.id, { ...line, author_id: 'human', body: 'Rewrites the CEO\'s line' }),
    // Like a line from her phone: only a finished text line, in a chat that is not archived, editing only her own text line.
    as('msg_forged_status', { ...line, author_id: 'human', kind: 'status', body: 'A status line' }),
    as('msg_forged_stream', { ...line, author_id: 'human', state: 'streaming', body: 'Never finished' }),
    as('msg_forged_archived', { ...line, conversation_id: old.id, author_id: 'human', body: 'Into an archived chat' }),
    as(answer.id, { ...line, author_id: 'human', body: 'Her answer turned into a text line' }),
    { t: 'tasks', id: plan.id, at: now, row: { ...a.h.db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [plan.id])!, title: 'Taken over' } },
    { t: 'conversations', id: theirs.id, at: now, row: { ...a.h.db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [theirs.id])!, title: 'Renamed' } },
    { t: 'messages', id: ceo.id, at: now, gone: true },
  ];
  const before = net.calls.length;
  assert.deepEqual(await a.handlers.get('sync.rows')!({ items: forged }, 'dev_e'), { ok: true, applied: 0 });
  await settle();
  assert.deepEqual(a.h.chats.messages(theirs.id).map((message) => [message.body, message.authorId]), [['From the CEO', 'human'], ['Yes', LENA]]);
  assert.equal(a.h.chats.messages(board.id).length, 0);
  assert.equal(a.h.chats.messages(old.id).length, 0);
  assert.equal(a.h.tasks.get(plan.id)?.title, 'Plan Q1');
  assert.equal(a.h.chats.get(theirs.id)?.title, 'With Lena');
  assert.equal(net.calls.length, before, 'nothing answers it, nothing repeats');
});


test('the first link-up brings the history: nothing wakes, nothing is unread', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara'));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'one' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'two' });
  link(a, b);
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  await settle();
  assert.deepEqual(b.h.chats.messages(chat.id).map((message) => message.body), ['one', 'two']);
  assert.equal(b.h.chats.summary(chat.id).unread, 0);
  assert.equal(b.h.wakes.pending('ag_mara'), 0, 'old messages wake nobody');
});

test('a PC that joins the company retires its own untouched first-run Manager once the company\'s agents arrive', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const now = a.h.clock.now();
  new AgentRepo(a.h.db).save(agent('ag_boss', 'Manager', { template: 'manager', createdAt: now - 10_000 }));
  const seed = agent('ag_seed', 'Manager', { template: 'manager', createdAt: now - 5_000 });
  new AgentRepo(b.h.db).save(seed);
  b.h.org.add(seed);
  const direct = b.h.chats.create({ agentIds: ['ag_seed'], createdBy: 'human' });
  const archived: string[] = [];
  Object.assign(b.h.org, { archive: (id: string) => { archived.push(id); b.h.db.run('UPDATE agents SET archived_at = ? WHERE id = ?', [now, id]); } });
  link(a, b); // B joined A
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  await settle();
  assert.deepEqual(archived, ['ag_seed'], 'one chief of staff: the company\'s');
  assert.equal(b.h.chats.get(direct.id), undefined, 'its empty chat went too');
});

test('B-087: taking over a SYSTEM.md that came before its row is an echo – the row of the PC it came from still wins, with its other fields', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const start = a.h.clock.now();
  const mara = agent('ag_mara', 'Mara', { instructions: 'Write short.', createdAt: start });
  for (const pc of [a, b]) { new AgentRepo(pc.h.db).save(mara); pc.h.org.add(mara); }
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  await settle();
  const edit = (pc: Pc, patch: Partial<typeof mara>) => {
    const next = { ...new AgentRepo(pc.h.db).get('ag_mara')!, ...patch };
    new AgentRepo(pc.h.db).save(next);
    pc.h.bus.emit('agent.upserted', next);
  };

  net.up = false; // A's row does not get through; its SYSTEM.md does (the file sync)
  a.h.clock.set(start + 1_000);
  edit(a, { team: 'Docs', instructions: 'Write long.' });
  b.h.clock.set(start + 2_000); // B takes the file over later by its clock
  b.stamps.echo.add('agents/ag_mara');
  edit(b, { instructions: 'Write long.' });
  assert.ok(b.stamps.get('agents/ag_mara')!.at < start + 1_000, 'stamped just after its last stamp, not now');
  assert.equal(b.stamps.echo.size, 0, 'used once');

  net.up = true;
  assert.ok(await b.sync.catchUp('dev_a', undefined));
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  await settle();
  for (const pc of [a, b]) {
    const row = new AgentRepo(pc.h.db).get('ag_mara')!;
    assert.equal(row.team, 'Docs', `${pc.id} keeps A's other field`);
    assert.equal(row.instructions, 'Write long.');
  }
});
