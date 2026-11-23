// The quest rules (Quests round 20.11.2026, runtime/tasks/quests.ts with service.ts, lifecycle.ts, transitions.ts):
// one level – a to-do placed under a to-do goes into its quest, a top-level to-do that gets one becomes a quest, a quest
// never sits in a quest; a closed quest ends its open to-dos ("Quest closed: <why>", quietly, one line); a to-do of a
// closed quest opens again only with its quest; the last open to-do ending wakes the quest's agent owner once ("Every
// to-do of … is done – it is done when …"), a person's quest gets nothing; moving a to-do into or out of a quest; the
// morning pass (tasks/morning.ts); a quest open again brings back the to-dos its close ended, as they were, and tells
// each agent owner once (R1.4). The 0.3.x bridge: test/unit/devices/sync-quests-bridge.test.ts.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { TaskWatcher } from '../../../src/runtime/tasks/watch.ts';
import { addDays, wallOf, wallTime } from '../../../src/shared/text/when.ts';
import { profileZone } from '../../../src/runtime/context/time.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida'));
  h.org.add(agent('ag_jonas', 'Jonas'));
  const chat = h.chats.create({ agentIds: ['ag_ida', 'ag_jonas'], createdBy: HUMAN_ID });
  const quest = h.tasks.create({ kind: 'quest', conversationId: chat.id, title: 'Windows signing', doneWhen: 'Signed builds ship', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const todo = (title: string, extra: Record<string, unknown> = {}) => h.tasks.create({ title, parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'ag_ida', ...extra });
  const wakesOf = (agentId: string) => h.wakeRows().filter((row) => row.agent_id === agentId);
  const code = (run: () => unknown) => { try { run(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };
  return { ...h, chat, quest, todo, wakesOf, code };
}

test('one level: a to-do under a to-do goes into its quest; a top-level to-do that gets one becomes a quest; a quest sits in no quest', () => {
  const h = setup();
  const cert = h.todo('Buy the certificate');
  const nested = h.tasks.create({ title: 'Pay the invoice', parentId: cert.id, assigneeKind: 'human', createdBy: 'ag_ida' });
  assert.equal(nested.parentId, h.quest.id, 'into the quest, not under the to-do');
  const plain = h.tasks.create({ title: 'Garden', assigneeKind: 'human', createdBy: HUMAN_ID });
  assert.equal(plain.kind, 'todo');
  h.tasks.create({ title: 'Mow', parentId: plain.id, assigneeKind: 'human', createdBy: HUMAN_ID });
  assert.equal(h.tasks.get(plain.id)!.kind, 'quest');
  assert.equal(h.code(() => h.tasks.create({ kind: 'quest', title: 'Inner', parentId: h.quest.id, createdBy: HUMAN_ID })), 'bad_request');
  assert.equal(h.code(() => h.tasks.update(h.quest.id, { parentId: plain.id }, HUMAN_ID)), 'bad_request');
  assert.deepEqual(h.tasks.get(h.quest.id)!.steps.map((step) => step.title), ['Buy the certificate', 'Pay the invoice']);
});

test('a to-do moves into an open quest and out again; never into a to-do or a closed quest', () => {
  const h = setup();
  const loose = h.tasks.create({ title: 'Send the VAT invoice', assigneeKind: 'human', createdBy: HUMAN_ID });
  assert.equal(h.tasks.update(loose.id, { parentId: h.quest.id }, HUMAN_ID).parentId, h.quest.id);
  assert.equal(h.tasks.update(loose.id, { parentId: null }, HUMAN_ID).parentId, undefined);
  const other = h.tasks.create({ title: 'Other', assigneeKind: 'human', createdBy: HUMAN_ID });
  assert.equal(h.code(() => h.tasks.update(loose.id, { parentId: other.id }, HUMAN_ID)), 'bad_request');
  h.tasks.finish(h.quest.id, { status: 'dropped', summary: 'Not needed' }, HUMAN_ID);
  assert.equal(h.code(() => h.tasks.update(loose.id, { parentId: h.quest.id }, HUMAN_ID)), 'conflict');
  assert.equal(h.code(() => h.tasks.create({ title: 'Late', parentId: h.quest.id, createdBy: HUMAN_ID })), 'conflict');
});

test('a closed quest ends its open to-dos quietly ("Quest closed: why") in one line; a to-do of it reopens only with the quest', () => {
  const h = setup();
  const done = h.todo('Make the CSR');
  h.tasks.finish(done.id, { status: 'done', summary: 'CSR made' }, 'ag_ida');
  const open = h.todo('Upload the build');
  const person = h.tasks.create({ title: 'Approve the payment', parentId: h.quest.id, assigneeKind: 'human', createdBy: 'ag_ida' });
  h.tasks.finish(h.quest.id, { status: 'done', summary: 'Signing works now' }, 'ag_ida');
  for (const id of [open.id, person.id]) {
    const after = h.tasks.get(id)!;
    assert.deepEqual([after.status, after.result?.summary, after.result?.quiet], ['dropped', 'Quest closed: Signing works now', true], id);
  }
  assert.equal(h.tasks.get(done.id)!.status, 'done', 'a done one stays done');
  assert.equal(h.notified.filter((note) => note.taskId === open.id || note.taskId === person.id).length, 1, 'nobody is notified for the ended to-dos (the one notice is the person\'s new to-do)');
  const lines = h.chats.messages(h.quest.id).filter((message) => message.kind === 'status' && /Windows signing/.test(message.body ?? '')); // the quest's own thread (tasks/thread.ts)
  assert.equal(lines.filter((line) => /Done: Windows signing · 2 open to-dos ended/.test(line.body ?? '')).length, 1, 'one line for the quest');
  assert.equal(h.code(() => h.tasks.update(person.id, { status: 'open' }, HUMAN_ID)), 'conflict');
  h.tasks.update(h.quest.id, { status: 'open' }, HUMAN_ID);
  assert.equal(h.tasks.update(person.id, { status: 'open' }, HUMAN_ID).status, 'open', 'with its quest open again');
});

test('the last open to-do ending wakes the quest\'s agent owner once with "Every to-do of … is done – it is done when …"', () => {
  const h = setup();
  const a = h.tasks.create({ title: 'Buy the certificate', parentId: h.quest.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: 'ag_ida' });
  const b = h.tasks.create({ title: 'Approve', parentId: h.quest.id, assigneeKind: 'human', createdBy: 'ag_ida' });
  h.db.run('DELETE FROM wakes');
  h.tasks.finish(a.id, { status: 'done', summary: 'Bought' }, 'ag_jonas');
  const first = h.wakesOf('ag_ida').find((row) => row.task_id === h.quest.id)!;
  assert.match(String(first.note), /^Jonas finished \(claimed, not checked yet\) "Buy the certificate", a to-do of my quest "Windows signing"\./);
  assert.match(String(first.note), /Still open: "Approve"/);
  h.db.run('DELETE FROM wakes');
  h.tasks.finish(b.id, { status: 'done', summary: 'Approved' }, HUMAN_ID);
  const last = h.wakesOf('ag_ida').filter((row) => row.task_id === h.quest.id);
  assert.equal(last.length, 1);
  assert.match(String(last[0].note), /^Every to-do of "Windows signing" is done – it is done when Signed builds ship\./);
  const mine = h.tasks.create({ kind: 'quest', title: 'Move', assigneeKind: 'human', createdBy: HUMAN_ID });
  const box = h.tasks.create({ title: 'Boxes', parentId: mine.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: HUMAN_ID });
  h.db.run('DELETE FROM wakes');
  h.tasks.finish(box.id, { status: 'done', summary: 'Bought' }, 'ag_jonas');
  assert.equal(h.wakeRows().filter((row) => row.task_id === mine.id).length, 0, 'a person\'s quest gets nothing');
});

test('the morning pass: at 07:00 an agent hears once of its open quests without a note; a quest with a reminder stays quiet; a quest made that day waits for the next (FIXREAL 6b)', () => {
  const h = setup();
  const watcher = h.ownership as unknown as TaskWatcher;
  const zone = profileZone(h.services);
  const today = wallOf(h.clock.now(), zone).date;
  h.todo('Upload the build');
  const noted = h.tasks.create({ kind: 'quest', title: 'Newsletter', assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: HUMAN_ID });
  h.scheduler.create({ ownerId: 'ag_jonas', kind: 'reminder', taskId: noted.id, title: 'Look', spec: { at: h.clock.now() + 86_400_000 }, payload: { note: 'Look' } });
  h.db.run('DELETE FROM wakes');
  assert.equal(watcher.morning.run(h.clock.now() + 60_000), 0, 'made today – the catch-up a minute after a start too: no nudge before tomorrow');
  const seven = wallTime(addDays(today, 1), 7 * 60, zone);
  assert.equal(watcher.morning.run(seven - 60_000), 0, 'nothing before 07:00');
  assert.equal(watcher.morning.run(seven + 60_000), 1);
  const [wake] = h.wakesOf('ag_ida');
  assert.match(String(wake.note), /^These quests of mine have no next note:\n\nWindows signing · task_\S+(?: · [^\n]+'s)? – done when Signed builds ship\.\nPerson: 0 open\nMe:\n {2}- "Upload the build" · task_\S+ · open since /); // context/quest-text.ts questSnapshot
  assert.equal(h.wakesOf('ag_jonas').length, 0, 'a quest with a reminder');
  assert.equal(watcher.morning.run(seven + 3_600_000), 0, 'once a day');
});

test('R1.4: a quest closed by mistake comes back whole – an undo or a reopen brings back the to-dos its close ended, as they were', () => {
  const h = setup();
  const earlier = h.todo('Make the CSR');
  h.tasks.finish(earlier.id, { status: 'dropped', summary: 'Not needed' }, 'ag_ida');
  const buy = h.tasks.create({ title: 'Buy the certificate', parentId: h.quest.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: 'ag_ida' });
  const upload = h.tasks.create({ title: 'Upload the build', parentId: h.quest.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: 'ag_ida' });
  const person = h.tasks.create({ title: 'Approve the payment', parentId: h.quest.id, assigneeKind: 'human', createdBy: 'ag_ida' });
  h.tasks.update(upload.id, { status: 'waiting', waitingOn: { on: 'outside', why: 'Certum activates the certificate' } }, 'ag_jonas');
  const states = () => [buy, upload, person].map((todo) => h.tasks.get(todo.id)!.status);
  h.tasks.finish(h.quest.id, { status: 'done', summary: 'Wrong quest' }, 'ag_ida'); // the mistake
  assert.deepEqual(states(), ['dropped', 'dropped', 'dropped']);
  h.db.run('DELETE FROM wakes');
  h.tasks.undo(h.quest.id, HUMAN_ID);
  assert.equal(h.tasks.get(h.quest.id)!.status, 'open');
  assert.deepEqual(states(), ['open', 'waiting', 'open'], 'as they were before the close');
  assert.equal(h.tasks.get(upload.id)!.waitingOn?.why, 'Certum activates the certificate', 'the wait with its reason');
  assert.equal(h.tasks.get(person.id)!.result, undefined, 'no "Quest closed" result left');
  assert.equal(h.tasks.get(earlier.id)!.status, 'dropped', 'dropped before the close: stays dropped');
  const told = h.wakesOf('ag_jonas');
  assert.equal(told.length, 1, 'Jonas hears it once for both of his');
  assert.equal(told[0].task_id, h.quest.id);
  assert.match(String(told[0].note), /^[^"]+ opened the quest "Windows signing" again; my to-dos in it are open again: "Buy the certificate" \(task_\S+\), "Upload the build" \(task_\S+\)\.$/);
  assert.ok(h.chats.messages(person.id, { limit: 20 }).some((line) => line.body.startsWith('Open again with its quest: Approve the payment')), 'a line in its thread');
  h.tasks.finish(h.quest.id, { status: 'dropped', summary: 'Wrong again' }, 'ag_ida');
  assert.deepEqual(states(), ['dropped', 'dropped', 'dropped']);
  h.tasks.update(h.quest.id, { status: 'open' }, HUMAN_ID); // the person's reopen
  assert.deepEqual(states(), ['open', 'waiting', 'open']);
});

test('the person\'s Done on an agent-led quest closes it at once: its open to-dos end "Quest closed: Done", no verifier waits', () => {
  const h = setup();
  const upload = h.todo('Upload the build');
  const jonas = h.tasks.create({ title: 'Buy the certificate', parentId: h.quest.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: 'ag_ida' });
  let verified = 0;
  h.services.subconscious = { verify: async () => { verified++; return { ok: true, checked: true, reason: 'fine' }; } } as never;
  h.tasks.finish(h.quest.id, { status: 'done', summary: 'Done' }, HUMAN_ID); // the quest menu's Done (tasks.finish {id})
  const quest = h.tasks.get(h.quest.id)!;
  assert.deepEqual([quest.status, quest.result?.verification], ['done', 'reported_by_human']);
  for (const id of [upload.id, jonas.id]) assert.deepEqual([h.tasks.get(id)!.status, h.tasks.get(id)!.result?.summary], ['dropped', 'Quest closed: Done'], id);
  assert.equal(verified, 0, 'the person\'s Done is final');
});
