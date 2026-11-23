// B-041 track A1 / Quests round 20.11.2026: the CalendarService – the window: appointments, the to-dos with a time read
// from their tasks (the person's, a done one at the time it was done – an agent's open work has no row) with those tasks, the
// agents' runs (computed from schedules, capped, never stored), the profile zone and sources not synced for a day; slot
// clicks (calendar.add: a to-do is the person's line at that time – day/intake.ts –, an event a row with its title,
// 'auto' reads nothing from the text, a resend answers the first result); moves (an event rev-checked and pinned, a
// to-do row moves the to-do's time), removal (an event goes, a to-do only loses its time), busy spans – every change,
// a to-do's time too, sent as calendar.upserted / calendar.removed and handed to the sources' mirror hook.
// Owns: checks of runtime/calendar/{service,add,agent-runs}.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { AGENT_RUN_LIMITS } from '../../../src/runtime/calendar/agent-runs.ts';
import { agent } from '../chat/harness.ts';
import { at, MIN, TZ, world } from './fixture.ts';

const code = (run: () => unknown) => { try { run(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

test("list: appointments, the to-dos with a time and their tasks, the agents' lane, the zone and stale sources", () => {
  const w = world({ now: '06:00' });
  const chat = w.chat();
  w.row({ id: 'cev_meeting', title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  const taxes = w.todo('Steuern', { at: at('12:00'), minutes: 45 });
  w.todo('Irgendwann'); // no time: not on the calendar
  const report = w.tasks.create({ title: 'Report', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: 'ag_mara', at: at('15:00') });
  w.tasks.create({ title: 'Draft', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: 'ag_mara', at: at('16:00') }); // open agent work: no row
  w.tasks.finish(report.id, { status: 'done', summary: 'Sent' }, 'ag_mara');
  w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'reminder', title: 'Morning digest', spec: { cron: '0 7 * * *', tz: TZ }, payload: { note: 'Digest' } });
  const paused = w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'message', title: 'Paused post', spec: { cron: '0 9 * * *', tz: TZ }, payload: { body: 'x' } });
  w.scheduler.update(paused.id, { active: false });
  w.source('cal_old', { syncedAt: w.clock.now() - 30 * 60 * MIN });
  const list = w.calendar.list(HUMAN_ID, at('00:00'), at('00:00', '2026-10-30'));
  assert.deepEqual(list.events.map((row) => [row.id, row.kind, row.ownerId, row.startAt, row.endAt]), [
    [report.id, 'todo', 'ag_mara', at('06:00'), at('06:30')], ['cev_meeting', 'event', HUMAN_ID, at('10:00'), at('11:00')], [taxes.id, 'todo', HUMAN_ID, at('12:00'), at('12:45')],
  ]);
  assert.equal(list.events[0].state, 'done', 'the agent\'s work shows where it was done (the logbook), never at an own time');
  assert.equal(list.events[2].title, undefined, 'a to-do row carries no text');
  assert.deepEqual(list.tasks.map((task) => task.id).sort(), [taxes.id, report.id].sort(), 'the tasks the rows show');
  assert.deepEqual(list.agentRuns.map((run) => [run.title, run.at]), [
    ['Morning digest', at('07:00')], ['Morning digest', at('07:00', '2026-10-28')], ['Morning digest', at('07:00', '2026-10-29')],
  ], "the reminder's runs; not the paused post");
  assert.equal(list.tz, TZ);
  assert.deepEqual(list.staleSources, ['cal_old']);
  assert.equal(w.db.get<{ n: number }>('SELECT count(*) AS n FROM calendar_events')?.n, 1, 'to-dos and runs are never stored');
});

test('a done to-do stays on the calendar at the time it was done (the logbook); a dropped one goes', () => {
  const w = world({ now: '09:00' });
  const call = w.todo('Bank anrufen', { at: at('14:00') });
  const skip = w.todo('Skip', { at: at('15:00') });
  w.clock.set(at('09:30'));
  w.tasks.finish(call.id, { status: 'done', summary: 'Done' }, HUMAN_ID);
  w.tasks.finish(skip.id, { status: 'dropped', summary: 'Not needed' }, HUMAN_ID);
  const rows = w.calendar.list(HUMAN_ID, at('00:00'), at('23:59')).events;
  assert.deepEqual(rows.map((row) => [row.id, row.state, row.startAt]), [[call.id, 'done', at('09:30')]]);
  assert.deepEqual(w.removedEvents().at(-1), { id: skip.id, ownerId: HUMAN_ID, taskId: skip.id }, 'the dropped one\'s row is sent as removed');
});

test("the agents' lane is capped per schedule and per window", () => {
  const w = world({ now: '06:00' });
  const chat = w.chat();
  for (const title of ['A', 'B', 'C', 'D', 'E']) w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'message', title, spec: { everyMs: 15 * MIN }, payload: { body: title } });
  const runs = w.calendar.list(HUMAN_ID, at('06:00'), at('06:00', '2026-10-29')).agentRuns;
  assert.equal(runs.length, AGENT_RUN_LIMITS.perWindow);
  for (const title of ['A', 'B', 'C', 'D', 'E']) assert.ok(runs.filter((run) => run.title === title).length <= AGENT_RUN_LIMITS.perSchedule, title);
});

