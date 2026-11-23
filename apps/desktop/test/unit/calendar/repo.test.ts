// B-041 track A1: CalendarRepo over migration 068 – rows map both ways (optional fields only when set), a to-do
// block never stores text, saves are rev-checked, the window is an overlap and leaves out hidden sources, a task's
// blocks, mirrored rows by their source id, what a cascade can take away, and sources not synced for a day.
// Owns: checks of runtime/calendar/repo.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEvent } from '../../../src/shared/model/calendar.ts';
import { at, MIN, world } from './fixture.ts';

test('a row round-trips with every field; a plain one has no optional keys', () => {
  const w = world();
  const full: CalendarEvent = {
    id: 'cev_full', ownerId: 'human', kind: 'event', title: 'Notar', notes: 'Unterlagen mitnehmen', startAt: at('10:00'), endAt: at('11:00'), allDay: true, tz: 'Europe/Vienna',
    sourceId: 'local', externalId: 'ext-1', etag: 'e1', setBy: 'person', state: 'planned', readOnly: true, createdBy: 'human', rev: 3, createdAt: 1, updatedAt: 2,
  };
  w.calendar.repo.insert(full);
  assert.deepEqual(w.calendar.repo.get('cev_full'), full);
  const plain = w.row({ id: 'cev_plain', startAt: at('12:00'), endAt: at('13:00') });
  const read = w.calendar.repo.get('cev_plain')!;
  assert.deepEqual(read, plain);
  for (const key of ['taskId', 'title', 'notes', 'allDay', 'tz', 'externalId', 'etag', 'readOnly']) assert.equal(key in read, false, key);
});

test('a to-do with a time is a row read from its task (id = the task\'s, no text): open at its time, done when it was done', () => {
  const w = world();
  const task = w.todo('Küche aufräumen', { at: at('10:00'), minutes: 20 });
  const row = w.calendar.repo.get(task.id)!;
  assert.deepEqual([row.kind, row.taskId, row.title, row.notes, row.startAt, row.endAt, row.state, row.setBy], ['todo', task.id, undefined, undefined, at('10:00'), at('10:20'), 'planned', 'person']);
  assert.equal(w.calendar.repo.get(w.todo('Ohne Zeit').id), undefined, 'no time: no row');
  assert.equal(w.db.get<{ n: number }>('SELECT count(*) AS n FROM calendar_events')?.n, 0, 'never stored');
  w.clock.set(at('09:00'));
  w.tasks.finish(task.id, { status: 'done', summary: 'ok' }, 'human');
  assert.deepEqual([w.calendar.repo.get(task.id)!.state, w.calendar.repo.get(task.id)!.startAt], ['done', at('09:00')]);
});

test('save is rev-checked; delete reports whether a row went', () => {
  const w = world();
  const row = w.row({ id: 'cev_a', startAt: at('09:00'), endAt: at('10:00'), title: 'Call' });
  assert.equal(w.calendar.repo.save({ ...row, startAt: at('09:30'), rev: 1 }, 5), false, 'a stale rev writes nothing');
  assert.ok(w.calendar.repo.save({ ...row, startAt: at('09:30'), rev: 1 }, 0));
  assert.deepEqual([w.calendar.repo.get('cev_a')!.startAt, w.calendar.repo.get('cev_a')!.rev], [at('09:30'), 1]);
  assert.ok(w.calendar.repo.delete('cev_a'));
  assert.equal(w.calendar.repo.delete('cev_a'), false);
});

test('the window is an overlap of [from, to) and leaves out rows of hidden sources and of other members', () => {
  const w = world();
  w.source('cal_shown');
  w.source('cal_hidden', { visible: false });
  w.row({ id: 'cev_before', startAt: at('08:00'), endAt: at('09:00') });
  w.row({ id: 'cev_across', startAt: at('08:30'), endAt: at('09:30') });
  w.row({ id: 'cev_inside', startAt: at('09:15'), endAt: at('09:45'), sourceId: 'cal_shown', readOnly: true, externalId: 'x1' });
  w.row({ id: 'cev_hidden', startAt: at('09:15'), endAt: at('09:45'), sourceId: 'cal_hidden', readOnly: true, externalId: 'x2' });
  w.row({ id: 'cev_after', startAt: at('10:00'), endAt: at('11:00') });
  w.row({ id: 'cev_anna', ownerId: 'per_anna00000000', startAt: at('09:00'), endAt: at('10:00') });
  const mine = w.todo('Bank', { at: at('09:40'), minutes: 60 });
  assert.deepEqual(w.calendar.repo.inRange('human', at('09:00'), at('10:00')).map((row) => row.id), ['cev_across', 'cev_inside', mine.id]);
});

test('mirrored rows by source id and removing a source', () => {
  const w = world();
  w.source('cal_1');
  w.row({ id: 'cev_m1', sourceId: 'cal_1', externalId: 'uid-1', readOnly: true, startAt: at('13:00'), endAt: at('14:00') });
  w.row({ id: 'cev_m2', sourceId: 'cal_1', externalId: 'uid-2', readOnly: true, startAt: at('15:00'), endAt: at('16:00') });
  assert.equal(w.calendar.repo.byExternal('cal_1', 'uid-2')?.id, 'cev_m2');
  assert.deepEqual(w.calendar.repo.deleteBySource('cal_1').sort(), ['cev_m1', 'cev_m2']);
  assert.equal(w.calendar.repo.byExternal('cal_1', 'uid-1'), undefined);
});

test('stale sources: shown ones not synced since the cut-off (never synced: since they were added)', () => {
  const w = world();
  const now = w.clock.now();
  w.source('cal_fresh', { syncedAt: now - 60 * MIN });
  w.source('cal_old', { syncedAt: now - 25 * 60 * MIN });
  w.source('cal_never_new', { createdAt: now - 10 * MIN });
  w.source('cal_never_old', { createdAt: now - 30 * 60 * MIN });
  w.source('cal_hidden_old', { visible: false, syncedAt: now - 48 * 60 * MIN });
  assert.deepEqual(w.calendar.repo.staleSources('human', now - 24 * 60 * MIN).sort(), ['cal_never_old', 'cal_old']);
});
