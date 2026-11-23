// Settings › Scheduled (owner 21.11.2026), the pure part (src/ui/tasks/schedule-edit.ts): schedules grouped by chat in the
// order of their soonest run, the agents that set up their own (by name, found by the words typed), the text a schedule says, and an edit becoming a schedules.update with only what changed –
// a new text or chat takes its @mentions along, a reminder only its note and rule.
// Owns: these assertions. Never: the DOM, rpc or a store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import { agentEntries, editParams, groupByChat, levelOf, scheduleText } from '../../../src/ui/tasks/schedule-edit.ts';

const schedule = (id: string, extra: Partial<Schedule> = {}): Schedule => ({
  id, ownerId: 'human', conversationId: 'cv_a', kind: 'message', title: id, spec: { at: 1_000 }, payload: { body: `${id} body` },
  runs: 0, active: true, createdAt: 1, ...extra,
});

test('groups by chat: chats in the order of their soonest run, rows by next run, a reminder without a chat apart', () => {
  const list = [
    schedule('a1', { nextAt: 300 }), schedule('b1', { conversationId: 'cv_b', nextAt: 100 }), schedule('a2', { nextAt: 200 }),
    schedule('r1', { kind: 'reminder', ownerId: 'ag_ava', conversationId: undefined, nextAt: 400, payload: { note: 'Look' } }),
  ];
  const groups = groupByChat(list);
  assert.deepEqual(groups.map((group) => group.conversationId), ['cv_b', 'cv_a', undefined]);
  assert.deepEqual(groups[1].schedules.map((entry) => entry.id), ['a2', 'a1']);
});

test('the text and level of a schedule', () => {
  assert.equal(scheduleText(schedule('m')), 'm body');
  assert.equal(scheduleText(schedule('r', { kind: 'reminder', payload: { note: 'Coffee' } })), 'Coffee');
  assert.equal(scheduleText(schedule('t', { payload: {} })), 't', 'the title when nothing else is stored');
  assert.equal(levelOf(schedule('s', { payload: { silent: true } })), 'silent');
  assert.equal(levelOf(schedule('i', { payload: { priority: 'important' } })), 'important');
});

test('an edit sends only what changed', () => {
  const stored = schedule('m', { payload: { body: 'Hi @Ava', mentions: ['ag_ava'] } });
  const same = { body: 'Hi @Ava', level: 'normal' as const, conversationId: 'cv_a', mentions: ['ag_ava'] };
  assert.equal(editParams(stored, same), null, 'nothing changed');
  assert.equal(editParams(stored, { ...same, body: '  ' }), null, 'an empty text is not saved');
  assert.deepEqual(editParams(stored, { ...same, level: 'important' }), { id: 'm', priority: 'important' });
  assert.deepEqual(editParams(stored, { ...same, body: 'Hello' , mentions: [] }), { id: 'm', body: 'Hello', mentions: [] });
  assert.deepEqual(editParams(stored, { ...same, conversationId: 'cv_b', mentions: [] }), { id: 'm', conversationId: 'cv_b', mentions: [] }, 'a move re-reads the mentions');
  assert.deepEqual(editParams(stored, { ...same, spec: { everyMs: 3_600_000 } }), { id: 'm', spec: { everyMs: 3_600_000 } });
});

test('a reminder changes its note and rule, never a chat or level', () => {
  const reminder = schedule('r', { kind: 'reminder', ownerId: 'ag_ava', payload: { note: 'Look' } });
  assert.deepEqual(editParams(reminder, { body: 'Look again', level: 'important', conversationId: 'cv_b', mentions: [] }), { id: 'r', body: 'Look again' });
});

test('the agents that set up their own: by name, counted, the soonest run of the running ones, found by the words typed', () => {
  const list = [
    schedule('h1'),
    schedule('a1', { ownerId: 'ag_ava', nextAt: 500 }), schedule('a2', { ownerId: 'ag_ava', nextAt: 100, active: false, pausedBy: 'human' }),
    schedule('b1', { ownerId: 'ag_bob', kind: 'reminder', nextAt: 300 }),
  ];
  const names: Record<string, string> = { ag_ava: 'Ava Stone', ag_bob: 'Bob' };
  const nameOf = (id: string) => names[id];
  assert.deepEqual(agentEntries(list, nameOf), [
    { agentId: 'ag_ava', name: 'Ava Stone', count: 2, nextAt: 500 }, // the paused one's run does not count
    { agentId: 'ag_bob', name: 'Bob', count: 1, nextAt: 300 },
  ]);
  assert.deepEqual(agentEntries(list, nameOf, '  sto ava ').map((entry) => entry.agentId), ['ag_ava']);
  assert.deepEqual(agentEntries(list, nameOf, 'zed'), []);
});
