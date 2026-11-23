// A line written on one PC while the agent's PC was out of reach (defect of 21.11.2026, e2e runtime-move scenario 4): it
// reaches the agent's PC with a fresh seq behind the agent's read mark – also when the agent answered in that chat
// meanwhile – and its wake comes after it, never before: a wake that arrives before its line finds nothing new and is
// settled without a turn (dispatch-groups.ts isStaleMessageGroup), and the line then waits unanswered. The wake came first
// when the rows' call of a link-up was cut (a link swap) and the link-up went on to its wakes, when another wake for the
// agent came while rows were still owed, and after a restart. And a link-up without a cursor (none completed yet) sent
// every row as history, which moves a caught-up member's mark past it: history is what was there before the link.
// Owns: these assertions only. Never: a real mesh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupWakes, isStaleMessageGroup } from '../../../src/runtime/agents/dispatch-groups.ts';
import { linkUps } from '../../../src/runtime/devices/sync/service.ts';
import { RowSync } from '../../../src/runtime/devices/sync/rows.ts';
import { agent } from '../chat/harness.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const JONAS = 'ag_jonas';

/** A (Jonas's PC) and B linked, a chat with one answered line on both; then the link is cut. */
async function apart() {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  a.repo.patch('dev_b', { pairedAt: a.h.clock.now() }); // both PCs store when the link was made (mesh.ts)
  a.h.org.add(agent(JONAS, 'Jonas'));
  b.h.org.add(agent(JONAS, 'Jonas', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: [JONAS], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'a long job' });
  await settle();
  a.h.wakes.cancel(JONAS);
  const cursor = b.h.clock.now();
  for (const pc of [a, b]) pc.h.clock.advance(1_000);
  net.up = false;
  b.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'while A is gone' });
  await settle();
  assert.equal(b.h.wakes.pending(JONAS), 1, 'its wake waits on B');
  for (const pc of [a, b]) pc.h.clock.advance(1_000);
  a.h.chats.markRead(chat.id, JONAS, a.h.chats.messages(chat.id).at(-1)!.seq); // A alone: his turn read the job …
  a.h.chats.send({ conversationId: chat.id, authorId: JONAS, authorKind: 'agent', body: 'the long job is done' }); // … and answered
  await settle();
  const answer = a.h.chats.messages(chat.id).at(-1)!;
  assert.equal(readMark(a, chat.id), answer.seq, 'Jonas has read all that is on A');
  for (const pc of [a, b]) pc.h.clock.advance(1_000);
  net.up = true;
  return { a, b, chat, cursor };
}

const readMark = (pc: Pc, chatId: string) => pc.h.chats.members(chatId).find((member) => member.memberId === JONAS)!.readSeq;
const unseen = (pc: Pc, chatId: string) => pc.h.chats.messages(chatId, { afterSeq: readMark(pc, chatId), limit: 50 }).filter((line) => line.authorId !== JONAS).map((line) => line.body);

for (const first of [false, true]) {
  test(`a line written on another PC during a split is unread for the agent that answered meanwhile (${first ? 'link-up without a cursor' : 'link-up with a cursor'})`, async () => {
    const { a, b, chat, cursor } = await apart();
    assert.ok(await b.sync.catchUp('dev_a', first ? undefined : cursor));
    b.sync.resume('dev_a');
    await settle();
    assert.ok(a.h.chats.messages(chat.id).some((line) => line.body === 'while A is gone'), 'the line is on A');
    assert.deepEqual(unseen(a, chat.id), ['while A is gone'], 'behind his read mark: he has not read it');
    assert.equal(a.h.wakes.pending(JONAS), 1, 'its wake is on A');
    const groups = groupWakes(a.h.wakes.claim(JONAS));
    assert.equal(groups.length, 1);
    assert.equal(isStaleMessageGroup(a.h.chats, JONAS, groups[0]), false, 'the dispatcher runs the turn');
    assert.equal(a.h.chats.summary(chat.id).unread, 0, 'the person wrote it: nothing unread for them');
  });
}