test("one agent's lane (the agent page): its own runs and done to-dos, capped for it alone; no appointments", () => {
  const w = world({ now: '06:00' });
  w.org.add(agent('ag_tom', 'Tom'));
  const chat = w.chat();
  w.row({ id: 'cev_meeting', title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  for (const title of ['A', 'B', 'C', 'D', 'E']) w.scheduler.create({ ownerId: 'ag_mara', conversationId: chat.id, kind: 'message', title, spec: { everyMs: 15 * MIN }, payload: { body: title } });
  w.scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'Evening report', spec: { cron: '0 18 * * *', tz: TZ }, payload: { note: 'Report' } });
  const own = w.tasks.create({ title: 'Toms Bericht', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: 'ag_tom', at: at('16:00') });
  assert.deepEqual(w.calendar.list(HUMAN_ID, at('06:00'), at('06:00', '2026-10-31'), 'ag_tom').events, [], 'open: no row');
  w.tasks.finish(own.id, { status: 'done', summary: 'Done' }, 'ag_tom');
  const toms = w.calendar.list(HUMAN_ID, at('06:00'), at('06:00', '2026-10-31'), 'ag_tom');
  assert.deepEqual(toms.agentRuns.map((run) => run.at), [at('18:00'), at('18:00', '2026-10-28'), at('18:00', '2026-10-29'), at('18:00', '2026-10-30')]);
  assert.deepEqual(toms.events.map((row) => [row.id, row.state]), [[own.id, 'done']], 'its done to-do, no appointments');
});

test("a slot click with a to-do: the person's line at that time – their own to-do with the range's minutes, the assistant told", async () => {
  const w = world({ now: '08:00' });
  const { event, task } = await w.calendar.add({ text: 'Steuern', startAt: at('10:00'), endAt: at('10:45') }, HUMAN_ID);
  assert.ok(task);
  assert.deepEqual([task.title, task.assigneeKind, task.createdBy, task.conversationId, task.at, task.minutes], ['Steuern', 'human', HUMAN_ID, undefined, at('10:00'), 45], 'chat-free (B-054)');
  assert.deepEqual([event.kind, event.id, event.taskId, event.title, event.setBy, event.startAt, event.endAt, event.ownerId], ['todo', task.id, task.id, undefined, 'person', at('10:00'), at('10:45'), HUMAN_ID]);
  assert.ok(w.wakes.list('ag_mara').some((wake) => /wrote a line on the Tasks page/.test(wake.note ?? '')), 'the assistant sorts it (tasks/quick.ts, the one intake)');
  assert.ok(w.changes.some((change) => 'id' in change && change.id === task.id), 'the mirror hears the to-do\'s row');
  const plain = await w.calendar.add({ text: 'Küche aufräumen 45 min', startAt: at('13:00') }, HUMAN_ID);
  assert.deepEqual([plain.task?.minutes, plain.event.endAt], [undefined, at('13:30')], 'no guessing from words: the default length');
  const only = world({ now: '08:00', day: { aiHelps: false } });
  assert.equal((await only.calendar.add({ text: 'Steuern', startAt: at('10:00') }, HUMAN_ID)).task?.private, true, '"Only me" makes it private');
  const first = await w.calendar.add({ text: 'Bad', startAt: at('16:00'), clientId: 'c1' }, HUMAN_ID);
  assert.equal((await w.calendar.add({ text: 'Bad', startAt: at('16:00'), clientId: 'c1' }, HUMAN_ID)).task?.id, first.task?.id, 'a resend answers the first');
});

