// The Tasks page's lists (src/ui/tasks/page-model.ts): the quest column (With you – quests holding the person's open
// to-dos, with their count –, Other, AI only), a quest's colour from its id (eight hues), the quests a to-do can move
// into, "For you" (overdue and today first, timed by time, the rest by age, then Later), "Done today", "At work" (per
// quest the lines of everyone but the person – agents, colleagues, the team –, running first, what they finished today,
// the quest's next note; ?owner= narrows it), its summary line and who is sorting a new line.
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Schedule, Task } from '../../../src/shared/model/tasks.ts';
import {
  HUES, atWork, doerOf, doneToday, forYou, nextNote, questChoices, questHue, questLines, questProgress, soonestNote, sortingAgent, workSummary,
} from '../../../src/ui/tasks/page-model.ts';

const NOW = Date.UTC(2026, 10, 20, 8, 40);
const DAY_START = Date.UTC(2026, 10, 19, 23);
const DAY_END = DAY_START + 24 * 3_600_000;
let seq = 0;

function task(patch: Partial<Task> = {}): Task {
  seq++;
  return {
    id: `task_${String(seq).padStart(8, '0')}`, kind: 'todo', title: `T${seq}`, notes: '', status: 'open', assigneeKind: 'human', createdBy: 'ag_lukas',
    priority: 0, ledger: {}, sort: seq, rev: 1, createdAt: NOW - 100_000 + seq, updatedAt: NOW, ...patch,
  };
}

const indexOf = (...list: Task[]) => new Map(list.map((entry) => [entry.id, entry]));

function reminder(patch: Partial<Schedule>): Schedule {
  return { id: `sch_${++seq}`, ownerId: 'ag_lukas', kind: 'reminder', title: 'Look again', spec: {}, payload: { note: 'Certum-Status ansehen' }, runs: 0, active: true, createdAt: 1, ...patch };
}

test('a quest\'s colour comes from its id: the same everywhere, one of the eight hues', () => {
  assert.equal(HUES, 8, 'the mockup\'s eight quest colours (tokens.css --wf-c1 … --wf-c8)');
  const hue = questHue('task_sign0001');
  assert.equal(questHue('task_sign0001'), hue);
  assert.ok(hue >= 1 && hue <= HUES);
  const hues = new Set(Array.from({ length: 80 }, (_, index) => questHue(`task_q${index}`)));
  assert.equal(hues.size, 8, 'ids spread over all eight');
});

test('the quest column: with the person\'s open to-dos first (their count), Other, then AI only (the agents\' count)', () => {
  const sign = task({ kind: 'quest', title: 'Windows-Signierung', assigneeKind: 'agent', assigneeId: 'ag_lukas', createdAt: 10 });
  const hn = task({ kind: 'quest', title: 'Show HN', assigneeKind: 'agent', assigneeId: 'ag_mira', createdAt: 20 });
  const closed = task({ kind: 'quest', status: 'done' });
  const mine = task({ parentId: hn.id });
  const theirs = task({ parentId: sign.id, assigneeKind: 'agent', assigneeId: 'ag_felix' });
  const doneMine = task({ parentId: sign.id, status: 'done' });
  const colleague = task({ parentId: sign.id, assigneeId: 'per_meral' });
  const lone = task();
  const loneDone = task({ status: 'done' });
  const lists = questLines(indexOf(sign, hn, closed, mine, theirs, doneMine, colleague, lone, loneDone));
  assert.deepEqual(lists.withYou.map((line) => [line.quest.title, line.mine]), [['Show HN', 1]]);
  assert.deepEqual(lists.aiOnly.map((line) => [line.quest.title, line.open]), [['Windows-Signierung', 2]], 'a colleague\'s to-do is not the person\'s');
  assert.equal(lists.other, 1, 'the person\'s open to-do without a quest');
  assert.equal(lists.withYou[0].hue, questHue(hn.id));
  assert.deepEqual(questChoices(indexOf(sign, hn, closed, mine, theirs)).map((quest) => quest.title), ['Show HN', 'Windows-Signierung'], 'Move to quest ›: open quests, the person\'s first');
});

test('For you: overdue and today first by time, then the rest by age, then Later; Other only; finished and others\' left out', () => {
  const overdue = task({ at: NOW - 3_600_000 });
  const today = task({ at: NOW + 3_600_000 });
  const noTime = task();
  const tomorrow = task({ at: DAY_END + 9 * 3_600_000 });
  const inQuest = task({ parentId: 'task_quest0001' });
  const agent = task({ assigneeKind: 'agent', assigneeId: 'ag_lukas' });
  const done = task({ status: 'done' });
  const lists = forYou([tomorrow, noTime, inQuest, today, overdue, agent, done], NOW, DAY_END);
  assert.deepEqual(lists.now.map((entry) => entry.id), [overdue.id, today.id, noTime.id, inQuest.id]);
  assert.deepEqual(lists.later.map((entry) => entry.id), [tomorrow.id]);
  assert.deepEqual(forYou([noTime, inQuest], NOW, DAY_END, true).now.map((entry) => entry.id), [noTime.id], 'Other: no quest');
  const ownQuest = task({ kind: 'quest', createdBy: 'human' });
  assert.deepEqual(forYou([ownQuest, noTime], NOW, DAY_END).now.map((entry) => entry.id), [noTime.id], "a quest of the person's is no to-do of theirs");
});

