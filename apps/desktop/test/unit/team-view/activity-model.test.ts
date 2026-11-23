// Activity (src/ui/team/activity-model.ts): one row per member, people and agents side by side – done today (since the
// day start, done only), working now (an agent's live run with its task's title; a person's to-do whose time on the
// calendar is now), open and stuck (the one rule, stuckOf) – counted are to-dos, each once, a quest's to-dos read from
// its steps (Quests round 20.11.2026) – and the totals line.
// Owns: these assertions only. Never: the DOM, rpc or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import type { Task, TaskView } from '../../../src/shared/model/tasks.ts';
import { DEFAULT_MINUTES } from '../../../src/shared/model/calendar.ts';
import { NO_OWNER, activityRows, activityTotals, onCalendarNow, ownedByMember } from '../../../src/ui/team/activity-model.ts';
import { everyTask } from '../../../src/shared/model/tasks.ts';
import { STUCK_MS, stuckOf } from '../../../src/shared/model/task-stuck.ts';
import type { ActivityInput, ActivityMember } from '../../../src/ui/team/activity-model.ts';

const NOW = Date.UTC(2026, 9, 24, 15);
const DAY_START = Date.UTC(2026, 9, 24, 0);
const MIN = 60_000;
let seq = 0;

function plain(patch: Partial<Task> = {}): Task {
  seq++;
  return {
    id: `task_${seq}`, kind: 'todo', conversationId: 'ch_a', title: `Task ${seq}`, notes: '', status: 'open', assigneeKind: 'agent', assigneeId: 'ag_mara',
    createdBy: 'human', priority: 0, dependsOn: [], ledger: { movedAt: NOW - 1000 }, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW,
    ...patch,
  };
}