test('a line the agent read stays read: the same rows coming again move no mark and wake nobody', async () => {
  const { a, b, chat, cursor } = await apart();
  assert.ok(await b.sync.catchUp('dev_a', cursor));
  b.sync.resume('dev_a');
  await settle();
  a.h.wakes.cancel(JONAS);
  a.h.chats.markRead(chat.id, JONAS, a.h.chats.messages(chat.id).at(-1)!.seq); // his turn read it
  assert.ok(await b.sync.catchUp('dev_a', undefined)); // everything once more
  b.sync.resume('dev_a');
  await settle();
  assert.deepEqual(unseen(a, chat.id), []);
  assert.equal(a.h.wakes.pending(JONAS), 0);
});

/** What A held of the chat each time a wake for Jonas arrived there: the lines of others behind his read mark. */
function wakesOn(a: Pc, chatId: string): string[][] {
  const seen: string[][] = [];
  const receive = a.handlers.get('sync.rows')!;
  a.handlers.set('sync.rows', async (params, from) => {
    const result = await receive(params, from);
    if ((params as { wakes?: unknown[] }).wakes?.length) seen.push(unseen(a, chatId));
    return result;
  });
  return seen;
}

/** B's first call with the chat's lines fails as a link swap cuts it: they do not arrive. */
function cutRows(b: Pc): void {
  const devices = b.h.services.devices as { call(peer: string, method: string, params: unknown): Promise<unknown> };
  const call = devices.call;
  devices.call = async (peer, method, params) => {
    if (!(params as { items?: Array<{ t: string }> }).items?.some((item) => item.t === 'messages')) return call(peer, method, params);
    devices.call = call;
    throw new Error('The link dropped while the call ran.');
  };
}

const quiet = { catchUp: async () => true };

test('a link-up whose rows were cut does not let the wake overtake its line: the rows go first, then the wake', async () => {
  const { a, b, chat, cursor } = await apart();
  const arrived = wakesOn(a, chat.id);
  cutRows(b);
  b.stamps.setCursor('dev_a', cursor);
  const done: string[] = [];
  const log = { debug() {}, warn() {}, error() {}, info: (message: string) => { done.push(message); } };
  linkUps({ clock: b.h.clock, log }, b.stamps, { tabs: quiet, rows: b.sync, secrets: quiet, logins: quiet, files: quiet }, () => true)('dev_a');
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(done.includes('linked PC caught up'), 'the link-up ran to its end');
  assert.equal(b.stamps.cursor('dev_a'), cursor, 'incomplete: its cursor stays');
  assert.deepEqual(arrived, [['while A is gone']], 'the wake arrived once, with its line there');
  assert.equal(b.h.wakes.pending(JONAS), 0);
  const groups = groupWakes(a.h.wakes.claim(JONAS));
  assert.equal(groups.length, 1);
  assert.equal(isStaleMessageGroup(a.h.chats, JONAS, groups[0]), false, 'the dispatcher runs the turn');
});

test('another wake for the agent while its PC still lacks rows from here takes them along first', async () => {
  const { a, b, chat } = await apart();
  const arrived = wakesOn(a, chat.id);
  b.h.wakes.wake({ agentId: JONAS, reason: 'manual', note: 'the weekly report' }); // back online, no link-up yet
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(arrived, [['while A is gone']], 'both wakes in one call, after the line');
  assert.equal(a.h.wakes.pending(JONAS), 2);
  assert.equal(b.h.wakes.pending(JONAS), 0);
});

test('after a restart a waiting wake goes with the rows that PC lacks; a catch-up that fails keeps it here for the link-up', async () => {
  const { a, b, chat } = await apart();
  const arrived = wakesOn(a, chat.id);
  b.detach(); // B restarts: what A has of B's rows is unknown again
  const sync = new RowSync(b.h.services, b.stamps, 0);
  b.handlers.set('sync.rows', (params, from) => sync.receive(params, from));
  const off = sync.attach();
  cutRows(b);
  sync.resume('dev_a');
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(arrived, [], 'the rows did not go: no wake either');
  assert.equal(b.h.wakes.pending(JONAS), 1, 'it waits on B');
  sync.resume('dev_a'); // the next link-up reaches its wakes
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(arrived, [['while A is gone']]);
  assert.equal(b.h.wakes.pending(JONAS), 0);
  off();
});