test('Done today: the person\'s own to-dos finished since the day began, in the order they were done', () => {
  const second = task({ status: 'done', completedAt: NOW - 1000 });
  const first = task({ status: 'done', completedAt: DAY_START + 1000 });
  const yesterday = task({ status: 'done', completedAt: DAY_START - 1000 });
  const dropped = task({ status: 'dropped', completedAt: NOW });
  const agents = task({ status: 'done', completedAt: NOW, assigneeKind: 'agent', assigneeId: 'ag_x' });
  assert.deepEqual(doneToday([second, first, yesterday, dropped, agents], DAY_START).map((entry) => entry.id), [first.id, second.id]);
});

test('At work: per quest the lines of agents, colleagues and the team – running first, what they finished today –, the next note, Other last; ?owner= narrows', () => {
  const sign = task({ kind: 'quest', title: 'Windows-Signierung', assigneeKind: 'agent', assigneeId: 'ag_lukas', createdAt: 5 });
  const waiting = task({ parentId: sign.id, assigneeKind: 'agent', assigneeId: 'ag_felix', status: 'waiting', waitingOn: { on: 'outside', why: 'Certum', since: NOW - 1 } });
  const running = task({ parentId: sign.id, assigneeKind: 'agent', assigneeId: 'ag_konrad' });
  const doneToday = task({ parentId: sign.id, assigneeKind: 'agent', assigneeId: 'ag_lukas', status: 'done', completedAt: NOW - 1000 });
  const doneBefore = task({ parentId: sign.id, assigneeKind: 'agent', assigneeId: 'ag_lukas', status: 'done', completedAt: DAY_START - 1000 });
  const yours = task({ parentId: sign.id });
  const loose = task({ assigneeKind: 'agent', assigneeId: 'ag_ben' });
  const index = indexOf(sign, waiting, running, doneToday, doneBefore, yours, loose);
  const note = reminder({ taskId: waiting.id, nextAt: NOW + 3_600_000 });
  const groups = atWork(index, new Set([running.id]), [note, reminder({ taskId: 'task_other', nextAt: NOW + 1 })], DAY_START);
  assert.deepEqual(groups.map((group) => group.quest?.title ?? 'Other'), ['Windows-Signierung', 'Other']);
  assert.deepEqual(groups[0].lines.map((line) => line.task.id), [running.id, waiting.id, doneToday.id]);
  assert.deepEqual(groups[0].lines.map((line) => line.who), ['ag_konrad', 'ag_felix', 'ag_lukas']);
  assert.equal(groups[0].lines[0].running, true);
  assert.equal(groups[0].note?.id, note.id, 'a note about one of its to-dos is the quest\'s next note');
  assert.deepEqual(atWork(index, new Set(), [], DAY_START, 'ag_felix').flatMap((group) => group.lines.map((line) => line.task.id)), [waiting.id]);
  assert.equal(workSummary(groups, { name: 'Lukas', clock: '12:00' }), '3 open to-dos in 1 quest · 1 running now · next: Lukas at 12:00');
  assert.equal(workSummary([], undefined), 'Nothing open right now');
});

test('At work: work the person gave to a colleague or to the team shows (R2.9); the person\'s own never', () => {
  const colleague = task({ title: 'Sign the lease', assigneeId: 'per_meral', createdBy: 'human' });
  const team = task({ title: 'Book the venue', assigneeKind: 'team', createdBy: 'human' });
  const mine = task({ title: 'Water the plants' });
  const groups = atWork(indexOf(colleague, team, mine), new Set(), [], DAY_START);
  assert.deepEqual(groups.flatMap((group) => group.lines.map((line) => [line.task.title, line.who])), [['Sign the lease', 'per_meral'], ['Book the venue', 'team']]);
  assert.deepEqual([doerOf(colleague), doerOf(team), doerOf(task({ assigneeKind: 'agent', assigneeId: 'ag_x' }))], ['per_meral', 'team', 'ag_x']);
  assert.deepEqual(atWork(indexOf(colleague, team), new Set(), [], DAY_START, 'team').flatMap((group) => group.lines.map((line) => line.task.id)), [team.id], '?owner=team');
  assert.equal(workSummary(groups, undefined), '2 open to-dos');
});

test('notes: the soonest active reminder from now on; a quest\'s next one about it or its to-dos; progress counts dropped ones out', () => {
  const past = reminder({ nextAt: NOW - 1 });
  const soon = reminder({ nextAt: NOW + 60_000 });
  const paused = reminder({ nextAt: NOW + 1, active: false });
  const message = reminder({ kind: 'message', nextAt: NOW + 2 });
  assert.equal(soonestNote([past, soon, paused, message], NOW)?.id, soon.id);
  assert.equal(nextNote([soon], new Set(['task_x'])), undefined, 'not about the quest');
  assert.deepEqual(questProgress([task({ status: 'done' }), task(), task({ status: 'dropped' })]), { done: 1, total: 2 });
});

test('"<assistant> is sorting…": only on the told to-dos, only while a run of it that began after the line is live', () => {
  const told = { agentId: 'ag_paula', at: NOW, ids: ['task_new00001'] };
  assert.equal(sortingAgent(told, 'task_new00001', [{ agentId: 'ag_paula', startedAt: NOW + 2000 }]), 'ag_paula');
  assert.equal(sortingAgent(told, 'task_new00001', [{ agentId: 'ag_paula', startedAt: NOW - 60_000 }]), undefined, 'an older run is other work');
  assert.equal(sortingAgent(told, 'task_other0001', [{ agentId: 'ag_paula', startedAt: NOW + 2000 }]), undefined);
  assert.equal(sortingAgent(null, 'task_new00001', []), undefined);
});