function task(patch: Partial<TaskView> = {}): TaskView {
  return { ...plain(patch), steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Alpha', running: false, ...patch };
}

const run = (agentId: string, patch: Partial<AgentActivity> = {}): AgentActivity => ({ agentId, runId: `run_${agentId}`, conversationId: 'ch_a', note: 'Working', startedAt: NOW - 60_000, ...patch });

const members: ActivityMember[] = [{ id: 'human', kind: 'person' }, { id: 'per_anna', kind: 'person' }, { id: 'ag_mara', kind: 'agent' }, { id: 'ag_leo', kind: 'agent' }];

function input(patch: Partial<ActivityInput>): ActivityInput {
  return { open: [], todos: [], done: [], live: [], now: NOW, dayStart: DAY_START, ...patch };
}

const row = (rows: ReturnType<typeof activityRows>, id: string) => rows.find((entry) => entry.member.id === id)!;

test('ownedByMember: agents by id, people as their page counts them (the caller also without an id)', () => {
  assert.equal(ownedByMember({ assigneeKind: 'agent', assigneeId: 'ag_mara' }, { id: 'ag_mara', kind: 'agent' }), true);
  assert.equal(ownedByMember({ assigneeKind: 'human', assigneeId: 'ag_mara' }, { id: 'ag_mara', kind: 'agent' }), false);
  assert.equal(ownedByMember({ assigneeKind: 'human' }, { id: 'human', kind: 'person' }), true);
  assert.equal(ownedByMember({ assigneeKind: 'human', assigneeId: 'per_anna' }, { id: 'per_anna', kind: 'person' }), true);
  assert.equal(ownedByMember({ assigneeKind: 'team' }, { id: 'human', kind: 'person' }), false);
});

test('a quest is counted by its to-dos: each to-do once for its own owner, a colleague\'s in someone else\'s quest too', () => {
  const quest = task({ kind: 'quest', title: 'Signing', assigneeId: 'ag_mara', steps: [
    plain({ parentId: 'q', assigneeId: 'ag_mara' }),
    plain({ parentId: 'q', assigneeId: 'ag_leo' }),
    plain({ parentId: 'q', assigneeKind: 'human', assigneeId: undefined }),
    plain({ parentId: 'q', assigneeId: 'ag_leo', status: 'done', completedAt: NOW - 3600_000 }),
  ] });
  const loose = task({ assigneeId: 'ag_mara' });
  const rows = activityRows(members, input({ open: [quest, loose], done: [] }));
  assert.equal(row(rows, 'ag_mara').open, 2, 'its to-do in the quest and its loose to-do – not the quest itself');
  assert.equal(row(rows, 'ag_leo').open, 1, 'a to-do in Mara\'s quest is Leo\'s work');
  assert.equal(row(rows, 'ag_leo').doneToday, 1, 'a done to-do of an open quest counts for today');
  assert.equal(row(rows, 'human').open, 1, 'the person\'s to-do inside an agent\'s quest');
  assert.equal(activityTotals(rows).open, 4);
});

test('everyTask: each task once, a quest\'s steps included; of two copies the newer one (rev) wins', () => {
  const stale = plain({ id: 'task_step', parentId: 'task_q', title: 'old', rev: 1 });
  const fresh = task({ id: 'task_step', parentId: 'task_q', title: 'new', rev: 3 });
  const quest = task({ id: 'task_q', kind: 'quest', steps: [stale] });
  assert.deepEqual([...everyTask([quest], [fresh]).keys()].sort(), ['task_q', 'task_step']);
  assert.equal(everyTask([quest], [fresh]).get('task_step')?.title, 'new');
  assert.equal(everyTask([fresh], [quest]).get('task_step')?.title, 'new', 'the order of the lists does not matter');
});

test('stuck is the one rule (stuckOf): a person\'s to-do past its time is not stuck while it moved lately; nothing moved for two days is', () => {
  const past = task({ assigneeKind: 'human', assigneeId: undefined, at: NOW - 3 * 3600_000 });
  const old = task({ assigneeKind: 'human', assigneeId: undefined, ledger: { movedAt: NOW - STUCK_MS - 1 } });
  const ahead = task({ assigneeKind: 'human', assigneeId: undefined, at: NOW + 24 * 3600_000, ledger: { movedAt: NOW - STUCK_MS - 1 } });
  const rows = activityRows(members, input({ todos: [past, old, ahead] }));
  assert.deepEqual([row(rows, 'human').open, row(rows, 'human').stuck], [3, 1], 'a to-do for tomorrow is open work, its time ahead keeps it from stuck');
  assert.equal(row(rows, 'human').stuck, [past, old, ahead].filter((entry) => stuckOf(entry, NOW)).length);
});

test('a person is working now on the open to-do whose time on the calendar is now (DEFAULT_MINUTES without a length)', () => {
  assert.equal(onCalendarNow({ status: 'open', at: NOW - 10 * MIN, minutes: 15 }, NOW), true);
  assert.equal(onCalendarNow({ status: 'open', at: NOW - 15 * MIN, minutes: 15 }, NOW), false, 'its slot ended');
  assert.equal(onCalendarNow({ status: 'open', at: NOW - (DEFAULT_MINUTES - 1) * MIN }, NOW), true);
  assert.equal(onCalendarNow({ status: 'open', at: NOW + MIN }, NOW), false, 'not yet');
  assert.equal(onCalendarNow({ status: 'waiting', at: NOW - MIN }, NOW), false, 'a waiting to-do is not worked on');
  assert.equal(onCalendarNow({ status: 'open' }, NOW), false, 'no time, no slot');
  const earlier = task({ assigneeKind: 'human', assigneeId: 'per_anna', title: 'Call the bank', at: NOW - 20 * MIN, minutes: 60 });
  const later = task({ assigneeKind: 'human', assigneeId: 'per_anna', title: 'Sign the offer', at: NOW - 5 * MIN, minutes: 30, conversationId: undefined });
  const rows = activityRows(members, input({ open: [earlier, later] }));
  assert.deepEqual(row(rows, 'per_anna').now, { title: 'Sign the offer', taskId: later.id }, 'the one that started last');
  assert.equal(row(rows, 'human').now, undefined);
});

test('activityRows: a live run names its task – a to-do in a quest or the quest itself', () => {
  const quest = task({ id: 'task_q', kind: 'quest', title: 'Signing', steps: [plain({ id: 'task_s', parentId: 'task_q', title: 'Check the PDF' })] });
  const rows = activityRows([{ id: 'ag_leo', kind: 'agent' }, { id: 'ag_mara', kind: 'agent' }], input({ open: [quest], live: [
    run('ag_leo', { taskId: 'task_s', note: 'Reading page 3' }), run('ag_mara', { taskId: 'task_q', note: 'Signing' }),
  ] }));
  assert.deepEqual(rows[0].now, { title: 'Check the PDF', note: 'Reading page 3', taskId: 'task_s', conversationId: 'ch_a' });
  assert.deepEqual(rows[1].now, { title: 'Signing', taskId: 'task_q', conversationId: 'ch_a' }, 'a note that says the title again is not repeated');
});

test('activityRows: a live run without a task shows its note; without a note "Working"', () => {
  const rows = activityRows([{ id: 'ag_leo', kind: 'agent' }, { id: 'ag_mara', kind: 'agent' }], input({ live: [run('ag_leo', { note: 'Checking the inbox' }), run('ag_mara', { note: '' })] }));
  assert.deepEqual(rows[0].now, { title: 'Checking the inbox', conversationId: 'ch_a' });
  assert.equal(rows[1].now?.title, 'Working');
});

test('B-054: a chat-free run without a task says what started it (origin label), with its live note beside it', () => {
  const rows = activityRows([{ id: 'ag_leo', kind: 'agent' }, { id: 'ag_mara', kind: 'agent' }], input({ live: [
    run('ag_leo', { conversationId: undefined, note: 'Reading the mail', origin: { source: 'app:mail1', label: 'New mail in office@example.com' } }),
    run('ag_mara', { conversationId: undefined, note: '', origin: { source: 'schedule:s1', label: 'Reminder "Morning check"' } }),
  ] }));
  assert.deepEqual(rows[0].now, { title: 'New mail in office@example.com', note: 'Reading the mail', conversationId: undefined });
  assert.equal(rows[1].now?.title, 'Reminder "Morning check"');
  assert.equal(rows[1].now?.note, undefined);
});

test('done today: done to-dos finished since the day start; dropped ones and done quests are not counted', () => {
  const done = [
    task({ status: 'done', completedAt: NOW - 3600_000 }),
    task({ status: 'done', completedAt: DAY_START - 1 }),
    task({ status: 'dropped', completedAt: NOW - 60_000 }),
    task({ kind: 'quest', status: 'done', completedAt: NOW - 60_000 }),
  ];
  assert.equal(row(activityRows(members, input({ done })), 'ag_mara').doneToday, 1);
});

test('work nobody owns yet is its own row ("No owner yet"): the totals then match the stuck rule over every to-do', () => {
  const unowned = task({ assigneeKind: 'team', assigneeId: undefined, title: 'Steuern erledigen' });
  const unowned2 = task({ assigneeKind: 'team', assigneeId: undefined, title: 'Webseite verbessern' });
  const blocked = task({ status: 'waiting' });
  const open = [unowned, unowned2, blocked];
  const rows = activityRows([...members, NO_OWNER], input({ open }));
  const nobody = rows.find((entry) => entry.member.kind === 'team')!;
  assert.deepEqual([nobody.open, nobody.stuck], [2, 2], 'no owner yet is stuck');
  assert.equal(activityTotals(rows).stuck, open.filter((entry) => stuckOf(entry, NOW)).length);
  assert.equal(ownedByMember({ assigneeKind: 'team' }, NO_OWNER), true);
  assert.equal(ownedByMember({ assigneeKind: 'agent', assigneeId: 'ag_mara' }, NO_OWNER), false);
});
