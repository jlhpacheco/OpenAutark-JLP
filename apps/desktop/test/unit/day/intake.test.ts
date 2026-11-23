// The one intake of a person's line (runtime/tasks/quick.ts – tasks.quickCreate, Quests round 20.11.2026): their own
// to-do at once (title first line, notes the rest, a plain Done widget), in the quest they picked and at the time they
// chose; their assistant woken once with the line, the times its words name that they did not choose, the open work it
// is about and the sorting text; "Only me" (theirs, not hidden – the default with day.aiHelps off) is sorted, never
// handed on; a retry makes nothing twice; Send to… hands the line straight to an agent (its time into the notes).
// Owns: checks of that flow only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, dayFixture } from './fixture.ts';

const EVENING = Date.parse('2026-10-26T21:30:00Z'); // Monday 22:30 in Berlin
const secretary = () => agent('ag_sec', 'Sara', { role: 'Secretary', template: 'secretary', mode: 'secretary', createdAt: 1 });

test('the line stands at once as the person\'s own to-do; their assistant is told once with it', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  const { task, assistantId } = await f.line({ text: 'Steuern machen\nmit allen Belegen' });
  assert.deepEqual([task.title, task.notes, task.kind, task.assigneeKind, task.widget?.type, task.conversationId], ['Steuern machen', 'mit allen Belegen', 'todo', 'human', 'confirm', undefined]);
  assert.equal(assistantId, 'ag_sec');
  const wakes = f.wakes.list('ag_sec');
  assert.equal(wakes.length, 1);
  assert.ok((wakes[0].note ?? '').includes(`- ${task.id}: Steuern machen`), wakes[0].note);
  assert.equal(wakes[0].dueAt - f.clock.now(), 15_000, 'a request on the page is not kept waiting');
});

test('the assistant reads the times the words name that the person did not choose, and the open work the line is about', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  f.org.add(agent('ag_felix', 'Felix'));
  const quest = f.tasks.create({ kind: 'quest', title: 'Windows-Signierung', assigneeKind: 'agent', assigneeId: 'ag_felix', createdBy: HUMAN_ID });
  const { task } = await f.line({ text: 'Morgen Felix schreiben, dass wir am Freitag den Call zur Windows-Signierung haben' });
  const note = f.wakes.list('ag_sec')[0]?.note ?? '';
  assert.match(note, /times in their words, none chosen: "Morgen" = 2026-10-27, "(?:am )?Freitag" = 2026-10-30/, note);
  assert.ok(note.includes(`open work it is about: ${quest.id} "Windows-Signierung" (quest of Felix)`), note);
  assert.ok(!note.includes(`${task.id} "`), 'its own to-do is no related work');
  assert.match(note, /I sort it the way it serves them/);
  assert.doesNotMatch(note, /\b(you|your|must|may|allowed|only if)\b/i);
});

test('a chosen time and a picked quest: the to-do stands there; the assistant hears the time is theirs', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  const quest = f.tasks.create({ kind: 'quest', title: 'Umzug', doneWhen: 'Wir wohnen in der neuen Wohnung', assigneeKind: 'human', createdBy: HUMAN_ID });
  const at = Date.parse('2026-10-27T08:00:00Z');
  const { task } = await f.line({ text: 'Umzugswagen buchen', at, minutes: 45, quest: quest.id });
  assert.deepEqual([task.parentId, task.at, task.minutes], [quest.id, at, 45]);
  const note = f.wakes.list('ag_sec')[0]?.note ?? '';
  assert.match(note, /at Tue 27 Oct 09:00 \(they chose it\) · in task_/);
  assert.doesNotMatch(note, /times in their words/);
});

test('"Only me" stays the person\'s, and their assistant still hears of it – to sort it, never to hand it on; a retry makes nothing twice', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  const { task, assistantId } = await f.line({ text: 'Arzt anrufen', private: true });
  assert.deepEqual([task.private, task.assigneeKind, assistantId], [true, 'human', 'ag_sec']);
  const note = f.wakes.list('ag_sec')[0]?.note ?? '';
  assert.ok(note.includes(`- ${task.id}: Arzt anrufen`) && note.includes('only me: it needs them'), note);
  const first = await f.line({ text: 'Bank', clientId: 'c1' });
  const again = await f.line({ text: 'Bank', clientId: 'c1' });
  assert.equal(again.task.id, first.task.id);
  assert.equal(again.assistantId, undefined, 'the retry wakes nobody again');
  await assert.rejects(f.line({ text: '   ' }));
  await assert.rejects(f.line({ text: 'x'.repeat(9000) }));
});

test('"Only me" by default with "AI helps" off (Settings › day.aiHelps); the line\'s own choice wins either way', async () => {
  const f = dayFixture({ now: EVENING });
  f.org.add(secretary());
  f.setDay({ aiHelps: false });
  assert.equal((await f.line({ text: 'Steuerberater anrufen' })).task.private, true, 'the default');
  assert.equal((await f.line({ text: 'Rechnung schreiben', private: false })).task.private, undefined, 'an explicit false');
  f.setDay({ aiHelps: true });
  assert.equal((await f.line({ text: 'Rechnung prüfen' })).task.private, undefined);
  assert.equal((await f.line({ text: 'Zahnarzt', private: true })).task.private, true);
});

test('without an assistant the to-do stays the person\'s, told to nobody; Send to… hands it to an agent – a time into its notes, no `at`', async () => {
  const f = dayFixture({ now: EVENING });
  const { task, assistantId } = await f.line({ text: 'Rasen mähen' });
  assert.deepEqual([task.assigneeKind, assistantId], ['human', undefined]);
  f.org.add(agent('ag_tom', 'Tom'));
  const handed = await f.line({ text: 'Schnitt fertig machen', target: { kind: 'agent', id: 'ag_tom' } });
  assert.deepEqual([handed.task.assigneeKind, handed.task.assigneeId], ['agent', 'ag_tom']);
  const timed = await f.line({ text: 'Video hochladen', at: Date.parse('2026-10-27T14:00:00Z'), target: { kind: 'agent', id: 'ag_tom' } });
  assert.equal(timed.task.at, undefined, 'agent work has no time of its own');
  assert.match(timed.task.notes, /^Time the person gave it: Tue 27 Oct 15:00$/m, 'the person\'s time stays, in the zone of the day');
});
