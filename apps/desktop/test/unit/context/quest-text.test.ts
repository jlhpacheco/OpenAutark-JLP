// Quests as the agent reads them (context/quest-text.ts, Quests round 20.11.2026): "## My quests" – one line per open quest
// I own, hold a to-do in or gave, without a cap, a time only on the person's to-dos, my next note, then "Other:" –; the
// quest as it stands (done-when, every owner's open to-dos with their waits, the person's done ones counted, thread lines
// since my last line there) – also under a reminder's note (FIXREAL 5); the person's lines a turn takes and "## Related
// open work" about others' work.
// Owns: these assertions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { myQuestsSection, personLineOf, personLinesOf, questSnapshot, relatedSection, reminderSnapshot } from '../../../src/runtime/context/quest-text.ts';
import { agent, harness } from '../chat/harness.ts';

const HOUR = 3_600_000;

function setup() {
  const h = harness(); // clock: Sat 17 Oct 2026 09:00 UTC
  h.org.add(agent('ag_ida', 'Ida'));
  h.org.add(agent('ag_felix', 'Felix'));
  const s = h.services as RuntimeServices;
  const quest = h.tasks.create({ kind: 'quest', title: 'Windows signing', doneWhen: 'Every installer is signed', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const sign = h.tasks.create({ title: 'Sign on the phone', parentId: quest.id, assigneeKind: 'human', createdBy: 'ag_ida', at: h.clock.now() + 26 * HOUR });
  const mine = h.tasks.create({ title: 'First signed build', parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'ag_ida', at: h.clock.now() + 50 * HOUR });
  h.tasks.update(mine.id, { status: 'waiting', waitingOn: { on: 'who', who: 'ag_felix', why: 'the certificate' } }, 'ag_ida');
  h.tasks.create({ title: 'Activate the certificate', parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_felix', createdBy: 'ag_ida' });
  h.tasks.create({ title: 'Release build with signing', parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_felix', createdBy: 'ag_ida' });
  return { ...h, s, quest, sign, mine };
}

test('"## My quests": one line per quest – the person\'s next to-do with its time, mine with the wait, each colleague\'s count, my next note; no time on agent work', () => {
  const h = setup();
  h.scheduler.create({ ownerId: 'ag_ida', kind: 'reminder', taskId: h.quest.id, title: 'Look', spec: { at: h.clock.now() + 24 * HOUR }, payload: { note: 'Look at Certum' } });
  const lone = h.tasks.create({ title: 'Answer the bank', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.tasks.create({ title: 'Draft the blog post', assigneeKind: 'agent', assigneeId: 'ag_felix', createdBy: 'ag_ida' });
  const text = myQuestsSection(h.s, 'ag_ida', 'UTC');
  const lines = text.split('\n');
  assert.equal(lines[0], '## My quests');
  assert.equal(lines[1], `- Windows signing · ${h.quest.id} · person: 1 open (next: Sign on the phone, Sun 18 Oct 11:00) · me: 1 (1 waits, on Felix since Sat 17 Oct) · Felix 2 · next note Sun 18 Oct 09:00`);
  assert.equal(lines[2], 'Other:');
  assert.equal(lines[3], `- ${lone.id} · open since Sat 17 Oct · Answer the bank`);
  assert.match(lines[4], /^- task_\S+ · Felix · open since Sat 17 Oct · Draft the blog post$/, 'a lone to-do I gave stands with its owner');
  assert.doesNotMatch(text, /Mon 19 Oct/, 'my own to-do\'s time is not printed');
});

test('"## My quests" has no cap: thirty quests are thirty lines; a quest I gave stands with its owner', () => {
  const h = setup();
  for (let i = 0; i < 30; i++) h.tasks.create({ kind: 'quest', title: `Quest ${i}`, assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const given = h.tasks.create({ kind: 'quest', title: 'Blog relaunch', assigneeKind: 'agent', assigneeId: 'ag_felix', createdBy: 'ag_ida' });
  const text = myQuestsSection(h.s, 'ag_ida', 'UTC');
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 32);
  assert.ok(text.includes(`- Blog relaunch · ${given.id} · Felix's · no open to-dos · no next note`), text);
});

test('the snapshot\'s done-when ends with one period when it was written with one (real run 20.11.: "…ist abgegeben..")', () => {
  const h = setup();
  h.tasks.update(h.quest.id, { doneWhen: 'Die Steuererklärung ist abgegeben.' }, 'ag_ida');
  const lines = questSnapshot(h.s, h.tasks.get(h.quest.id)!, 'ag_ida', 'UTC');
  assert.equal(lines[0], `Windows signing · ${h.quest.id} – done when Die Steuererklärung ist abgegeben.`);
});

test('the snapshot: done-when, every owner\'s open to-dos with their state, the person\'s done ones, the thread since my last line', () => {
  const h = setup();
  h.tasks.finish(h.sign.id, { status: 'done', summary: 'Signed' }, HUMAN_ID);
  h.chats.send({ conversationId: h.mine.id, authorId: HUMAN_ID, body: 'Use the new certificate, please.' });
  const view = h.tasks.get(h.mine.id)!;
  const lines = questSnapshot(h.s, view, 'ag_ida', 'UTC');
  assert.equal(lines[0], `Windows signing · ${h.quest.id} – done when Every installer is signed.`);
  assert.equal(lines[1], 'Person: 0 open, 1 done (last: "Sign on the phone", Sat 17 Oct 09:00)');
  assert.equal(lines[2], 'Me:');
  assert.equal(lines[3], `  - "First signed build" · ${h.mine.id} · waits on Felix since Sat 17 Oct: the certificate`);
  assert.equal(lines[4], 'Felix:');
  assert.match(lines[5], /^ {2}- "Activate the certificate" · task_\S+ · open since Sat 17 Oct$/);
  assert.equal(lines[7], 'Thread since my last line:');
  assert.match(lines[8], /the person on "First signed build" \(task_\S+\): Use the new certificate, please\.$/);
  h.chats.send({ conversationId: h.mine.id, authorId: 'ag_ida', body: 'I use it.' });
  assert.equal(questSnapshot(h.s, view, 'ag_ida', 'UTC').at(-1), 'Thread since my last line: nothing new.', 'my own line closes what came before');
});

test('the person\'s line a turn takes, and "## Related open work" names the open work of others it is about – never my own', () => {
  const h = setup();
  h.org.add(agent('ag_lena', 'Lena'));
  const chat = h.chats.create({ agentIds: ['ag_lena'], createdBy: HUMAN_ID });
  assert.equal(personLineOf(h.s, 'ag_lena', chat.id), undefined, 'nothing new');
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Wie weit ist die Windows-Signierung? Und das signing für den Installer?' });
  assert.match(personLineOf(h.s, 'ag_lena', chat.id)?.body ?? '', /Windows-Signierung/);
  const related = relatedSection(h.s as never, 'ag_lena', chat.id, 'UTC');
  assert.ok(related.startsWith('## Related open work\n'), related);
  assert.ok(related.includes(`Windows signing · ${h.quest.id} · quest of Ida`), related);
  assert.equal(relatedSection(h.s as never, 'ag_ida', chat.id, 'UTC'), '', 'Ida is no member of that chat: no line of hers');
  const felixChat = h.chats.create({ agentIds: ['ag_felix'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: felixChat.id, authorId: HUMAN_ID, body: 'Wie weit ist die Windows-Signierung?' });
  assert.equal(relatedSection(h.s as never, 'ag_felix', felixChat.id, 'UTC'), '', 'a quest Felix holds to-dos in is his own work, in his quests');
});

test('FIXREAL 5: a reminder\'s note carries the quest as it stands now – a to-do\'s quest, a quest itself; nothing for a task that is gone', () => {
  const h = setup();
  const onTodo = reminderSnapshot(h.s, h.mine.id, 'ag_ida', 'UTC')!;
  assert.deepEqual(onTodo.split('\n').slice(0, 3), ['Its quest now:', `Windows signing · ${h.quest.id} – done when Every installer is signed.`, 'Person: 1 open']);
  assert.deepEqual(onTodo.split('\n'), ['Its quest now:', ...questSnapshot(h.s, h.tasks.get(h.mine.id)!, 'ag_ida', 'UTC')], 'the snapshot as the turn\'s own section shows it');
  assert.ok(reminderSnapshot(h.s, h.quest.id, 'ag_ida', 'UTC')!.startsWith(`Now:\nWindows signing · ${h.quest.id} – done when`));
  assert.equal(reminderSnapshot(h.s, 'task_gone00000', 'ag_ida', 'UTC'), undefined);
});

test('the person\'s lines a turn takes: every one after my read mark, oldest first; the newest is the line it started from', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ida', 'ag_felix'], createdBy: HUMAN_ID });
  const first = h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Zahnarzt morgen um 9 Uhr.' });
  h.chats.send({ conversationId: chat.id, authorId: 'ag_felix', body: 'Noted.' });
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Und Paul schreiben.' });
  assert.deepEqual(personLinesOf(h.s, 'ag_ida', chat.id).map((line) => line.body), ['Zahnarzt morgen um 9 Uhr.', 'Und Paul schreiben.']);
  assert.equal(personLineOf(h.s, 'ag_ida', chat.id)?.body, 'Und Paul schreiben.');
  h.chats.markRead(chat.id, 'ag_ida', first.seq);
  assert.deepEqual(personLinesOf(h.s, 'ag_ida', chat.id).map((line) => line.body), ['Und Paul schreiben.']);
  assert.deepEqual(personLinesOf(h.s, 'ag_ida', undefined), []);
});
