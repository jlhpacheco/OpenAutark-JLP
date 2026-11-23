// Task.dependsOn (tasks/depends.ts): a task that comes after others waits; each one that ends shortens the wait without a
// wake; after the last one it opens again and its owner hears how it ended – once for all of its tasks one end opened
// (R1.10). Nothing holds it: it can be moved on by hand.
// Owns: these assertions only. Never: real timers, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom', { createdAt: 1 }));
  h.org.add(agent('ag_ivy', 'Ivy', { createdAt: 2 }));
  const wakesOf = (taskId: string) => h.wakeRows().filter((row) => row.task_id === taskId);
  const done = (id: string, by = 'ag_ivy') => h.tasks.finish(id, { status: 'done' as const, ...{ summary: 'Copy is ready', evidence: [], verification: 'claimed_by_agent' } }, by);
  return { h, wakesOf, done };
}


test('a finished dependency holds nothing; cancelled and removed ones end the wait too', () => {
  const { h, wakesOf, done } = setup();
  const first = h.tasks.create({ title: 'First', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  done(first.id);
  const free = h.tasks.create({ title: 'Free', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [first.id] });
  assert.equal(free.status, 'open');
  assert.ok(wakesOf(free.id).length, 'its owner starts at once');

  const cancelled = h.tasks.create({ title: 'Cancelled', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const a = h.tasks.create({ title: 'After cancelled', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [cancelled.id] });
  h.tasks.finish(cancelled.id, { status: 'dropped' as const, summary: 'Dropped' }, HUMAN_ID);
  assert.equal(h.tasks.get(a.id)?.status, 'open');
  assert.match(String(wakesOf(a.id)[0]?.note ?? ''), /is dropped/);

  const removed = h.tasks.create({ title: 'Removed', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const b = h.tasks.create({ title: 'After removed', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [removed.id] });
  h.tasks.remove(removed.id, HUMAN_ID);
  assert.equal(h.tasks.get(b.id)?.status, 'open');
});




test('a task after two others waits; the first end shortens the wait, the last opens it and its owner hears', () => {
  const { h, wakesOf, done } = setup();
  const copy = h.tasks.create({ title: 'Copy', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const art = h.tasks.create({ title: 'Art', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const launch = h.tasks.create({ title: 'Launch', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [copy.id, art.id] });
  assert.deepEqual([launch.status, launch.waitingOn?.on], ['waiting', 'task']);
  const told = wakesOf(launch.id).length; // its owner heard of the new work once
  done(copy.id);
  assert.deepEqual(h.tasks.get(launch.id)!.waitingOn?.ids, [art.id]);
  assert.equal(wakesOf(launch.id).length, told, 'a shorter wait wakes nobody');
  done(art.id);
  assert.equal(h.tasks.get(launch.id)!.status, 'open');
  assert.match(String(wakesOf(launch.id)[0]?.note ?? ''), /"Art".* is done/s);
});

test('a wait on a task (tasks.update on: task) ends with that task like a dependency', () => {
  const { h, done } = setup();
  const ask = h.tasks.create({ title: 'Which colour?', assigneeKind: 'human', createdBy: 'ag_tom' });
  const work = h.tasks.create({ title: 'Paint', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  h.tasks.update(work.id, { status: 'waiting', waitingOn: { on: 'task', ids: [ask.id], why: 'The colour' } }, 'ag_tom');
  done(ask.id, HUMAN_ID);
  assert.equal(h.tasks.get(work.id)!.status, 'open');
});

test('R1.10: an end that opens several tasks of one agent wakes it once, naming all of them – on their one quest', () => {
  const { h, done } = setup();
  const release = h.tasks.create({ title: 'Release 0.3.16', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const quest = h.tasks.create({ kind: 'quest', title: 'Asks of the week', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  const asks = ['Signed installer', 'Phone fix', 'Calendar fix'].map((title) => h.tasks.create({ title, parentId: quest.id, assigneeId: 'ag_tom', createdBy: 'ag_tom', dependsOn: [release.id] }));
  const announce = h.tasks.create({ title: 'Announce it', assigneeId: 'ag_ivy', createdBy: HUMAN_ID, dependsOn: [release.id] });
  h.db.run('DELETE FROM wakes');
  done(release.id);
  assert.ok(asks.every((ask) => h.tasks.get(ask.id)!.status === 'open'));
  const tom = h.wakeRows().filter((row) => row.agent_id === 'ag_tom');
  assert.equal(tom.length, 1, 'one wake for all three');
  assert.equal(tom[0].task_id, quest.id, 'on their one quest');
  assert.match(String(tom[0].note), /^"Release 0\.3\.16", which 3 of my tasks waited on, is done: Copy is ready\. Nothing else is ahead of them: /);
  for (const ask of asks) assert.ok(String(tom[0].note).includes(`"${ask.title}" (${ask.id})`), ask.title);
  const ivy = h.wakeRows().filter((row) => row.agent_id === 'ag_ivy');
  assert.deepEqual(ivy.map((row) => row.task_id), [announce.id], 'a single one: with that task, as before');
  assert.match(String(ivy[0].note), /which my task "Announce it" waited on, is done/);
});