test("a slot click with kind 'event': an event with its title; 'auto' is a to-do; the click decides the time", async () => {
  const w = world({ now: '08:00' });
  const dentist = await w.calendar.add({ text: 'Zahnarzt', startAt: at('10:00'), kind: 'event' }, HUMAN_ID);
  assert.equal(dentist.task, undefined);
  assert.deepEqual([dentist.event.kind, dentist.event.title, dentist.event.setBy, dentist.event.endAt], ['event', 'Zahnarzt', 'person', at('11:00')], 'an hour by default');
  assert.equal((await w.calendar.add({ text: 'Meeting mit Anna', startAt: at('14:00'), kind: 'auto' }, HUMAN_ID)).event.kind, 'todo', 'no guessing from words');
  const notes = await w.calendar.add({ text: 'Notar\nUnterlagen mitnehmen', startAt: at('17:00'), kind: 'event' }, HUMAN_ID);
  assert.deepEqual([notes.event.title, notes.event.notes], ['Notar', 'Notar\nUnterlagen mitnehmen']);
  const resent = await w.calendar.add({ text: 'Zahnarzt', startAt: at('18:00'), clientId: 'e1', kind: 'event' }, HUMAN_ID);
  assert.equal((await w.calendar.add({ text: 'Zahnarzt', startAt: at('18:00'), clientId: 'e1', kind: 'event' }, HUMAN_ID)).event.id, resent.event.id);
  await assert.rejects(w.calendar.add({ text: '   ', startAt: at('18:00') }, HUMAN_ID), { code: 'bad_request' });
});

test("an agent's event is refused over an appointment or a to-do the person placed; agents give to-dos through their task tools", async () => {
  const w = world({ now: '08:00' });
  w.row({ title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  w.todo('Buch', { at: at('12:00'), minutes: 60 });
  w.tasks.create({ title: 'Wäsche', assigneeKind: 'human', createdBy: 'ag_mara', at: at('14:00') });
  await assert.rejects(w.calendar.add({ text: 'Dentist', startAt: at('10:30'), endAt: at('11:30'), kind: 'event' }, 'ag_mara'), { code: 'conflict' });
  await assert.rejects(w.calendar.add({ text: 'Dentist', startAt: at('12:30'), kind: 'event' }, 'ag_mara'), { code: 'conflict' });
  const ok = await w.calendar.add({ text: 'Dentist', startAt: at('14:00'), endAt: at('15:00'), kind: 'event' }, 'ag_mara');
  assert.deepEqual([ok.event.setBy, ok.event.createdBy], ['agent', 'ag_mara'], 'an agent\'s to-do yields');
  await assert.rejects(w.calendar.add({ text: 'Kitchen', startAt: at('16:00'), kind: 'todo' }, 'ag_mara'), { code: 'bad_request' });
});

test('move and remove: an event rev-checked and pinned; a to-do row moves or clears the to-do\'s time; read-only rows refused', () => {
  const w = world({ now: '08:00' });
  const event = w.row({ title: 'Call', setBy: 'agent', startAt: at('10:00'), endAt: at('10:30') });
  assert.equal(code(() => w.calendar.move(event.id, at('11:00'), at('11:30'), event.rev + 1, HUMAN_ID)), 'conflict');
  const moved = w.calendar.move(event.id, at('11:00'), at('11:30'), event.rev, HUMAN_ID);
  assert.deepEqual([moved.startAt, moved.endAt, moved.setBy, moved.rev], [at('11:00'), at('11:30'), 'person', event.rev + 1]);
  assert.equal(code(() => w.calendar.move(event.id, at('12:00'), at('11:00'), moved.rev, HUMAN_ID)), 'bad_request');
  const task = w.todo('Steuern', { at: at('13:00') });
  const row = w.calendar.repo.get(task.id)!;
  const shifted = w.calendar.move(task.id, at('15:00'), at('16:30'), row.rev, HUMAN_ID);
  assert.deepEqual([shifted.startAt, shifted.endAt], [at('15:00'), at('16:30')]);
  assert.deepEqual([w.tasks.get(task.id)!.at, w.tasks.get(task.id)!.minutes], [at('15:00'), 90], 'the to-do got the time');
  w.calendar.remove(task.id, HUMAN_ID);
  assert.deepEqual([w.tasks.get(task.id)!.status, w.tasks.get(task.id)!.at], ['open', undefined], 'the to-do stays, without its time');
  assert.deepEqual(w.removedEvents().at(-1), { id: task.id, ownerId: HUMAN_ID, taskId: task.id });
  assert.equal(code(() => w.calendar.remove(task.id, HUMAN_ID)), 'not_found');
  w.source('cal_1');
  const mirrored = w.row({ title: 'Team sync', sourceId: 'cal_1', externalId: 'uid-1', readOnly: true, setBy: 'sync', startAt: at('15:00'), endAt: at('16:00') });
  assert.equal(code(() => w.calendar.move(mirrored.id, at('16:00'), at('17:00'), 0, HUMAN_ID)), 'bad_request');
  assert.equal(code(() => w.calendar.remove(mirrored.id, HUMAN_ID)), 'bad_request');
  assert.equal(code(() => w.calendar.move('cev_none', at('16:00'), at('17:00'), 0, HUMAN_ID)), 'not_found');
  w.calendar.remove(event.id, HUMAN_ID);
  assert.equal(w.calendar.repo.get(event.id), undefined);
  assert.deepEqual(w.removedEvents().at(-1), { id: event.id, ownerId: HUMAN_ID });
});

test('busy: timed appointments and open to-dos with a time – not all-day rows, not done to-dos', () => {
  const w = world({ now: '08:00' });
  w.row({ title: 'Meeting', startAt: at('10:00'), endAt: at('11:00') });
  w.row({ title: 'Holiday', allDay: true, startAt: at('00:00'), endAt: at('00:00', '2026-10-28') });
  w.todo('Buch', { at: at('12:00'), minutes: 60 });
  const done = w.todo('Done early', { at: at('07:00') });
  w.tasks.finish(done.id, { status: 'done', summary: 'ok' }, HUMAN_ID);
  assert.deepEqual(w.calendar.busy(HUMAN_ID, at('00:00'), at('23:59')), [{ startAt: at('10:00'), endAt: at('11:00') }, { startAt: at('12:00'), endAt: at('13:00') }]);
});

test('a day without a time is an all-day row of that day – the Google mirror writes it so – and blocks no hour; 00:00 with minutes is a time', () => {
  const w = world({ now: '08:00' });
  const day = w.todo('Steuerberater anrufen', { at: at('00:00', '2026-10-28') });
  const timed = w.todo('Mitternacht', { at: at('00:00', '2026-10-28'), minutes: 30 });
  const rows = w.calendar.list(HUMAN_ID, at('00:00', '2026-10-28'), at('00:00', '2026-10-29')).events;
  const row = rows.find((entry) => entry.id === day.id);
  assert.deepEqual([row?.allDay, row?.startAt, row?.endAt], [true, at('00:00', '2026-10-28'), at('00:00', '2026-10-29')]);
  assert.equal(w.calendar.repo.get(day.id)?.allDay, true, 'the row the mirror reads');
  assert.equal(rows.find((entry) => entry.id === timed.id)?.allDay, undefined);
  assert.deepEqual(w.calendar.busy(HUMAN_ID, at('00:00', '2026-10-28'), at('23:59', '2026-10-28')), [{ startAt: at('00:00', '2026-10-28'), endAt: at('00:30', '2026-10-28') }]);
});
